import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRuntime from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import EngineeringReviewRuntime, { type Config } from '../src/index.ts'
import { runArgv } from '../src/process.ts'
import type { EngineeringReviewAdapter, EngineeringReviewRequest } from '../src/types.ts'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function setup(config: Config = { riskThreshold: 'high' }): Promise<{
  ctx: Context
  agent: Agent
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-runtime-'))
  temporaryDirectories.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SkillRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(EngineeringReviewRuntime, config)
  const agent = ctx.agentLoop.create(
    SessionId(`engineering-runtime-${String(contexts.length)}`),
    { provider: 'unused', model: 'unused' },
    { cwd },
  )
  return { ctx, agent, cwd }
}

function request(agent: Agent, cwd: string, fingerprint: string): EngineeringReviewRequest {
  return {
    agent,
    signal: new AbortController().signal,
    cwd,
    fingerprint,
    changedPaths: ['notes.txt'],
    diff: '+candidate change',
    diffTruncated: false,
    depth: 'fast',
    readText: () => Promise.resolve(undefined),
    hasFile: () => Promise.resolve(false),
  }
}

describe('engineering review runtime', () => {
  it('shares one in-flight review for a fingerprint and retries after rejection', async () => {
    const { ctx, agent, cwd } = await setup()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const disposer = ctx.engineeringReview.registerAdapter({
      id: 'cache-probe',
      async contribute() {
        calls += 1
        await blocked
        return {}
      },
    })
    const first = ctx.engineeringReview.review(request(agent, cwd, 'shared'))
    const second = ctx.engineeringReview.review(request(agent, cwd, 'shared'))
    expect(second).toBe(first)
    release?.()
    await expect(first).resolves.toMatchObject({ fingerprint: 'shared', passed: true })
    expect(calls).toBe(1)
    const otherAgent = ctx.agentLoop.create(
      SessionId('engineering-runtime-other-agent'),
      { provider: 'unused', model: 'unused' },
      { cwd },
    )
    await ctx.engineeringReview.review(request(otherAgent, cwd, 'shared'))
    expect(calls).toBe(2)
    disposer()
    await Promise.resolve()

    // One throwing adapter is isolated: the gate completes with an explicit
    // degraded reason instead of rejecting the whole review, and its guidance
    // is skipped without poisoning the fingerprint cache.
    let attempts = 0
    ctx.engineeringReview.registerAdapter({
      id: 'retry-probe',
      contribute() {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('transient adapter failure')) : Promise.resolve({})
      },
    })
    const isolated = await ctx.engineeringReview.review(request(agent, cwd, 'retry'))
    expect(isolated).toMatchObject({ passed: true, degradedReasons: ['adapter retry-probe failed: transient adapter failure'] })
    expect(attempts).toBe(1)
    await expect(ctx.engineeringReview.review(request(agent, cwd, 'retry'))).resolves.toMatchObject({ passed: true })
    expect(attempts).toBe(1)
  })

  it('evicts a rejected review from the fingerprint cache and retries', async () => {
    const { ctx, agent, cwd } = await setup()
    let failing = true
    ctx.engineeringReview.registerAdapter({
      id: 'cache-evict-probe',
      contribute: () => Promise.resolve({
        checks: failing
          ? [{ id: 'duplicate:check', argv: ['true'] }, { id: 'duplicate:check', argv: ['true'] }]
          : [],
      }),
    })
    await expect(ctx.engineeringReview.review(request(agent, cwd, 'retry'))).rejects.toThrow('duplicate assembled check id')
    failing = false
    await expect(ctx.engineeringReview.review(request(agent, cwd, 'retry'))).resolves.toMatchObject({ passed: true })
  })

  it('does not start a process for an already-aborted caller', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(runArgv(ctx, [process.execPath, '-e', '0'], {
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    })).rejects.toThrow()
  })

  it('removes an adapter through its registration disposer', async () => {
    const { ctx, agent, cwd } = await setup()
    let calls = 0
    const adapter: EngineeringReviewAdapter = {
      id: 'disposable',
      contribute: () => {
        calls += 1
        return Promise.resolve({ riskSignals: [{ risk: 'high', reason: 'test signal' }] })
      },
    }
    const dispose = ctx.engineeringReview.registerAdapter(adapter)
    expect(() => ctx.engineeringReview.registerAdapter(adapter)).toThrow(/duplicate adapter/u)
    await ctx.engineeringReview.review(request(agent, cwd, 'before-dispose'))
    expect(calls).toBe(1)
    dispose()
    await Promise.resolve()
    await ctx.engineeringReview.review(request(agent, cwd, 'after-dispose'))
    expect(calls).toBe(1)
  })

  it('bounds check summaries and reports a timed-out optional check without blocking', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'process-limits',
      contribute: () => Promise.resolve({
        checks: [
          {
            id: 'large-output',
            argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(300000))'],
          },
          {
            id: 'deadline',
            argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
            timeoutMs: 100,
          },
        ],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'process-limits'))
    const largeOutput = report.checks.find(check => check.id === 'large-output')
    const deadline = report.checks.find(check => check.id === 'deadline')
    expect(largeOutput).toMatchObject({ status: 'passed', required: false })
    expect(Buffer.byteLength(largeOutput?.summary ?? '')).toBeLessThanOrEqual(2_100)
    expect(deadline).toMatchObject({ status: 'failed', required: false })
    expect(deadline?.summary).toMatch(/Timed out after 100ms/u)
    expect(report.passed).toBe(true)
    expect(report.degradedReasons).toHaveLength(1)
  })

  it('skips non-matching checks and reports a missing check cwd as unavailable', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'check-edges',
      contribute: () => Promise.resolve({
        checks: [
          { id: 'skip:match', argv: [process.execPath, '-e', '0'], files: ['**/*.c'] },
          { id: 'bad:cwd', argv: [process.execPath, '-e', '0'], cwd: 'missing-dir' },
        ],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'check-edges'))
    expect(report.checks.find(check => check.id === 'skip:match')).toMatchObject({ status: 'skipped', summary: 'No changed path matched this check.' })
    expect(report.checks.find(check => check.id === 'bad:cwd')).toMatchObject({ status: 'unavailable' })
    expect(report.passed).toBe(true)
  })

  it('surfaces adapter degraded reasons and routes workspace readers', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'degraded-probe',
      contribute: async (request) => {
        await request.hasFile('probe.txt')
        await request.readText('probe.txt')
        return { degradedReasons: ['probe adapter unavailable'] }
      },
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'degraded'))
    expect(report.degradedReasons).toEqual(['probe adapter unavailable'])
    expect(report.passed).toBe(true)
  })

  it('rejects a review whose request is already aborted', async () => {
    const { ctx, agent, cwd } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.engineeringReview.review({ ...request(agent, cwd, 'aborted'), signal: controller.signal }))
      .rejects.toThrow()
  })

  it('rethrows an aborted reviewer failure instead of degrading', async () => {
    const { ctx, agent, cwd } = await setup()
    const controller = new AbortController()
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() {
        controller.abort()
        return Promise.reject(new Error('aborted reviewer start'))
      },
    })
    await expect(ctx.engineeringReview.review({
      ...request(agent, cwd, 'aborted-reviewer'),
      changedPaths: ['driver.c'],
      depth: 'deep',
      signal: controller.signal,
    })).rejects.toThrow('aborted reviewer start')
  })

  it('rejects a direct engineering_review call without an owning agent', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      name: 'engineering_review',
      arguments: {},
      callId: CallId('er-no-agent'),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('engineering_review requires an agent-owned call')
  })

  it('rejects adapter ids that are empty or untrimmed', async () => {
    const { ctx } = await setup()
    expect(() => ctx.engineeringReview.registerAdapter({
      id: '', contribute: () => Promise.resolve(undefined),
    })).toThrow(/non-empty and trimmed/u)
    expect(() => ctx.engineeringReview.registerAdapter({
      id: ' padded ', contribute: () => Promise.resolve(undefined),
    })).toThrow(/non-empty and trimmed/u)
  })

  it('rethrows an adapter failure when the caller aborts mid-contribution', async () => {
    const { ctx, agent, cwd } = await setup()
    const controller = new AbortController()
    ctx.engineeringReview.registerAdapter({
      id: 'abort-adapter',
      contribute() {
        controller.abort()
        return Promise.reject(new Error('adapter aborted mid-contribution'))
      },
    })
    await expect(ctx.engineeringReview.review({
      ...request(agent, cwd, 'adapter-abort'),
      signal: controller.signal,
    })).rejects.toThrow('adapter aborted mid-contribution')
  })

  it('presents the engineering_review call with and without a focus', async () => {
    const { ctx, agent } = await setup()
    const definition = ctx.tools.get('engineering_review', agent)
    expect(definition?.presentCall?.({ focus: 'concurrency' })).toMatchObject({
      card: 'generic',
      title: 'Engineering review',
      content: [{ type: 'text', text: 'concurrency' }],
    })
    expect(definition?.presentCall?.({})).toMatchObject({ content: [] })
  })

  it('ignores tool results for an agent without a tracked turn', async () => {
    const { ctx, cwd } = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {},
      async execute() { return [{ type: 'text', text: 'probed' }] },
    }))
    const untouched = ctx.agentLoop.create(
      SessionId('engineering-review-untouched'),
      { provider: 'unused', model: 'unused' },
      { cwd },
    )
    const result = await ctx.tools.execute({
      name: 'probe',
      arguments: {},
      callId: CallId('er-probe'),
      agent: untouched,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
  })

  it('records the effective reviewer route when explicitly overridden', async () => {
    const { ctx, agent, cwd } = await setup({ riskThreshold: 'low', reviewerProvider: 'other', reviewerModel: 'strict' })
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() {
        return Promise.resolve({
          id: SessionId('engineering-review-route-child'),
          localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured: { findings: [] } }),
          dispose: () => Promise.resolve(),
        })
      },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'reviewer-route'),
      changedPaths: ['driver.c'],
    })
    expect(report.reviewer).toMatchObject({ used: true, provider: 'other', model: 'strict' })
  })

  it('degrades an adapter that throws a non-Error value', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'string-throw',
      contribute() { throw 'adapter exploded' },
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'string-throw'))
    expect(report.degradedReasons).toEqual(['adapter string-throw failed: adapter exploded'])
    expect(report.passed).toBe(true)
  })

  it('captures stderr in a failed check summary', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'stderr-check',
      contribute: () => Promise.resolve({
        checks: [{ id: 'stderr:emit', argv: [process.execPath, '-e', 'process.stderr.write("diagnostic")'] }],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'stderr-check'))
    const check = report.checks.find(candidate => candidate.id === 'stderr:emit')
    expect(check?.summary).toBe('diagnostic')
  })

  it('tracks str_replace_editor file_path mutations even without a string path', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'str_replace_editor', description: 'editor', parameters: {},
      async execute() { return [{ type: 'text', text: 'edited' }] },
    }))
    await ctx.tools.execute({
      name: 'str_replace_editor',
      arguments: { file_path: 42 },
      callId: CallId('er-editor'),
      agent,
      signal: new AbortController().signal,
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'editor-tracked'),
      changedPaths: ['driver.c'],
    })
    expect(report.passed).toBe(true)
  })

  it('skips adapters that decline to contribute', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'declining',
      contribute: () => Promise.resolve(undefined),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'declining'))
    expect(report.degradedReasons).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('blocks on a required check that becomes unavailable', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'required-unavailable',
      contribute: () => Promise.resolve({
        checks: [{ id: 'required:unavailable', argv: [process.execPath, '-e', '0'], cwd: 'missing-dir', required: true }],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'required-unavailable'))
    expect(report.checks[0]).toMatchObject({ status: 'unavailable', required: true })
    expect(report.passed).toBe(false)
  })

  it('uses the configured default timeout in a timed-out summary', async () => {
    const { ctx, agent, cwd } = await setup({ riskThreshold: 'high', checkTimeoutMs: 50 })
    ctx.engineeringReview.registerAdapter({
      id: 'default-deadline',
      contribute: () => Promise.resolve({
        checks: [{ id: 'hang:default', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] }],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'default-deadline'))
    expect(report.checks[0]?.summary).toMatch(/Timed out after 50ms/u)
  })

  it('resolves the sandbox policy with the owning session', async () => {
    const { ctx } = await setup()
    const session = ctx.agentLoop.create(
      SessionId('engineering-review-sandbox-session'),
      { provider: 'unused', model: 'unused' },
      { cwd: process.cwd() },
    )
    let resolvedWithSession = false
    ctx.provide('sandboxPolicy', {
      resolve(args: unknown) {
        resolvedWithSession = (args as { session?: unknown } | undefined)?.session === session.session
        return { mode: 'danger-full-access' }
      },
    } as never)
    const result = await runArgv(ctx, [process.execPath, '-e', '0'], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      sandbox: true,
      agent: session,
    })
    expect(result.exitCode).toBe(0)
    expect(resolvedWithSession).toBe(true)
  })

  it('serves a manual review for an agent without any tracked turn state', async () => {
    const { ctx, cwd } = await setup()
    const fresh = ctx.agentLoop.create(
      SessionId('engineering-review-fresh'),
      { provider: 'unused', model: 'unused' },
      { cwd },
    )
    const result = await ctx.tools.execute({
      name: 'engineering_review',
      arguments: {},
      callId: CallId('er-fresh-agent'),
      agent: fresh,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('"passed": true')
  })

  it('omits the reviewer route when the agent declares no provider', async () => {
    const { ctx, cwd } = await setup({ riskThreshold: 'low' })
    const agent = ctx.agentLoop.create(SessionId('engineering-review-no-route'), {}, { cwd })
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() {
        return Promise.resolve({
          id: SessionId('engineering-review-no-route-child'),
          localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured: { findings: [] } }),
          dispose: () => Promise.resolve(),
        })
      },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'reviewer-no-route'),
      changedPaths: ['driver.c'],
    })
    expect(report.reviewer).toEqual({ used: true })
  })

  it('runs a check whose working directory exists', async () => {
    const { ctx, agent, cwd } = await setup()
    ctx.engineeringReview.registerAdapter({
      id: 'existing-cwd',
      contribute: () => Promise.resolve({
        checks: [{ id: 'existing:cwd', argv: [process.execPath, '-e', '0'], cwd: '.' }],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'existing-cwd'))
    expect(report.checks[0]).toMatchObject({ status: 'passed' })
  })

  it('reports a check whose working directory resolves to a file', async () => {
    const { ctx, agent, cwd } = await setup()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(cwd, 'plain.txt'), 'content', 'utf8')
    ctx.engineeringReview.registerAdapter({
      id: 'file-cwd',
      contribute: () => Promise.resolve({
        checks: [{ id: 'file:cwd', argv: [process.execPath, '-e', '0'], cwd: 'plain.txt' }],
      }),
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'file-cwd'))
    expect(report.checks[0]).toMatchObject({ status: 'unavailable' })
  })
  it('keeps low-risk changes on the checks-only route', async () => {
    const { ctx, agent, cwd } = await setup()
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() { starts += 1; throw new Error('reviewer must not start for low risk') },
    })
    const report = await ctx.engineeringReview.review(request(agent, cwd, 'low-risk'))
    expect(report).toMatchObject({ route: 'checks-only', risk: 'low', passed: true, reviewer: { used: false } })
    expect(starts).toBe(0)
  })

  it('keeps ordinary multi-line automatic code edits on checks-only', async () => {
    const { ctx, agent, cwd } = await setup()
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() { starts += 1; throw new Error('ordinary code edit must not start a reviewer') },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'ordinary-multi-line-edit'),
      automatic: true,
      changedPaths: ['driver.c'],
      diff: 'diff --git a/driver.c b/driver.c\n+++ b/driver.c\n@@ -1,2 +1,4 @@\n+int first = 1;\n+int second = 2;',
    })
    expect(report).toMatchObject({ route: 'checks-only', risk: 'medium', reviewer: { used: false } })
    expect(starts).toBe(0)
  })

  it('dispatches fast review when a changed code line carries risk evidence', async () => {
    const { ctx, agent, cwd } = await setup({ riskThreshold: 'medium' })
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() {
        starts += 1
        return Promise.resolve({
          id: SessionId('engineering-review-risk-child'),
          localAgent: undefined,
          result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured: { findings: [] } }),
          dispose: () => Promise.resolve(),
        })
      },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'risk-evidence'),
      automatic: true,
      changedPaths: ['driver.c'],
      diff: 'diff --git a/driver.c b/driver.c\n+++ b/driver.c\n@@ -1 +1 @@\n+timeout();',
    })
    expect(report).toMatchObject({ route: 'fast', risk: 'medium', reviewer: { used: true } })
    expect(starts).toBe(1)
  })

  it('times out and disposes a reviewer that never settles', async () => {
    const { ctx, agent, cwd } = await setup({ reviewerTimeoutMs: 20 })
    let disposed = false
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start(request) {
        const result = new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => { reject(new Error('reviewer aborted')) }, { once: true })
        })
        return Promise.resolve({
          id: SessionId('engineering-review-timeout-child'),
          localAgent: undefined,
          result,
          dispose: () => { disposed = true; return Promise.resolve() },
        })
      },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'reviewer-timeout'),
      depth: 'deep',
      changedPaths: ['driver.c'],
    })
    expect(report).toMatchObject({ route: 'deep', reviewer: { used: false, degradedReason: 'engineering reviewer timed out after 20ms' } })
    expect(report.degradedReasons).toContain('independent reviewer unavailable: engineering reviewer timed out after 20ms')
    expect(disposed).toBe(true)
  })
  it('does not dispatch a reviewer after a required check fails', async () => {
    const { ctx, agent, cwd } = await setup({ riskThreshold: 'low' })
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() { starts += 1; throw new Error('required check failure must short-circuit review') },
    })
    ctx.engineeringReview.registerAdapter({
      id: 'required-failure-route',
      contribute: () => Promise.resolve({
        checks: [{ id: 'required:failure', argv: [process.execPath, '-e', 'process.exit(7)'], required: true }],
      }),
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'required-failure-route'),
      changedPaths: ['driver.c'],
      depth: 'deep',
    })
    expect(report.route).toBe('checks-only')
    expect(report.passed).toBe(false)
    expect(starts).toBe(0)
  })
  it('keeps a tiny automatic code edit on checks-only', async () => {
    const { ctx, agent, cwd } = await setup({ riskThreshold: 'low' })
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start() { starts += 1; throw new Error('tiny automatic edit must not start a reviewer') },
    })
    const report = await ctx.engineeringReview.review({
      ...request(agent, cwd, 'tiny-automatic-edit'),
      automatic: true,
      changedPaths: ['driver.c'],
      diff: 'diff --git a/driver.c b/driver.c\n+++ b/driver.c\n@@ -1 +1 @@\n+int driver(void) { return 0; }',
    })
    expect(report).toMatchObject({ route: 'checks-only', risk: 'medium', passed: true, reviewer: { used: false } })
    expect(starts).toBe(0)
  })
})

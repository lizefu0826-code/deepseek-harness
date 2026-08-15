import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRuntime from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import EngineeringReviewRuntime, { type Config } from '../src/index.ts'
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

    let attempts = 0
    ctx.engineeringReview.registerAdapter({
      id: 'retry-probe',
      contribute() {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('transient adapter failure')) : Promise.resolve({})
      },
    })
    await expect(ctx.engineeringReview.review(request(agent, cwd, 'retry'))).rejects.toThrow('transient adapter failure')
    await expect(ctx.engineeringReview.review(request(agent, cwd, 'retry'))).resolves.toMatchObject({ passed: true })
    expect(attempts).toBe(2)
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
})

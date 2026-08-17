import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SkillRuntime from '@deepseek-ai/dsh-skill'
import SubagentRuntime, { type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import EngineeringReviewRuntime from '../src/index.ts'
import type { EngineeringReviewAdapter } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const runFile = promisify(execFile)

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

class StructuredReviewer implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false
  starts = 0
  disposes = 0
  lastRequest: ResolvedSubagentStartRequest | undefined
  constructor(
    private readonly findings: readonly Record<string, unknown>[] = [{
      category: 'blocking-and-concurrency', severity: 'high', confidence: 'high', title: 'Unbounded device wait',
      evidence: [{ path: 'driver.c', line: 10, detail: 'The device wait has no timeout.' }],
      impact: 'A failed device can stall progress forever.',
      recommendation: 'Add a bounded deadline and propagate timeout failure.',
      validation: 'Run with a device that never becomes ready.',
    }],
    private readonly stopReason: 'completed' | 'error' = 'completed',
    private readonly firstStopsMaxTokens = false,
    private readonly localAgent?: Agent,
  ) {}
  start(request: ResolvedSubagentStartRequest) {
    this.starts += 1
    this.lastRequest = request
    const truncated = this.firstStopsMaxTokens && this.starts === 1
    const stopReason: SubagentStopReason = truncated ? 'max-tokens' : this.stopReason
    return Promise.resolve({
      id: SessionId('engineering-review-child'),
      localAgent: this.localAgent,
      result: Promise.resolve({
        stopReason,
        output: [],
        ...stopReason === 'completed' ? { structured: { findings: this.findings } } : {},
      }),
      dispose: () => {
        this.disposes += 1
        return Promise.resolve()
      },
    })
  }
}

describe('automatic engineering review gate', () => {
  it('drops a candidate without high confidence or blocker severity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-warning-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([{
      category: 'observability-and-verification', severity: 'high', confidence: 'medium', title: 'Sparse timeout context',
      evidence: [{ path: 'driver.c', line: 12, detail: 'The timeout path omits the device identifier.' }],
      impact: 'Field diagnosis may take longer.',
      recommendation: 'Include the stable device identifier in the timeout diagnostic.',
      validation: 'Trigger a timeout and inspect the diagnostic.',
    }])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'read', description: 'test read', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'contents' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('write-warning'), 'write', { path: 'driver.mjs' }),
      textResponse('completion with warning'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-warning'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, findings: [] })
    expect(notices).toHaveLength(0)
    // The fake write leaves no readable change, so the empty-diff review gets
    // no tools and must answer from the prompt alone.
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    expect(reviewer.disposes).toBe(1)
    expect(llm.requests).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('treats a successful shell call with unknown write scope as high risk', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-shell-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'pwsh', description: 'test shell', parameters: { command: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'shell complete' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('pwsh-unknown'), 'pwsh', { command: 'opaque command' }),
      textResponse('shell completion'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-shell'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the project helper' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'high' })
    expect(reviewer.starts).toBe(1)
    expect(reviewer.disposes).toBe(1)
    await ctx.fiber.dispose()
  })

  it('reviews one fingerprint once, steers two corrections, then requests one final report', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    const reviewPlugin = ctx.plugin(EngineeringReviewRuntime, { maxCorrectionPasses: 2 })
    await reviewPlugin
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const adapter = new MockAdapter([
      toolCallResponse(CallId('write-1'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('correction one'),
      textResponse('correction two'),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('engineering-gate'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const directTask = `change the driver\n${'界'.repeat(6_000)}\nuser-tail-must-be-truncated`
    agent.followup(createUserMessage({ content: [{ type: 'text', text: directTask }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(reviewer.starts).toBe(1)
    expect(reviewer.disposes).toBe(1)
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    expect(reviewer.lastRequest?.agentOptions?.maxTokens).toBe(8_192)
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('User task requirements:\\nchange the driver')
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('your final message must be exactly the requested JSON object')
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('[task context truncated]')
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).not.toContain('user-tail-must-be-truncated')
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).not.toContain('initial completion')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.passed).toBe(false)
    expect(notices).toEqual(['Correction pass 1/2', 'Correction pass 2/2', 'Final blocker report required'])
    const finalReportRequest = agent.session.events.find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.form === 'notice'
      && event.data.source.summary === 'Final blocker report required')
    const finalReportContent = finalReportRequest?.data.content[0]
    expect(finalReportContent?.type).toBe('text')
    if (finalReportContent?.type !== 'text') throw new Error('final blocker report request must contain text')
    expect(finalReportContent.text).toContain('Stop modifying files.')
    expect(adapter.requests).toHaveLength(5)
    await reviewPlugin.dispose()
    expect(ctx.tools.get('engineering_review', agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forwards an explicit isolated reviewer output cap', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-budget-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { reviewerMaxTokens: 2_048 })
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'read', description: 'test read', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'contents' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('write-budget'), 'write', { path: 'driver.c' }),
      textResponse('completion'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-budget'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reviewer.lastRequest?.agentOptions).toMatchObject({
      provider: 'mock',
      model: 'mock',
      maxTokens: 2_048,
    })
    // The automatic review of the fake write has no readable change, so it
    // gets no tools; the manual reviews below pin the fast/deep tool split.
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    await ctx.engineeringReview.review({
      agent,
      signal: new AbortController().signal,
      cwd: workspace,
      fingerprint: 'manual-fast-tools',
      changedPaths: ['driver.c'],
      diff: '+ return 0;',
      diffTruncated: false,
      depth: 'fast',
      readText: () => Promise.resolve(undefined),
      hasFile: () => Promise.resolve(false),
    })
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    await ctx.engineeringReview.review({
      agent,
      signal: new AbortController().signal,
      cwd: workspace,
      fingerprint: 'manual-deep-tools',
      changedPaths: ['driver.c'],
      diff: '+ return 0;',
      diffTruncated: false,
      depth: 'deep',
      readText: () => Promise.resolve(undefined),
      hasFile: () => Promise.resolve(false),
    })
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: ['read'] })
    await ctx.fiber.dispose()
  })

  it('degrades an unavailable optional analyzer to one explicit self-review', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-optional-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    const adapter: EngineeringReviewAdapter = {
      id: 'optional-analyzer',
      contribute: () => Promise.resolve({
        checks: [{ id: 'optional:missing', argv: ['definitely-missing-engineering-review-analyzer'], required: false }],
      }),
    }
    ctx.engineeringReview.registerAdapter(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('write-optional'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('self review complete'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-optional'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(reviewer.starts).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true })
    expect(results[0]?.data.degradedReasons?.[0]).toMatch(/optional check optional:missing unavailable/u)
    expect(notices).toHaveLength(1)
    expect(llm.requests).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('blocks a required deterministic check and stops steering after the correction budget', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-required-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { riskThreshold: 'high', maxCorrectionPasses: 1 })
    ctx.engineeringReview.registerAdapter({
      id: 'required-check',
      contribute: () => Promise.resolve({
        checks: [{ id: 'required:fail', argv: [process.execPath, '-e', 'process.exit(7)'], required: true }],
      }),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('write-required'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('correction attempted'),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-required'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: false, checks: [{ id: 'required:fail', status: 'failed', required: true }] })
    expect(notices).toEqual(['Correction pass 1/1', 'Final blocker report required'])
    expect(llm.requests).toHaveLength(4)
    await ctx.fiber.dispose()
  })

  it('enforces the final-report freeze by rejecting further file mutations', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-freeze-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxCorrectionPasses: 1 })
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    let writes = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { writes += 1; return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('freeze-write-1'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('correction attempted'),
      toolCallResponse(CallId('freeze-write-2'), 'write', { path: 'driver.c' }),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-freeze'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(notices).toEqual(['Correction pass 1/1', 'Final blocker report required'])
    // The first write dispatched; the post-final-report write was rejected
    // before the tool body ran.
    expect(writes).toBe(1)
    const blocked = agent.session.events
      .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
      .find(event => JSON.stringify(event.data.message.content).includes('file modification is disabled after the final blocker report'))
    expect(blocked).toBeDefined()
    const blockedContent = blocked?.data.message.content as readonly { isError?: boolean }[]
    expect(blockedContent[0]?.isError).toBe(true)
    expect(llm.requests).toHaveLength(5)
    await ctx.fiber.dispose()
  })

  it('supports report-only gating with no correction pass', async () => {    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-report-only-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { riskThreshold: 'high', maxCorrectionPasses: 0 })
    ctx.engineeringReview.registerAdapter({
      id: 'report-only-required-check',
      contribute: () => Promise.resolve({
        checks: [{ id: 'required:fail', argv: [process.execPath, '-e', 'process.exit(7)'], required: true }],
      }),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'pwsh', description: 'test shell', parameters: { command: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'inspected' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('write-report-only'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      toolCallResponse(CallId('inspect-report-only'), 'pwsh', { command: 'inspect' }),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-report-only'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(notices).toEqual(['Final blocker report required'])
    expect(agent.session.events.filter(event => event.type === 'engineering-review/result')).toHaveLength(1)
    expect(llm.requests).toHaveLength(4)
    await ctx.fiber.dispose()
  })

  it('gives the reviewer a real diff on non-Git changes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-diff-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await writeFile(join(workspace, args.path), 'int changed(void) { return 1; }\n')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('diff-write'), 'write', { path: 'driver.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-diff'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reviewer.starts).toBe(1)
    // A real diff means the fast review needs no read tools...
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    // ...and the reviewer prompt carries the change content.
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('+int changed(void) { return 1; }')
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('b/driver.c')
    await ctx.fiber.dispose()
  })

  it('diffs the full turn change from first-mutation content', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-diff-full-'))
    temporaryDirectories.push(workspace)
    await writeFile(join(workspace, 'driver.c'), 'int base(void) { return 0; }\n', 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await writeFile(join(workspace, args.path), 'int v1(void) { return 1; }\n')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'edit', description: 'test edit', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await writeFile(join(workspace, args.path), 'int v2(void) { return 2; }\n')
        return [{ type: 'text', text: 'edited' }]
      },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('diff-full-write'), 'write', { path: 'driver.c' }),
      toolCallResponse(CallId('diff-full-edit'), 'edit', { path: 'driver.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-diff-full'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const prompt = JSON.stringify(reviewer.lastRequest?.prompt)
    // The baseline is the pre-mutation content, so the diff spans base -> v2
    // and never shows the intermediate v1.
    expect(prompt).toContain('-int base(void) { return 0; }')
    expect(prompt).toContain('+int v2(void) { return 2; }')
    expect(prompt).not.toContain('v1(void)')
    await ctx.fiber.dispose()
  })

  it('diffs a deletion to nothing in non-Git reviews', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-diff-del-'))
    temporaryDirectories.push(workspace)
    await writeFile(join(workspace, 'driver.c'), 'int base(void) { return 0; }\n', 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    const { unlink } = await import('node:fs/promises')
    ctx.tools.register(defineContentToolFixture({
      name: 'edit', description: 'test edit', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await unlink(join(workspace, args.path))
        return [{ type: 'text', text: 'deleted' }]
      },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('diff-del-edit'), 'edit', { path: 'driver.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-diff-del'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'remove the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const prompt = JSON.stringify(reviewer.lastRequest?.prompt)
    expect(prompt).toContain('-int base(void) { return 0; }')
    expect(prompt).not.toContain('+int base(void) { return 0; }')
    await ctx.fiber.dispose()
  })

  it('degrades the snapshot silently for an unresolvable touched path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-diff-bad-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: {},
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('diff-bad-write'), 'write', { path: 'bad\0path' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-diff-bad'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The snapshot read fails silently; the review still completes without a diff.
    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(reviewer.starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('truncates an oversized non-Git snapshot diff', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-diff-trunc-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxDiffBytes: 16 })
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await writeFile(join(workspace, args.path), 'a rather long line of content that far exceeds the tiny diff budget\n')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('diff-trunc-write'), 'write', { path: 'driver.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-diff-trunc'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reviewer.starts).toBe(1)
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('(truncated; inspect files as needed)')
    await ctx.fiber.dispose()
  })

  it('skips the gate entirely for a turn without changes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-nochange-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([textResponse('nothing to change')])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-nochange'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'just answer' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(agent.session.events.filter(event => event.type === 'engineering-review/result')).toHaveLength(0)
    expect(reviewer.starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('runs the gate against a real Git workspace and serves manual reviews', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-git-'))
    temporaryDirectories.push(workspace)
    await runFile('git', ['init'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.name', 'Test'], { cwd: workspace, windowsHide: true })
    await writeFile(join(workspace, 'driver.c'), 'int main(void) { return 0; }\n')
    await runFile('git', ['add', '.'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['commit', '-m', 'base'], { cwd: workspace, windowsHide: true })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxCorrectionPasses: 1 })
    // The finding must cite the actual changed line of the small driver.c patch.
    const reviewer = new StructuredReviewer([{
      category: 'blocking-and-concurrency', severity: 'high', confidence: 'high', title: 'Unbounded device wait',
      evidence: [{ path: 'driver.c', line: 1, detail: 'The device wait has no timeout.' }],
      impact: 'A failed device can stall progress forever.',
      recommendation: 'Add a bounded deadline and propagate timeout failure.',
      validation: 'Run with a device that never becomes ready.',
    }])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        await writeFile(join(workspace, args.path), 'changed\n')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    ctx.engineeringReview.registerAdapter({
      id: 'reader-probe',
      contribute: async (request) => {
        await request.hasFile('driver.c')
        await request.readText('driver.c')
        return {}
      },
    })
    const llm = new MockAdapter([
      toolCallResponse(CallId('git-write'), 'write', { path: 'driver.c' }),
      toolCallResponse(CallId('git-manual'), 'engineering_review', {}),
      textResponse('reviewed'),
      textResponse('corrected'),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-git-gate'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(reviewer.starts).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: false, risk: 'medium' })
    expect(notices).toEqual(['Correction pass 1/1', 'Final blocker report required'])
    await ctx.fiber.dispose()
  })

  it('degrades an erroring independent reviewer to one explicit self-review', async () => {    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-degraded-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([], 'error')
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('degraded-write'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('self review complete'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-degraded'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(reviewer.starts).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true })
    const degraded = (results[0]?.data as { degradedReasons?: readonly string[] }).degradedReasons?.[0]
    expect(degraded).toMatch(/reviewer stopped with "error" without structured findings/u)
    expect(notices).toEqual(['Engineering review degraded to self-review'])
    await ctx.fiber.dispose()
  })

  it('retries a max-tokens reviewer once with a concise-answer directive', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-retry-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    // The first reviewer attempt exhausts its budget; the retry completes
    // with the default blocker finding.
    const reviewer = new StructuredReviewer(undefined, 'completed', true)
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('retry-write'), 'write', { path: 'driver.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-retry'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(reviewer.starts).toBe(2)
    expect(reviewer.disposes).toBe(2)
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: false, findings: [{ severity: 'blocker' }] })
    expect((results[0]?.data as { degradedReasons?: readonly string[] }).degradedReasons ?? []).toHaveLength(0)
    // The retry ran with the concise-answer directive and no tools.
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('cut off by the output limit')
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: [] })
    await ctx.fiber.dispose()
  })

  it('steers an explicit self-review when an adapter reports degraded capabilities', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-adapter-degraded-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.engineeringReview.registerAdapter({
      id: 'degrading-adapter',
      contribute: () => Promise.resolve({ degradedReasons: ['probe adapter unavailable'] }),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('adapter-degraded-write'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('self review complete'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-adapter-degraded'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    expect(results).toHaveLength(1)
    expect((results[0]?.data as { degradedReasons?: readonly string[] }).degradedReasons).toContain('probe adapter unavailable')
    expect(notices).toEqual(['Engineering review degraded to self-review'])
    await ctx.fiber.dispose()
  })

  it('serves manual non-Git reviews and empty reports', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-manual-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxCorrectionPasses: 1 })
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('manual-write'), 'write', { path: 'driver.c' }),
      toolCallResponse(CallId('manual-review'), 'engineering_review', { focus: 'concurrency' }),
      textResponse('reviewed'),
      textResponse('corrected'),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-manual'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'review and change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    const notices = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .map(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' ? event.data.source.summary : undefined)
    // The manual review and the automatic stopping-boundary review derive
    // different fingerprints, so both run the isolated reviewer.
    expect(reviewer.starts).toBe(2)
    expect(results).toHaveLength(2)
    expect(results[0]?.data).toMatchObject({ passed: false, risk: 'medium' })
    expect(results[1]?.data).toMatchObject({ passed: false, risk: 'medium' })
    expect(notices).toEqual(['Correction pass 1/1', 'Final blocker report required'])
    await ctx.fiber.dispose()
  })

  it('returns an empty manual report when nothing changed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-manual-empty-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    const llm = new MockAdapter([
      toolCallResponse(CallId('manual-empty'), 'engineering_review', {}),
      textResponse('no changes yet'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-manual-empty'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'review the workspace' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'low', findings: [] })
    expect(reviewer.starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('omits the task context when the latest user message has no text block', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-notext-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('notext-write'), 'write', { path: 'driver.c' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-notext'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({
      content: [{ type: 'reasoning', text: 'no visible task text' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(reviewer.starts).toBe(1)
    expect(JSON.stringify(reviewer.lastRequest?.prompt)).toContain('User task requirements:\\n(not available)')
    await ctx.fiber.dispose()
  })

  it('reviews pre-existing Git overflow with an unknown shell mutation scope', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-overflow-'))
    temporaryDirectories.push(workspace)
    await runFile('git', ['init'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.name', 'Test'], { cwd: workspace, windowsHide: true })
    for (const name of ['a.c', 'b.c', 'c.c']) await writeFile(join(workspace, name), 'int main(void) { return 0; }\n')
    await runFile('git', ['add', '.'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['commit', '-m', 'base'], { cwd: workspace, windowsHide: true })
    // Three dirty files against a maxFiles of two forces the overflow path.
    for (const name of ['a.c', 'b.c', 'c.c']) await writeFile(join(workspace, name), 'changed\n')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxFiles: 2 })
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'pwsh', description: 'test shell', parameters: { command: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'shell complete' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('overflow-shell'), 'pwsh', { command: 'opaque command' }),
      toolCallResponse(CallId('overflow-manual'), 'engineering_review', {}),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-overflow'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the repo' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'high' })
    expect(reviewer.starts).toBe(1)
    await ctx.fiber.dispose()
  })

  it('steers a correction naming an unavailable required check', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-unavailable-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxCorrectionPasses: 1 })
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.engineeringReview.registerAdapter({
      id: 'required-unavailable-adapter',
      contribute: () => Promise.resolve({
        checks: [{ id: 'required:unavailable', argv: [process.execPath, '-e', '0'], cwd: 'missing-dir', required: true }],
      }),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('unavailable-write'), 'write', { path: 'driver.c' }),
      textResponse('initial completion'),
      textResponse('corrected'),
      textResponse('final blocker report'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-unavailable'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const notice = agent.session.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
      .find(event => event.data.source.kind === 'plugin' && event.data.source.form === 'notice' && event.data.source.summary === 'Correction pass 1/1')
    expect(notice).toBeDefined()
    const text = notice?.data.content[0]
    expect(text?.type === 'text' && text.text).toContain('check required:unavailable:')
    expect(text?.type === 'text' && text.text).toContain('does not exist')
    await ctx.fiber.dispose()
  })

  it('reviews pre-existing Git overflow without an unknown shell mutation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-overflow-write-'))
    temporaryDirectories.push(workspace)
    await runFile('git', ['init'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.name', 'Test'], { cwd: workspace, windowsHide: true })
    for (const name of ['a.c', 'b.c', 'c.c']) await writeFile(join(workspace, name), 'int main(void) { return 0; }\n')
    await runFile('git', ['add', '.'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['commit', '-m', 'base'], { cwd: workspace, windowsHide: true })
    for (const name of ['a.c', 'b.c', 'c.c']) await writeFile(join(workspace, name), 'changed\n')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime, { maxFiles: 2 })
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('overflow-write'), 'write', { path: 'a.c' }),
      textResponse('reviewed'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-overflow-write'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change a.c' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'high' })
    await ctx.fiber.dispose()
  })

  it('skips clean Git turns and serves empty manual reviews', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-clean-git-'))
    temporaryDirectories.push(workspace)
    await runFile('git', ['init'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['config', 'user.name', 'Test'], { cwd: workspace, windowsHide: true })
    await writeFile(join(workspace, 'driver.c'), 'int main(void) { return 0; }\n')
    await runFile('git', ['add', '.'], { cwd: workspace, windowsHide: true })
    await runFile('git', ['commit', '-m', 'base'], { cwd: workspace, windowsHide: true })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer()
    ctx.subagents.registerProvider(reviewer)
    const llm = new MockAdapter([
      toolCallResponse(CallId('clean-manual'), 'engineering_review', {}),
      textResponse('clean tree'),
      textResponse('nothing to do'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-clean-git'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'check the repo' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    // The manual empty report is the only durable result; the automatic stop
    // sees no changes and skips review entirely.
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'low', findings: [] })
    expect(reviewer.starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('tracks str_replace_editor file_path mutations inside a turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-editor-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    const reviewer = new StructuredReviewer([])
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'str_replace_editor', description: 'test editor', parameters: {},
      async execute() { return [{ type: 'text', text: 'edited' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('editor-call'), 'str_replace_editor', { file_path: 42 }),
      textResponse('edited the file'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-editor'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'edit the file' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const results = agent.session.events.filter(event => event.type === 'engineering-review/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ passed: true, risk: 'low' })
    await ctx.fiber.dispose()
  })

  it('pins the reviewer child requests to reasoning effort off', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-effort-'))
    temporaryDirectories.push(workspace)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SkillRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(EngineeringReviewRuntime)
    // Capture the agent/request waterfall listener the reviewer installs on its
    // child so the test can assert the pinned reasoning effort.
    const requestListeners: Array<
      (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
    > = []
    const localAgent = {
      ctx: {
        on(name: string, listener: (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) {
          if (name === 'agent/request') requestListeners.push(listener)
          return () => undefined
        },
      },
    } as unknown as Agent
    const reviewer = new StructuredReviewer([], 'completed', false, localAgent)
    ctx.subagents.registerProvider(reviewer)
    ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'test write', parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'written' }] },
    }))
    const llm = new MockAdapter([
      toolCallResponse(CallId('effort-write'), 'write', { path: 'driver.c' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], llm)
    const agent = ctx.agentLoop.create(SessionId('engineering-effort'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'change the driver' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(requestListeners).toHaveLength(1)
    const requestListener = requestListeners[0]
    expect(requestListener).toBeDefined()
    const config = await requestListener!({}, async () => ({ provider: 'mock', model: 'mock', reasoningEffort: 'high' }))
    expect(config.reasoningEffort).toBe('off')
    // The first child request has no persisted header, so the effort would be
    // undefined and the adapter default would win; the pin must apply there too.
    const plain = await requestListener!({}, async () => ({ provider: 'mock', model: 'mock' }))
    expect(plain.reasoningEffort).toBe('off')
    await ctx.fiber.dispose()
  })
})

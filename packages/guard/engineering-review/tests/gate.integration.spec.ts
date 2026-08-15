import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SkillRuntime from '@deepseek-ai/dsh-skill'
import SubagentRuntime, { type ResolvedSubagentStartRequest, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import EngineeringReviewRuntime from '../src/index.ts'
import type { EngineeringReviewAdapter } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

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
  constructor(private readonly findings: readonly Record<string, unknown>[] = [{
    category: 'blocking-and-concurrency', severity: 'high', confidence: 'high', title: 'Unbounded device wait',
    evidence: [{ path: 'driver.c', line: 10, detail: 'The device wait has no timeout.' }],
    impact: 'A failed device can stall progress forever.',
    recommendation: 'Add a bounded deadline and propagate timeout failure.',
    validation: 'Run with a device that never becomes ready.',
  }]) {}
  start(request: ResolvedSubagentStartRequest) {
    this.starts += 1
    this.lastRequest = request
    return Promise.resolve({
      id: SessionId('engineering-review-child'),
      localAgent: undefined,
      result: Promise.resolve({
        stopReason: 'completed' as const,
        output: [],
        structured: { findings: this.findings },
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
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: ['read'] })
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
    expect(reviewer.lastRequest?.toolFilter).toEqual({ allow: ['read'] })
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

  it('supports report-only gating with no correction pass', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-report-only-'))
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
})

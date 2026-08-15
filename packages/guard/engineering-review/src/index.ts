/**
 * Engineering quality review runtime: adapter registry, deterministic checks,
 * isolated structured review, model-facing tool, and turn-stopping correction.
 * @module @deepseek-ai/dsh-engineering-review
 */

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type { EngineeringReviewLogData } from './types.ts'
import type {
  EngineeringCheckRecipe,
  EngineeringCheckResult,
  EngineeringReviewAdapter,
  EngineeringReviewContribution,
  EngineeringReviewDepth,
  EngineeringReviewReport,
  EngineeringReviewRequest,
  EngineeringRisk,
} from './types.ts'
import {
  captureGitSnapshot,
  changedGitPaths,
  fingerprintGit,
  gitPatch,
  gitRoot,
  type GitSnapshot,
} from './git.ts'
import {
  checkApplies,
  discoverStandardChecks,
  hasWorkspaceFile,
  loadProjectChecks,
  readWorkspaceText,
} from './config.ts'
import { runArgv } from './process.ts'
import { bundledSkillSource, runReviewer, skillBody } from './reviewer.ts'
import { safeRelativeDirectory, validateCheckRecipe } from './recipe.ts'

export type {
  EngineeringCheckRecipe,
  EngineeringCheckResult,
  EngineeringFinding,
  EngineeringFindingEvidence,
  EngineeringReviewAdapter,
  EngineeringReviewContribution,
  EngineeringReviewDepth,
  EngineeringReviewLogData,
  EngineeringReviewReport,
  EngineeringReviewRequest,
  EngineeringReviewerResult,
  EngineeringRisk,
  EngineeringRiskSignal,
} from './types.ts'
export type { EngineeringFindingCategory } from './categories.ts'
export { REVIEW_CATEGORIES } from './categories.ts'

const DEFAULT_MAX_DIFF_BYTES = 512 * 1024
const DEFAULT_MAX_FILES = 100
const DEFAULT_CHECK_TIMEOUT_MS = 120_000
const DEFAULT_REVIEWER_MAX_TOKENS = 8_192
const RESULT_SUMMARY_BYTES = 2_048
const TASK_CONTEXT_BYTES = 16 * 1024

const RISK_ORDER: Readonly<Record<EngineeringRisk, number>> = { low: 0, medium: 1, high: 2 }

/** Runtime configuration. The package is opt-in; once mounted, automatic review defaults on. */
export interface Config {
  /** Whether stopping boundaries run the gate automatically (default true once mounted). */
  readonly automatic?: boolean
  /** Minimum assembled risk that starts the isolated reviewer (default medium). */
  readonly riskThreshold?: EngineeringRisk
  /** Number of blocker correction steers before the final report; zero is report-only (default 2). */
  readonly maxCorrectionPasses?: number
  /** Maximum UTF-8 diff bytes supplied to review (default 512 KiB). */
  readonly maxDiffBytes?: number
  /** Maximum Git paths captured before overflow becomes high risk (default 100). */
  readonly maxFiles?: number
  /** Default deadline for one deterministic check in milliseconds (default 120000). */
  readonly checkTimeoutMs?: number
  /** Named fresh one-shot subagent provider used for review (default spawn). */
  readonly subagentProvider?: string
  /** Optional LLM provider override for the reviewer; omission inherits the parent. */
  readonly reviewerProvider?: string
  /** Optional LLM model override for the reviewer; omission inherits the parent. */
  readonly reviewerModel?: string
  /** Maximum output tokens for each isolated reviewer request (default 8192). */
  readonly reviewerMaxTokens?: number
}

interface ResolvedConfig {
  readonly automatic: boolean
  readonly riskThreshold: EngineeringRisk
  readonly maxCorrectionPasses: number
  readonly maxDiffBytes: number
  readonly maxFiles: number
  readonly checkTimeoutMs: number
  readonly subagentProvider: string
  readonly reviewerProvider?: string
  readonly reviewerModel?: string
  readonly reviewerMaxTokens: number
}

interface GitTurnBaseline {
  readonly kind: 'git'
  readonly snapshot: GitSnapshot
}

interface NonGitTurnBaseline {
  readonly kind: 'non-git'
}

interface TurnState {
  turn: number
  baseline: GitTurnBaseline | NonGitTurnBaseline
  touchedPaths: Set<string>
  unknownShellMutation: boolean
  mutationRevision: number
  correctionPasses: number
  finalReportRequested: boolean
  selfReviewFingerprints: Set<string>
  loggedFingerprints: Set<string>
}

interface ReviewEvidence {
  readonly request: EngineeringReviewRequest
  readonly noChanges: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    engineeringReview: EngineeringReviewRuntime
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`engineering-review: ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`engineering-review: ${field} must be a non-negative safe integer`)
  }
  return value
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved = {
    automatic: config.automatic ?? true,
    riskThreshold: config.riskThreshold ?? 'medium',
    maxCorrectionPasses: config.maxCorrectionPasses ?? 2,
    maxDiffBytes: config.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
    checkTimeoutMs: config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    subagentProvider: config.subagentProvider ?? 'spawn',
    ...config.reviewerProvider === undefined ? {} : { reviewerProvider: config.reviewerProvider },
    ...config.reviewerModel === undefined ? {} : { reviewerModel: config.reviewerModel },
    reviewerMaxTokens: config.reviewerMaxTokens ?? DEFAULT_REVIEWER_MAX_TOKENS,
  }
  nonNegativeInteger(resolved.maxCorrectionPasses, 'maxCorrectionPasses')
  positiveInteger(resolved.maxDiffBytes, 'maxDiffBytes')
  positiveInteger(resolved.maxFiles, 'maxFiles')
  positiveInteger(resolved.checkTimeoutMs, 'checkTimeoutMs')
  positiveInteger(resolved.reviewerMaxTokens, 'reviewerMaxTokens')
  if (resolved.subagentProvider.trim().length === 0) throw new TypeError('engineering-review: subagentProvider must not be empty')
  return resolved
}

function maxRisk(risks: readonly EngineeringRisk[]): EngineeringRisk {
  return risks.reduce((highest, risk) => RISK_ORDER[risk] > RISK_ORDER[highest] ? risk : highest, 'low')
}

function baseRisk(paths: readonly string[], unknownShellMutation: boolean): EngineeringRisk {
  if (unknownShellMutation) return 'high'
  const code = /\.(?:[cm]?[ch]|cc|cpp|cxx|rs|go|py|java|kt|swift|ts|tsx|[cm]?js|jsx|v|vh|sv|svh)$/iu
  return paths.some(path => code.test(path)) ? 'medium' : 'low'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedSummary(stdout: string, stderr: string): string {
  const text = `${stdout}${stderr.length === 0 ? '' : `\n${stderr}`}`.trim() || '(no output)'
  const bytes = Buffer.from(text)
  return bytes.length <= RESULT_SUMMARY_BYTES
    ? text
    : `${bytes.subarray(bytes.length - RESULT_SUMMARY_BYTES).toString('utf8')}\n[output truncated to tail]`
}

function boundedUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}\n[task context truncated]`
}

function latestUserTask(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    return text.length === 0 ? undefined : boundedUtf8Prefix(text, TASK_CONTEXT_BYTES)
  }
  return undefined
}

/** Generic engineering review engine and adapter registry. */
export class EngineeringReviewRuntime extends Service {
  static inject = ['agents', 'tools', 'fs', 'subprocess', 'subagents', 'skills']
  static Config: z<Config> = z.object({
    automatic: z.boolean().default(true),
    riskThreshold: z.union(['low', 'medium', 'high'] as const).default('medium'),
    maxCorrectionPasses: z.number().default(2),
    maxDiffBytes: z.number().default(DEFAULT_MAX_DIFF_BYTES),
    maxFiles: z.number().default(DEFAULT_MAX_FILES),
    checkTimeoutMs: z.number().default(DEFAULT_CHECK_TIMEOUT_MS),
    subagentProvider: z.string().default('spawn'),
    reviewerProvider: z.string(),
    reviewerModel: z.string(),
    reviewerMaxTokens: z.number().default(DEFAULT_REVIEWER_MAX_TOKENS),
  })

  private readonly config: ResolvedConfig
  private readonly adapters = new Map<string, EngineeringReviewAdapter>()
  private readonly reports = new WeakMap<Agent, Map<string, Promise<EngineeringReviewReport>>>()
  private readonly turns = new WeakMap<Agent, TurnState>()

  /** Create the service and install its reversible skill, tool, and lifecycle contributions. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'engineeringReview')
    this.config = resolveConfig(config)
    ctx.skills.register({
      name: 'engineering-review',
      description: 'Review changed engineering code for systemic correctness risks before completion. Use for implementation or review work involving concurrency, lifecycle, recovery, boundaries, performance, state, compatibility, security, observability, or validation adequacy.',
      source: 'bundled',
      content: skillBody(bundledSkillSource()),
      resourceBase: { kind: 'directory', path: dirname(fileURLToPath(new URL('../skill/engineering-review/SKILL.md', import.meta.url))) },
    })
    ctx.tools.register(defineTool({
      name: 'engineering_review',
      description: 'Manually review current engineering changes with deterministic checks and independent analysis. The automatic completion gate already runs when enabled; call this tool only when the user explicitly requests an extra review or a focused review is needed before completion.',
      parameters: {
        depth: { type: 'string', enum: ['fast', 'deep'] as const, description: 'Review depth; default fast.' },
        focus: { type: 'string', description: 'Optional review focus.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('engineering_review requires an agent-owned call')
        const evidence = await this.manualEvidence(exec.agent, args.depth ?? 'fast', args.focus, exec.signal)
        const report = evidence.noChanges
          ? this.emptyReport(evidence.request.fingerprint)
          : await this.review(evidence.request)
        this.logOnce(exec.agent, report)
        return JSON.parse(JSON.stringify(report)) as Record<string, JsonValue>
      },
      presentCall: args => ({ card: 'generic', title: 'Engineering review', kind: 'execute', content: args.focus === undefined ? [] : [{ type: 'text', text: args.focus }] }),
    }))
    ctx.on('agent/pre-step', (payload, next): Promise<PreStepDecision> => this.onPreStep(payload, next))
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent === undefined || result.isError) return
      const state = this.turns.get(exec.agent)
      if (state === undefined) return
      if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'str_replace_editor') {
        const args = exec.arguments as Record<string, unknown>
        const path = args.path ?? args.file_path
        if (typeof path === 'string' && path.length > 0) state.touchedPaths.add(path)
        state.mutationRevision += 1
      } else if (exec.name === 'bash' || exec.name === 'pwsh' || exec.name.startsWith('terminal')) {
        state.unknownShellMutation = true
        state.mutationRevision += 1
      }
    })
    if (this.config.automatic) {
      ctx.on('agent/turn-stopping', payload => this.onTurnStopping(payload.agent, payload.turn, payload.signal))
    }
  }

  /**
   * Register one adapter until the calling plugin is disposed.
   * @param adapter - domain contribution provider with one stable id.
   * @returns the exact Cordis effect disposer for this registration.
   */
  registerAdapter(adapter: EngineeringReviewAdapter): () => void {
    if (adapter.id.trim().length === 0 || adapter.id !== adapter.id.trim()) {
      throw new TypeError('engineering-review: adapter id must be non-empty and trimmed')
    }
    const id = adapter.id
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: EngineeringReviewRuntime) {
      if (this.adapters.has(id)) throw new Error(`engineering-review: duplicate adapter ${JSON.stringify(id)}`)
      this.adapters.set(id, adapter)
      yield () => { this.adapters.delete(id) }
    }.bind(this), 'engineeringReview.registerAdapter()')
  }

  /**
   * Review one immutable change fingerprint, sharing in-flight and completed work.
   * @param request - bounded evidence, route owner, depth, and workspace readers.
   * @returns the canonical deterministic and reviewer report.
   */
  review(request: EngineeringReviewRequest): Promise<EngineeringReviewReport> {
    const focusKey = [...request.focus ?? []].sort().join('\0')
    const cacheKey = `${request.fingerprint}\0${request.depth}\0${focusKey}`
    let cache = this.reports.get(request.agent)
    if (cache === undefined) {
      cache = new Map()
      this.reports.set(request.agent, cache)
    }
    const existing = cache.get(cacheKey)
    if (existing !== undefined) return existing
    const pending = this.performReview(request)
    cache.set(cacheKey, pending)
    void pending.catch(() => { cache.delete(cacheKey) })
    return pending
  }

  private async performReview(request: EngineeringReviewRequest): Promise<EngineeringReviewReport> {
    const contributions = (await Promise.all([...this.adapters.values()].map(adapter =>
      adapter.contribute(request, request.signal)))).filter((value): value is EngineeringReviewContribution => value !== undefined)
    const risk = maxRisk([
      baseRisk(request.changedPaths, request.unknownShellMutation === true),
      ...contributions.flatMap(value => value.riskSignals?.map(signal => signal.risk) ?? []),
    ])
    const focus = [...new Set([...request.focus ?? [], ...contributions.flatMap(value => value.focus ?? [])])]
    const configured = await loadProjectChecks(this.ctx, request.cwd, request.signal)
    const projectChecks = configured ?? await discoverStandardChecks(this.ctx, request.cwd, request.depth, request.signal)
    const checks = [...projectChecks, ...contributions.flatMap(value => value.checks ?? [])]
    const ids = new Set<string>()
    for (const check of checks) {
      validateCheckRecipe(check)
      if (ids.has(check.id)) throw new Error(`engineering-review: duplicate assembled check id ${JSON.stringify(check.id)}`)
      ids.add(check.id)
    }
    const checkResults: EngineeringCheckResult[] = []
    for (const check of checks) checkResults.push(await this.runCheck(check, request))
    let findings: EngineeringReviewReport['findings'] = []
    let reviewer: EngineeringReviewReport['reviewer'] = { used: false }
    const degradedReasons = checkResults
      .filter(check => !check.required && (check.status === 'failed' || check.status === 'unavailable'))
      .map(check => `optional check ${check.id} ${check.status}: ${check.summary}`.slice(0, 1_024))
    if (request.depth === 'deep' || RISK_ORDER[risk] >= RISK_ORDER[this.config.riskThreshold]) {
      try {
        const outcome = await runReviewer(
          this.ctx,
          request,
          checkResults,
          focus,
          this.config.subagentProvider,
          this.config.reviewerProvider,
          this.config.reviewerModel,
          this.config.reviewerMaxTokens,
          request.signal,
        )
        findings = outcome.findings
        reviewer = {
          used: true,
          ...outcome.provider === undefined ? {} : { provider: outcome.provider },
          ...outcome.model === undefined ? {} : { model: outcome.model },
        }
      } catch (error) {
        if (request.signal.aborted) throw error
        const degradedReason = errorMessage(error).slice(0, 1_024)
        reviewer = { used: false, degradedReason }
        degradedReasons.push(`independent reviewer unavailable: ${degradedReason}`)
      }
    }
    const deterministicBlocker = checkResults.some(check => check.required && (check.status === 'failed' || check.status === 'unavailable'))
    const reviewerBlocker = findings.some(finding => finding.severity === 'blocker')
    return {
      fingerprint: request.fingerprint,
      risk,
      passed: !deterministicBlocker && !reviewerBlocker,
      checks: checkResults,
      findings,
      reviewer,
      degradedReasons,
    }
  }

  private async runCheck(check: EngineeringCheckRecipe, request: EngineeringReviewRequest): Promise<EngineeringCheckResult> {
    const required = check.required ?? false
    if (!checkApplies(check, request.changedPaths)) return { id: check.id, status: 'skipped', required, summary: 'No changed path matched this check.' }
    try {
      const cwdTarget = await this.ctx.fs.resolve(safeRelativeDirectory(check.cwd), { cwd: request.cwd, signal: request.signal })
      const info = await this.ctx.fs.stat(cwdTarget, request.signal)
      if (info?.type !== 'directory') throw new Error(`working directory ${JSON.stringify(check.cwd ?? '.')} does not exist`)
      const result = await runArgv(this.ctx, check.argv, {
        cwd: this.ctx.fs.processPath(cwdTarget),
        signal: request.signal,
        timeoutMs: check.timeoutMs ?? this.config.checkTimeoutMs,
        maxOutputBytes: 256 * 1024,
        agent: request.agent,
        sandbox: true,
      })
      const status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed'
      return {
        id: check.id,
        status,
        required,
        summary: result.timedOut
          ? `Timed out after ${check.timeoutMs ?? this.config.checkTimeoutMs}ms. ${boundedSummary(result.stdout, result.stderr)}`
          : boundedSummary(result.stdout, result.stderr),
      }
    } catch (error) {
      if (request.signal.aborted) throw error
      return { id: check.id, status: 'unavailable', required, summary: errorMessage(error).slice(0, RESULT_SUMMARY_BYTES) }
    }
  }

  private async onPreStep(
    payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    if (payload.step === 1 && this.turns.get(payload.agent)?.turn !== payload.turn) {
      const cwd = payload.agent.session.header.cwd ?? process.cwd()
      const root = await gitRoot(this.ctx, cwd, payload.signal)
      const baseline: GitTurnBaseline | NonGitTurnBaseline = root === undefined
        ? { kind: 'non-git' }
        : { kind: 'git', snapshot: await captureGitSnapshot(this.ctx, root, payload.signal, this.config.maxFiles) }
      this.turns.set(payload.agent, {
        turn: payload.turn,
        baseline,
        touchedPaths: new Set(),
        unknownShellMutation: false,
        mutationRevision: 0,
        correctionPasses: 0,
        finalReportRequested: false,
        selfReviewFingerprints: new Set(),
        loggedFingerprints: new Set(),
      })
    }
    return next()
  }

  private async automaticEvidence(agent: Agent, state: TurnState, signal: AbortSignal): Promise<ReviewEvidence> {
    const cwd = agent.session.header.cwd ?? process.cwd()
    if (state.baseline.kind === 'git') {
      const current = await captureGitSnapshot(this.ctx, state.baseline.snapshot.root, signal, this.config.maxFiles)
      const paths = changedGitPaths(state.baseline.snapshot, current)
      const overflowChanged = state.baseline.snapshot.overflow || current.overflow
      const reviewedPaths = paths.length === 0 && overflowChanged ? [...current.pathStates.keys()] : paths
      const patch = await gitPatch(this.ctx, current.root, reviewedPaths, signal, this.config.maxDiffBytes)
      const fingerprint = fingerprintGit(current, reviewedPaths, state.unknownShellMutation ? state.mutationRevision : overflowChanged)
      return {
        noChanges: reviewedPaths.length === 0 && !state.unknownShellMutation && !overflowChanged,
        request: this.request(agent, signal, current.root, fingerprint, reviewedPaths, patch, 'fast', undefined, state.unknownShellMutation || overflowChanged),
      }
    }
    const paths = [...state.touchedPaths].sort()
    const fingerprint = createHash('sha256')
      .update(`${state.mutationRevision}\0${paths.join('\0')}\0${state.unknownShellMutation}`)
      .digest('hex')
    return {
      noChanges: state.mutationRevision === 0,
      request: this.request(
        agent,
        signal,
        cwd,
        fingerprint,
        paths,
        { diff: '', truncated: true },
        'fast',
        undefined,
        state.unknownShellMutation,
      ),
    }
  }

  private async manualEvidence(
    agent: Agent,
    depth: EngineeringReviewDepth,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewEvidence> {
    const cwd = agent.session.header.cwd ?? process.cwd()
    const state = this.turns.get(agent)
    const root = await gitRoot(this.ctx, cwd, signal)
    if (root !== undefined) {
      const snapshot = await captureGitSnapshot(this.ctx, root, signal, this.config.maxFiles)
      const paths = [...snapshot.pathStates.keys()].sort()
      const patch = await gitPatch(this.ctx, root, paths, signal, this.config.maxDiffBytes)
      const fingerprint = fingerprintGit(
        snapshot,
        paths,
        state?.unknownShellMutation === true ? state.mutationRevision : snapshot.overflow,
      )
      return {
        noChanges: paths.length === 0 && state?.unknownShellMutation !== true && !snapshot.overflow,
        request: this.request(
          agent,
          signal,
          root,
          fingerprint,
          paths,
          patch,
          depth,
          focus,
          state?.unknownShellMutation === true || snapshot.overflow,
        ),
      }
    }
    const paths = [...state?.touchedPaths ?? []].sort()
    const revision = state?.mutationRevision ?? 0
    const fingerprint = createHash('sha256').update(`${revision}\0${paths.join('\0')}`).digest('hex')
    return {
      noChanges: revision === 0,
      request: this.request(agent, signal, cwd, fingerprint, paths, { diff: '', truncated: true }, depth, focus, state?.unknownShellMutation === true),
    }
  }

  private request(
    agent: Agent,
    signal: AbortSignal,
    cwd: string,
    fingerprint: string,
    changedPaths: readonly string[],
    patch: { diff: string; truncated: boolean },
    depth: EngineeringReviewDepth,
    focus: string | undefined,
    unknownShellMutation: boolean,
  ): EngineeringReviewRequest {
    const taskContext = latestUserTask(agent)
    return {
      agent,
      signal,
      cwd,
      fingerprint,
      changedPaths,
      diff: patch.diff,
      diffTruncated: patch.truncated,
      ...taskContext === undefined ? {} : { taskContext },
      depth,
      ...focus === undefined ? {} : { focus: [focus] },
      ...unknownShellMutation ? { unknownShellMutation: true } : {},
      readText: relative => readWorkspaceText(this.ctx, cwd, relative, signal),
      hasFile: relative => hasWorkspaceFile(this.ctx, cwd, relative, signal),
    }
  }

  private emptyReport(fingerprint: string): EngineeringReviewReport {
    return { fingerprint, risk: 'low', passed: true, checks: [], findings: [], reviewer: { used: false }, degradedReasons: [] }
  }

  private logOnce(agent: Agent, report: EngineeringReviewReport): void {
    const state = this.turns.get(agent)
    if (state?.loggedFingerprints.has(report.fingerprint) === true) return
    state?.loggedFingerprints.add(report.fingerprint)
    const data: EngineeringReviewLogData = {
      fingerprint: report.fingerprint,
      risk: report.risk,
      passed: report.passed,
      checks: report.checks.map(check => ({ id: check.id, status: check.status, required: check.required })),
      findings: report.findings.map(finding => ({
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
        evidence: finding.evidence.map(item => ({
          path: item.path,
          ...item.line === undefined ? {} : { line: item.line },
        })),
      })),
      ...report.degradedReasons.length === 0 ? {} : { degradedReasons: report.degradedReasons },
    }
    agent.session.append('engineering-review/result', data)
  }

  private async onTurnStopping(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const state = this.turns.get(agent)
    if (state === undefined || state.turn !== turn) return
    if (state.finalReportRequested) return
    const evidence = await this.automaticEvidence(agent, state, signal)
    if (evidence.noChanges) return
    const report = await this.review(evidence.request)
    this.logOnce(agent, report)
    if (report.degradedReasons.length > 0 && !state.selfReviewFingerprints.has(report.fingerprint)) {
      state.selfReviewFingerprints.add(report.fingerprint)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `Engineering review capabilities degraded:\n${report.degradedReasons.join('\n')}\n\nPerform a focused self-review of the changed engineering code using the engineering-review rubric. Fix only evidence-backed issues, run the relevant checks, then finish again.` }],
        source: { kind: 'plugin', plugin: 'engineering-review', form: 'notice', summary: 'Engineering review degraded to self-review' },
      }))
      return
    }
    if (report.passed) return
    if (state.correctionPasses < this.config.maxCorrectionPasses) {
      state.correctionPasses += 1
      const blockers = [
        ...report.checks.filter(check => check.required && (check.status === 'failed' || check.status === 'unavailable')).map(check => `check ${check.id}: ${check.summary}`),
        ...report.findings.filter(finding => finding.severity === 'blocker').map(finding => `${finding.id}: ${finding.title} — ${finding.recommendation}; verify: ${finding.validation}`),
      ]
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `Engineering review found blockers. Correct the changed code, run targeted verification, and finish again.\n\n${blockers.join('\n')}` }],
        source: { kind: 'plugin', plugin: 'engineering-review', form: 'notice', summary: `Correction pass ${state.correctionPasses}/${this.config.maxCorrectionPasses}` },
      }))
      return
    }
    state.finalReportRequested = true
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Engineering review still has blockers after the allowed correction passes. Stop modifying files. Report the unresolved blockers, their evidence and impact, checks that failed or were unavailable, and the safest next action. Then finish normally.' }],
      source: { kind: 'plugin', plugin: 'engineering-review', form: 'notice', summary: 'Final blocker report required' },
    }))
  }
}

export default EngineeringReviewRuntime

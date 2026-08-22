/**
 * Engineering quality review runtime: adapter registry, deterministic checks,
 * isolated structured review, model-facing tool, and turn-stopping correction.
 * @module @deepseek-ai/dsh-engineering-review
 */

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTwoFilesPatch } from 'diff'
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
  EngineeringReviewRoute,
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
import type { ReviewerLifecycleSummary } from './lifecycle/types.ts'
import { ReviewerLifecycleError } from './lifecycle/controller.ts'

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
  EngineeringReviewRoute,
  EngineeringReviewerResult,
  EngineeringRisk,
  EngineeringRiskSignal,
} from './types.ts'
export type { ReviewerLifecycleSummary } from './lifecycle/types.ts'
export type { EngineeringFindingCategory } from './categories.ts'
export { REVIEW_CATEGORIES } from './categories.ts'

const DEFAULT_MAX_DIFF_BYTES = 512 * 1024
const DEFAULT_MAX_FILES = 100
const DEFAULT_CHECK_TIMEOUT_MS = 120_000
const DEFAULT_REVIEWER_MAX_TOKENS = 8_192
const DEFAULT_REVIEW_CONTEXT_BYTES = 128 * 1024
const DEFAULT_REVIEWER_TIMEOUT_MS = 60_000
const DEFAULT_PREPARE_TIMEOUT_MS = 5_000
const DEFAULT_START_TIMEOUT_MS = 10_000
const DEFAULT_SPAWN_WATCHER_TIMEOUT_MS = 30_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000
const DEFAULT_TOTAL_TIMEOUT_MS = 90_000
const DEFAULT_MAX_DIAGNOSTIC_EVENTS = 32
const DEFAULT_MAX_DIAGNOSTIC_INCIDENTS = 32
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 8 * 1024
const MIN_AUTOMATIC_REVIEW_LINES = 2
const RESULT_SUMMARY_BYTES = 2_048
const TASK_CONTEXT_BYTES = 16 * 1024

const RISK_ORDER: Readonly<Record<EngineeringRisk, number>> = { low: 0, medium: 1, high: 2 }

/** File-mutation tools disabled once the final blocker report has been requested. */
const MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'str_replace_editor'])

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
  /** Maximum UTF-8 bytes in one isolated reviewer prompt (default 128 KiB). */
  readonly maxReviewContextBytes?: number
  /** Wall-clock deadline for one isolated reviewer attempt (default 60000). */
  readonly reviewerTimeoutMs?: number
  /** Deadline for reviewer preparation (default 5000). */
  readonly prepareTimeoutMs?: number
  /** Deadline for provider startup (default 10000). */
  readonly startTimeoutMs?: number
  /** Deadline for reclaiming a late provider handle (default 30000). */
  readonly spawnWatcherTimeoutMs?: number
  /** Deadline for model execution (default 60000). */
  readonly executionTimeoutMs?: number
  /** Deadline for reviewer cleanup (default 5000). */
  readonly disposeTimeoutMs?: number
  /** Total reviewer lifecycle deadline (default 90000). */
  readonly totalTimeoutMs?: number
  /** Maximum lifecycle events retained per reviewer (default 32). */
  readonly maxDiagnosticEvents?: number
  /** Maximum lifecycle incidents retained per reviewer (default 32). */
  readonly maxDiagnosticIncidents?: number
  /** Aggregate UTF-8 diagnostic budget per reviewer (default 8192). */
  readonly maxDiagnosticBytes?: number
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
  readonly maxReviewContextBytes: number
  readonly reviewerTimeoutMs: number
  readonly prepareTimeoutMs: number
  readonly startTimeoutMs: number
  readonly spawnWatcherTimeoutMs: number
  readonly executionTimeoutMs: number
  readonly disposeTimeoutMs: number
  readonly totalTimeoutMs: number
  readonly maxDiagnosticEvents: number
  readonly maxDiagnosticIncidents: number
  readonly maxDiagnosticBytes: number
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
  /** Pre-mutation file text keyed by touched path; null means the file did not exist at first mutation. */
  beforeContents: Map<string, string | null>
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
    maxReviewContextBytes: config.maxReviewContextBytes ?? DEFAULT_REVIEW_CONTEXT_BYTES,
    reviewerTimeoutMs: config.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
    prepareTimeoutMs: config.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
    startTimeoutMs: config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    spawnWatcherTimeoutMs: config.spawnWatcherTimeoutMs ?? DEFAULT_SPAWN_WATCHER_TIMEOUT_MS,
    executionTimeoutMs: config.executionTimeoutMs ?? config.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
    disposeTimeoutMs: config.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
    totalTimeoutMs: config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    maxDiagnosticEvents: config.maxDiagnosticEvents ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS,
    maxDiagnosticIncidents: config.maxDiagnosticIncidents ?? DEFAULT_MAX_DIAGNOSTIC_INCIDENTS,
    maxDiagnosticBytes: config.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES,
  }
  nonNegativeInteger(resolved.maxCorrectionPasses, 'maxCorrectionPasses')
  positiveInteger(resolved.maxDiffBytes, 'maxDiffBytes')
  positiveInteger(resolved.maxFiles, 'maxFiles')
  positiveInteger(resolved.checkTimeoutMs, 'checkTimeoutMs')
  positiveInteger(resolved.reviewerMaxTokens, 'reviewerMaxTokens')
  positiveInteger(resolved.maxReviewContextBytes, 'maxReviewContextBytes')
  positiveInteger(resolved.reviewerTimeoutMs, 'reviewerTimeoutMs')
  positiveInteger(resolved.prepareTimeoutMs, 'prepareTimeoutMs')
  positiveInteger(resolved.startTimeoutMs, 'startTimeoutMs')
  positiveInteger(resolved.spawnWatcherTimeoutMs, 'spawnWatcherTimeoutMs')
  positiveInteger(resolved.executionTimeoutMs, 'executionTimeoutMs')
  positiveInteger(resolved.disposeTimeoutMs, 'disposeTimeoutMs')
  positiveInteger(resolved.totalTimeoutMs, 'totalTimeoutMs')
  positiveInteger(resolved.maxDiagnosticEvents, 'maxDiagnosticEvents')
  positiveInteger(resolved.maxDiagnosticIncidents, 'maxDiagnosticIncidents')
  positiveInteger(resolved.maxDiagnosticBytes, 'maxDiagnosticBytes')
  if (resolved.subagentProvider.trim().length === 0) throw new TypeError('engineering-review: subagentProvider must not be empty')
  return resolved
}

function maxRisk(risks: readonly EngineeringRisk[]): EngineeringRisk {
  return risks.reduce((highest, risk) => RISK_ORDER[risk] > RISK_ORDER[highest] ? risk : highest, 'low')
}

function isCodePath(path: string): boolean {
  return /\.(?:[cm]?[ch]|cc|cpp|cxx|rs|go|py|java|kt|swift|ts|tsx|[cm]?js|jsx)$/iu.test(path)
}

function baseRisk(paths: readonly string[], unknownShellMutation: boolean): EngineeringRisk {
  if (unknownShellMutation) return 'high'
  return paths.some(isCodePath) ? 'medium' : 'low'
}

function hasGenericRiskEvidence(paths: readonly string[], diff: string): boolean {
  if (!paths.some(isCodePath)) return false
  const changedLines = diff
    .split(/\r?\n/u)
    .filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .join('\\n')
  const riskPattern = new RegExp(
    '\\b(?:' + [
      'atomic', 'blocking', 'cdc', 'close', 'dma', 'error', 'free', 'interrupt', 'isr', 'lock',
      'malloc', 'mutex', 'poll', 'queue', 'reset', 'resource', 'retry', 'rollback', 'send',
      'shared', 'sleep', 'timeout', 'transaction', 'unlock', 'wait',
    ].join('|') + ')(?:[_a-z0-9]*)?\\b',
    'iu',
  )
  return riskPattern.test(changedLines)
}

function changedLineCount(diff: string): number {
  let added = 0
  let removed = 0
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return Math.max(added, removed)
}

function selectRoute(
  request: EngineeringReviewRequest,
  risk: EngineeringRisk,
  checks: readonly EngineeringCheckResult[],
  threshold: EngineeringRisk,
  genericRiskEvidence: boolean,
): EngineeringReviewRoute {
  const requiredFailure = checks.some(check => check.required && (check.status === 'failed' || check.status === 'unavailable'))
  if (requiredFailure) return 'checks-only'
  if (request.depth === 'deep') return 'deep'
  const explicitlyFocused = request.focus !== undefined && request.focus.length > 0
  if (!explicitlyFocused && RISK_ORDER[risk] < RISK_ORDER[threshold]) return 'checks-only'
  const highRiskEvidence = risk === 'high' || request.diffTruncated || request.unknownShellMutation === true
  if (highRiskEvidence) return 'deep'
  if (request.automatic === true && !explicitlyFocused && threshold === 'medium' && !genericRiskEvidence) return 'checks-only'
  // The automatic gate does not spend a model call on a tiny ordinary edit.
  // Adapters can still raise risk to high for a dangerous one-line change;
  // explicit focus/deep requests remain opt-in review paths.
  if (request.automatic === true && !explicitlyFocused && !genericRiskEvidence && request.diff.length > 0 && changedLineCount(request.diff) < MIN_AUTOMATIC_REVIEW_LINES) return 'checks-only'
  return 'fast'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The workspace-relative or absolute path one mutation tool call targets, if any. */
function mutationToolPath(exec: { arguments: unknown }): string | undefined {
  const args = exec.arguments as Record<string, unknown>
  const path = args.path ?? args.file_path
  return typeof path === 'string' && path.length > 0 ? path : undefined
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
  // v8 ignore next -- bytes[end] is undefined only when the truncation lands exactly on the buffer end, excluded above.
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
    maxReviewContextBytes: z.number().default(DEFAULT_REVIEW_CONTEXT_BYTES),
    reviewerTimeoutMs: z.number().default(DEFAULT_REVIEWER_TIMEOUT_MS),
    prepareTimeoutMs: z.number().default(DEFAULT_PREPARE_TIMEOUT_MS),
    startTimeoutMs: z.number().default(DEFAULT_START_TIMEOUT_MS),
    spawnWatcherTimeoutMs: z.number().default(DEFAULT_SPAWN_WATCHER_TIMEOUT_MS),
    executionTimeoutMs: z.number(),
    disposeTimeoutMs: z.number().default(DEFAULT_DISPOSE_TIMEOUT_MS),
    totalTimeoutMs: z.number().default(DEFAULT_TOTAL_TIMEOUT_MS),
    maxDiagnosticEvents: z.number().default(DEFAULT_MAX_DIAGNOSTIC_EVENTS),
    maxDiagnosticIncidents: z.number().default(DEFAULT_MAX_DIAGNOSTIC_INCIDENTS),
    maxDiagnosticBytes: z.number().default(DEFAULT_MAX_DIAGNOSTIC_BYTES),
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
    // After the final blocker report is requested, the model is instructed to
    // stop modifying files. Enforce that instruction: mutation tools now fail
    // with an explicit error instead of relying on the model's compliance.
    // Before dispatch also snapshot each path's pre-mutation content for
    // non-Git baselines, so the reviewer receives a real diff instead of
    // having to reconstruct the change by reading the whole workspace.
    ctx.on('tools/execute', async (exec, next) => {
      const agent = exec.agent
      const state = agent === undefined ? undefined : this.turns.get(agent)
      if (state?.finalReportRequested === true && MUTATION_TOOL_NAMES.has(exec.name)) {
        const message = 'engineering review: file modification is disabled after the final blocker report; report the unresolved blockers instead.'
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
          error: { message },
        }
      }
      if (agent !== undefined && state?.baseline.kind === 'non-git' && MUTATION_TOOL_NAMES.has(exec.name)) {
        const path = mutationToolPath(exec)
        if (path !== undefined && !state.beforeContents.has(path)) {
          state.beforeContents.set(path, await this.snapshotText(path, agent, exec.signal))
        }
      }
      return next()
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
    // Isolate each adapter: one throwing contributor must not sink the whole
    // gate. Its failure becomes an explicit degraded reason, and its guidance
    // is skipped; the remaining adapters still contribute.
    const degradedReasons: string[] = []
    const contributions: EngineeringReviewContribution[] = []
    for (const adapter of this.adapters.values()) {
      try {
        const contribution = await adapter.contribute(request, request.signal)
        if (contribution !== undefined) {
          contributions.push(contribution)
          degradedReasons.push(...contribution.degradedReasons ?? [])
        }
      } catch (error) {
        if (request.signal.aborted) throw error
        degradedReasons.push(`adapter ${adapter.id} failed: ${errorMessage(error).slice(0, 1_024)}`)
      }
    }
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
    let lifecycle: ReviewerLifecycleSummary | undefined
    const route = selectRoute(request, risk, checkResults, this.config.riskThreshold, hasGenericRiskEvidence(request.changedPaths, request.diff) || contributions.some(value => value.riskSignals?.some(signal => signal.risk !== 'low') === true))
    degradedReasons.push(...checkResults
      .filter(check => !check.required && (check.status === 'failed' || check.status === 'unavailable'))
      .map(check => `optional check ${check.id} ${check.status}: ${check.summary}`.slice(0, 1_024)))
    if (route !== 'checks-only') {
      try {
        const outcome = await runReviewer(
          this.ctx,
          request,
          checkResults,
          focus,
          route,
          this.config.subagentProvider,
          this.config.reviewerProvider,
          this.config.reviewerModel,
          this.config.reviewerMaxTokens,
          this.config.maxReviewContextBytes,
          {
            prepareTimeoutMs: this.config.prepareTimeoutMs,
            startTimeoutMs: this.config.startTimeoutMs,
            spawnWatcherTimeoutMs: this.config.spawnWatcherTimeoutMs,
            executionTimeoutMs: this.config.executionTimeoutMs,
            disposeTimeoutMs: this.config.disposeTimeoutMs,
            totalTimeoutMs: this.config.totalTimeoutMs,
            diagnosticBudget: {
              maxEvents: this.config.maxDiagnosticEvents,
              maxIncidents: this.config.maxDiagnosticIncidents,
              maxBytes: this.config.maxDiagnosticBytes,
            },
          },
          request.signal,
        )
        findings = outcome.findings
        lifecycle = outcome.lifecycle
        reviewer = {
          used: true,
          ...outcome.provider === undefined ? {} : { provider: outcome.provider },
          ...outcome.model === undefined ? {} : { model: outcome.model },
        }
      } catch (error) {
        if (request.signal.aborted) throw error
        const degradedReason = errorMessage(error).slice(0, 1_024)
        lifecycle = error instanceof ReviewerLifecycleError ? error.summary : undefined
        reviewer = { used: false, degradedReason }
        degradedReasons.push(`independent reviewer unavailable: ${degradedReason}`)
      }
    }
    const deterministicBlocker = checkResults.some(check => check.required && (check.status === 'failed' || check.status === 'unavailable'))
    const reviewerBlocker = findings.some(finding => finding.severity === 'blocker')
    return {
      fingerprint: request.fingerprint,
      risk,
      route,
      passed: !deterministicBlocker && !reviewerBlocker,
      checks: checkResults,
      findings,
      reviewer,
      degradedReasons,
      ...lifecycle === undefined ? {} : { lifecycle },
    }
  }

  private async runCheck(check: EngineeringCheckRecipe, request: EngineeringReviewRequest): Promise<EngineeringCheckResult> {
    const required = check.required ?? false
    if (!checkApplies(check, request.changedPaths)) return { id: check.id, status: 'skipped', required, summary: 'No changed path matched this check.' }
    try {
      const cwdTarget = await this.ctx.fs.resolve(safeRelativeDirectory(check.cwd), { cwd: request.cwd, signal: request.signal })
      const info = await this.ctx.fs.stat(cwdTarget, request.signal)
      // v8 ignore next -- a check without a cwd resolves to '.' which always exists, so the default arm never throws.
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
      /* v8 ignore next -- rethrow only when the caller aborts between check selection and process start; no in-process flow races it. */
      if (request.signal.aborted) throw error
      return { id: check.id, status: 'unavailable', required, summary: errorMessage(error).slice(0, RESULT_SUMMARY_BYTES) }
    }
  }

  private async onPreStep(
    payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    if (payload.step === 1 && this.turns.get(payload.agent)?.turn !== payload.turn) {
      // v8 ignore next -- every product agent session carries a cwd; the fallback is defensive.
      const cwd = payload.agent.session.header.cwd ?? process.cwd()
      const root = await gitRoot(this.ctx, cwd, payload.signal)
      const baseline: GitTurnBaseline | NonGitTurnBaseline = root === undefined
        ? { kind: 'non-git' }
        : { kind: 'git', snapshot: await captureGitSnapshot(this.ctx, root, payload.signal, this.config.maxFiles) }
      this.turns.set(payload.agent, {
        turn: payload.turn,
        baseline,
        touchedPaths: new Set(),
        beforeContents: new Map(),
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

  /** Read one touched path's current text for the non-Git snapshot; null when absent or unreadable. */
  private async snapshotText(path: string, agent: Agent, signal: AbortSignal): Promise<string | null> {
    try {
      // v8 ignore next -- every product agent session carries a cwd; the fallback is defensive.
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = await this.ctx.fs.resolve(path, { cwd, signal })
      const info = await this.ctx.fs.stat(target, signal)
      return info?.type === 'file' ? await this.ctx.fs.readText(target, signal) : null
    } catch (error) {
      /* v8 ignore next -- a snapshot read only rethrows when the caller aborts mid-read; other failures degrade to null. */
      if (signal.aborted) throw error
      return null
    }
  }

  /**
   * Build the real unified diff between each path's first-mutation content and
   * its current content. An empty result degrades to the legacy empty/truncated
   * patch so the reviewer still gets read tools when nothing readable changed.
   */
  private async nonGitDiff(
    state: TurnState,
    agent: Agent,
    paths: readonly string[],
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ diff: string; truncated: boolean }> {
    const chunks: string[] = []
    let bytes = 0
    for (const path of paths) {
      const before = state.beforeContents.get(path) ?? null
      const after = await this.snapshotText(path, agent, signal)
      if (before === after) continue
      const patch = createTwoFilesPatch(
        `a/${path}`, `b/${path}`,
        before ?? '', after ?? '',
        undefined, undefined, { context: 3 },
      )
      chunks.push(patch)
      bytes += Buffer.byteLength(patch)
      if (bytes > maxBytes) return { diff: chunks.join('\n'), truncated: true }
    }
    const diff = chunks.join('\n')
    // An empty diff means nothing observable changed (e.g. a file created and
    // removed within the turn). Leave the reviewer with no tools: without a
    // diff there is nothing to investigate, and read tools on missing or
    // unreadable paths only encourage an aimless file hunt.
    return diff.length === 0 ? { diff: '', truncated: false } : { diff, truncated: false }
  }

  private async automaticEvidence(agent: Agent, state: TurnState, signal: AbortSignal): Promise<ReviewEvidence> {
    // v8 ignore next -- every product agent session carries a cwd; the fallback is defensive.
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
        request: this.request(agent, signal, current.root, fingerprint, reviewedPaths, patch, 'fast', undefined, state.unknownShellMutation || overflowChanged, true),
      }
    }
    const paths = [...state.touchedPaths].sort()
    const fingerprint = createHash('sha256')
      .update(`${state.mutationRevision}\0${paths.join('\0')}\0${state.unknownShellMutation}`)
      .digest('hex')
    const patch = await this.nonGitDiff(state, agent, paths, this.config.maxDiffBytes, signal)
    return {
      noChanges: state.mutationRevision === 0,
      request: this.request(
        agent,
        signal,
        cwd,
        fingerprint,
        paths,
        patch,
        'fast',
        undefined,
        state.unknownShellMutation,
        true,
      ),
    }
  }

  private async manualEvidence(
    agent: Agent,
    depth: EngineeringReviewDepth,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewEvidence> {
    // v8 ignore next -- every product agent session carries a cwd; the fallback is defensive.
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
          false,
        ),
      }
    }
    const paths = [...state?.touchedPaths ?? []].sort()
    const revision = state?.mutationRevision ?? 0
    const fingerprint = createHash('sha256').update(`${revision}\0${paths.join('\0')}`).digest('hex')
    const patch = state === undefined
      ? { diff: '', truncated: true }
      : await this.nonGitDiff(state, agent, paths, this.config.maxDiffBytes, signal)
    return {
      noChanges: revision === 0,
      request: this.request(agent, signal, cwd, fingerprint, paths, patch, depth, focus, state?.unknownShellMutation === true, false),
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
    automatic: boolean,
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
      ...automatic ? { automatic: true } : {},
      depth,
      ...focus === undefined ? {} : { focus: [focus] },
      ...unknownShellMutation ? { unknownShellMutation: true } : {},
      readText: relative => readWorkspaceText(this.ctx, cwd, relative, signal),
      hasFile: relative => hasWorkspaceFile(this.ctx, cwd, relative, signal),
    }
  }

  private emptyReport(fingerprint: string): EngineeringReviewReport {
    return { fingerprint, risk: 'low', route: 'checks-only', passed: true, checks: [], findings: [], reviewer: { used: false }, degradedReasons: [] }
  }

  private logOnce(agent: Agent, report: EngineeringReviewReport): void {
    const state = this.turns.get(agent)
    if (state?.loggedFingerprints.has(report.fingerprint) === true) return
    state?.loggedFingerprints.add(report.fingerprint)
    const data: EngineeringReviewLogData = {
      fingerprint: report.fingerprint,
      risk: report.risk,
      route: report.route,
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
          // v8 ignore next -- admission requires a positive changed line, so normalized findings always carry one.
          ...item.line === undefined ? {} : { line: item.line },
        })),
      })),
      ...report.degradedReasons.length === 0 ? {} : { degradedReasons: report.degradedReasons },
      ...report.lifecycle === undefined ? {} : { lifecycle: report.lifecycle },
    }
    agent.session.append('engineering-review/result', data)
  }

  private async onTurnStopping(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const state = this.turns.get(agent)
    /* v8 ignore next -- every stopping turn ran its step-1 pre-step; rejected/erroring pre-steps never reach turn-stopping. */
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

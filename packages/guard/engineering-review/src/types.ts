/** Public engineering-review vocabulary. @module @deepseek-ai/dsh-engineering-review/types */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EngineeringFindingCategory } from './categories.ts'
import type { LifecycleEvent, LifecycleIncident, ReviewerLifecycleSummary } from './lifecycle/types.ts'

/** Ordered engineering risk used by adapters and review policy. */
export type EngineeringRisk = 'low' | 'medium' | 'high'

/** Manual review depth. Deep review always requests an independent reviewer. */
export type EngineeringReviewDepth = 'fast' | 'deep'

/** Runtime route selected after deterministic checks have completed. */
export type EngineeringReviewRoute = 'checks-only' | 'fast' | 'deep'

/** One exact-argv deterministic project check. */
export interface EngineeringCheckRecipe {
  /** Stable id within the assembled review. */
  readonly id: string
  /** Exact executable and arguments; no shell parsing occurs. */
  readonly argv: readonly string[]
  /** Workspace-relative working directory. */
  readonly cwd?: string
  /** Changed-path globs that select this check; omission selects every change. */
  readonly files?: readonly string[]
  /** Positive execution deadline. */
  readonly timeoutMs?: number
  /** Failure or unavailability blocks completion when true. */
  readonly required?: boolean
}

/** Risk evidence contributed by an adapter without claiming a defect. */
export interface EngineeringRiskSignal {
  readonly risk: EngineeringRisk
  readonly reason: string
}

/** Adapter output. Adapters may guide review and checks, but never emit findings. */
export interface EngineeringReviewContribution {
  readonly riskSignals?: readonly EngineeringRiskSignal[]
  readonly focus?: readonly string[]
  readonly checks?: readonly EngineeringCheckRecipe[]
  /** Non-blocking capability failures (e.g. explicit configuration pointing at a missing tool). */
  readonly degradedReasons?: readonly string[]
  readonly lifecycle?: Pick<ReviewerLifecycleSummary, 'id' | 'outcome' | 'resource' | 'diagnostics'>
}

/** Inputs shared by automatic and manual review. */
export interface EngineeringReviewRequest {
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly cwd: string
  readonly fingerprint: string
  readonly changedPaths: readonly string[]
  readonly diff: string
  readonly diffTruncated: boolean
  /** Bounded text from the latest direct user task; excludes agent reasoning and plugin steering. */
  readonly taskContext?: string
  /** True when the request came from the automatic stopping gate. */
  readonly automatic?: boolean
  readonly depth: EngineeringReviewDepth
  readonly focus?: readonly string[]
  readonly unknownShellMutation?: boolean
  /** Read one workspace-relative text file, returning undefined when absent or non-file. */
  readText(relativePath: string): Promise<string | undefined>
  /** Test whether one workspace-relative regular file exists. */
  hasFile(relativePath: string): Promise<boolean>
}

/** Extensible domain adapter registered on `ctx.engineeringReview`. */
export interface EngineeringReviewAdapter {
  readonly id: string
  /**
   * Contribute risk, reviewer focus, and exact-argv checks.
   * @param request - immutable change evidence and bounded workspace readers.
   * @param signal - cancellation for this review operation.
   * @returns guidance, or undefined when the adapter does not apply.
   */
  contribute(
    request: EngineeringReviewRequest,
    signal: AbortSignal,
  ): Promise<EngineeringReviewContribution | undefined>
}

/** Outcome of one deterministic check. */
export interface EngineeringCheckResult {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'skipped' | 'unavailable'
  readonly required: boolean
  readonly summary: string
}

/** Source evidence for one reviewer finding. */
export interface EngineeringFindingEvidence {
  readonly path: string
  readonly line?: number
  readonly detail: string
}

/** Normalized engineering finding. */
export interface EngineeringFinding {
  readonly id: string
  readonly category: EngineeringFindingCategory
  readonly severity: 'blocker' | 'warning'
  readonly confidence: 'high' | 'medium' | 'low'
  readonly title: string
  readonly evidence: readonly EngineeringFindingEvidence[]
  readonly impact: string
  readonly recommendation: string
  readonly validation: string
}

/** Independent-review execution facts. */
export interface EngineeringReviewerResult {
  readonly used: boolean
  readonly provider?: string
  readonly model?: string
  readonly degradedReason?: string
}

/** Canonical result returned by the service and model-facing tool. */
export interface EngineeringReviewReport {
  readonly fingerprint: string
  readonly risk: EngineeringRisk
  /** The effective route; checks-only means no independent reviewer ran. */
  readonly route: EngineeringReviewRoute
  readonly passed: boolean
  readonly checks: readonly EngineeringCheckResult[]
  readonly findings: readonly EngineeringFinding[]
  readonly reviewer: EngineeringReviewerResult
  /** Non-blocking capability failures that require an explicit main-model self-review. */
  readonly degradedReasons: readonly string[]
  /** Bounded lifecycle and resource diagnostics for an independent reviewer. */
  readonly lifecycle?: ReviewerLifecycleSummary
}

/** Durable lifecycle record emitted independently of the business result snapshot. */
export interface EngineeringReviewLifecycleLogData {
  readonly fingerprint: string
  readonly id: string
  readonly kind: 'event' | 'incident' | 'finalized'
  readonly event?: LifecycleEvent
  readonly incident?: LifecycleIncident
  readonly state?: ReviewerLifecycleSummary['state']
  readonly outcome?: ReviewerLifecycleSummary['outcome']
  readonly resource?: ReviewerLifecycleSummary['resource']
}

/** Compact durable projection of one completed review. */
export interface EngineeringReviewLogData {
  readonly fingerprint: string
  readonly risk: EngineeringRisk
  /** The effective route; checks-only means no independent reviewer ran. */
  readonly route: EngineeringReviewRoute
  readonly passed: boolean
  readonly checks: readonly { id: string; status: EngineeringCheckResult['status']; required: boolean }[]
  readonly findings: readonly {
    id: string
    category: EngineeringFindingCategory
    severity: EngineeringFinding['severity']
    confidence: EngineeringFinding['confidence']
    title: string
    evidence: readonly { path: string; line?: number }[]
  }[]
  readonly degradedReasons?: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Compact, log-only result for one reviewed change fingerprint. */
    'engineering-review/result': EngineeringReviewLogData
    /** Lifecycle events remain durable after the business result is returned. */
    'engineering-review/lifecycle': EngineeringReviewLifecycleLogData
  }
}

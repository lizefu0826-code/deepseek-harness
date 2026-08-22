/** Diagnostic and ownership vocabulary for bounded reviewer execution. */

/** Lifecycle phase currently owned by the controller. */
export type ReviewerLifecycleState = 'idle' | 'preparing' | 'spawning' | 'executing' | 'disposing' | 'finished'

/** Review outcome independent of resource cleanup. */
export type ReviewerOutcomeStatus = 'success' | 'failed' | 'skipped' | 'degraded'

/** Knowledge about resources created by a provider. */
export type ReviewerResourceState = 'clean' | 'owned' | 'cleanup-pending' | 'orphaned' | 'unknown'

/** Severity used when bounded diagnostics overflow. */
export type LifecycleEventPriority = 'critical' | 'warning' | 'info'

/** Structured incident reason. */
export type LifecycleIncidentReason =
  | 'deadline-exceeded'
  | 'provider-hang'
  | 'io-hang'
  | 'model-timeout'
  | 'dispose-timeout'
  | 'invalid-output'
  | 'internal-error'

/** One bounded lifecycle event. */
export interface LifecycleEvent {
  readonly elapsedMs: number
  readonly phase: ReviewerLifecycleState
  readonly event: string
  readonly priority: LifecycleEventPriority
}

/** One diagnostic incident attached to a reviewer run. */
export interface DiagnosticBudget {
  readonly maxEvents: number
  readonly maxIncidents: number
  readonly maxBytes: number
}

/** Sink for lifecycle diagnostics that outlives the business result snapshot. */
export interface DiagnosticSink {
  append(event: LifecycleEvent): void
  appendIncident(incident: LifecycleIncident): void
  finalize(summary: ReviewerLifecycleSummary): void
}

/** One diagnostic incident attached to a reviewer run. */
export interface LifecycleIncident {
  readonly phase: ReviewerLifecycleState
  readonly reason: LifecycleIncidentReason
  readonly recoverable: boolean
  readonly action: 'self-review' | 'skip' | 'report'
}

/** Resource state after the controller returns. */
export interface ReviewerResourceResult {
  readonly state: ReviewerResourceState
  readonly reason?: string
}

/** Bounded controller diagnostics. */
export interface ReviewerLifecycleDiagnostics {
  readonly events: readonly LifecycleEvent[]
  readonly incidents: readonly LifecycleIncident[]
}
/** Final lifecycle projection attached to one reviewer request. */
export interface ReviewerLifecycleSummary {
  readonly id: string
  readonly state: ReviewerLifecycleState
  readonly outcome: ReviewerOutcomeStatus
  readonly resource: ReviewerResourceResult
  readonly diagnostics: ReviewerLifecycleDiagnostics
}

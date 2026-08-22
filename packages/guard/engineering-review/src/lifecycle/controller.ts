/** Bounded reviewer lifecycle controller and resource ownership handoff. */

import { randomUUID } from 'node:crypto'
import { DeadlineContext } from './deadline.ts'
import type {
  DiagnosticBudget,
  DiagnosticSink,
  LifecycleEvent,
  LifecycleEventPriority,
  LifecycleIncident,
  LifecycleIncidentReason,
  ReviewerLifecycleState,
  ReviewerLifecycleSummary,
  ReviewerOutcomeStatus,
  ReviewerResourceState,
} from './types.ts'

const DEFAULT_DIAGNOSTIC_BUDGET: DiagnosticBudget = { maxEvents: 32, maxIncidents: 32, maxBytes: 8 * 1024 }

type ActivePhase = Exclude<ReviewerLifecycleState, 'idle' | 'finished'>

const RESOURCE_TRANSITIONS: Readonly<Record<ReviewerResourceState, readonly ReviewerResourceState[]>> = {
  // `clean` ends one run; `unknown` begins the next run before ownership is confirmed.
  clean: ['clean', 'unknown'],
  unknown: ['unknown', 'owned'],
  owned: ['owned', 'cleanup-pending'],
  'cleanup-pending': ['cleanup-pending', 'clean', 'orphaned'],
  orphaned: ['orphaned'],
}

/** Error raised when a resource ownership transition violates the FSM. */
export class ReviewerResourceTransitionError extends Error {
  constructor(readonly from: ReviewerResourceState, readonly to: ReviewerResourceState) {
    super(`invalid reviewer resource transition: ${from} -> ${to}`)
    this.name = 'ReviewerResourceTransitionError'
  }
}

/** Assert that a reviewer resource transition is allowed by the ownership FSM.
 * @param from - current resource state.
 * @param to - requested resource state.
 */
export function assertReviewerResourceTransition(
  from: ReviewerResourceState,
  to: ReviewerResourceState,
): void {
  if (!RESOURCE_TRANSITIONS[from].includes(to)) throw new ReviewerResourceTransitionError(from, to)
}
/** Runtime budgets for one reviewer lifecycle. */
export interface ReviewerLifecycleBudgets {
  readonly prepareTimeoutMs: number
  readonly startTimeoutMs: number
  readonly spawnWatcherTimeoutMs: number
  readonly executionTimeoutMs: number
  readonly disposeTimeoutMs: number
  readonly totalTimeoutMs: number
  readonly diagnosticBudget?: DiagnosticBudget
}

/** Error raised when a lifecycle phase exceeds its bounded budget. */
export class ReviewerLifecycleError extends Error {
  constructor(
    message: string,
    readonly phase: ReviewerLifecycleState,
    readonly reason: LifecycleIncidentReason,
    readonly summary: ReviewerLifecycleSummary,
  ) {
    super(message)
    this.name = 'ReviewerLifecycleError'
  }
}

interface DisposableRun {
  dispose(): Promise<void>
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Owns reviewer phase deadlines and late-resource cleanup.
 * @param parentSignal - parent operation cancellation.
 * @param budgets - phase and total budgets.
 * @param now - monotonic clock, injectable for deterministic tests.
 * @param sink - durable diagnostic sink independent of the business result.
 */
export class ReviewerLifecycleController {
  /** Correlation id shared by lifecycle events and the durable review report. */
  readonly id = `review-run-${randomUUID()}`
  private readonly deadline: DeadlineContext
  private readonly now: () => number
  private readonly sink: DiagnosticSink | undefined
  private readonly diagnosticBudget: DiagnosticBudget
  private readonly events: LifecycleEvent[] = []
  private readonly incidents: LifecycleIncident[] = []
  private readonly watchers = new Set<Promise<void>>()
  private state: ReviewerLifecycleState = 'idle'
  private outcome: ReviewerOutcomeStatus = 'success'
  private resourceState: ReviewerResourceState = 'clean'
  private resourceReason: string | undefined
  private finished = false
  private diagnosticsFinalized = false

  constructor(
    private readonly parentSignal: AbortSignal,
    private readonly budgets: ReviewerLifecycleBudgets,
    now: () => number = monotonicNow,
    sink?: DiagnosticSink,
  ) {
    this.now = now
    this.sink = sink
    this.diagnosticBudget = { ...DEFAULT_DIAGNOSTIC_BUDGET, ...budgets.diagnosticBudget }
    this.deadline = new DeadlineContext(now, budgets.totalTimeoutMs)
  }

  /** Execution budget used by the reviewer model phase. */
  get executionTimeoutMs(): number { return this.budgets.executionTimeoutMs }

  /** Execute a phase without allowing it to exceed its remaining total budget.
   * @param phase - lifecycle phase being executed.
   * @param timeoutMs - phase budget, further bounded by the total deadline.
   * @param operation - operation receiving a phase-scoped abort signal.
   * @returns the operation result.
   */
  async runPhase<T>(
    phase: ActivePhase,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.state = phase
    this.record(phase, 'phase_started', 'info')
    const budget = this.deadline.phaseBudget(timeoutMs)
    if (budget <= 0) throw this.phaseTimeout(phase, 'deadline-exceeded', budget)
    const controller = new AbortController()
    const onParentAbort = () => { controller.abort(this.parentSignal.reason) }
    if (this.parentSignal.aborted) onParentAbort()
    else this.parentSignal.addEventListener('abort', onParentAbort, { once: true })
    const task = Promise.resolve().then(() => operation(controller.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`${phase} deadline exceeded`))
        reject(this.phaseTimeout(phase, phase === 'executing' ? 'model-timeout' : 'deadline-exceeded', budget))
      }, budget)
    })
    try {
      const result = await Promise.race([task, timeout])
      this.record(phase, 'phase_completed', 'info')
      return result
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.parentSignal.removeEventListener('abort', onParentAbort)
    }
  }

  /** Spawn a run and reclaim a handle that arrives after the parent path timed out.
   * @param operation - provider startup operation receiving a phase-scoped abort signal.
   * @returns the confirmed disposable run.
   */
  async spawn<T extends DisposableRun>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.state = 'spawning'
    this.transitionResourceState('unknown')
    this.resourceReason = 'spawn-in-progress'
    this.record('spawning', 'phase_started', 'info')
    const budget = this.deadline.phaseBudget(this.budgets.startTimeoutMs)
    if (budget <= 0) throw this.phaseTimeout('spawning', 'deadline-exceeded', budget)
    const controller = new AbortController()
    const onParentAbort = () => { controller.abort(this.parentSignal.reason) }
    if (this.parentSignal.aborted) onParentAbort()
    else this.parentSignal.addEventListener('abort', onParentAbort, { once: true })
    const attempt = Promise.resolve().then(() => operation(controller.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('spawning deadline exceeded'))
        reject(this.phaseTimeout('spawning', 'provider-hang', budget))
      }, budget)
    })
    try {
      const run = await Promise.race([attempt, timeout])
      this.transitionResourceState('owned')
      this.resourceReason = undefined
      this.record('spawning', 'phase_completed', 'info')
      return run
    } catch (error) {
      this.transitionResourceState('unknown')
      this.resourceReason = error instanceof ReviewerLifecycleError && error.reason === 'provider-hang'
        ? 'spawn-not-confirmed'
        : 'spawn-rejected'
      if (error instanceof ReviewerLifecycleError && error.reason === 'provider-hang') {
        this.watchLateHandle(attempt)
      } else {
        this.record('spawning', 'spawn_rejected', 'warning')
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.parentSignal.removeEventListener('abort', onParentAbort)
    }
  }

  /** Dispose a confirmed run within the cleanup budget.
   * @param run - confirmed provider run owned by this controller.
   */
  async dispose(run: DisposableRun): Promise<void> {
    this.state = 'disposing'
    this.transitionResourceState('cleanup-pending')
    this.record('disposing', 'cleanup_started', 'info')
    try {
      await this.runPhase('disposing', this.budgets.disposeTimeoutMs, () => run.dispose())
      this.transitionResourceState('clean')
      this.resourceReason = undefined
      this.record('disposing', 'cleanup_completed', 'info')
    } catch (error) {
      this.transitionResourceState('orphaned')
      this.resourceReason = 'dispose-timeout'
      this.incident('disposing', 'dispose-timeout', 'report', false)
      throw error
    }
  }

  /** Mark a terminal outcome and return a stable lifecycle projection.
   * @param outcome - final review result independent of resource cleanup.
   * @returns immutable lifecycle and resource diagnostics.
   */
  finish(outcome: ReviewerOutcomeStatus): ReviewerLifecycleSummary {
    this.state = 'finished'
    this.outcome = outcome
    this.finished = true
    this.finalizeDiagnosticsIfSettled()
    return this.summary()
  }

  /** Return the current diagnostic projection without ending the controller.
   * @returns the current lifecycle and resource diagnostics.
   */
  summary(): ReviewerLifecycleSummary {
    return {
      id: this.id,
      state: this.state,
      outcome: this.outcome,
      resource: {
        state: this.resourceState,
        ...this.resourceReason === undefined ? {} : { reason: this.resourceReason },
      },
      diagnostics: {
        events: [...this.events],
        incidents: [...this.incidents],
      },
    }
  }

  private watchLateHandle(attempt: Promise<DisposableRun>): void {
    const watcher = this.reclaimLateHandle(attempt)
    this.watchers.add(watcher)
    void watcher.then(
      () => { this.watchers.delete(watcher); this.finalizeDiagnosticsIfSettled() },
      () => { this.watchers.delete(watcher); this.finalizeDiagnosticsIfSettled() },
    )
  }

  private async reclaimLateHandle(attempt: Promise<DisposableRun>): Promise<void> {
    const watcherBudget = this.deadline.phaseBudget(this.budgets.spawnWatcherTimeoutMs)
    if (watcherBudget <= 0) return
    const watcherDeadline = this.now() + watcherBudget
    let watcherTimer: ReturnType<typeof setTimeout> | undefined
    const watcherTimeoutError = new Error('spawn watcher deadline exceeded')
    const timeout = new Promise<never>((_resolve, reject) => {
      watcherTimer = setTimeout(() => {
        reject(watcherTimeoutError)
      }, watcherBudget)
    })
    let run: DisposableRun
    try {
      run = await Promise.race([attempt, timeout])
    } catch (error) {
      if (error === watcherTimeoutError) {
        this.transitionResourceState('unknown')
        this.resourceReason = 'watcher-expired-before-handle'
        this.incident('spawning', 'deadline-exceeded', 'skip', true)
      } else {
        this.transitionResourceState('unknown')
        this.resourceReason = 'late-spawn-rejected'
        this.record('spawning', 'late_spawn_rejected', 'warning')
      }
      return
    } finally {
      if (watcherTimer !== undefined) clearTimeout(watcherTimer)
    }
    this.transitionResourceState('owned')
    this.resourceReason = undefined
    this.record('spawning', 'late_handle_received', 'critical')
    this.transitionResourceState('cleanup-pending')
    const cleanupBudget = Math.min(
      this.budgets.disposeTimeoutMs,
      this.deadline.remaining(),
      Math.max(0, watcherDeadline - this.now()),
    )
    if (cleanupBudget <= 0) {
      this.transitionResourceState('orphaned')
      this.resourceReason = 'late-cleanup-deadline'
      this.incident('disposing', 'dispose-timeout', 'report', false)
      return
    }
    const disposeAttempt = Promise.resolve().then(() => run.dispose())
    const cleanupTimeoutError = new Error('late cleanup deadline exceeded')
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const cleanupTimeout = new Promise<never>((_resolve, reject) => {
      cleanupTimer = setTimeout(() => {
        reject(cleanupTimeoutError)
      }, cleanupBudget)
    })
    try {
      await Promise.race([disposeAttempt, cleanupTimeout])
      this.transitionResourceState('clean')
      this.resourceReason = undefined
      this.record('disposing', 'late_cleanup_completed', 'warning')
    } catch (error) {
      this.transitionResourceState('orphaned')
      const cleanupTimedOut = error === cleanupTimeoutError
      this.resourceReason = cleanupTimedOut ? 'late-dispose-timeout' : 'late-dispose-failed'
      this.incident('disposing', cleanupTimedOut ? 'dispose-timeout' : 'internal-error', 'report', false)
      void disposeAttempt.catch(() => {
        // The bounded watcher owns the late promise after timeout; its rejection is observed here.
      })
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
    }
  }

  private finalizeDiagnosticsIfSettled(): void {
    if (!this.finished || this.diagnosticsFinalized || this.watchers.size > 0) return
    this.diagnosticsFinalized = true
    try {
      this.sink?.finalize(this.summary())
    } catch {
      // Diagnostics must not change the business result or re-enter the reviewer path.
    }
  }

  private transitionResourceState(next: ReviewerResourceState, reason?: string): void {
    try {
      assertReviewerResourceTransition(this.resourceState, next)
    } catch (error) {
      this.resourceReason = 'resource-transition-invariant'
      this.incident('disposing', 'internal-error', 'report', false)
      throw error
    }
    this.resourceState = next
    this.resourceReason = reason
  }
  private phaseTimeout(phase: ReviewerLifecycleState, reason: LifecycleIncidentReason, budget: number): ReviewerLifecycleError {
    this.incident(phase, reason, phase === 'disposing' ? 'report' : 'self-review', true)
    const message = reason === 'model-timeout'
      ? `engineering reviewer timed out after ${Math.ceil(budget)}ms`
      : `${phase} deadline exceeded`
    return new ReviewerLifecycleError(message, phase, reason, this.summary())
  }

  private incident(
    phase: ReviewerLifecycleState,
    reason: LifecycleIncidentReason,
    action: LifecycleIncident['action'],
    recoverable: boolean,
  ): void {
    const incident = { phase, reason, action, recoverable }
    const priority: LifecycleEventPriority = reason === 'dispose-timeout' ? 'critical' : 'warning'
    if (this.acceptDiagnostic('incident', incident, priority)) {
      this.incidents.push(incident)
      try { this.sink?.appendIncident(incident) } catch {
        // A failed diagnostic sink cannot affect reviewer execution.
      }
    }
    this.record(phase, reason, priority)
  }

  private record(phase: ReviewerLifecycleState, event: string, priority: LifecycleEventPriority): void {
    const next: LifecycleEvent = { elapsedMs: Math.max(0, Math.round(this.now() - this.deadline.startTime)), phase, event, priority }
    if (!this.acceptDiagnostic('event', next, priority)) return
    this.events.push(next)
    try { this.sink?.append(next) } catch {
      // A failed diagnostic sink cannot affect reviewer execution.
    }
  }

  private acceptDiagnostic(kind: 'event' | 'incident', value: LifecycleEvent | LifecycleIncident, priority: LifecycleEventPriority): boolean {
    const maxItems = kind === 'event' ? this.diagnosticBudget.maxEvents : this.diagnosticBudget.maxIncidents
    const items = kind === 'event' ? this.events : this.incidents
    if (maxItems <= 0 || this.diagnosticBudget.maxBytes <= 0) return false
    const size = byteSize(value)
    if (size > this.diagnosticBudget.maxBytes) return false
    while (
      (items.length >= maxItems || this.diagnosticBytes() + size > this.diagnosticBudget.maxBytes)
      && this.removeLowPriorityDiagnostic()
    ) { /* make room */ }
    if (items.length >= maxItems || this.diagnosticBytes() + size > this.diagnosticBudget.maxBytes) {
      return priority === 'critical' && kind === 'event' && items.length < maxItems
    }
    return true
  }

  private diagnosticBytes(): number {
    return this.events.reduce((sum, item) => sum + byteSize(item), 0)
      + this.incidents.reduce((sum, item) => sum + byteSize(item), 0)
  }

  private removeLowPriorityDiagnostic(): boolean {
    const eventIndex = this.events.findIndex(item => item.priority === 'info')
    if (eventIndex >= 0) { this.events.splice(eventIndex, 1); return true }
    const incidentIndex = this.incidents.findIndex(item => item.reason !== 'dispose-timeout')
    if (incidentIndex >= 0) { this.incidents.splice(incidentIndex, 1); return true }
    const warningEvent = this.events.findIndex(item => item.priority === 'warning')
    if (warningEvent >= 0) { this.events.splice(warningEvent, 1); return true }
    return false
  }
}

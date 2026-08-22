import { describe, expect, it } from 'vitest'
import { DeadlineContext } from '../src/lifecycle/deadline.ts'
import {
  assertReviewerResourceTransition,
  ReviewerLifecycleController,
  ReviewerResourceTransitionError,
  type ReviewerLifecycleBudgets,
} from '../src/lifecycle/controller.ts'
import type { DiagnosticSink } from '../src/lifecycle/types.ts'

const budgets: ReviewerLifecycleBudgets = {
  prepareTimeoutMs: 20,
  startTimeoutMs: 10,
  spawnWatcherTimeoutMs: 30,
  executionTimeoutMs: 20,
  disposeTimeoutMs: 10,
  totalTimeoutMs: 100,
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((value, fail) => { resolve = value; reject = fail })
  return { promise, resolve, reject }
}

describe('reviewer lifecycle foundation', () => {
  it('enforces the resource ownership FSM', () => {
    expect(() => { assertReviewerResourceTransition('unknown', 'owned') }).not.toThrow()
    expect(() => { assertReviewerResourceTransition('owned', 'cleanup-pending') }).not.toThrow()
    expect(() => { assertReviewerResourceTransition('cleanup-pending', 'clean') }).not.toThrow()
    expect(() => { assertReviewerResourceTransition('cleanup-pending', 'orphaned') }).not.toThrow()
    expect(() => { assertReviewerResourceTransition('unknown', 'orphaned') }).toThrow(ReviewerResourceTransitionError)
    expect(() => { assertReviewerResourceTransition('clean', 'orphaned') }).toThrow(ReviewerResourceTransitionError)
    expect(() => { assertReviewerResourceTransition('clean', 'owned') }).toThrow(ReviewerResourceTransitionError)
  })

  it('records and rejects an invalid runtime resource transition', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets)
    await expect(controller.dispose({ dispose: async () => {} })).rejects.toBeInstanceOf(ReviewerResourceTransitionError)
    expect(controller.summary().resource).toEqual({ state: 'clean', reason: 'resource-transition-invariant' })
    expect(controller.summary().diagnostics.incidents).toContainEqual(expect.objectContaining({ reason: 'internal-error', recoverable: false }))
  })

  it('bounds every phase by the remaining total deadline', () => {
    let now = 1_000
    const deadline = new DeadlineContext(() => now, 15)
    expect(deadline.phaseBudget(60)).toBe(15)
    now += 12
    expect(deadline.remaining()).toBe(3)
    expect(deadline.phaseBudget(60)).toBe(3)
    now += 3
    expect(deadline.expired()).toBe(true)
    expect(deadline.phaseBudget(1)).toBe(0)
  })

  it('returns from a hanging spawn and marks ownership unknown', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets)
    const started = Date.now()
    await expect(controller.spawn(() => new Promise<never>(() => {}))).rejects.toMatchObject({ reason: 'provider-hang' })
    expect(Date.now() - started).toBeLessThan(100)
    expect(controller.summary().resource).toEqual({ state: 'unknown', reason: 'spawn-not-confirmed' })
  })

  it('reclaims a late handle and reports cleanup failure separately', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets)
    const late = deferred<{ dispose(): Promise<void> }>()
    const spawn = controller.spawn(() => late.promise)
    await expect(spawn).rejects.toMatchObject({ reason: 'provider-hang' })
    late.resolve({ dispose: () => new Promise<void>(() => {}) })
    await new Promise(resolve => setTimeout(resolve, 25))
    const summary = controller.summary()
    expect(summary.resource.state).toBe('orphaned')
    expect(summary.diagnostics.events.some(event => event.event === 'late_handle_received')).toBe(true)
    expect(summary.diagnostics.incidents.some(incident => incident.reason === 'dispose-timeout')).toBe(true)
  })

  it('keeps a rejected late spawn in unknown rather than orphaned', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets)
    const late = deferred<{ dispose(): Promise<void> }>()
    const spawn = controller.spawn(() => late.promise)
    await expect(spawn).rejects.toMatchObject({ reason: 'provider-hang' })
    late.reject(new Error('provider rejected after timeout'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(controller.summary().resource).toEqual({ state: 'unknown', reason: 'late-spawn-rejected' })
    expect(controller.summary().diagnostics.events.some(event => event.event === 'late_spawn_rejected')).toBe(true)
  })

  it('keeps watcher expiry in unknown and records the bounded incident', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, { ...budgets, spawnWatcherTimeoutMs: 10 })
    await expect(controller.spawn(() => new Promise<never>(() => {}))).rejects.toMatchObject({ reason: 'provider-hang' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(controller.summary().resource.state).toBe('unknown')
    expect(controller.summary().diagnostics.incidents).toContainEqual(expect.objectContaining({ phase: 'spawning', reason: 'deadline-exceeded' }))
  })

  it('keeps late watcher diagnostics durable after the business result snapshot', async () => {
    const records: string[] = []
    const sink: DiagnosticSink = {
      append: (event) => { records.push(event.event) },
      appendIncident: () => {},
      finalize: (summary) => { records.push('final:' + summary.resource.state) },
    }
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets, undefined, sink)
    const late = deferred<{ dispose(): Promise<void> }>()
    const spawn = controller.spawn(() => late.promise)
    await expect(spawn).rejects.toMatchObject({ reason: 'provider-hang' })
    const result = controller.finish('degraded')
    expect(result.resource.state).toBe('unknown')
    late.resolve({ dispose: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(records).toContain('late_handle_received')
    expect(records.some(value => value.startsWith('final:'))).toBe(true)
  })

  it('bounds late cleanup by the remaining total deadline', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, {
      ...budgets,
      startTimeoutMs: 5,
      totalTimeoutMs: 20,
      disposeTimeoutMs: 100,
    })
    const late = deferred<{ dispose(): Promise<void> }>()
    const started = Date.now()
    const spawn = controller.spawn(() => late.promise)
    await expect(spawn).rejects.toMatchObject({ reason: 'provider-hang' })
    late.resolve({ dispose: () => new Promise<void>(() => {}) })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(Date.now() - started).toBeLessThan(80)
    expect(controller.summary().resource.state).toBe('orphaned')
  })

  it('keeps a successful review result independent from cleanup', async () => {
    const controller = new ReviewerLifecycleController(new AbortController().signal, budgets)
    const run = { dispose: () => new Promise<void>(() => {}) }
    await expect(controller.spawn(async () => run)).resolves.toBe(run)
    await expect(controller.runPhase('executing', 20, async () => 'ok')).resolves.toBe('ok')
    await expect(controller.dispose(run)).rejects.toBeInstanceOf(Error)
    const summary = controller.finish('success')
    expect(summary.outcome).toBe('success')
    expect(summary.resource.state).toBe('orphaned')
  })

  it('stops execution at the total deadline even when the phase budget is larger', async () => {
    const short: ReviewerLifecycleBudgets = { ...budgets, executionTimeoutMs: 100, totalTimeoutMs: 15 }
    const controller = new ReviewerLifecycleController(new AbortController().signal, short)
    const started = Date.now()
    await expect(controller.runPhase('executing', short.executionTimeoutMs, () => new Promise<never>(() => {})))
      .rejects.toMatchObject({ reason: 'model-timeout' })
    expect(Date.now() - started).toBeLessThan(100)
  })
})

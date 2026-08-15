/** Package-owned durable engineering-review invariants. @module @deepseek-ai/dsh-engineering-review/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-engineering-review'

/** Cordis companion plugin name. */
export const name = 'engineering-review-invariant'
/** Services used to validate loaded and appended review events. */
export const inject = ['invariants']

function validate(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'engineering-review/result') return
  const data = event.data as unknown as {
    passed?: unknown
    findings?: readonly { severity?: unknown }[]
    checks?: readonly { status?: unknown; required?: unknown }[]
  }
  const hasBlocker = data.findings?.some(finding => finding.severity === 'blocker') === true
    || data.checks?.some(check => check.required === true && (check.status === 'failed' || check.status === 'unavailable')) === true
  if (typeof data.passed !== 'boolean' || data.passed === hasBlocker) {
    fail('engineering-review/result passed must be the inverse of its deterministic and finding blockers')
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => { for (const event of session.events) validate(event, fail) }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validate(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

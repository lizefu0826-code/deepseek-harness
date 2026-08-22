import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as EngineeringReviewInvariant from '../src/invariant.ts'
import * as HardwareInvariant from '../../engineering-review-hardware/src/invariant.ts'

async function setup(withEventBeforeMount = false): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  const session = ctx.sessions.create(SessionId('engineering-review-invariant-session'))
  if (withEventBeforeMount) {
    session.append('engineering-review/result', {
      fingerprint: 'fp-before', risk: 'low', route: 'checks-only', passed: true, checks: [], findings: [], degradedReasons: [],
    })
  }
  await ctx.plugin(EngineeringReviewInvariant)
  await ctx.plugin(HardwareInvariant)
  return { ctx, session }
}

describe('engineering-review invariant companion', () => {
  it('accepts a consistent review result event on existing and new sessions', async () => {
    const { ctx, session } = await setup(true)
    session.append('engineering-review/result', {
      fingerprint: 'fp-new', risk: 'medium', route: 'checks-only', passed: false,
      checks: [{ id: 'c', status: 'failed', required: true }],
      findings: [], degradedReasons: [],
    })
    await ctx.fiber.dispose()
  })

  it('rejects a review result whose passed flag contradicts its blockers', async () => {
    const { ctx, session } = await setup()
    expect(() => session.append('engineering-review/result', {
      fingerprint: 'fp-bad', risk: 'high', route: 'checks-only', passed: true,
      checks: [{ id: 'c', status: 'failed', required: true }],
      findings: [], degradedReasons: [],
    })).toThrow(/invariant violated/u)
    expect(() => session.append('engineering-review/result', {
      fingerprint: 'fp-bad', risk: 'high', route: 'checks-only', passed: true,
      // The invariant reads only severity; the cast keeps the malformed
      // semantic (blocker + passed:true) expressible against the typed map.
      checks: [], findings: [{ severity: 'blocker' }] as never, degradedReasons: [],
    })).toThrow(/invariant violated/u)
    expect(() => session.append('engineering-review/result', {
      fingerprint: 'fp-bad', risk: 'high', route: 'checks-only', passed: true,
      checks: [{ id: 'c', status: 'unavailable', required: true }],
      findings: [], degradedReasons: [],
    })).toThrow(/invariant violated/u)
    await ctx.fiber.dispose()
  })
})

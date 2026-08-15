/**
 * Benchmark-only candidate injector. The treatment overlay makes this row
 * depend on engineeringReview. Its first request hook runs after every
 * pre-step listener has settled but before provider dispatch, so the blinded
 * candidate appears after the review baseline and before the model sees it.
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'engineering-review-benchmark-candidate-injector'

function absolute(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`engineering-review benchmark: ${field} must be an absolute path`)
  }
  return resolve(value)
}

function changedPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new TypeError('engineering-review benchmark: changedPaths must contain non-empty relative paths')
  }
  return value
}

/** Apply exactly one prevalidated patch at the first root-agent request. */
export function apply(ctx, config) {
  const workspace = absolute(config.workspace, 'workspace')
  const patchPath = absolute(config.patchPath, 'patchPath')
  const markerPath = absolute(config.markerPath, 'markerPath')
  const paths = changedPaths(config.changedPaths)
  const denyManualReview = config.denyManualReview === true
  let injected = false
  if (denyManualReview) {
    ctx.tools.guard(exec => exec.name === 'engineering_review'
      ? 'engineering_review is disabled in this benchmark condition; let the automatic completion gate run'
      : undefined)
  }
  ctx.on('agent/request', async (payload, next) => {
    if (!injected && payload.turn === 1 && payload.step === 1) {
      const cwd = resolve(payload.agent.session.header.cwd ?? '')
      if (cwd !== workspace) throw new Error('engineering-review benchmark: candidate workspace mismatch')
      injected = true
      await execFileAsync('git', ['apply', '--check', patchPath], {
        cwd: workspace,
        windowsHide: true,
      })
      await execFileAsync('git', ['apply', patchPath], {
        cwd: workspace,
        windowsHide: true,
      })
      for (const [index, path] of paths.entries()) {
        const callId = `engineering-review-benchmark-injection-${String(index)}`
        ctx.emit('tools/result', {
          callId,
          rootCallId: callId,
          token: Symbol(callId),
          name: 'edit',
          arguments: { path },
          agent: payload.agent,
          signal: payload.signal,
        }, {
          content: [{ type: 'text', text: 'benchmark candidate injected' }],
          isError: false,
          value: null,
        })
      }
      await writeFile(markerPath, `${JSON.stringify({ injected: true, turn: payload.turn, step: payload.step })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }
    return next()
  })
}

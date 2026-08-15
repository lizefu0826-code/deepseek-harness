/** Read-only Git change fingerprinting and bounded patch extraction. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { runArgv } from './process.ts'

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_BYTES = 4 * 1024 * 1024

/** One repository snapshot sufficient to distinguish pre-existing dirty work. */
export interface GitSnapshot {
  readonly root: string
  readonly pathStates: ReadonlyMap<string, string>
  readonly overflow: boolean
}

async function git(ctx: Context, cwd: string, signal: AbortSignal, args: readonly string[]) {
  return runArgv(ctx, ['git', '--no-optional-locks', ...args], {
    cwd,
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_OUTPUT_BYTES,
    env: GIT_ENV,
  })
}

/**
 * Return the containing Git root, or undefined outside a usable repository.
 * @param ctx - runtime carrying the subprocess service.
 * @param cwd - candidate working directory.
 * @param signal - operation cancellation.
 * @returns absolute Git root, or undefined outside a usable repository.
 */
export async function gitRoot(ctx: Context, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await git(ctx, cwd, signal, ['rev-parse', '--show-toplevel'])
    // v8 ignore next -- a successful rev-parse never emits an empty stdout.
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

function parseStatus(output: string): Map<string, string> {
  const records = output.split('\0')
  const states = new Map<string, string>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    states.set(path, code)
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = records[index + 1]
      // v8 ignore next -- a porcelain status record always carries its rename source after the target.
      if (oldPath !== undefined && oldPath.length > 0) {
        states.set(oldPath, `${code}:source`)
        index += 1
      }
    }
  }
  return states
}

async function pathState(ctx: Context, root: string, path: string, status: string, signal: AbortSignal): Promise<string> {
  const worktree = await git(ctx, root, signal, ['hash-object', '--no-filters', '--', path])
  const index = await git(ctx, root, signal, ['ls-files', '--stage', '--', path])
  // v8 ignore next -- ls-files --stage output always carries the hash column when it succeeds.
  const indexHash = index.exitCode === 0 ? index.stdout.trim().split(/\s+/u)[1] ?? '' : ''
  return `${status}\0${worktree.exitCode === 0 ? worktree.stdout.trim() : '-'}\0${indexHash}`
}

/**
 * Capture dirty-path content and index identities, capped by `maxFiles`.
 * @param ctx - runtime carrying the subprocess service.
 * @param root - absolute repository root.
 * @param signal - operation cancellation.
 * @param maxFiles - maximum status paths to retain.
 * @returns immutable path identities and overflow state.
 */
export async function captureGitSnapshot(
  ctx: Context,
  root: string,
  signal: AbortSignal,
  maxFiles: number,
): Promise<GitSnapshot> {
  const status = await git(ctx, root, signal, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.exitCode !== 0) {
    // v8 ignore next -- git status failures always print a diagnostic to stderr.
    throw new Error(`git status failed: ${status.stderr.trim() || `exit ${status.exitCode}`}`)
  }
  const parsed = parseStatus(status.stdout)
  const paths = [...parsed.keys()].sort()
  const selected = paths.slice(0, maxFiles)
  const pathStates = new Map<string, string>()
  for (const path of selected) {
    pathStates.set(path, await pathState(ctx, root, path, parsed.get(path) as string, signal))
  }
  return { root, pathStates, overflow: paths.length > maxFiles || status.truncated }
}

/**
 * Paths whose dirty/index identities differ between two snapshots.
 * @param before - first-step snapshot.
 * @param after - stopping-boundary snapshot.
 * @returns sorted paths changed during the observed turn.
 */
export function changedGitPaths(before: GitSnapshot, after: GitSnapshot): string[] {
  const paths = new Set([...before.pathStates.keys(), ...after.pathStates.keys()])
  return [...paths].filter(path => before.pathStates.get(path) !== after.pathStates.get(path)).sort()
}

/**
 * Stable fingerprint of the reviewed path states.
 * @param snapshot - current Git snapshot.
 * @param paths - paths selected for this review.
 * @param unknownShellMutation - false/zero for known scope, otherwise the unknown-mutation revision.
 * @returns hexadecimal SHA-256 fingerprint.
 */
export function fingerprintGit(snapshot: GitSnapshot, paths: readonly string[], unknownShellMutation: boolean | number): string {
  const hash = createHash('sha256')
  hash.update(unknownShellMutation === false || unknownShellMutation === 0
    ? 'shell:known\0'
    : `shell:unknown:${String(unknownShellMutation)}\0`)
  for (const path of paths) {
    hash.update(path).update('\0')
    // v8 ignore next -- pathStates always carries every selected path by construction.
    hash.update(snapshot.pathStates.get(path) ?? '-').update('\0')
  }
  return hash.digest('hex')
}

/**
 * Extract staged and unstaged patches for only the reviewed paths.
 * @param ctx - runtime carrying the subprocess service.
 * @param root - absolute repository root.
 * @param paths - selected paths.
 * @param signal - operation cancellation.
 * @param maxBytes - maximum UTF-8 patch bytes.
 * @returns bounded patch text and truncation state.
 */
export async function gitPatch(
  ctx: Context,
  root: string,
  paths: readonly string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ diff: string; truncated: boolean }> {
  if (paths.length === 0) return { diff: '', truncated: false }
  const common = ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', ...paths]
  const unstaged = await git(ctx, root, signal, common)
  const staged = await git(ctx, root, signal, ['--no-pager', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...paths])
  const combined = `${unstaged.stdout}${staged.stdout}`
  const bytes = Buffer.byteLength(combined)
  if (bytes <= maxBytes) return { diff: combined, truncated: unstaged.truncated || staged.truncated }
  return { diff: Buffer.from(combined).subarray(0, maxBytes).toString('utf8'), truncated: true }
}

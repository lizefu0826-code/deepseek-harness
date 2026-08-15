import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import EngineeringReviewRuntime from '../src/index.ts'
import {
  checkApplies,
  discoverStandardChecks,
  loadProjectChecks,
  parseProjectChecks,
  readWorkspaceText,
} from '../src/config.ts'
import {
  admitReviewerFinding,
  changedLineRanges,
  type RawFinding,
} from '../src/reviewer.ts'
import { fingerprintGit, gitRoot, type GitSnapshot } from '../src/git.ts'
import { runArgv } from '../src/process.ts'
import { safeRelativeDirectory, validateCheckRecipe } from '../src/recipe.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function mounted(overrides: { fs?: boolean; subprocess?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  if (overrides.fs !== false) {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-edges-'))
    temporaryDirectories.push(cwd)
    await ctx.plugin(LocalFileSystem, { cwd })
  }
  if (overrides.subprocess !== false) await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

describe('engineering review configuration validation', () => {
  it('rejects non-object roots, untrimmed ids, unknown fields, and invalid field types', () => {
    expect(() => parseProjectChecks('config')).toThrow(/must be an object/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: ' x', argv: ['a'] }] })).toThrow(/non-empty trimmed string/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'], stray: 1 }] })).toThrow(/unknown field/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'], files: 'src' }] })).toThrow(/must be an array/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'], timeoutMs: -1 }] })).toThrow(/must be positive/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'], required: 'yes' }] })).toThrow(/must be boolean/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'], files: ['../escape'] }] })).toThrow(/within the workspace/u)
    expect(() => parseProjectChecks({ version: 1, checks: 'not-an-array' })).toThrow(/checks must be an array/u)
  })

  it('rejects recipe ids with whitespace, empty argv entries, and escaped cwd values', () => {
    expect(() => { validateCheckRecipe({ id: ' x', argv: ['a'] }) }).toThrow(/non-empty and trimmed/u)
    expect(() => { validateCheckRecipe({ id: 'x', argv: ['a', ' '] }) }).toThrow(/invalid argv/u)
    expect(safeRelativeDirectory(undefined)).toBe('.')
    expect(safeRelativeDirectory('.')).toBe('.')
    expect(safeRelativeDirectory('sub\\dir')).toBe('sub/dir')
    expect(() => safeRelativeDirectory('/abs')).toThrow(/within the workspace/u)
    expect(() => safeRelativeDirectory('C:/abs')).toThrow(/within the workspace/u)
    expect(() => safeRelativeDirectory('a/../b')).toThrow(/within the workspace/u)
  })

  it('rejects invalid runtime configuration at mount time', () => {
    expect(() => new EngineeringReviewRuntime(new Context(), { maxDiffBytes: 0 })).toThrow(/positive safe integer/u)
    expect(() => new EngineeringReviewRuntime(new Context(), { maxCorrectionPasses: -1 })).toThrow(/non-negative safe integer/u)
    expect(() => new EngineeringReviewRuntime(new Context(), { subagentProvider: ' ' })).toThrow(/must not be empty/u)
  })

  it('reports an unparsable project configuration file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-config-bad-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    const dir = join(cwd, '.dsh')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'engineering-review.yml'), '::: broken ::: yaml\n', 'utf8')
    await expect(loadProjectChecks(ctx, cwd, new AbortController().signal)).rejects.toThrow(/cannot parse/u)
    await ctx.fiber.dispose()
  })

  it('loads a valid project configuration file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-config-valid-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    const dir = join(cwd, '.dsh')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'engineering-review.yml'), [
      'version: 1',
      'checks:',
      '  - id: unit',
      '    argv: [node, --test]',
      '    required: true',
    ].join('\n'), 'utf8')
    const checks = await loadProjectChecks(ctx, cwd, new AbortController().signal)
    expect(checks).toEqual([{ id: 'unit', argv: ['node', '--test'], required: true }])
    await ctx.fiber.dispose()
  })
})

describe('engineering review workspace reading', () => {
  it('returns undefined for an absent file and rethrows on abort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-read-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    const signal = new AbortController().signal
    expect(await readWorkspaceText(ctx, cwd, 'missing.txt', signal)).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    await expect(readWorkspaceText(ctx, cwd, 'missing.txt', aborted.signal)).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('returns undefined when the filesystem rejects a path without aborting', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-read-bad-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    expect(await readWorkspaceText(ctx, cwd, 'bad\0path', new AbortController().signal)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('engineering review standard check discovery', () => {
  it('discovers manifest-backed scripts for every lockfile manager and depth', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-discover-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    const signal = new AbortController().signal
    const cases: Array<[string, string[], string[], boolean]> = [
      ['pnpm-lock.yaml', ['typecheck', 'lint'], ['pnpm', 'run', 'typecheck'], false],
      ['yarn.lock', ['typecheck', 'lint'], ['yarn', 'run', 'typecheck'], false],
      ['bun.lock', ['typecheck', 'lint'], ['bun', 'run', 'typecheck'], false],
      ['', ['typecheck', 'lint'], ['npm', 'run', 'typecheck'], false],
      ['pnpm-lock.yaml', ['test'], ['pnpm', 'run', 'test'], true],
    ]
    for (const [lockfile, scriptNames, expectedArgv, deep] of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-er-discover-case-'))
      temporaryDirectories.push(dir)
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(scriptNames.map(name => [name, 'true'])) }), 'utf8')
      if (lockfile !== '') await writeFile(join(dir, lockfile), '')
      const checks = await discoverStandardChecks(ctx, dir, deep ? 'deep' : 'fast', signal)
      expect(checks.map(check => check.argv)).toContainEqual(expectedArgv)
      expect(checks.map(check => check.required)).toEqual(checks.map(() => true))
    }
    await ctx.fiber.dispose()
  })

  it('skips non-string scripts, tolerates broken package.json, and falls back to Cargo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-er-discover-cargo-'))
    temporaryDirectories.push(cwd)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(LocalSubprocessRuntime)
    const signal = new AbortController().signal
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { typecheck: 7, lint: 'true' } }), 'utf8')
    expect((await discoverStandardChecks(ctx, cwd, 'fast', signal)).map(check => check.id)).toEqual(['package:lint'])
    await writeFile(join(cwd, 'package.json'), 'not json', 'utf8')
    expect(await discoverStandardChecks(ctx, cwd, 'fast', signal)).toEqual([])
    // A package.json without a scripts section yields no checks on its own.
    await writeFile(join(cwd, 'package.json'), '{}', 'utf8')
    expect(await discoverStandardChecks(ctx, cwd, 'fast', signal)).toEqual([])
    await rm(join(cwd, 'package.json'))
    await writeFile(join(cwd, 'Cargo.toml'), '[package]\n', 'utf8')
    expect((await discoverStandardChecks(ctx, cwd, 'fast', signal)).map(check => check.id)).toEqual(['cargo:check'])
    expect((await discoverStandardChecks(ctx, cwd, 'deep', signal)).map(check => check.id)).toEqual(['cargo:check', 'cargo:test'])
    await ctx.fiber.dispose()
  })
})

describe('engineering review diff span edge cases', () => {
  it('handles empty, quoted, and adjacent-hunk file sections', () => {
    const diff = [
      'diff --git a/a.c b/a.c',
      '--- a/a.c',
      '+++ b/',
      'diff --git a/b.c b/b.c',
      '--- a/b.c',
      '+++ "b/odd\\qpath"',
      '@@ -1,2 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/c.c b/c.c',
      '--- a/c.c',
      '+++ b/c.c',
      '@@ -1,2 +1,2 @@',
      '+one',
      '+two',
      '@@ -3,1 +3,1 @@',
      '+three',
    ].join('\n')
    const ranges = changedLineRanges(diff)
    expect(ranges.get('a.c')).toBeUndefined()
    expect(ranges.get('odd\\qpath')).toEqual([[1, 2]])
    // Adjacent hunks merge into one span.
    expect(ranges.get('c.c')).toEqual([[1, 3]])
  })

  it('admits a finding with a changed-path line through the ranged map', () => {
    const ranges = changedLineRanges('diff --git a/d.c b/d.c\n--- a/d.c\n+++ b/d.c\n@@ -4,1 +4,1 @@\n+x\n')
    const finding: RawFinding = {
      category: 'blocking-and-concurrency', severity: 'high', confidence: 'high', title: 't',
      evidence: [{ path: 'd.c', line: 4, detail: 'd' }],
      impact: 'i', recommendation: 'r', validation: 'v',
    }
    expect(admitReviewerFinding(finding, ['d.c'], ranges)).toBe(true)
  })
})

describe('engineering review process and Git seams', () => {
  it('rejects empty argv entries before spawning', async () => {
    const ctx = await mounted()
    await expect(runArgv(ctx, ['node', ''], {
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 1000, maxOutputBytes: 1024,
    })).rejects.toThrow(/non-empty entries/u)
    await ctx.fiber.dispose()
  })

  it('stops a running process when the caller signal aborts', async () => {
    const ctx = await mounted()
    const controller = new AbortController()
    const run = runArgv(ctx, [process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(), signal: controller.signal, timeoutMs: 10_000, maxOutputBytes: 1024,
    })
    setTimeout(() => { controller.abort() }, 50)
    const result = await run
    expect(result.timedOut).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails a sandboxed check when the policy has no sandbox provider, and confines with one', async () => {
    const ctx = await mounted()
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only' }) } as never)
    await expect(runArgv(ctx, [process.execPath, '-e', '0'], {
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 1000, maxOutputBytes: 1024, sandbox: true,
    })).rejects.toThrow(/has no sandbox provider/u)
    await ctx.fiber.dispose()

    const confined = await mounted()
    let confinedArgv: string[] | undefined
    confined.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only' }) } as never)
    confined.provide('sandbox', { confine(argv: string[]) { confinedArgv = argv; return { argv } } } as never)
    const result = await runArgv(confined, [process.execPath, '-e', '0'], {
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 1000, maxOutputBytes: 1024, sandbox: true,
    })
    expect(result.exitCode).toBe(0)
    expect(confinedArgv).toBeDefined()
    await confined.fiber.dispose()
  })

  it('reports no Git root outside a usable repository', async () => {
    const ctx = await mounted()
    expect(await gitRoot(ctx, join(tmpdir(), 'dsh-er-no-such-repo'), new AbortController().signal)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('treats a zero unknown-shell revision like the known-scope marker', () => {
    const current: GitSnapshot = { root: '/workspace', pathStates: new Map([['main.c', '.M\0work\0index']]), overflow: false }
    expect(fingerprintGit(current, ['main.c'], 0)).toBe(fingerprintGit(current, ['main.c'], false))
  })

  it('matches single-star and question-mark globs', () => {
    const check = { id: 'c', argv: ['t'], files: ['src/?c/*.c'] }
    expect(checkApplies(check, ['src/ac/main.c'])).toBe(true)
    expect(checkApplies(check, ['src/abx/main.c'])).toBe(false)
  })
})

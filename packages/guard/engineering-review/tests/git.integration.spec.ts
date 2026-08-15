import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { captureGitSnapshot, changedGitPaths, gitPatch } from '../src/git.ts'

const runFile = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await runFile('git', args, { cwd, windowsHide: true })
}

describe('engineering review real Git capture', () => {
  it('captures staged, unstaged, untracked, rename, delete, and later edits to dirty files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-git-'))
    temporaryDirectories.push(root)
    await git(root, 'init')
    await git(root, 'config', 'user.email', 'test@example.invalid')
    await git(root, 'config', 'user.name', 'Test')
    for (const name of ['staged.c', 'unstaged.c', 'rename.c', 'delete.c']) await writeFile(join(root, name), 'base\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'base')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const signal = new AbortController().signal
    const clean = await captureGitSnapshot(ctx, root, signal, 100)

    await writeFile(join(root, 'staged.c'), 'staged\n')
    await git(root, 'add', 'staged.c')
    await writeFile(join(root, 'unstaged.c'), 'unstaged\n')
    await writeFile(join(root, 'untracked.sv'), 'module untracked; endmodule\n')
    await rename(join(root, 'rename.c'), join(root, 'renamed.c'))
    await unlink(join(root, 'delete.c'))
    await git(root, 'add', '-A', 'rename.c', 'renamed.c')
    const dirty = await captureGitSnapshot(ctx, root, signal, 100)
    expect(changedGitPaths(clean, dirty)).toEqual(['delete.c', 'rename.c', 'renamed.c', 'staged.c', 'unstaged.c', 'untracked.sv'])

    await writeFile(join(root, 'unstaged.c'), 'edited again\n')
    const dirtier = await captureGitSnapshot(ctx, root, signal, 100)
    expect(changedGitPaths(dirty, dirtier)).toEqual(['unstaged.c'])
  })

  it('extracts empty, complete, and truncated patches for selected paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-git-patch-'))
    temporaryDirectories.push(root)
    await git(root, 'init')
    await git(root, 'config', 'user.email', 'test@example.invalid')
    await git(root, 'config', 'user.name', 'Test')
    await writeFile(join(root, 'main.c'), 'base\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'base')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const signal = new AbortController().signal

    expect(await gitPatch(ctx, root, [], signal, 1024)).toEqual({ diff: '', truncated: false })

    await writeFile(join(root, 'main.c'), 'base\nchanged line\n')
    const complete = await gitPatch(ctx, root, ['main.c'], signal, 1024)
    expect(complete.diff).toContain('+changed line')
    expect(complete.truncated).toBe(false)

    const truncated = await gitPatch(ctx, root, ['main.c'], signal, 10)
    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.diff)).toBeLessThanOrEqual(10)
  })

  it('reports a failed git status as an error snapshot capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-git-fail-'))
    temporaryDirectories.push(root)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(captureGitSnapshot(ctx, root, new AbortController().signal, 100)).rejects.toThrow(/git status failed/u)
  })
})

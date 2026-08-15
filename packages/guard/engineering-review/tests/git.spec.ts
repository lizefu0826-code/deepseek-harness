import { describe, expect, it } from 'vitest'
import { changedGitPaths, fingerprintGit, type GitSnapshot } from '../src/git.ts'

function snapshot(entries: Record<string, string>, overflow = false): GitSnapshot {
  return { root: '/workspace', pathStates: new Map(Object.entries(entries)), overflow }
}

describe('engineering review Git fingerprint', () => {
  it('ignores unchanged pre-existing dirty paths and identifies a later edit', () => {
    const before = snapshot({ 'old.c': '.M\0aaa\0index-a' })
    const unchanged = snapshot({ 'old.c': '.M\0aaa\0index-a' })
    const edited = snapshot({ 'old.c': '.M\0bbb\0index-a' })
    expect(changedGitPaths(before, unchanged)).toEqual([])
    expect(changedGitPaths(before, edited)).toEqual(['old.c'])
  })

  it('distinguishes staged, untracked, rename-source, and deleted identities', () => {
    const before = snapshot({
      'staged.c': 'M.\0work\0old-index',
      'old.v': 'R.:source\0-\0old-index',
      'gone.c': '.M\0work\0index',
    })
    const after = snapshot({
      'staged.c': 'M.\0work\0new-index',
      'new.v': 'R.\0work-new\0new-index',
      'old.v': 'R.:source\0-\0old-index',
      'untracked.sv': '??\0blob\0',
      'gone.c': '.D\0-\0index',
    })
    expect(changedGitPaths(before, after)).toEqual(['gone.c', 'new.v', 'staged.c', 'untracked.sv'])
  })

  it('deduplicates the same path state and rekeys unknown shell scope', () => {
    const current = snapshot({ 'main.c': '.M\0work\0index' })
    const first = fingerprintGit(current, ['main.c'], false)
    expect(fingerprintGit(current, ['main.c'], false)).toBe(first)
    expect(fingerprintGit(current, ['main.c'], true)).not.toBe(first)
    expect(fingerprintGit(current, ['main.c'], 2)).not.toBe(fingerprintGit(current, ['main.c'], 1))
  })
})

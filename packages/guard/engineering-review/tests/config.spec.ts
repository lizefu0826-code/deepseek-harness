import { describe, expect, it } from 'vitest'
import { checkApplies, parseProjectChecks } from '../src/config.ts'

describe('engineering review project configuration', () => {
  it('accepts versioned exact-argv checks', () => {
    expect(parseProjectChecks({
      version: 1,
      checks: [{ id: 'unit', argv: ['pnpm', 'test'], cwd: 'firmware', files: ['**/*.c'], timeoutMs: 5000, required: true }],
    })).toEqual([{
      id: 'unit', argv: ['pnpm', 'test'], cwd: 'firmware', files: ['**/*.c'], timeoutMs: 5000, required: true,
    }])
  })

  it('rejects command shells, mutating checks, path escape, duplicates, and unknown versions', () => {
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: [] }] })).toThrow(/non-empty array/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['bash', '-lc', 'test'] }] })).toThrow(/command shell/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['pnpm', 'install'] }] })).toThrow(/installation/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['eslint', '--fix'] }] })).toThrow(/mutation/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['tool'], cwd: '../outside' }] })).toThrow(/workspace/u)
    expect(() => parseProjectChecks({ version: 1, checks: [{ id: 'x', argv: ['a'] }, { id: 'x', argv: ['b'] }] })).toThrow(/duplicate/u)
    expect(() => parseProjectChecks({ version: 2, checks: [] })).toThrow(/version: 1/u)
  })

  it('matches path globs without admitting sibling directories', () => {
    const check = { id: 'c', argv: ['tool'], files: ['firmware/**/*.c'] }
    expect(checkApplies(check, ['firmware/src/main.c'])).toBe(true)
    expect(checkApplies(check, ['other/src/main.c'])).toBe(false)
  })
})

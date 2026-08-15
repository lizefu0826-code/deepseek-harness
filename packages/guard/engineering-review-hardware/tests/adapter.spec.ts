import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EngineeringReviewAdapter, EngineeringReviewRequest } from '@deepseek-ai/dsh-engineering-review'
import { apply } from '../src/index.ts'

function request(paths: string[], files: string[], diff = ''): EngineeringReviewRequest {
  return {
    agent: {} as never,
    signal: new AbortController().signal,
    cwd: '/workspace',
    fingerprint: 'fp',
    changedPaths: paths,
    diff,
    diffTruncated: false,
    depth: 'fast',
    readText: path => Promise.resolve(files.includes(path) ? '' : undefined),
    hasFile: path => Promise.resolve(files.includes(path)),
  }
}

describe('hardware engineering review adapter', () => {
  it('adds C focus and clang-tidy only with an existing compilation database', async () => {
    let adapter: EngineeringReviewAdapter | undefined
    const ctx = new Context()
    ctx.provide('engineeringReview', { registerAdapter(value: EngineeringReviewAdapter) { adapter = value; return () => {} } } as never)
    apply(ctx)
    const withoutDb = await adapter?.contribute(request(['src/uart.c'], []), new AbortController().signal)
    const withDb = await adapter?.contribute(request(['src/uart.c'], ['compile_commands.json']), new AbortController().signal)
    expect(withoutDb?.checks).toEqual([])
    expect(withDb?.checks?.map(check => check.id)).toEqual(['hardware:clang-tidy'])
    expect(withDb?.focus).toContain('blocking paths and bounded progress')
  })

  it('marks HDL high risk and uses only an existing Verilator argument file', async () => {
    let adapter: EngineeringReviewAdapter | undefined
    const ctx = new Context()
    ctx.provide('engineeringReview', { registerAdapter(value: EngineeringReviewAdapter) { adapter = value; return () => {} } } as never)
    apply(ctx)
    const contribution = await adapter?.contribute(request(['rtl/cdc.sv'], ['verilator.f']), new AbortController().signal)
    expect(contribution?.riskSignals?.[0]?.risk).toBe('high')
    expect(contribution?.checks?.[0]?.argv).toEqual(['verilator', '--lint-only', '-f', 'verilator.f'])
  })

  it('raises hardware polling without an observable bound above bounded polling', async () => {
    let adapter: EngineeringReviewAdapter | undefined
    const ctx = new Context()
    ctx.provide('engineeringReview', { registerAdapter(value: EngineeringReviewAdapter) { adapter = value; return () => {} } } as never)
    apply(ctx)
    const unbounded = await adapter?.contribute(request(
      ['src/uart.c'],
      [],
      '+ while ((uart->status & UART_READY) == 0u) {\n+ }',
    ), new AbortController().signal)
    const bounded = await adapter?.contribute(request(
      ['src/uart.c'],
      [],
      '+ while ((uart->status & UART_READY) == 0u) {\n+   if (elapsed > timeout) return -1;\n+ }',
    ), new AbortController().signal)
    expect(unbounded?.riskSignals?.[0]?.risk).toBe('high')
    expect(bounded?.riskSignals?.[0]?.risk).toBe('medium')
  })

  it('does not contribute to unrelated languages', async () => {
    let adapter: EngineeringReviewAdapter | undefined
    const ctx = new Context()
    ctx.provide('engineeringReview', { registerAdapter(value: EngineeringReviewAdapter) { adapter = value; return () => {} } } as never)
    apply(ctx)
    await expect(adapter?.contribute(request(['src/app.py'], []), new AbortController().signal)).resolves.toBeUndefined()
  })
})

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasBlockingFinding, parseAssistantFindingReport, scoreFindings } from '../src/cli.ts'
import { apply as applyCandidateInjector } from '../src/candidate-injector.mjs'

const manifest = {
  schemaVersion: 1,
  id: 'sample',
  domain: 'embedded',
  difficulty: 'standard',
  riskTags: ['timeout'],
  taskFile: 'task.md',
  variants: {
    buggy: { patch: 'buggy.patch', expectedOracle: 'fail', expectedFindings: ['timeout'] },
    fixed: { patch: 'fixed.patch', expectedOracle: 'pass', forbiddenFindings: ['timeout'] },
  },
  gold: [{
    id: 'timeout',
    category: 'timeout-and-recovery',
    path: 'driver.c',
    anchor: 'wait_ready',
    lineRange: [7, 9],
    minimumSeverity: 'high',
  }],
  oracle: { argv: ['node', 'oracle.mjs'], timeoutMs: 1000, unavailableExitCode: 77, fixEligible: true },
} as Parameters<typeof scoreFindings>[0]

describe('engineering-review benchmark report protocol', () => {
  it('parses the final marked report and assigns a stable id when omitted', () => {
    const output = `prose\n<engineering-review-benchmark>\n{"findings":[{"category":"timeout-and-recovery","severity":"high","title":"Unbounded wait","evidence":[{"path":"driver.c","line":8}]}]}\n</engineering-review-benchmark>`
    const first = parseAssistantFindingReport(output)
    const second = parseAssistantFindingReport(output)
    expect(first.status).toBe('parsed')
    expect(first.result?.findings[0]?.id).toMatch(/^assistant-[0-9a-f]{12}$/u)
    expect(second.result?.findings[0]?.id).toBe(first.result?.findings[0]?.id)
  })

  it('guards the manual review tool in treatment without hiding automatic review', () => {
    const guards: Array<(exec: { name: string }) => string | undefined> = []
    const ctx = {
      tools: { guard: (guard: (exec: { name: string }) => string | undefined) => { guards.push(guard) } },
      on: () => undefined,
    }
    applyCandidateInjector(ctx, {
      workspace: resolve('workspace'),
      patchPath: resolve('candidate.patch'),
      markerPath: resolve('injected.json'),
      changedPaths: ['driver.c'],
      denyManualReview: true,
    })
    expect(guards).toHaveLength(1)
    expect(guards[0]?.({ name: 'engineering_review' })).toMatch(/automatic completion gate/u)
    expect(guards[0]?.({ name: 'read' })).toBeUndefined()
  })

  it('distinguishes missing and invalid reports', () => {
    expect(parseAssistantFindingReport('ordinary prose')).toEqual({ status: 'missing' })
    expect(parseAssistantFindingReport('<engineering-review-benchmark>{}</engineering-review-benchmark>')).toEqual({ status: 'invalid' })
  })

  it('requires the declared minimum severity for a gold match', () => {
    const finding = (severity: string) => [{ findings: [{
      id: severity,
      category: 'timeout-and-recovery',
      severity,
      title: 'Unbounded wait',
      evidence: [{ path: 'driver.c', line: 8 }],
    }] }]
    expect(scoreFindings(manifest, 'buggy', finding('high')).bugRecall).toBe(1)
    expect(scoreFindings(manifest, 'buggy', finding('medium')).bugRecall).toBe(0)
    expect(scoreFindings(manifest, 'buggy', finding('medium')).findingScores[0]?.status).toBe('unmatched')
  })

  it('accepts only explicitly declared cross-category equivalents', () => {
    const crossCategory = structuredClone(manifest)
    crossCategory.gold[0].acceptableCategories = ['boundaries-and-data-integrity']
    const result = [{ findings: [{
      id: 'boundary-timeout',
      category: 'boundaries-and-data-integrity',
      severity: 'high',
      title: 'Unbounded wait at boundary',
      evidence: [{ path: 'driver.c', line: 8 }],
    }] }]
    expect(scoreFindings(crossCategory, 'buggy', result).bugRecall).toBe(1)
    crossCategory.gold[0].acceptableCategories = []
    expect(scoreFindings(crossCategory, 'buggy', result).bugRecall).toBe(0)
  })

  it('scores successful fixes against residual findings instead of the original defect', () => {
    const cleanFinalReview = [{ findings: [] }]
    const result = scoreFindings(manifest, 'buggy', cleanFinalReview, [])
    expect(result.expectedGoldFindings).toBe(0)
    expect(result.bugRecall).toBeNull()
    expect(result.findingPrecision).toBeNull()
  })

  it('recognizes high and critical reports as blocking without promoting medium warnings', () => {
    const result = (severity: string) => [{ findings: [{ severity }] }]
    expect(hasBlockingFinding(result('critical'))).toBe(true)
    expect(hasBlockingFinding(result('high'))).toBe(true)
    expect(hasBlockingFinding(result('medium'))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { admitReviewerFinding, normalizeReviewerFinding, type RawFinding } from '../src/reviewer.ts'

function finding(severity: RawFinding['severity'], confidence: RawFinding['confidence']): RawFinding {
  return {
    category: 'blocking-and-concurrency', severity, confidence, title: 'Unbounded wait',
    evidence: [{ path: 'driver.c', line: 42, detail: 'Loop has no timeout or cancellation path.' }],
    impact: 'A failed device can stall the worker forever.',
    recommendation: 'Use a bounded deadline and propagate the failure.',
    validation: 'Exercise a device that never becomes ready.',
  }
}

describe('engineering reviewer finding mapping', () => {
  it('blocks only high-confidence critical/high findings', () => {
    expect(normalizeReviewerFinding(finding('critical', 'high')).severity).toBe('blocker')
    expect(normalizeReviewerFinding(finding('high', 'high')).severity).toBe('blocker')
    expect(normalizeReviewerFinding(finding('high', 'medium')).severity).toBe('warning')
    expect(normalizeReviewerFinding(finding('medium', 'high')).severity).toBe('warning')
  })

  it('assigns a stable evidence-derived id', () => {
    const first = normalizeReviewerFinding(finding('high', 'high'))
    expect(normalizeReviewerFinding(finding('high', 'high')).id).toBe(first.id)
  })

  it('admits only high-confidence material findings with evidence on a changed line', () => {
    expect(admitReviewerFinding(finding('high', 'high'), ['driver.c'])).toBe(true)
    expect(admitReviewerFinding(finding('high', 'medium'), ['driver.c'])).toBe(false)
    expect(admitReviewerFinding(finding('medium', 'high'), ['driver.c'])).toBe(false)
    expect(admitReviewerFinding(finding('high', 'high'), ['other.c'])).toBe(false)
    const missingLine = finding('high', 'high')
    missingLine.evidence = [{ path: 'driver.c', detail: 'No changed line supplied.' }]
    expect(admitReviewerFinding(missingLine, ['driver.c'])).toBe(false)
  })
})

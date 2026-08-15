import { describe, expect, it } from 'vitest'
import { admitReviewerFinding, changedLineRanges, normalizeReviewerFinding, type RawFinding } from '../src/reviewer.ts'

function finding(severity: RawFinding['severity'], confidence: RawFinding['confidence']): RawFinding {
  return {
    category: 'blocking-and-concurrency', severity, confidence, title: 'Unbounded wait',
    evidence: [{ path: 'driver.c', line: 42, detail: 'Loop has no timeout or cancellation path.' }],
    impact: 'A failed device can stall the worker forever.',
    recommendation: 'Use a bounded deadline and propagate the failure.',
    validation: 'Exercise a device that never becomes ready.',
  }
}

const SAMPLE_DIFF = [
  'diff --git a/driver.c b/driver.c',
  'index 1111111..2222222 100644',
  '--- a/driver.c',
  '+++ b/driver.c',
  '@@ -5,3 +5,4 @@',
  '  context',
  '+added-line-6',
  '-removed-line',
  '  context',
  '@@ -20,2 +21,2 @@',
  '  unchanged',
  '+second-hunk-added',
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1,2 @@',
  '+note-one',
  '+note-two',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-gone-one',
  '-gone-two',
  '-gone-three',
].join('\n')

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

  it('parses new-side changed line spans from a unified diff', () => {
    const ranges = changedLineRanges(SAMPLE_DIFF)
    expect(ranges.get('driver.c')).toEqual([[5, 7], [21, 22]])
    expect(ranges.get('notes.txt')).toEqual([[1, 2]])
    // The deleted file has no new-side lines and no recorded span.
    expect(ranges.get('gone.txt')).toBeUndefined()
  })

  it('strips the b/ prefix from Git-quoted new-side paths', () => {
    const ranges = changedLineRanges([
      'diff --git a/foo bar.c b/foo bar.c',
      '--- a/foo bar.c',
      '+++ "b/foo bar.c"',
      '@@ -1,1 +1,1 @@',
      '+changed',
    ].join('\n'))
    expect(ranges.get('foo bar.c')).toEqual([[1, 1]])
    expect(ranges.get('b/foo bar.c')).toBeUndefined()
  })

  it('rejects evidence citing a pre-existing line of a changed file inside its hunks', () => {
    const ranges = changedLineRanges(SAMPLE_DIFF)
    const oldLine = finding('high', 'high')
    oldLine.evidence = [{ path: 'driver.c', line: 15, detail: 'An untouched pre-existing line.' }]
    expect(admitReviewerFinding(oldLine, ['driver.c'], ranges)).toBe(false)
  })

  it('admits evidence inside an added or context line of the change', () => {
    const ranges = changedLineRanges(SAMPLE_DIFF)
    const added = finding('high', 'high')
    added.evidence = [{ path: 'driver.c', line: 6, detail: 'The added wait loop.' }]
    expect(admitReviewerFinding(added, ['driver.c'], ranges)).toBe(true)
    const context = finding('high', 'high')
    context.evidence = [{ path: 'driver.c', line: 5, detail: 'Context line in the hunk.' }]
    expect(admitReviewerFinding(context, ['driver.c'], ranges)).toBe(true)
    const hunkEdge = finding('high', 'high')
    hunkEdge.evidence = [{ path: 'driver.c', line: 22, detail: 'Last changed line of the second hunk.' }]
    expect(admitReviewerFinding(hunkEdge, ['driver.c'], ranges)).toBe(true)
  })

  it('keeps file-level admission for touched files without hunks and for missing diffs', () => {
    const ranges = changedLineRanges(SAMPLE_DIFF)
    const untracked = finding('high', 'high')
    untracked.evidence = [{ path: 'new_file.c', line: 9, detail: 'Untracked content the Git diff does not carry.' }]
    expect(admitReviewerFinding(untracked, ['new_file.c'], ranges)).toBe(true)
    // No ranges argument: unchanged legacy behavior.
    expect(admitReviewerFinding(finding('high', 'high'), ['driver.c'])).toBe(true)
  })
})

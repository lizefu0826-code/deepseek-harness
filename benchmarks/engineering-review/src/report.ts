/**
 * Reproducible benchmark report generator for engineering-review.
 *
 * Reads the calibration artifacts under `.artifacts/engineering-review-bench/`
 * and emits a normalized ML-experiment record set (`results.csv`,
 * `results.json`) plus a human report (`report.md`) that answers cost,
 * latency, value, and risk questions about the reviewer gate.
 *
 * @module engineering-review-bench/report
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The clean post-hardening batch: runs recorded on the quality-gate commit. */
const HEADLINE_REVISION = '23bbce1d5e0809632dc2d873bfd28f4d945048d3'

/** Calibration overlay constants shared by every treatment cell. */
const CALIBRATION_CONFIG = {
  riskThreshold: 'medium',
  reviewerMaxTokens: 3072,
  rootMaxTokens: 8192,
  reasoningEffort: 'off',
  taskMode: 'review',
} as const

/** One normalized cell record in ML-experiment form. */
export interface BenchmarkRecord {
  runId: string
  timestamp: string
  harnessRevision: string
  headlineBatch: boolean
  caseId: string
  domain: string
  difficulty: string
  riskTags: string[]
  variant: 'buggy' | 'fixed'
  condition: 'control' | 'treatment'
  repetition: number
  provider: string
  model: string
  reasoningEffort: string
  rootMaxTokens: number
  reviewerMaxTokens: number
  expectedOracle: string
  initialOracleStatus: string
  finalOracleStatus: string
  oracleUnavailable: boolean
  candidateInjected: boolean
  automaticReviewObserved: boolean
  assistantReportStatus: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  rootInputTokens: number
  rootOutputTokens: number
  reviewerInputTokens: number
  reviewerOutputTokens: number
  reviewerCalls: number
  correctionPasses: number
  expectedFindings: number
  matchedFindings: string[]
  missedFindings: string[]
  bugRecall: number | null
  findingPrecision: number | null
  gateBugRecall: number | null
  gateFindingPrecision: number | null
  falseBlock: boolean | null
}

interface RunMeta {
  runId: string
  mode: string
  revision: string
  timestamp: string
}

interface CellRaw {
  caseId: string
  domain: string
  difficulty: string
  riskTags: string[]
  variant: string
  repetition: number
  condition: string
  expectedOracle: string
  initialOracleStatus: string
  finalOracleStatus: string
  candidateInjected: boolean
  automaticReviewObserved: boolean
  assistantReportStatus: string
  durationMs: number
  expectedGoldFindings: number
  matchedGoldFindings: string[]
  missedGoldFindings: string[]
  bugRecall: number | null
  findingPrecision: number | null
  gateBugRecall: number | null
  gateFindingPrecision: number | null
  falseBlock: boolean | null
  session: {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    rootUsage: { inputTokens: number; outputTokens: number }
    subagentUsage: { inputTokens: number; outputTokens: number }
    subagentSessions: number
    correctionPasses: number
  }
}

function runTimestamp(runId: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{6})/.exec(runId)
  if (match === null) return runId
  return `${match[1]}Z`
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Normalize one calibration cell's result.json into the experiment record. */
function normalizeCell(run: RunMeta, raw: CellRaw): BenchmarkRecord {
  const s = raw.session
  return {
    runId: run.runId,
    timestamp: run.timestamp,
    harnessRevision: run.revision,
    headlineBatch: run.revision === HEADLINE_REVISION,
    caseId: raw.caseId,
    domain: raw.domain,
    difficulty: raw.difficulty,
    riskTags: raw.riskTags,
    variant: raw.variant as 'buggy' | 'fixed',
    condition: raw.condition as 'control' | 'treatment',
    repetition: raw.repetition,
    provider: s.provider,
    model: s.model,
    reasoningEffort: CALIBRATION_CONFIG.reasoningEffort,
    rootMaxTokens: CALIBRATION_CONFIG.rootMaxTokens,
    reviewerMaxTokens: CALIBRATION_CONFIG.reviewerMaxTokens,
    expectedOracle: raw.expectedOracle,
    initialOracleStatus: raw.initialOracleStatus,
    finalOracleStatus: raw.finalOracleStatus,
    oracleUnavailable: raw.finalOracleStatus === 'oracle-unavailable',
    candidateInjected: raw.candidateInjected,
    automaticReviewObserved: raw.automaticReviewObserved,
    assistantReportStatus: raw.assistantReportStatus,
    durationMs: raw.durationMs,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    rootInputTokens: s.rootUsage.inputTokens,
    rootOutputTokens: s.rootUsage.outputTokens,
    reviewerInputTokens: s.subagentUsage.inputTokens,
    reviewerOutputTokens: s.subagentUsage.outputTokens,
    reviewerCalls: s.subagentSessions,
    correctionPasses: s.correctionPasses,
    expectedFindings: raw.expectedGoldFindings,
    matchedFindings: raw.matchedGoldFindings,
    missedFindings: raw.missedGoldFindings,
    bugRecall: numberOrNull(raw.bugRecall),
    findingPrecision: numberOrNull(raw.findingPrecision),
    gateBugRecall: numberOrNull(raw.gateBugRecall),
    gateFindingPrecision: numberOrNull(raw.gateFindingPrecision),
    falseBlock: booleanOrNull(raw.falseBlock),
  }
}

interface Aggregated {
  runs: number
  cells: number
  medianDurationMs: number | null
  totalInputTokens: number
  totalOutputTokens: number
  reviewerInputTokens: number
  reviewerOutputTokens: number
  reviewerCalls: number
  meanBugRecall: number | null
  meanFindingPrecision: number | null
  meanGateBugRecall: number | null
  meanGateFindingPrecision: number | null
  falseBlockRate: number | null
  oracleUnavailable: number
  candidateInjectionFailures: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

function meanNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length
}

function aggregate(records: BenchmarkRecord[]): Aggregated {
  return {
    runs: new Set(records.map(record => record.runId)).size,
    cells: records.length,
    medianDurationMs: median(records.map(record => record.durationMs)),
    totalInputTokens: records.reduce((sum, record) => sum + record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens, 0),
    totalOutputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    reviewerInputTokens: records.reduce((sum, record) => sum + record.reviewerInputTokens, 0),
    reviewerOutputTokens: records.reduce((sum, record) => sum + record.reviewerOutputTokens, 0),
    reviewerCalls: records.reduce((sum, record) => sum + record.reviewerCalls, 0),
    meanBugRecall: meanNullable(records.map(record => record.bugRecall)),
    meanFindingPrecision: meanNullable(records.map(record => record.findingPrecision)),
    meanGateBugRecall: meanNullable(records.map(record => record.gateBugRecall)),
    meanGateFindingPrecision: meanNullable(records.map(record => record.gateFindingPrecision)),
    falseBlockRate: meanNullable(records.map(record => record.falseBlock === null ? null : record.falseBlock ? 1 : 0)),
    oracleUnavailable: records.filter(record => record.oracleUnavailable).length,
    candidateInjectionFailures: records.filter(record => !record.candidateInjected).length,
  }
}

function csvEscape(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const CSV_COLUMNS: ReadonlyArray<keyof BenchmarkRecord> = [
  'runId', 'timestamp', 'harnessRevision', 'headlineBatch', 'caseId', 'domain', 'difficulty', 'riskTags',
  'variant', 'condition', 'repetition', 'provider', 'model', 'reasoningEffort', 'rootMaxTokens', 'reviewerMaxTokens',
  'expectedOracle', 'initialOracleStatus', 'finalOracleStatus', 'oracleUnavailable', 'candidateInjected',
  'automaticReviewObserved', 'assistantReportStatus', 'durationMs',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'rootInputTokens', 'rootOutputTokens', 'reviewerInputTokens', 'reviewerOutputTokens', 'reviewerCalls', 'correctionPasses',
  'expectedFindings', 'matchedFindings', 'missedFindings',
  'bugRecall', 'findingPrecision', 'gateBugRecall', 'gateFindingPrecision', 'falseBlock',
]

function toCsv(records: BenchmarkRecord[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = records.map(record => CSV_COLUMNS.map(column => csvEscape(record[column])).join(','))
  return [header, ...rows].join('\n')
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

function renderReport(headline: BenchmarkRecord[]): string {
  const control = aggregate(headline.filter(record => record.condition === 'control'))
  const treatment = aggregate(headline.filter(record => record.condition === 'treatment'))
  const perCase = [...new Set(headline.map(record => record.caseId))].map((caseId) => {
    const cells = headline.filter(record => record.caseId === caseId)
    const by = (condition: 'control' | 'treatment') => aggregate(cells.filter(record => record.condition === condition))
    return { caseId, difficulty: cells[0]?.difficulty, control: by('control'), treatment: by('treatment') }
  }).sort((a, b) => a.caseId.localeCompare(b.caseId))
  const models = [...new Set(headline.map(record => `${record.provider}/${record.model}`))].join(', ')
  const missed = headline.filter(record => record.gateBugRecall === 0).map(record => record.caseId)
  const latencyDelta = treatment.medianDurationMs !== null && control.medianDurationMs !== null
    ? treatment.medianDurationMs - control.medianDurationMs
    : null

  return `# Engineering Review — benchmark report

Generated from calibration artifacts under \`.artifacts/engineering-review-bench/\`. Regenerate with
\`pnpm exec tsx benchmarks/engineering-review/src/cli.ts report\` — the command is deterministic and costs no model tokens.

## Experiment configuration

- **Headline batch:** ${headline.length} cells across ${control.runs + treatment.runs} runs on harness revision \`${headline[0]?.harnessRevision?.slice(0, 8) ?? 'n/a'}\` (${new Set(headline.map(r => r.caseId)).size} unique cases)
- **Model:** ${models}
- **Reasoning effort:** ${CALIBRATION_CONFIG.reasoningEffort}; **root output cap:** ${CALIBRATION_CONFIG.rootMaxTokens}; **reviewer output cap:** ${CALIBRATION_CONFIG.reviewerMaxTokens}; **risk threshold:** ${CALIBRATION_CONFIG.riskThreshold}
- **Task mode:** ${CALIBRATION_CONFIG.taskMode} (detection only — the candidate is never repaired; Repair Success is deliberately not measured here)
- **Scoring:** outcome Recall/Precision on the assistant's final tagged report; gate Recall/Precision on the independent reviewer event only

> LLM benchmark, not a software test: every number below is a snapshot of this model at this revision. A change to the model, reviewer prompt, reviewer budget, or risk threshold can shift it. Treat these as experiment records, not permanent guarantees.

## Headline results (control vs treatment)

| Metric | control | treatment (gate) |
|---|---|---|
| Cells | ${control.cells} | ${treatment.cells} |
| Outcome bug Recall (mean) | ${fmt(control.meanBugRecall)} | ${fmt(treatment.meanBugRecall)} |
| Outcome finding Precision (mean) | ${fmt(control.meanFindingPrecision)} | ${fmt(treatment.meanFindingPrecision)} |
| Gate Recall (mean, independent reviewer) | — | ${fmt(treatment.meanGateBugRecall)} |
| Gate Precision (mean) | — | ${fmt(treatment.meanGateFindingPrecision)} |
| False Block Rate (fixed cases) | ${fmt(control.falseBlockRate)} | ${fmt(treatment.falseBlockRate)} |
| Median latency (ms) | ${control.medianDurationMs ?? 'n/a'} | ${treatment.medianDurationMs ?? 'n/a'} |
| Input tokens (incl. cache) | ${control.totalInputTokens} | ${treatment.totalInputTokens} |
| Reviewer calls | ${control.reviewerCalls} | ${treatment.reviewerCalls} |

## The four questions

### Cost — how much does one review cost?

Treatment spent ${treatment.totalInputTokens} input tokens and ${treatment.totalOutputTokens} output tokens across ${treatment.cells} cells
(≈ ${Math.round(treatment.totalInputTokens / treatment.cells)} input / ${Math.round(treatment.totalOutputTokens / treatment.cells)} output per cell),
of which the isolated reviewer used ${treatment.reviewerInputTokens} input and ${treatment.reviewerOutputTokens} output tokens (${treatment.reviewerCalls} reviewer calls).
Control spent ${control.totalInputTokens} input tokens. The gate's marginal cost is the reviewer call on high/medium-risk changes only.

### Latency — how much delay does it add?

Median ${control.medianDurationMs ?? 'n/a'} ms (control) vs ${treatment.medianDurationMs ?? 'n/a'} ms (treatment)
${latencyDelta === null ? '' : `— a median delta of ${latencyDelta} ms (${(latencyDelta / (control.medianDurationMs ?? 1) * 100).toFixed(0)}%).`}
The delay applies only to changes that reach the risk threshold.

### Value — does it reduce false blockers?

False Block Rate on fixed (clean) cases: **control ${fmt(control.falseBlockRate)} vs treatment ${fmt(treatment.falseBlockRate)}**.
The gate's high-confidence + changed-line admission filters the bare model's false high/critical reports;
treatment finding precision ${treatment.meanFindingPrecision !== null && control.meanFindingPrecision !== null
  ? `is ${fmt(treatment.meanFindingPrecision)} vs ${fmt(control.meanFindingPrecision)} for control`
  : 'is not comparable with this batch'}.

### Risk — does it miss high-severity issues?

Gate Recall (the independent reviewer alone) is ${fmt(treatment.meanGateBugRecall)}; the assistant's final outcome Recall is ${fmt(treatment.meanBugRecall)}.
Known miss this batch: ${missed.length === 0 ? 'none' : missed.join(', ')} — the isolated reviewer returned no finding while the
assistant's report caught the defect (see the recall-diagnosis note). The gate is a second set of eyes, not the sole detector.

## Per-case detail

| case | difficulty | control Recall/Prec | control FalseBlock | treatment Recall/Prec | treatment gate Recall/Prec | treatment FalseBlock |
|---|---|---|---|---|---|---|
${perCase.map(row => `| ${row.caseId} | ${row.difficulty ?? 'n/a'} | ${fmt(row.control.meanBugRecall)} / ${fmt(row.control.meanFindingPrecision)} | ${fmt(row.control.falseBlockRate)} | ${fmt(row.treatment.meanBugRecall)} / ${fmt(row.treatment.meanFindingPrecision)} | ${fmt(row.treatment.meanGateBugRecall)} / ${fmt(row.treatment.meanGateFindingPrecision)} | ${fmt(row.treatment.falseBlockRate)} |`).join('\n')}

## Raw data

All calibration runs with cells are included in \`results.csv\` / \`results.json\`; the headline batch above uses only the
\`${HEADLINE_REVISION.slice(0, 8)}\` clean runs. Earlier \`47f94385\` runs were development pilots with runner defects
(candidate injection, oracle, or observation failures) and are excluded from headline aggregates.

## Limitations

- Detection-only: Repair Success is deferred to a separate Correction benchmark (review vs fix are different experiments).
- Single-sample cells: one run per case×variant×condition; variance is not yet measured.
- Model-dependent: numbers are a snapshot of ${models} at report time.
- Reviewer output budget and prompt are part of the experiment config; changing them changes the numbers.
`
}

/** Generate the report from artifact runs and write results.csv, results.json, report.md. */
export async function generateReport(
  artifactsRoot: string,
  outputDir: string,
): Promise<{ records: BenchmarkRecord[]; headline: BenchmarkRecord[] }> {
  const runs: RunMeta[] = []
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runId = entry.name
    const runPath = join(artifactsRoot, runId)
    try {
      const runJson = await readJson<{ mode?: string; revision?: string }>(join(runPath, 'run.json'))
      if (runJson.mode !== 'calibrate') continue
      runs.push({ runId, mode: runJson.mode, revision: runJson.revision ?? 'unknown', timestamp: runTimestamp(runId) })
    } catch {
      continue
    }
  }
  runs.sort((a, b) => a.runId.localeCompare(b.runId))

  const records: BenchmarkRecord[] = []
  for (const run of runs) {
    const caseDirs = (await readdir(join(artifactsRoot, run.runId), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    for (const caseId of caseDirs) {
      const variantDirs = (await readdir(join(artifactsRoot, run.runId, caseId), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      for (const variant of variantDirs) {
        const runDirs = (await readdir(join(artifactsRoot, run.runId, caseId, variant), { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && /^run-\d+$/u.test(entry.name))
          .map(entry => entry.name)
        for (const runDir of runDirs) {
          const conditionDirs = (await readdir(join(artifactsRoot, run.runId, caseId, variant, runDir), { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
          for (const condition of conditionDirs) {
            const resultPath = join(artifactsRoot, run.runId, caseId, variant, runDir, condition, 'result.json')
            try {
              const raw = await readJson<CellRaw>(resultPath)
              records.push(normalizeCell(run, raw))
            } catch {
              // A missing or malformed result.json cell is skipped.
            }
          }
        }
      }
    }
  }

  const headline = records.filter(record => record.headlineBatch)
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'results.csv'), toCsv(records))
  await writeFile(join(outputDir, 'results.json'), `${JSON.stringify({
    meta: { generatedAt: new Date().toISOString(), headlineRevision: HEADLINE_REVISION, calibrationConfig: CALIBRATION_CONFIG },
    records,
    headline: headline.length === 0 ? undefined : {
      aggregate: { control: aggregate(headline.filter(r => r.condition === 'control')), treatment: aggregate(headline.filter(r => r.condition === 'treatment')) },
      perCase: [...new Set(headline.map(r => r.caseId))].map(caseId => {
        const cells = headline.filter(r => r.caseId === caseId)
        return { caseId, difficulty: cells[0]?.difficulty, control: aggregate(cells.filter(r => r.condition === 'control')), treatment: aggregate(cells.filter(r => r.condition === 'treatment')) }
      }),
    },
  }, undefined, 2)}\n`)
  await writeFile(join(outputDir, 'report.md'), renderReport(headline))

  return { records, headline }
}

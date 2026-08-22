/** Manual engineering-review corpus validator and external-oracle runner. */

import { spawn } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { appendFile, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { generateReport } from './report.js'

const REVIEW_CATEGORIES = [
  'blocking-and-concurrency',
  'resources-and-lifecycle',
  'timeout-and-recovery',
  'boundaries-and-data-integrity',
  'performance-and-real-time',
  'state-consistency-and-compatibility',
  'security-and-safety',
  'observability-and-verification',
  'hdl-clock-reset-and-cdc',
  'hdl-width-and-sequential-semantics',
] as const

type EngineeringFindingCategory = typeof REVIEW_CATEGORIES[number]

type Domain = 'embedded' | 'hdl' | 'backend'
type Difficulty = 'standard' | 'combined' | 'advanced'
type VariantName = 'buggy' | 'fixed'
type ExpectedOracle = 'pass' | 'fail'
type OracleStatus = 'passed' | 'failed' | 'oracle-unavailable'

interface VariantSpec {
  patch: string
  expectedOracle: ExpectedOracle
  expectedFindings?: readonly string[]
  forbiddenFindings?: readonly string[]
}

interface GoldFinding {
  id: string
  category: EngineeringFindingCategory
  acceptableCategories?: readonly EngineeringFindingCategory[]
  path: string
  anchor: string
  lineRange: readonly [number, number]
  minimumSeverity: 'critical' | 'high' | 'medium' | 'low'
}

interface CaseManifest {
  schemaVersion: 1
  id: string
  domain: Domain
  difficulty: Difficulty
  riskTags: readonly string[]
  taskFile: string
  variants: Record<VariantName, VariantSpec>
  gold: readonly GoldFinding[]
  oracle: {
    argv: readonly string[]
    timeoutMs: number
    unavailableExitCode: number
    fixEligible: boolean
  }
}

interface ProcessResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

interface VariantResult {
  caseId: string
  domain: Domain
  difficulty: Difficulty
  riskTags: readonly string[]
  variant: VariantName
  expectedOracle: ExpectedOracle
  oracleStatus: OracleStatus
  durationMs: number
  patchSha256: string
  stdout: string
  stderr: string
}

type Condition = 'control' | 'treatment'
type TaskMode = 'fix' | 'review'
type AssistantReportStatus = 'not-requested' | 'parsed' | 'missing' | 'invalid'

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface SessionSummary {
  provider?: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  rootUsage: TokenUsage
  subagentUsage: TokenUsage
  subagentSessions: number
  engineeringResults: unknown[]
  correctionPasses: number
  finalBlockerReportRequested: boolean
  toolCalls: number
  toolNames: string[]
  manualReviewToolCalls: number
  assistantMessages: number
}

interface CalibrationResult {
  caseId: string
  domain: Domain
  difficulty: Difficulty
  riskTags: readonly string[]
  variant: VariantName
  repetition: number
  condition: Condition
  taskMode: TaskMode
  expectedOracle: ExpectedOracle
  initialOracleStatus: OracleStatus
  finalOracleStatus: OracleStatus
  commandExitCode: number | null
  commandTimedOut: boolean
  candidateInjected: boolean
  durationMs: number
  patchSha256: string
  finalDiffSha256: string
  changedPaths: string[]
  unrelatedChangedPaths: string[]
  fixSuccess: boolean | null
  regression: boolean | null
  falseBlock: boolean | null
  automaticReviewObserved: boolean | null
  findingSource: 'engineering-event' | 'assistant-report'
  assistantReportStatus: AssistantReportStatus
  expectedGoldFindings: number
  matchedGoldFindings: string[]
  missedGoldFindings: string[]
  findingScores: FindingScore[]
  bugRecall: number | null
  findingPrecision: number | null
  manualReviewFindings: number
  gateBugRecall: number | null
  gateFindingPrecision: number | null
  gateMatchedGoldFindings: string[]
  gateFindingScores: FindingScore[]
  session: SessionSummary
}

interface FindingScore {
  findingId: string
  title: string
  status: 'matched' | 'unmatched' | 'manual-review'
  goldId?: string
}

interface AssistantFindingReport {
  status: Exclude<AssistantReportStatus, 'not-requested'>
  result?: { findings: Record<string, unknown>[] }
}

const repoRoot = resolve(import.meta.dirname, '../../..')
const benchmarkRoot = resolve(import.meta.dirname, '..')
const casesRoot = join(benchmarkRoot, 'cases')
const artifactRoot = join(repoRoot, '.artifacts', 'engineering-review-bench')
const builtCli = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const candidateInjector = join(benchmarkRoot, 'src', 'candidate-injector.mjs')
const MAX_CAPTURE_BYTES = 64 * 1024
const MODEL_RUN_TIMEOUT_MS = 8 * 60_000
const ASSISTANT_REPORT_BEGIN = '<engineering-review-benchmark>'
const ASSISTANT_REPORT_END = '</engineering-review-benchmark>'

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${subject} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${subject} must be a non-empty string`)
  return value
}

function integer(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${subject} must be a positive integer`)
  return value as number
}

function strings(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${subject} must be an array of non-empty strings`)
  }
  return value
}

function safePath(root: string, value: unknown, subject: string): string {
  const path = string(value, subject)
  if (isAbsolute(path)) throw new Error(`${subject} must be relative`)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${subject} escapes its case directory`)
  return target
}

function variant(value: unknown, caseRoot: string, subject: string): VariantSpec {
  const raw = record(value, subject)
  const expectedOracle = string(raw.expectedOracle, `${subject}.expectedOracle`)
  if (expectedOracle !== 'pass' && expectedOracle !== 'fail') throw new Error(`${subject}.expectedOracle must be pass or fail`)
  const patch = relative(caseRoot, safePath(caseRoot, raw.patch, `${subject}.patch`)).split(sep).join('/')
  return {
    patch,
    expectedOracle,
    ...raw.expectedFindings === undefined ? {} : { expectedFindings: strings(raw.expectedFindings, `${subject}.expectedFindings`) },
    ...raw.forbiddenFindings === undefined ? {} : { forbiddenFindings: strings(raw.forbiddenFindings, `${subject}.forbiddenFindings`) },
  }
}

/** Parse and validate one case-owned YAML interface. */
export async function readManifest(caseRoot: string): Promise<CaseManifest> {
  const raw = record(load(await readFile(join(caseRoot, 'case.yaml'), 'utf8')), 'case.yaml')
  if (raw.schemaVersion !== 1) throw new Error('case.yaml schemaVersion must be 1')
  const domain = string(raw.domain, 'case.yaml.domain')
  if (domain !== 'embedded' && domain !== 'hdl' && domain !== 'backend') throw new Error('case.yaml.domain is unsupported')
  const difficulty = string(raw.difficulty, 'case.yaml.difficulty')
  if (difficulty !== 'standard' && difficulty !== 'combined' && difficulty !== 'advanced') {
    throw new Error('case.yaml.difficulty must be standard, combined, or advanced')
  }
  const riskTags = strings(raw.riskTags, 'case.yaml.riskTags')
  if (riskTags.length === 0) throw new Error('case.yaml.riskTags must not be empty')
  if (new Set(riskTags).size !== riskTags.length) throw new Error('case.yaml.riskTags must not contain duplicates')
  const variants = record(raw.variants, 'case.yaml.variants')
  const gold = Array.isArray(raw.gold) ? raw.gold.map((value, index): GoldFinding => {
    const item = record(value, `case.yaml.gold[${String(index)}]`)
    const lineRange = item.lineRange
    if (!Array.isArray(lineRange) || lineRange.length !== 2 || lineRange.some(line => !Number.isSafeInteger(line) || (line as number) <= 0)) {
      throw new Error(`case.yaml.gold[${String(index)}].lineRange must contain two positive integers`)
    }
    const minimumSeverity = string(item.minimumSeverity, `case.yaml.gold[${String(index)}].minimumSeverity`)
    if (!['critical', 'high', 'medium', 'low'].includes(minimumSeverity)) {
      throw new Error(`case.yaml.gold[${String(index)}].minimumSeverity is unsupported`)
    }
    const category = string(item.category, `case.yaml.gold[${String(index)}].category`)
    if (!REVIEW_CATEGORIES.includes(category as EngineeringFindingCategory)) {
      throw new Error(`case.yaml.gold[${String(index)}].category is unsupported`)
    }
    const acceptableCategories = item.acceptableCategories === undefined
      ? undefined
      : strings(item.acceptableCategories, `case.yaml.gold[${String(index)}].acceptableCategories`)
        .map((candidate) => {
          if (!REVIEW_CATEGORIES.includes(candidate as EngineeringFindingCategory)) {
            throw new Error(`case.yaml.gold[${String(index)}].acceptableCategories contains an unsupported category`)
          }
          return candidate as EngineeringFindingCategory
        })
    if (acceptableCategories !== undefined && new Set(acceptableCategories).size !== acceptableCategories.length) {
      throw new Error(`case.yaml.gold[${String(index)}].acceptableCategories must not contain duplicates`)
    }
    return {
      id: string(item.id, `case.yaml.gold[${String(index)}].id`),
      category: category as EngineeringFindingCategory,
      ...acceptableCategories === undefined ? {} : { acceptableCategories },
      path: string(item.path, `case.yaml.gold[${String(index)}].path`),
      anchor: string(item.anchor, `case.yaml.gold[${String(index)}].anchor`),
      lineRange: lineRange as unknown as readonly [number, number],
      minimumSeverity: minimumSeverity as GoldFinding['minimumSeverity'],
    }
  }) : []
  const oracle = record(raw.oracle, 'case.yaml.oracle')
  const argv = strings(oracle.argv, 'case.yaml.oracle.argv')
  if (argv.length === 0) throw new Error('case.yaml.oracle.argv must not be empty')
  safePath(caseRoot, raw.taskFile, 'case.yaml.taskFile')
  safePath(caseRoot, 'workspace', 'case.yaml workspace')
  return {
    schemaVersion: 1,
    id: string(raw.id, 'case.yaml.id'),
    domain,
    difficulty,
    riskTags,
    taskFile: string(raw.taskFile, 'case.yaml.taskFile'),
    variants: {
      buggy: variant(variants.buggy, caseRoot, 'case.yaml.variants.buggy'),
      fixed: variant(variants.fixed, caseRoot, 'case.yaml.variants.fixed'),
    },
    gold,
    oracle: {
      argv,
      timeoutMs: integer(oracle.timeoutMs, 'case.yaml.oracle.timeoutMs'),
      unavailableExitCode: integer(oracle.unavailableExitCode, 'case.yaml.oracle.unavailableExitCode'),
      fixEligible: oracle.fixEligible === true,
    },
  }
}

async function runProcess(argv: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, env, shell: false, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    const capture = (target: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - current)
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      return current + chunk.byteLength
    }
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = capture(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = capture(stderr, chunk, stderrBytes) })
    child.once('error', reject)
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.unref()
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      resolveProcess({
        exitCode,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess(['git', ...args], cwd, 20_000)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
}

async function prepareVariant(
  caseRoot: string,
  spec: VariantSpec,
  applyCandidate = true,
): Promise<{ root: string; workspace: string; patchSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-review-bench-'))
  try {
    const workspace = join(root, 'workspace')
    await cp(join(caseRoot, 'workspace'), workspace, { recursive: true })
    await git(workspace, ['init'])
    await git(workspace, ['config', 'user.email', 'engineering-review-bench@example.invalid'])
    await git(workspace, ['config', 'user.name', 'Engineering Review Benchmark'])
    await git(workspace, ['config', 'core.autocrlf', 'false'])
    await git(workspace, ['add', '.'])
    await git(workspace, ['commit', '-m', 'benchmark base'])
    const patchPath = join(caseRoot, spec.patch)
    const patch = await readFile(patchPath)
    await git(workspace, ['apply', '--check', patchPath])
    if (applyCandidate) await git(workspace, ['apply', patchPath])
    return { root, workspace, patchSha256: createHash('sha256').update(patch).digest('hex') }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function runOracle(
  manifest: CaseManifest,
  caseRoot: string,
  workspace: string,
  artifactDirectory: string,
): Promise<{ status: OracleStatus; result: ProcessResult; durationMs: number }> {
  await mkdir(artifactDirectory, { recursive: true })
  const started = performance.now()
  const result = await runProcess(manifest.oracle.argv, caseRoot, manifest.oracle.timeoutMs, {
    ...process.env,
    ER_BENCH_WORKSPACE: workspace,
    ER_BENCH_CASE_DIR: caseRoot,
    ER_BENCH_ARTIFACT_DIR: artifactDirectory,
  })
  return {
    status: oracleStatus(result, manifest.oracle.unavailableExitCode),
    result,
    durationMs: Math.round(performance.now() - started),
  }
}

async function caseDirectories(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(casesRoot, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(casesRoot, entry.name)).sort()
}

function oracleStatus(result: ProcessResult, unavailableExitCode: number): OracleStatus {
  if (result.exitCode === unavailableExitCode) return 'oracle-unavailable'
  return result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed'
}

async function repositoryRevision(): Promise<string> {
  const result = await runProcess(['git', 'rev-parse', 'HEAD'], repoRoot, 10_000)
  return result.exitCode === 0 ? result.stdout.trim() : 'unknown'
}

async function validate(): Promise<void> {
  const revision = await repositoryRevision()
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${revision.slice(0, 12)}`
  const runArtifacts = join(artifactRoot, runId)
  await mkdir(runArtifacts, { recursive: true })
  await writeFile(join(runArtifacts, 'run.json'), `${JSON.stringify({
    runId,
    mode: 'validate',
    revision,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }, undefined, 2)}\n`)
  const seen = new Set<string>()
  const difficultyCounts: Record<Difficulty, number> = { standard: 0, combined: 0, advanced: 0 }
  let unavailable = 0
  let variants = 0
  for (const caseRoot of await caseDirectories()) {
    const manifest = await readManifest(caseRoot)
    if (seen.has(manifest.id)) throw new Error(`duplicate case id ${JSON.stringify(manifest.id)}`)
    seen.add(manifest.id)
    difficultyCounts[manifest.difficulty] += 1
    if (basename(caseRoot) !== manifest.id) throw new Error(`case directory ${basename(caseRoot)} must equal id ${manifest.id}`)
    for (const variantName of ['buggy', 'fixed'] as const) {
      variants += 1
      const spec = manifest.variants[variantName]
      const prepared = await prepareVariant(caseRoot, spec)
      const variantArtifacts = join(runArtifacts, manifest.id, variantName)
      await mkdir(variantArtifacts, { recursive: true })
      const started = performance.now()
      try {
        const result = await runProcess(manifest.oracle.argv, caseRoot, manifest.oracle.timeoutMs, {
          ...process.env,
          ER_BENCH_WORKSPACE: prepared.workspace,
          ER_BENCH_CASE_DIR: caseRoot,
          ER_BENCH_ARTIFACT_DIR: variantArtifacts,
        })
        const status = oracleStatus(result, manifest.oracle.unavailableExitCode)
        if (status === 'oracle-unavailable') unavailable += 1
        const expectedStatus = spec.expectedOracle === 'pass' ? 'passed' : 'failed'
        if (status !== 'oracle-unavailable' && status !== expectedStatus) {
          throw new Error(`${manifest.id}/${variantName} oracle was ${status}, expected ${expectedStatus}:\n${result.stderr}`)
        }
        const row: VariantResult = {
          caseId: manifest.id,
          domain: manifest.domain,
          difficulty: manifest.difficulty,
          riskTags: manifest.riskTags,
          variant: variantName,
          expectedOracle: spec.expectedOracle,
          oracleStatus: status,
          durationMs: Math.round(performance.now() - started),
          patchSha256: prepared.patchSha256,
          stdout: result.stdout,
          stderr: result.stderr,
        }
        await appendFile(join(runArtifacts, 'results.jsonl'), `${JSON.stringify(row)}\n`)
        process.stdout.write(`${manifest.id}/${variantName}: ${status}\n`)
      } finally {
        await rm(prepared.root, { recursive: true, force: true })
      }
    }
  }
  process.stdout.write(`validated ${String(seen.size)} case family(s), ${String(variants)} variant(s), ${String(unavailable)} oracle-unavailable; difficulty=${JSON.stringify(difficultyCounts)}\n`)
  process.stdout.write(`${runArtifacts}\n`)
}

function yamlString(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'))
}

function calibrationOverlay(
  condition: Condition,
  taskMode: TaskMode,
  workspace: string,
  patchPath: string,
  markerPath: string,
  sessionRoot: string,
  injectorPath: string,
  changedPaths: readonly string[],
): string {
  const reviewRows = condition === 'treatment' ? `
    - id: engineering-review
      name: '@deepseek-ai/dsh-engineering-review'
      config:
        automatic: true
        riskThreshold: medium
        maxCorrectionPasses: ${taskMode === 'review' ? '0' : '2'}
        maxDiffBytes: 524288
        maxFiles: 100
        checkTimeoutMs: 120000
        subagentProvider: spawn
        reviewerMaxTokens: 3072
    - id: engineering-review-hardware
      name: '@deepseek-ai/dsh-engineering-review-hardware'
` : ''
  const injectorDependency = condition === 'treatment' ? '\n      inject: [engineeringReview, tools]' : ''
  return `# Generated benchmark overlay; contains paths but never credentials.
- id: llm-deepseek
  config:
    reasoningEffort: off
    maxTokens: 8192

- id: session-persistence-jsonl
  config:
    root: ${yamlString(sessionRoot)}
    packChunks: false
    compression: none

- insert:${reviewRows}
    - id: engineering-review-benchmark-candidate
      name: ${yamlString(pathToFileURL(injectorPath).href)}${injectorDependency}
      config:
        workspace: ${yamlString(workspace)}
        patchPath: ${yamlString(patchPath)}
        markerPath: ${yamlString(markerPath)}
        changedPaths: ${JSON.stringify(changedPaths)}
        denyManualReview: ${condition === 'treatment' ? 'true' : 'false'}
`
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await visit(root)
  return found.sort()
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

async function summarizeSessions(sessionRoot: string): Promise<SessionSummary> {
  const logs = (await filesBelow(sessionRoot)).filter(path => path.endsWith('.jsonl'))
  const sessions: Array<{ header: Record<string, unknown>; events: Record<string, unknown>[] }> = []
  for (const path of logs) {
    const rows = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const [header, ...events] = rows
    if (header?.type === 'session') sessions.push({ header, events })
  }
  const rootSession = sessions.find(session => session.header.origin !== 'subagent')
  const rootEvents = rootSession?.events ?? []
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  const rootUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const subagentUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let provider: string | undefined
  let model: string | undefined
  for (const session of sessions) {
    for (const event of session.events) {
      const data = record(event.data, 'session event data')
      if (event.type === 'request/context') {
        if (typeof data.provider === 'string') provider ??= data.provider
        if (typeof data.model === 'string') model ??= data.model
      }
      if (event.type !== 'assistant/message') continue
      const usage = typeof data.usage === 'object' && data.usage !== null ? data.usage as Record<string, unknown> : {}
      const target = session.header.origin === 'subagent' ? subagentUsage : rootUsage
      const messageInputTokens = finiteToken(usage.inputTokens)
      const messageOutputTokens = finiteToken(usage.outputTokens)
      const messageCacheReadTokens = finiteToken(usage.cacheReadTokens)
      const messageCacheWriteTokens = finiteToken(usage.cacheWriteTokens)
      inputTokens += messageInputTokens
      outputTokens += messageOutputTokens
      cacheReadTokens += messageCacheReadTokens
      cacheWriteTokens += messageCacheWriteTokens
      target.inputTokens += messageInputTokens
      target.outputTokens += messageOutputTokens
      target.cacheReadTokens += messageCacheReadTokens
      target.cacheWriteTokens += messageCacheWriteTokens
    }
  }
  const notices = rootEvents.flatMap((event) => {
    if (event.type !== 'user/message') return []
    const data = record(event.data, 'user message data')
    const source = typeof data.source === 'object' && data.source !== null ? data.source as Record<string, unknown> : {}
    return source.plugin === 'engineering-review' && typeof source.summary === 'string' ? [source.summary] : []
  })
  const toolNames = rootEvents.filter(event => event.type === 'tool/call').map((event) => {
    const data = record(event.data, 'tool call data')
    return typeof data.name === 'string' ? data.name : '(unknown)'
  })
  return {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    rootUsage,
    subagentUsage,
    subagentSessions: sessions.filter(session => session.header.origin === 'subagent').length,
    engineeringResults: rootEvents.filter(event => event.type === 'engineering-review/result').map(event => event.data),
    correctionPasses: notices.filter(notice => notice.startsWith('Correction pass ')).length,
    finalBlockerReportRequested: notices.includes('Final blocker report required'),
    toolCalls: toolNames.length,
    toolNames,
    manualReviewToolCalls: toolNames.filter(name => name === 'engineering_review').length,
    assistantMessages: rootEvents.filter(event => event.type === 'assistant/message').length,
  }
}

function normalizeEvidencePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '')
}

/** Parse the bounded machine-readable finding report requested in review mode. */
export function parseAssistantFindingReport(output: string): AssistantFindingReport {
  const begin = output.lastIndexOf(ASSISTANT_REPORT_BEGIN)
  if (begin < 0) return { status: 'missing' }
  const contentStart = begin + ASSISTANT_REPORT_BEGIN.length
  const end = output.indexOf(ASSISTANT_REPORT_END, contentStart)
  if (end < 0) return { status: 'invalid' }
  try {
    const raw = JSON.parse(output.slice(contentStart, end).trim()) as unknown
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Record<string, unknown>).findings)) {
      return { status: 'invalid' }
    }
    const findings = (raw as Record<string, unknown>).findings as unknown[]
    if (findings.some(finding => typeof finding !== 'object' || finding === null || Array.isArray(finding))) {
      return { status: 'invalid' }
    }
    return {
      status: 'parsed',
      result: {
        findings: findings.map((value) => {
          const finding = value as Record<string, unknown>
          if (typeof finding.id === 'string' && finding.id.length > 0) return finding
          const id = `assistant-${createHash('sha256').update(JSON.stringify(finding)).digest('hex').slice(0, 12)}`
          return { ...finding, id }
        }),
      },
    }
  } catch {
    return { status: 'invalid' }
  }
}

function severityRank(value: unknown): number {
  if (value === 'critical') return 4
  if (value === 'high' || value === 'blocker') return 3
  if (value === 'medium') return 2
  if (value === 'low' || value === 'warning') return 1
  return 0
}

/** Return whether structured review output contains a high-confidence blocking severity. */
export function hasBlockingFinding(engineeringResults: readonly unknown[]): boolean {
  return engineeringResults.some((result) => {
    if (typeof result !== 'object' || result === null) return false
    const findings = (result as Record<string, unknown>).findings
    return Array.isArray(findings) && findings.some((finding) =>
      typeof finding === 'object'
      && finding !== null
      && severityRank((finding as Record<string, unknown>).severity) >= severityRank('high'))
  })
}

export function scoreFindings(
  manifest: CaseManifest,
  variant: VariantName,
  engineeringResults: readonly unknown[],
  expectedFindingIds: readonly string[] = manifest.variants[variant].expectedFindings ?? [],
): Pick<CalibrationResult,
  'expectedGoldFindings' | 'matchedGoldFindings' | 'missedGoldFindings' | 'findingScores'
  | 'bugRecall' | 'findingPrecision' | 'manualReviewFindings'> {
  const expectedIds = new Set(expectedFindingIds)
  const expectedGold = manifest.gold.filter(gold => expectedIds.has(gold.id))
  const matchedGold = new Set<string>()
  const seenFindings = new Set<string>()
  const findingScores: FindingScore[] = []
  for (const result of engineeringResults) {
    if (typeof result !== 'object' || result === null) continue
    const findings = (result as Record<string, unknown>).findings
    if (!Array.isArray(findings)) continue
    for (const rawFinding of findings) {
      if (typeof rawFinding !== 'object' || rawFinding === null) continue
      const finding = rawFinding as Record<string, unknown>
      const findingId = typeof finding.id === 'string' ? finding.id : '(missing-id)'
      if (seenFindings.has(findingId)) continue
      seenFindings.add(findingId)
      const title = typeof finding.title === 'string' ? finding.title : '(untitled finding)'
      if (expectedGold.length === 0) {
        findingScores.push({ findingId, title, status: 'unmatched' })
        continue
      }
      const category = typeof finding.category === 'string' ? finding.category : undefined
      const eligibleGold = expectedGold.filter(gold => severityRank(finding.severity) >= severityRank(gold.minimumSeverity))
      const categoryMatches = (gold: GoldFinding): boolean => category === gold.category
        || gold.acceptableCategories?.includes(category as EngineeringFindingCategory) === true
      const evidence = Array.isArray(finding.evidence) ? finding.evidence.flatMap((value) => {
        if (typeof value !== 'object' || value === null) return []
        const item = value as Record<string, unknown>
        if (typeof item.path !== 'string') return []
        return [{ path: normalizeEvidencePath(item.path), line: typeof item.line === 'number' ? item.line : undefined }]
      }) : []
      const exact = eligibleGold.find(gold => categoryMatches(gold) && evidence.some(item =>
        item.path === normalizeEvidencePath(gold.path)
        && item.line !== undefined
        && item.line >= gold.lineRange[0]
        && item.line <= gold.lineRange[1]))
      if (exact !== undefined) {
        matchedGold.add(exact.id)
        findingScores.push({ findingId, title, status: 'matched', goldId: exact.id })
        continue
      }
      const fuzzy = eligibleGold.find(gold => categoryMatches(gold) && evidence.some(item =>
        item.path === normalizeEvidencePath(gold.path)))
      findingScores.push({
        findingId,
        title,
        status: fuzzy === undefined ? 'unmatched' : 'manual-review',
        ...fuzzy === undefined ? {} : { goldId: fuzzy.id },
      })
    }
  }
  const matchedGoldFindings = [...matchedGold].sort()
  const missedGoldFindings = expectedGold.map(gold => gold.id).filter(id => !matchedGold.has(id)).sort()
  const conclusive = findingScores.filter(score => score.status !== 'manual-review')
  return {
    expectedGoldFindings: expectedGold.length,
    matchedGoldFindings,
    missedGoldFindings,
    findingScores,
    bugRecall: expectedGold.length === 0 ? null : matchedGoldFindings.length / expectedGold.length,
    findingPrecision: conclusive.length === 0 ? null : conclusive.filter(score => score.status === 'matched').length / conclusive.length,
    manualReviewFindings: findingScores.filter(score => score.status === 'manual-review').length,
  }
}

function patchPaths(patch: string): string[] {
  return [...new Set(patch.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('+++ b/')) return []
    return [line.slice('+++ b/'.length).trim()]
  }))].sort()
}

function shuffledConditions(): Condition[] {
  return randomInt(2) === 0 ? ['control', 'treatment'] : ['treatment', 'control']
}

async function copyHarnessCredentials(sourceHome: string, targetHome: string): Promise<string> {
  const source = join(sourceHome, '.credentials.yaml')
  const parsed = record(load(await readFile(source, 'utf8')), 'Harness managed credentials')
  if (typeof parsed.DEEPSEEK_API_KEY !== 'string' || parsed.DEEPSEEK_API_KEY.trim().length === 0) {
    throw new Error('Harness managed credentials do not contain a non-empty DEEPSEEK_API_KEY')
  }
  const target = join(targetHome, '.credentials.yaml')
  await copyFile(source, target)
  await chmod(target, 0o600)
  const settings = join(sourceHome, 'settings.yaml')
  try {
    await copyFile(settings, join(targetHome, 'settings.yaml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return parsed.DEEPSEEK_API_KEY
}

async function changedPaths(workspace: string): Promise<string[]> {
  const result = await runProcess(['git', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', 'HEAD'], workspace, 20_000)
  if (result.exitCode !== 0) throw new Error(`git diff --name-only failed: ${result.stderr}`)
  return result.stdout.split(/\r?\n/u).map(path => path.trim()).filter(Boolean).sort()
}

async function finalPatch(workspace: string): Promise<string> {
  const result = await runProcess(['git', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'], workspace, 20_000)
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr}`)
  return result.stdout
}

async function runCalibrationCondition(options: {
  manifest: CaseManifest
  caseRoot: string
  variant: VariantName
  repetition: number
  condition: Condition
  taskMode: TaskMode
  runArtifacts: string
  sourceHome: string
  managedKey: string
  initialOracleStatus: OracleStatus
}): Promise<CalibrationResult> {
  const spec = options.manifest.variants[options.variant]
  const prepared = await prepareVariant(options.caseRoot, spec, false)
  const conditionArtifacts = join(options.runArtifacts, options.manifest.id, options.variant, `run-${String(options.repetition)}`, options.condition)
  await mkdir(conditionArtifacts, { recursive: true })
  const runHome = join(prepared.root, 'home')
  const sessionRoot = join(runHome, 'sessions')
  const markerPath = join(runHome, 'candidate-injected.json')
  await mkdir(runHome, { recursive: true })
  await copyHarnessCredentials(options.sourceHome, runHome)
  const injectorPath = join(runHome, 'candidate-injector.mjs')
  await copyFile(candidateInjector, injectorPath)
  const overlayPath = join(runHome, 'benchmark-overlay.yml')
  const patchPath = join(options.caseRoot, spec.patch)
  const expectedPaths = patchPaths(await readFile(patchPath, 'utf8'))
  await writeFile(
    overlayPath,
    calibrationOverlay(options.condition, options.taskMode, prepared.workspace, patchPath, markerPath, sessionRoot, injectorPath, expectedPaths),
    'utf8',
  )
  const caseTask = await readFile(join(options.caseRoot, options.manifest.taskFile), 'utf8')
  const task = options.taskMode === 'fix'
    ? caseTask
    : `Review the candidate implementation for engineering correctness. Do not modify files or run commands that change files. Report only critical/high correctness defects with concrete changed-file line evidence.\n\nEngineering task and requirements:\n${caseTask.trim()}\n\nThis is a review-only run. Do not follow any instruction above to modify files. When an engineering review completion gate is present, let it run automatically. Do not call engineering_review manually.\n\nEnd the final response with exactly this machine-readable block, using an empty findings array when there is no qualifying defect:\n${ASSISTANT_REPORT_BEGIN}\n{"findings":[{"id":"short-stable-id","category":"one category listed below","severity":"critical or high","confidence":"high, medium, or low","title":"concise title","evidence":[{"path":"workspace-relative path","line":1,"detail":"concrete evidence"}]}]}\n${ASSISTANT_REPORT_END}\n\nAllowed categories: ${REVIEW_CATEGORIES.join(', ')}.`
  const started = performance.now()
  try {
    const command = await runProcess([
      process.execPath,
      builtCli,
      '--profile',
      'headless',
      '--patch',
      overlayPath,
      task.trim(),
    ], prepared.workspace, MODEL_RUN_TIMEOUT_MS, {
      ...process.env,
      DSH_HOME: runHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      NO_COLOR: '1',
    })
    const durationMs = Math.round(performance.now() - started)
    const candidateInjected = await readFile(markerPath, 'utf8').then(() => true, () => false)
    const oracle = await runOracle(options.manifest, options.caseRoot, prepared.workspace, join(conditionArtifacts, 'oracle'))
    const session = await summarizeSessions(sessionRoot)
    const paths = await changedPaths(prepared.workspace)
    const patch = await finalPatch(prepared.workspace)
    const unrelatedChangedPaths = paths.filter(path => !expectedPaths.includes(path))
    const hadBlocker = session.engineeringResults.some((value) => {
      const data = record(value, 'engineering review result')
      return data.passed === false
    }) || session.correctionPasses > 0 || session.finalBlockerReportRequested
    const automaticReviewObserved = options.condition === 'treatment'
      ? session.engineeringResults.some((value) => {
          const data = record(value, 'engineering review result')
          return data.risk === 'medium' || data.risk === 'high'
        })
      : null
    const assistantReport = options.taskMode === 'review'
      ? parseAssistantFindingReport(command.stdout)
      : { status: 'not-requested' as const }
    const findingSource = options.taskMode === 'review'
      ? 'assistant-report' as const
      : 'engineering-event' as const
    const findingInputs = findingSource === 'assistant-report' && assistantReport.status === 'parsed'
      ? [assistantReport.result]
      : options.taskMode === 'fix'
        ? session.engineeringResults.slice(-1)
        : session.engineeringResults
    const residualExpectedFindings = options.taskMode === 'fix' && oracle.status === 'passed'
      ? []
      : spec.expectedFindings ?? []
    const findingEvaluation = scoreFindings(options.manifest, options.variant, findingInputs, residualExpectedFindings)
    const gateEvaluation = options.condition === 'treatment'
      ? scoreFindings(
          options.manifest,
          options.variant,
          options.taskMode === 'fix' ? session.engineeringResults.slice(-1) : session.engineeringResults,
          residualExpectedFindings,
        )
      : undefined
    const falseBlock = options.variant === 'fixed' && options.taskMode === 'review'
      ? options.condition === 'treatment'
        ? hadBlocker
        : assistantReport.status === 'parsed' && hasBlockingFinding([assistantReport.result])
      : null
    const result: CalibrationResult = {
      caseId: options.manifest.id,
      domain: options.manifest.domain,
      difficulty: options.manifest.difficulty,
      riskTags: options.manifest.riskTags,
      variant: options.variant,
      repetition: options.repetition,
      condition: options.condition,
      taskMode: options.taskMode,
      expectedOracle: spec.expectedOracle,
      initialOracleStatus: options.initialOracleStatus,
      finalOracleStatus: oracle.status,
      commandExitCode: command.exitCode,
      commandTimedOut: command.timedOut,
      candidateInjected,
      durationMs,
      patchSha256: prepared.patchSha256,
      finalDiffSha256: createHash('sha256').update(patch).digest('hex'),
      changedPaths: paths,
      unrelatedChangedPaths,
      fixSuccess: options.taskMode === 'fix' && options.manifest.oracle.fixEligible && options.initialOracleStatus !== 'oracle-unavailable'
        ? oracle.status === 'passed'
        : null,
      regression: options.taskMode === 'fix' && options.initialOracleStatus === 'passed' && oracle.status !== 'oracle-unavailable'
        ? oracle.status !== 'passed' || unrelatedChangedPaths.length > 0
        : null,
      falseBlock,
      automaticReviewObserved,
      findingSource,
      assistantReportStatus: assistantReport.status,
      ...findingEvaluation,
      gateBugRecall: gateEvaluation?.bugRecall ?? null,
      gateFindingPrecision: gateEvaluation?.findingPrecision ?? null,
      gateMatchedGoldFindings: gateEvaluation?.matchedGoldFindings ?? [],
      gateFindingScores: gateEvaluation?.findingScores ?? [],
      session,
    }
    await writeFile(join(conditionArtifacts, 'result.json'), `${JSON.stringify(result, undefined, 2)}\n`)
    await writeFile(join(conditionArtifacts, 'final.patch'), patch)
    await writeFile(join(conditionArtifacts, 'assistant.txt'), command.stdout)
    await writeFile(join(conditionArtifacts, 'stderr.txt'), command.stderr)
    const artifactFiles = await filesBelow(conditionArtifacts)
    for (const path of artifactFiles) {
      if ((await readFile(path)).includes(Buffer.from(options.managedKey))) {
        await rm(options.runArtifacts, { recursive: true, force: true })
        throw new Error('credential redaction audit failed; contaminated run artifacts were removed')
      }
    }
    return result
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
}

function parseCalibrationArgs(args: readonly string[]): {
  runs: number
  variants: readonly VariantName[]
  conditions: readonly Condition[]
  taskMode: TaskMode
  caseId?: string
} {
  let runs = 3
  let variants: readonly VariantName[] = ['buggy', 'fixed']
  let conditions: readonly Condition[] = ['control', 'treatment']
  let taskMode: TaskMode = 'fix'
  let caseId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--runs') {
      const value = Number(args[index + 1])
      if (!Number.isSafeInteger(value) || value <= 0 || value > 10) throw new Error('--runs must be an integer from 1 to 10')
      runs = value
      index += 1
    } else if (argument === '--variant') {
      const value = args[index + 1]
      if (value === 'buggy' || value === 'fixed') variants = [value]
      else if (value === 'all') variants = ['buggy', 'fixed']
      else throw new Error('--variant must be buggy, fixed, or all')
      index += 1
    } else if (argument === '--condition') {
      const value = args[index + 1]
      if (value === 'control' || value === 'treatment') conditions = [value]
      else if (value === 'all') conditions = ['control', 'treatment']
      else throw new Error('--condition must be control, treatment, or all')
      index += 1
    } else if (argument === '--case') {
      caseId = string(args[index + 1], '--case')
      index += 1
    } else if (argument === '--task-mode') {
      const value = args[index + 1]
      if (value !== 'fix' && value !== 'review') throw new Error('--task-mode must be fix or review')
      taskMode = value
      index += 1
    } else {
      throw new Error(`unknown calibrate argument ${JSON.stringify(argument)}`)
    }
  }
  return { runs, variants, conditions, taskMode, ...caseId === undefined ? {} : { caseId } }
}

async function calibrate(args: readonly string[]): Promise<void> {
  const options = parseCalibrationArgs(args)
  const sourceHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const credentialDocument = record(load(await readFile(join(sourceHome, '.credentials.yaml'), 'utf8')), 'Harness managed credentials')
  const managedKey = string(credentialDocument.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY')
  const revision = await repositoryRevision()
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-calibration-${revision.slice(0, 12)}`
  const runArtifacts = join(artifactRoot, runId)
  await mkdir(runArtifacts, { recursive: true })
  await writeFile(join(runArtifacts, 'run.json'), `${JSON.stringify({
    runId,
    mode: 'calibrate',
    revision,
    runs: options.runs,
    variants: options.variants,
    conditions: options.conditions,
    taskMode: options.taskMode,
    credentialSource: 'harness-managed-file',
    randomizedPairOrder: true,
    pairedSeed: false,
    modelRequestBudget: { reasoningEffort: 'off', maxTokens: 8192 },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }, undefined, 2)}\n`)
  const initialOracle = new Map<string, OracleStatus>()
  const cases = (await caseDirectories()).filter(caseRoot => options.caseId === undefined || basename(caseRoot) === options.caseId)
  if (cases.length === 0) throw new Error(`no benchmark case matched ${JSON.stringify(options.caseId)}`)
  for (const caseRoot of cases) {
    const manifest = await readManifest(caseRoot)
    for (const variant of options.variants) {
      const prepared = await prepareVariant(caseRoot, manifest.variants[variant])
      try {
        const oracle = await runOracle(manifest, caseRoot, prepared.workspace, join(runArtifacts, manifest.id, variant, 'initial-oracle'))
        initialOracle.set(`${manifest.id}/${variant}`, oracle.status)
      } finally {
        await rm(prepared.root, { recursive: true, force: true })
      }
    }
  }
  const total = cases.length * options.variants.length * options.runs * options.conditions.length
  let completed = 0
  const results: CalibrationResult[] = []
  for (const caseRoot of cases) {
    const manifest = await readManifest(caseRoot)
    for (const variant of options.variants) {
      for (let repetition = 1; repetition <= options.runs; repetition += 1) {
        const orderedConditions = options.conditions.length === 2 ? shuffledConditions() : options.conditions
        for (const condition of orderedConditions) {
          const result = await runCalibrationCondition({
            manifest,
            caseRoot,
            variant,
            repetition,
            condition,
            taskMode: options.taskMode,
            runArtifacts,
            sourceHome,
            managedKey,
            initialOracleStatus: initialOracle.get(`${manifest.id}/${variant}`) ?? 'oracle-unavailable',
          })
          results.push(result)
          await appendFile(join(runArtifacts, 'results.jsonl'), `${JSON.stringify(result)}\n`)
          completed += 1
          process.stdout.write(`[${String(completed)}/${String(total)}] ${manifest.id}/${variant} run ${String(repetition)} ${condition}: oracle=${result.finalOracleStatus}, exit=${String(result.commandExitCode)}, corrections=${String(result.session.correctionPasses)}\n`)
        }
      }
    }
  }
  const scoredFixes = results.filter(result => result.fixSuccess !== null)
  const negativeRuns = results.filter(result => result.falseBlock !== null)
  const summarizeCondition = (condition: Condition) => {
    const selected = results.filter(result => result.condition === condition)
    const negativeSelected = selected.filter(result => result.falseBlock !== null)
    const durations = selected.map(result => result.durationMs).sort((left, right) => left - right)
    const expectedGoldFindings = selected.reduce((sum, result) => sum + result.expectedGoldFindings, 0)
    const matchedGoldFindings = selected.reduce((sum, result) => sum + result.matchedGoldFindings.length, 0)
    const conclusiveFindings = selected.flatMap(result => result.findingScores).filter(score => score.status !== 'manual-review')
    const gateExpectedGoldFindings = selected
      .filter(result => result.condition === 'treatment')
      .reduce((sum, result) => sum + result.expectedGoldFindings, 0)
    const gateMatchedGoldFindings = selected.reduce((sum, result) => sum + result.gateMatchedGoldFindings.length, 0)
    const conclusiveGateFindings = selected.flatMap(result => result.gateFindingScores).filter(score => score.status !== 'manual-review')
    return {
      runs: selected.length,
      medianDurationMs: durations[Math.floor(durations.length / 2)] ?? null,
      totalInputTokens: selected.reduce((sum, result) => sum + result.session.inputTokens + result.session.cacheReadTokens + result.session.cacheWriteTokens, 0),
      totalOutputTokens: selected.reduce((sum, result) => sum + result.session.outputTokens, 0),
      rootOutputTokens: selected.reduce((sum, result) => sum + result.session.rootUsage.outputTokens, 0),
      subagentOutputTokens: selected.reduce((sum, result) => sum + result.session.subagentUsage.outputTokens, 0),
      reviewerCalls: selected.reduce((sum, result) => sum + result.session.subagentSessions, 0),
      manualReviewToolCalls: selected.reduce((sum, result) => sum + result.session.manualReviewToolCalls, 0),
      protocolViolationRuns: selected.filter(result => result.session.manualReviewToolCalls > 0).length,
      falseBlockRate: negativeSelected.length === 0
        ? null
        : negativeSelected.filter(result => result.falseBlock).length / negativeSelected.length,
      bugRecall: expectedGoldFindings === 0 ? null : matchedGoldFindings / expectedGoldFindings,
      findingPrecision: conclusiveFindings.length === 0
        ? null
        : conclusiveFindings.filter(score => score.status === 'matched').length / conclusiveFindings.length,
      manualReviewFindings: selected.reduce((sum, result) => sum + result.manualReviewFindings, 0),
      gateBugRecall: gateExpectedGoldFindings === 0 ? null : gateMatchedGoldFindings / gateExpectedGoldFindings,
      gateFindingPrecision: conclusiveGateFindings.length === 0
        ? null
        : conclusiveGateFindings.filter(score => score.status === 'matched').length / conclusiveGateFindings.length,
    }
  }
  const summary = {
    runs: results.length,
    candidateInjectionFailures: results.filter(result => !result.candidateInjected).length,
    automaticReviewObservationFailures: results.filter(result => result.automaticReviewObserved === false).length,
    assistantReportFailures: results.filter(result => result.taskMode === 'review' && result.assistantReportStatus !== 'parsed').length,
    commandFailures: results.filter(result => result.commandExitCode !== 0 || result.commandTimedOut).length,
    oracleUnavailable: results.filter(result => result.finalOracleStatus === 'oracle-unavailable').length,
    fixSuccessRate: scoredFixes.length === 0 ? null : scoredFixes.filter(result => result.fixSuccess).length / scoredFixes.length,
    falseBlockRate: negativeRuns.length === 0 ? null : negativeRuns.filter(result => result.falseBlock).length / negativeRuns.length,
    regressionRate: results.filter(result => result.regression !== null).length === 0
      ? null
      : results.filter(result => result.regression).length / results.filter(result => result.regression !== null).length,
    medianDurationMs: [...results].sort((left, right) => left.durationMs - right.durationMs)[Math.floor(results.length / 2)]?.durationMs ?? null,
    totalInputTokens: results.reduce((sum, result) => sum + result.session.inputTokens + result.session.cacheReadTokens + result.session.cacheWriteTokens, 0),
    totalOutputTokens: results.reduce((sum, result) => sum + result.session.outputTokens, 0),
    manualReviewToolCalls: results.reduce((sum, result) => sum + result.session.manualReviewToolCalls, 0),
    protocolViolationRuns: results.filter(result => result.session.manualReviewToolCalls > 0).length,
    difficultyRuns: {
      standard: results.filter(result => result.difficulty === 'standard').length,
      combined: results.filter(result => result.difficulty === 'combined').length,
      advanced: results.filter(result => result.difficulty === 'advanced').length,
    },
    conditions: {
      control: summarizeCondition('control'),
      treatment: summarizeCondition('treatment'),
    },
  }
  await writeFile(join(runArtifacts, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary)}\n${runArtifacts}\n`)
}

async function report(argv: string[]) {
  let artifactsRoot = join(process.cwd(), '.artifacts', 'engineering-review-bench')
  let outputDir = join(process.cwd(), 'benchmarks', 'engineering-review', 'report')
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag === '--artifacts' || flag === '--out') && value !== undefined) {
      if (flag === '--artifacts') artifactsRoot = value
      else outputDir = value
      index += 1
    }
  }
  const { records, headline } = await generateReport(artifactsRoot, outputDir)
  process.stdout.write(
    `report: ${records.length} cells (${headline.length} in headline batch) → ${outputDir}\n`,
  )
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const command = process.argv[2]
  if (command === 'validate') await validate()
  else if (command === 'calibrate') await calibrate(process.argv.slice(3))
  else if (command === 'report') await report(process.argv.slice(3))
  else throw new Error('usage: cli.ts <validate|calibrate|report [--artifacts DIR] [--out DIR]>')
}

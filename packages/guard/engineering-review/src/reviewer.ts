/** Isolated structured reviewer invocation and finding normalization. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {
  EngineeringCheckResult,
  EngineeringFinding,
  EngineeringReviewRequest,
  EngineeringReviewRoute,
} from './types.ts'
import { REVIEW_CATEGORIES, type EngineeringFindingCategory } from './categories.ts'

const REVIEW_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...REVIEW_CATEGORIES] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                line: { type: 'number' },
                detail: { type: 'string' },
              },
              required: ['path', 'detail'],
              additionalProperties: false,
            },
          },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          validation: { type: 'string' },
        },
        required: ['category', 'severity', 'confidence', 'title', 'evidence', 'impact', 'recommendation', 'validation'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

/** Structured finding emitted by the isolated reviewer before blocker mapping. */
export interface RawFinding {
  category: EngineeringFindingCategory
  severity: 'critical' | 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  title: string
  evidence: { path: string; line?: number; detail: string }[]
  impact: string
  recommendation: string
  validation: string
}

interface RawReview { findings: RawFinding[] }

/** Reviewer route and normalized findings. */
export interface ReviewerOutcome {
  readonly findings: readonly EngineeringFinding[]
  readonly provider?: string
  readonly model?: string
}

/**
 * Load the package-owned skill body for runtime registration.
 * @returns complete skill Markdown including frontmatter.
 */
export function bundledSkillSource(): string {
  return readFileSync(new URL('../skill/engineering-review/SKILL.md', import.meta.url), 'utf8')
}

/**
 * Load the detailed default rubric passed directly to the isolated reviewer.
 * @returns package-owned rubric Markdown.
 */
export function bundledRubricSource(): string {
  return readFileSync(new URL('../skill/engineering-review/references/rubric.md', import.meta.url), 'utf8')
}

/**
 * Strip the YAML frontmatter expected by `ctx.skills.register`.
 * @param source - complete skill Markdown.
 * @returns body text without frontmatter.
 */
export function skillBody(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
}

function findingId(finding: RawFinding): string {
  /* v8 ignore next 2 -- admission requires a positive line, so every finding cited here carries one. */
  const evidence = finding.evidence
    .map(item => `${item.path}:${item.line ?? ''}:${item.detail}`).join('|')
  return `er-${createHash('sha256').update(`${finding.category}|${finding.title}|${evidence}`).digest('hex').slice(0, 12)}`
}

/**
 * Normalize source severity, confidence, evidence, and stable identity.
 * @param finding - structured reviewer finding.
 * @returns canonical warning or blocker finding.
 */
export function normalizeReviewerFinding(finding: RawFinding): EngineeringFinding {
  const blocker = (finding.severity === 'critical' || finding.severity === 'high') && finding.confidence === 'high'
  return {
    id: findingId(finding),
    category: finding.category,
    severity: blocker ? 'blocker' : 'warning',
    confidence: finding.confidence,
    title: finding.title,
    evidence: finding.evidence.map(item => ({
      path: item.path,
      // v8 ignore next -- admission requires a positive changed line, so the omitted-line arm never carries an admitted finding.
      ...Number.isSafeInteger(item.line) && (item.line as number) > 0 ? { line: item.line } : {},
      detail: item.detail,
    })),
    impact: finding.impact,
    recommendation: finding.recommendation,
    validation: finding.validation,
  }
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '')
}

/** New-side path carried by one `+++ b/...` line, unquoted when Git quoted it. */
function newSidePath(value: string): string | undefined {
  let unquoted = value
  if (unquoted.startsWith('"') && unquoted.endsWith('"')) {
    try { unquoted = JSON.parse(unquoted) as string } catch { unquoted = unquoted.slice(1, -1) }
  }
  // v8 ignore next -- Git always emits `b/`-prefixed new-side paths; the raw arm only exists for hand-built diffs.
  const path = unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted
  if (path.length === 0) return undefined
  return path
}

/**
 * Parse the new-side changed line spans of a unified Git diff, keyed by
 * normalized workspace-relative path. A span covers every added and context
 * line inside one hunk; removed lines have no new-side line number.
 * @param diff - bounded unified diff text.
 * @returns per-file inclusive `[start, end]` new-side line ranges.
 */
export function changedLineRanges(diff: string): ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>()
  let file: string | undefined
  let hunkStart = 0
  let newLine = 0
  let inHunk = false
  const closeHunk = (): void => {
    if (!inHunk || file === undefined || newLine < hunkStart) return
    const range: [number, number] = [hunkStart, newLine]
    const list = ranges.get(file)
    const previous = list?.[list.length - 1]
    if (previous !== undefined && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
    else if (list !== undefined) list.push(range)
    else ranges.set(file, [range])
    inHunk = false
  }
  for (const raw of diff.split(/\r?\n/u)) {
    if (raw.startsWith('diff --git ')) {
      closeHunk()
      file = undefined
      continue
    }
    if (raw.startsWith('+++ ')) {
      closeHunk()
      file = raw === '+++ /dev/null' ? undefined : newSidePath(raw.slice(4))
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw)
    if (hunk !== null) {
      closeHunk()
      hunkStart = Number(hunk[1])
      newLine = hunkStart - 1
      inHunk = true
      continue
    }
    if (!inHunk || file === undefined || raw.length === 0) continue
    const marker = raw[0] as string
    if (marker === '+' || marker === ' ') newLine += 1
  }
  closeHunk()
  return ranges
}

/**
 * Admit only high-confidence material findings with evidence on a changed
 * line: the path must be in the change and, when the diff is available, the
 * cited line must fall inside that file's changed line spans rather than an
 * arbitrary pre-existing line of a touched file.
 * @param finding - structured reviewer candidate.
 * @param changedPaths - workspace-relative paths in the reviewed change.
 * @param changedRanges - parsed diff spans; omit when the diff is truncated or absent.
 * @returns whether the candidate belongs in the engineering report.
 */
export function admitReviewerFinding(
  finding: RawFinding,
  changedPaths: readonly string[],
  changedRanges?: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): boolean {
  if ((finding.severity !== 'critical' && finding.severity !== 'high') || finding.confidence !== 'high') return false
  const changed = new Set(changedPaths.map(normalizedPath))
  return finding.evidence.some((item) => {
    const line = item.line
    if (!Number.isSafeInteger(line) || (line as number) <= 0) return false
    const path = normalizedPath(item.path)
    if (!changed.has(path)) return false
    if (changedRanges === undefined) return true
    const fileRanges = changedRanges.get(path)
    // A touched file without hunks in the diff (e.g. untracked content Git
    // diff does not carry) cannot contradict the citation; keep file-level
    // admission. Files WITH hunks must cite a line inside them.
    if (fileRanges === undefined) return true
    const cited = line as number
    return fileRanges.some(([start, end]) => cited >= start && cited <= end)
  })
}

const FAST_RUBRIC = 'Check only high-confidence critical/high defects in the changed lines: progress and blocking, ownership and cleanup, timeout/recovery, bounds and data integrity, state consistency, compatibility, safety, observability, and verification. Do not infer undocumented requirements.'

function boundedUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const marker = text.includes('[task context truncated]')
    ? '\n[task context truncated]'
    : '\n[review context truncated]'
  const markerBytes = Buffer.from(marker)
  if (maxBytes <= markerBytes.length) return markerBytes.subarray(0, maxBytes).toString('utf8')
  const end = maxBytes - markerBytes.length
  return `${bytes.subarray(0, end).toString('utf8')}${marker}`
}

function reviewerPrompt(
  request: EngineeringReviewRequest,
  checks: readonly EngineeringCheckResult[],
  focus: readonly string[],
  skill: string,
  rubric: string,
  projectInstructions: string | undefined,
  route: EngineeringReviewRoute,
  maxContextBytes: number,
): string {
  const deep = route === 'deep'
  const header = [
    'Review the engineering change independently. Return only critical/high correctness defects introduced or exposed by the change.',
    'Every finding must identify a violated task, project, interface, or execution requirement and cite at least one changed file line. Omit diagnostics preferences, API-style suggestions, optional hardening, and speculative concerns.',
    'Return a candidate only at high confidence. If confidence is medium or low, omit it instead of returning a warning.',
    'Answer directly: your final message must be exactly the requested JSON object, with no prose before or after it.',
    deep ? 'Inspect files only when needed to verify a specific candidate. Do not modify files.' : 'Do not inspect files or use tools; the complete bounded diff is the evidence. Do not modify files.',
    `Choose each finding category from this stable list: ${REVIEW_CATEGORIES.join(', ')}.`,
    `Changed paths:\n${boundedUtf8(request.changedPaths.join('\n'), Math.min(8_192, maxContextBytes >> 3))}`,
    `Review focus:\n${boundedUtf8(focus.join('\n') || '(general engineering review)', Math.min(8_192, maxContextBytes >> 3))}`,
    `Deterministic checks:\n${boundedUtf8(JSON.stringify(checks), Math.min(12_288, maxContextBytes >> 2))}`,
    `User task requirements:\n${boundedUtf8(request.taskContext ?? '(not available)', Math.min(16_384, maxContextBytes >> 2))}`,
  ]
  if (deep) {
    header.push(`Project instructions:\n${boundedUtf8(projectInstructions ?? '(none found)', 16_384)}`)
    header.push(`Review workflow:\n${boundedUtf8(skill, 16_384)}`)
    header.push(`Rubric:\n${boundedUtf8(rubric, 24_576)}`)
  } else {
    header.push(`Fast rubric:\n${FAST_RUBRIC}`)
  }
  const prefix = header.join('\n\n')
  const remaining = Math.max(1_024, maxContextBytes - Buffer.byteLength(prefix) - 96)
  const diff = boundedUtf8(request.diff || '(no textual diff available)', remaining)
  return boundedUtf8(`${prefix}\n\nBounded diff${request.diffTruncated ? ' (truncated; inspect files as needed)' : ''}:\n${diff}`, maxContextBytes)
}
/**
 * Start one fresh structured reviewer and dispose it after settlement.
 * @param ctx - runtime carrying skill, tool, and subagent services.
 * @param request - immutable review evidence and owner.
 * @param checks - deterministic check outcomes.
 * @param focus - merged caller and adapter focus.
 * @param route - selected checks-only, fast, or deep reviewer route.
 * @param providerName - named one-shot subagent backend.
 * @param reviewerProvider - optional LLM provider override.
 * @param reviewerModel - optional LLM model override.
 * @param reviewerMaxTokens - positive output cap for each reviewer request.
 * @param maxContextBytes - total UTF-8 input budget for one reviewer prompt.
 * @param signal - operation cancellation.
 * @returns normalized findings and reviewer metadata.
 */
export async function runReviewer(
  ctx: Context,
  request: EngineeringReviewRequest,
  checks: readonly EngineeringCheckResult[],
  focus: readonly string[],
  route: EngineeringReviewRoute,
  providerName: string,
  reviewerProvider: string | undefined,
  reviewerModel: string | undefined,
  reviewerMaxTokens: number,
  maxContextBytes: number,
  signal: AbortSignal,
): Promise<ReviewerOutcome> {
  const winningSkill = await ctx.skills.get('engineering-review', {
    cwd: request.cwd,
    scope: request.agent,
    signal,
  })
  const projectInstructions = await request.readText('AGENTS.md')
  const readOnlyTools = [
    'read',
    'read_image',
    'lsp',
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'git_grep',
  ].filter(name => ctx.tools.get(name, request.agent) !== undefined)
  const provider = reviewerProvider ?? request.agent.options.provider
  const model = reviewerModel ?? request.agent.options.model
  // v8 ignore next -- the gate registers this skill at mount, so the bundled fallback never wins a mounted runtime.
  const skill = winningSkill?.content ?? skillBody(bundledSkillSource())
  const rubric = bundledRubricSource()
  const prompt = reviewerPrompt(request, checks, focus, skill, rubric, projectInstructions, route, maxContextBytes)
  const firstAttemptTools = route === 'deep' ? readOnlyTools : []
  let result = await startReviewer(ctx, providerName, request, signal, prompt, provider, model, reviewerMaxTokens, firstAttemptTools)
  // A reviewer that exhausts its output budget before emitting the structured
  // object (observed: narrative investigation prose on diff-less reviews) gets
  // one retry: a fresh child with a concise-answer directive, no tools, and a
  // doubled budget. Any other failure mode still degrades immediately.
  if (result.stopReason === 'max-tokens' && result.structured === undefined) {
    result = await startReviewer(
      ctx, providerName, request, signal,
      `${prompt}\n\n${MAX_TOKENS_RETRY_DIRECTIVE}`,
      provider, model, reviewerMaxTokens * 2, [],
    )
  }
  if (result.stopReason !== 'completed' || result.structured === undefined) {
    throw new Error(`reviewer stopped with ${JSON.stringify(result.stopReason)} without structured findings`)
  }
  const raw = result.structured as RawReview
  // A truncated or absent diff cannot prove a citation lies inside the
  // change, so line-level admission applies only to a complete diff.
  const changedRanges = request.diffTruncated || request.diff.length === 0
    ? undefined
    : changedLineRanges(request.diff)
  return {
    findings: raw.findings
      .filter(finding => admitReviewerFinding(finding, request.changedPaths, changedRanges))
      .map(normalizeReviewerFinding),
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}

/** Directive appended to the retry attempt after an output-budget truncation. */
const MAX_TOKENS_RETRY_DIRECTIVE = 'Your previous attempt was cut off by the output limit before returning the structured findings. Respond now with ONLY the requested JSON object: concise findings, no narrative and no investigation summary.'

async function startReviewer(
  ctx: Context,
  providerName: string,
  request: EngineeringReviewRequest,
  signal: AbortSignal,
  prompt: string,
  provider: string | undefined,
  model: string | undefined,
  maxTokens: number,
  allowTools: readonly string[],
): Promise<SubagentResult> {
  const run = await ctx.subagents.start(providerName, {
    label: 'engineering review',
    parent: request.agent,
    signal,
    prompt: [{ type: 'text', text: prompt }],
    outputSchema: REVIEW_SCHEMA,
    toolFilter: { allow: allowTools },
    agentOptions: {
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      maxTokens,
      reasoningEffort: ReasoningEffortId('off'),
    },
    persona: 'You are an independent engineering reviewer. Do not edit files. Prefer precise evidence over speculative warnings.',
  })
  const localAgent = run.localAgent
  if (localAgent !== undefined) {
    localAgent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return { ...config, reasoningEffort: ReasoningEffortId('off') }
    })
  }
  try {
    return await run.result
  } finally {
    await run.dispose()
  }
}

/** Isolated structured reviewer invocation and finding normalization. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'
import type {
  EngineeringCheckResult,
  EngineeringFinding,
  EngineeringReviewRequest,
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
  const evidence = finding.evidence.map(item => `${item.path}:${item.line ?? ''}:${item.detail}`).join('|')
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

/**
 * Admit only high-confidence material findings with evidence on a changed line.
 * @param finding - structured reviewer candidate.
 * @param changedPaths - workspace-relative paths in the reviewed change.
 * @returns whether the candidate belongs in the engineering report.
 */
export function admitReviewerFinding(finding: RawFinding, changedPaths: readonly string[]): boolean {
  if ((finding.severity !== 'critical' && finding.severity !== 'high') || finding.confidence !== 'high') return false
  const changed = new Set(changedPaths.map(normalizedPath))
  return finding.evidence.some(item => Number.isSafeInteger(item.line)
    && (item.line as number) > 0
    && changed.has(normalizedPath(item.path)))
}

function reviewerPrompt(
  request: EngineeringReviewRequest,
  checks: readonly EngineeringCheckResult[],
  focus: readonly string[],
  skill: string,
  rubric: string,
  projectInstructions: string | undefined,
): string {
  return [
    'Review the engineering change independently. Return only critical/high correctness defects introduced or exposed by the change.',
    'Every finding must identify a violated task, project, interface, or execution requirement and cite at least one changed file line. Omit diagnostics preferences, API-style suggestions, optional hardening, and speculative concerns.',
    'Return a candidate only at high confidence. If confidence is medium or low, omit it instead of returning a warning.',
    `Choose each finding category from this stable list: ${REVIEW_CATEGORIES.join(', ')}.`,
    'Do not modify files. Return the requested structured object.',
    `Changed paths:\n${request.changedPaths.join('\n')}`,
    `Review focus:\n${focus.join('\n') || '(general engineering review)'}`,
    `Deterministic checks:\n${JSON.stringify(checks)}`,
    `User task requirements:\n${request.taskContext ?? '(not available)'}`,
    `Project instructions:\n${projectInstructions ?? '(none found)'}`,
    `Review workflow:\n${skill}`,
    `Rubric:\n${rubric}`,
    `Bounded diff${request.diffTruncated ? ' (truncated; inspect files as needed)' : ''}:\n${request.diff || '(no textual diff available)'}`,
  ].join('\n\n')
}

/**
 * Start one fresh structured reviewer and dispose it after settlement.
 * @param ctx - runtime carrying skill, tool, and subagent services.
 * @param request - immutable review evidence and owner.
 * @param checks - deterministic check outcomes.
 * @param focus - merged caller and adapter focus.
 * @param providerName - named one-shot subagent backend.
 * @param reviewerProvider - optional LLM provider override.
 * @param reviewerModel - optional LLM model override.
 * @param reviewerMaxTokens - positive output cap for each reviewer request.
 * @param signal - operation cancellation.
 * @returns normalized findings and effective reviewer route.
 */
export async function runReviewer(
  ctx: Context,
  request: EngineeringReviewRequest,
  checks: readonly EngineeringCheckResult[],
  focus: readonly string[],
  providerName: string,
  reviewerProvider: string | undefined,
  reviewerModel: string | undefined,
  reviewerMaxTokens: number,
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
  const run = await ctx.subagents.start(providerName, {
    label: 'engineering review',
    parent: request.agent,
    signal,
    prompt: [{
      type: 'text',
      text: reviewerPrompt(
        request,
        checks,
        focus,
        winningSkill?.content ?? skillBody(bundledSkillSource()),
        bundledRubricSource(),
        projectInstructions,
      ),
    }],
    outputSchema: REVIEW_SCHEMA,
    toolFilter: { allow: request.depth === 'deep' || request.diffTruncated ? readOnlyTools : [] },
    agentOptions: {
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      maxTokens: reviewerMaxTokens,
    },
    persona: 'You are an independent engineering reviewer. Do not edit files. Prefer precise evidence over speculative warnings.',
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed' || result.structured === undefined) {
      throw new Error(`reviewer stopped with ${JSON.stringify(result.stopReason)} without structured findings`)
    }
    const raw = result.structured as RawReview
    return {
      findings: raw.findings
        .filter(finding => admitReviewerFinding(finding, request.changedPaths))
        .map(normalizeReviewerFinding),
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
    }
  } finally {
    await run.dispose()
  }
}

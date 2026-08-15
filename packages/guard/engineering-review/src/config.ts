/** Project configuration parsing, validation, glob selection, and conservative check discovery. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { parse as parseYaml } from 'yaml'
import type { EngineeringCheckRecipe, EngineeringReviewDepth } from './types.ts'
import { validateCheckRecipe } from './recipe.ts'

const PROJECT_CONFIG = '.dsh/engineering-review.yml'

function record(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`engineering-review: ${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`engineering-review: ${subject} must be a non-empty trimmed string`)
  }
  return value
}

function relativePath(value: unknown, subject: string): string {
  const path = nonEmptyString(value, subject).replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`engineering-review: ${subject} must stay within the workspace`)
  }
  return path
}

function parseCheck(value: unknown, index: number): EngineeringCheckRecipe {
  const input = record(value, `checks[${index}]`)
  const allowed = new Set(['id', 'argv', 'cwd', 'files', 'timeoutMs', 'required'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`engineering-review: checks[${index}] has unknown field ${JSON.stringify(key)}`)
  }
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new TypeError(`engineering-review: checks[${index}].argv must be a non-empty array`)
  }
  const argv = input.argv.map((entry, argvIndex) => nonEmptyString(entry, `checks[${index}].argv[${argvIndex}]`))
  const files = input.files === undefined
    ? undefined
    : Array.isArray(input.files)
      ? input.files.map((entry, fileIndex) => relativePath(entry, `checks[${index}].files[${fileIndex}]`))
      : (() => { throw new TypeError(`engineering-review: checks[${index}].files must be an array`) })()
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new TypeError(`engineering-review: checks[${index}].timeoutMs must be positive`)
  }
  if (input.required !== undefined && typeof input.required !== 'boolean') {
    throw new TypeError(`engineering-review: checks[${index}].required must be boolean`)
  }
  const recipe = {
    id: nonEmptyString(input.id, `checks[${index}].id`),
    argv,
    ...input.cwd === undefined ? {} : { cwd: relativePath(input.cwd, `checks[${index}].cwd`) },
    ...files === undefined ? {} : { files },
    ...input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
    ...input.required === undefined ? {} : { required: input.required },
  }
  validateCheckRecipe(recipe)
  return recipe
}

/**
 * Read one workspace-relative text file through the mounted filesystem.
 * @param ctx - runtime carrying the filesystem service.
 * @param cwd - absolute workspace root.
 * @param relative - workspace-relative file path.
 * @param signal - operation cancellation.
 * @returns file text, or undefined when absent or not a regular file.
 */
export async function readWorkspaceText(
  ctx: Context,
  cwd: string,
  relative: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const safe = relativePath(relative, 'workspace path')
  try {
    const target = await ctx.fs.resolve(safe, { cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    return info?.type === 'file' ? await ctx.fs.readText(target, signal) : undefined
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
}

/**
 * Whether one workspace-relative regular file exists.
 * @param ctx - runtime carrying the filesystem service.
 * @param cwd - absolute workspace root.
 * @param relative - workspace-relative file path.
 * @param signal - operation cancellation.
 * @returns whether the file exists and is readable as text.
 */
export async function hasWorkspaceFile(ctx: Context, cwd: string, relative: string, signal: AbortSignal): Promise<boolean> {
  return (await readWorkspaceText(ctx, cwd, relative, signal)) !== undefined
}

/**
 * Load and validate `.dsh/engineering-review.yml`; undefined means no project config.
 * @param ctx - runtime carrying the filesystem service.
 * @param cwd - absolute workspace root.
 * @param signal - operation cancellation.
 * @returns configured recipes, or undefined when the project file is absent.
 */
export async function loadProjectChecks(
  ctx: Context,
  cwd: string,
  signal: AbortSignal,
): Promise<readonly EngineeringCheckRecipe[] | undefined> {
  const source = await readWorkspaceText(ctx, cwd, PROJECT_CONFIG, signal)
  if (source === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch (cause) {
    throw new Error(`engineering-review: cannot parse ${PROJECT_CONFIG}`, { cause })
  }
  return parseProjectChecks(parsed)
}

/**
 * Validate already-parsed project configuration. Exported for parser-boundary tests.
 * @param parsed - decoded YAML value.
 * @returns validated exact-argv check recipes.
 */
export function parseProjectChecks(parsed: unknown): readonly EngineeringCheckRecipe[] {
  const input = record(parsed, PROJECT_CONFIG)
  if (input.version !== 1) throw new TypeError(`engineering-review: ${PROJECT_CONFIG} requires version: 1`)
  if (!Array.isArray(input.checks)) throw new TypeError(`engineering-review: ${PROJECT_CONFIG}.checks must be an array`)
  const checks = input.checks.map(parseCheck)
  const ids = new Set<string>()
  for (const check of checks) {
    if (ids.has(check.id)) throw new TypeError(`engineering-review: duplicate check id ${JSON.stringify(check.id)}`)
    ids.add(check.id)
  }
  return checks
}

function scriptsFromPackageJson(source: string | undefined): ReadonlySet<string> {
  if (source === undefined) return new Set()
  try {
    const root = record(JSON.parse(source), 'package.json')
    const scripts = root.scripts === undefined ? {} : record(root.scripts, 'package.json scripts')
    return new Set(Object.entries(scripts).filter(([, value]) => typeof value === 'string').map(([key]) => key))
  } catch {
    return new Set()
  }
}

/**
 * Discover only manifest-backed standard checks; explicit project config takes precedence.
 * @param ctx - runtime carrying the filesystem service.
 * @param cwd - absolute workspace root.
 * @param depth - fast or deep check selection.
 * @param signal - operation cancellation.
 * @returns deterministic recipes backed by existing manifests and scripts.
 */
export async function discoverStandardChecks(
  ctx: Context,
  cwd: string,
  depth: EngineeringReviewDepth,
  signal: AbortSignal,
): Promise<readonly EngineeringCheckRecipe[]> {
  const packageJson = await readWorkspaceText(ctx, cwd, 'package.json', signal)
  const scripts = scriptsFromPackageJson(packageJson)
  if (scripts.size > 0) {
    const manager = await hasWorkspaceFile(ctx, cwd, 'pnpm-lock.yaml', signal) ? 'pnpm'
      : await hasWorkspaceFile(ctx, cwd, 'yarn.lock', signal) ? 'yarn'
        : await hasWorkspaceFile(ctx, cwd, 'bun.lock', signal) || await hasWorkspaceFile(ctx, cwd, 'bun.lockb', signal) ? 'bun'
          : 'npm'
    const command = (script: string): string[] => manager === 'npm'
      ? ['npm', 'run', script]
      : [manager, 'run', script]
    const names = ['typecheck', 'lint', ...(depth === 'deep' ? ['test'] : [])]
    return names.filter(name => scripts.has(name)).map(name => ({
      id: `package:${name}`,
      argv: command(name),
      required: true,
    }))
  }
  if (await hasWorkspaceFile(ctx, cwd, 'Cargo.toml', signal)) {
    return [{ id: 'cargo:check', argv: ['cargo', 'check'], required: true },
      ...depth === 'deep' ? [{ id: 'cargo:test', argv: ['cargo', 'test'], required: true }] : []]
  }
  return []
}

function globRegExp(glob: string): RegExp {
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*'
      index += 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
  }
  return new RegExp(`${source}$`, 'u')
}

/**
 * Whether a recipe applies to at least one changed path.
 * @param check - recipe with optional path globs.
 * @param paths - normalized changed workspace paths.
 * @returns true when the recipe has no filter or one path matches.
 */
export function checkApplies(check: EngineeringCheckRecipe, paths: readonly string[]): boolean {
  if (check.files === undefined || check.files.length === 0) return true
  const patterns = check.files.map(globRegExp)
  return paths.some(path => patterns.some(pattern => pattern.test(path.replaceAll('\\', '/'))))
}

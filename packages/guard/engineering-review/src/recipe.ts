/** Exact-argv check validation shared by project configuration and adapters. */

import type { EngineeringCheckRecipe } from './types.ts'

const DIRECT_SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'pip', 'pip3', 'uv'])

/**
 * Validate that one recipe is deterministic, non-shell, and non-mutating.
 * @param recipe - assembled project or adapter recipe.
 */
export function validateCheckRecipe(recipe: EngineeringCheckRecipe): void {
  if (recipe.id.trim().length === 0 || recipe.id !== recipe.id.trim()) {
    throw new TypeError('engineering-review: check id must be non-empty and trimmed')
  }
  if (recipe.argv.length === 0 || recipe.argv.some(part => part.trim().length === 0)) {
    throw new TypeError(`engineering-review: check ${JSON.stringify(recipe.id)} has invalid argv`)
  }
  const executable = recipe.argv[0]?.toLowerCase().replace(/\.exe$/u, '')
  if (executable !== undefined && DIRECT_SHELLS.has(executable)) {
    throw new TypeError(`engineering-review: check ${JSON.stringify(recipe.id)} may not invoke a command shell`)
  }
  const argumentsLower = recipe.argv.slice(1).map(part => part.toLowerCase())
  const packageMutation = executable !== undefined && PACKAGE_MANAGERS.has(executable)
    && argumentsLower.some(part => part === 'install' || part === 'add')
  const otherMutation = argumentsLower.some(part => part.startsWith('--fix') || part === 'deploy' || part === 'migrate')
  if (packageMutation || otherMutation) {
    throw new TypeError(`engineering-review: check ${JSON.stringify(recipe.id)} requests installation, mutation, migration, or deployment`)
  }
}

/**
 * Normalize a workspace-relative check working directory.
 * @param value - optional configured directory.
 * @returns normalized relative directory.
 */
export function safeRelativeDirectory(value: string | undefined): string {
  if (value === undefined || value === '.') return '.'
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')) {
    throw new TypeError('engineering-review: check cwd must stay within the workspace')
  }
  return normalized
}

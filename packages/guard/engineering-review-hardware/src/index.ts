/** C/C++, embedded, Verilog, and SystemVerilog engineering-review adapter. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  EngineeringCheckRecipe,
  EngineeringReviewAdapter,
  EngineeringReviewContribution,
  EngineeringReviewRequest,
} from '@deepseek-ai/dsh-engineering-review'

export const name = 'engineering-review-hardware'
export const inject = ['engineeringReview']

/** Optional existing project metadata paths; this adapter never generates them. */
export interface Config {
  /** Existing workspace-relative `compile_commands.json` path. */
  readonly compilationDatabase?: string
  /** Existing workspace-relative Verilator argument-file path. */
  readonly verilatorArgsFile?: string
}

export const Config: z<Config> = z.object({
  compilationDatabase: z.string(),
  verilatorArgsFile: z.string(),
})

function projectRelative(path: string, field: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').includes('..')) {
    throw new TypeError(`engineering-review-hardware: ${field} must be a non-empty workspace-relative path`)
  }
  return normalized
}

const C_FOCUS = [
  'blocking paths and bounded progress',
  'ISR/thread shared state and lock/I/O interaction',
  'heap, stack, DMA/cache coherency, registers, and resource lifetime',
  'timeouts, counter wraparound, buffers, partial I/O, and error recovery',
]

const HDL_FOCUS = [
  'clock-domain crossings, metastability containment, and reset release',
  'bit width, signedness, latch inference, and blocking/nonblocking assignment semantics',
  'handshake backpressure, synthesis semantics, timing constraints, and assertions',
]

function addedCode(diff: string): string {
  return diff.split(/\r?\n/u)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n')
}

function hasHighRiskHdl(paths: readonly string[], diff: string): boolean {
  const pathHint = paths.some(path => /(?:cdc|clock|reset|fifo|handshake|axi|bus)/iu.test(path))
  const hdlCode = addedCode(diff)
  const codeHint = /\b(?:always_ff|always @(?:posedge|negedge)|posedge|negedge|crossing|synchronizer)\b/iu.test(hdlCode)
    || /\b(?:reset|handshake|backpressure)\b/iu.test(hdlCode)
  return pathHint || codeHint
}

function hasPotentiallyUnboundedHardwarePoll(diff: string): boolean {
  const code = addedCode(diff)
  const boundedBody = /\b(?:break|return|goto|timeout|deadline|cancel|tick|elapsed|yield|sleep)\b/iu
  for (const match of code.matchAll(/\bwhile\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/giu)) {
    /* v8 ignore next -- the capture group always exists when the regex matches. */
    const condition = match[1] ?? ''
    /* v8 ignore next -- the capture group always exists when the regex matches. */
    const body = match[2] ?? ''
    if (/->|\b(?:ready|busy|status|flag|done)\b/iu.test(condition) && !boundedBody.test(body)) return true
  }
  for (const match of code.matchAll(/\bfor\s*\(\s*;\s*;\s*\)\s*\{([\s\S]*?)\}/gu)) {
    // v8 ignore next -- the body capture group always exists when the regex matches.
    if (!boundedBody.test(match[1] ?? '')) return true
  }
  return false
}

class HardwareReviewAdapter implements EngineeringReviewAdapter {
  readonly id = 'hardware'
  constructor(private readonly config: Config) {}

  async contribute(request: EngineeringReviewRequest, signal: AbortSignal): Promise<EngineeringReviewContribution | undefined> {
    signal.throwIfAborted()
    const cPaths = request.changedPaths.filter(path => /\.(?:c|h|cc|cpp|cxx|hpp|hh)$/iu.test(path))
    const hdlPaths = request.changedPaths.filter(path => /\.(?:v|vh|sv|svh)$/iu.test(path))
    if (cPaths.length === 0 && hdlPaths.length === 0) return undefined
    const degradedReasons: string[] = []
    const checks: EngineeringCheckRecipe[] = []
    if (cPaths.length > 0) {
      const database = await this.compilationDatabase(request, degradedReasons)
      if (database !== undefined) {
        // v8 ignore next -- validated workspace-relative paths never have an empty directory component.
        const directory = database.includes('/') ? database.slice(0, database.lastIndexOf('/')) || '.' : '.'
        checks.push({
          id: 'hardware:clang-tidy',
          argv: ['clang-tidy', '-p', directory, ...cPaths],
          files: ['**/*.c', '**/*.h', '**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.hpp', '**/*.hh'],
          required: false,
        })
      }
    }
    if (hdlPaths.length > 0) {
      const argsFile = await this.verilatorArgsFile(request, degradedReasons)
      if (argsFile !== undefined) {
        checks.push({
          id: 'hardware:verilator-lint',
          argv: ['verilator', '--lint-only', '-f', argsFile],
          files: ['**/*.v', '**/*.vh', '**/*.sv', '**/*.svh'],
          required: false,
        })
      }
    }
    return {
      riskSignals: [
        ...cPaths.length === 0 ? [] : [hasPotentiallyUnboundedHardwarePoll(request.diff)
          ? { risk: 'high' as const, reason: 'Changed C/C++ control flow may poll hardware state without an observable bound.' }
          : { risk: 'medium' as const, reason: 'C/C++ changes can couple blocking, memory, interrupt, and hardware-resource behavior.' }],
        ...hdlPaths.length === 0 ? [] : [hasHighRiskHdl(hdlPaths, request.diff)
          ? { risk: 'high' as const, reason: 'HDL changes can alter clock, reset, handshake, width, synthesis, and timing behavior.' }
          : { risk: 'low' as const, reason: 'HDL change has no clock/reset/CDC or interface-risk signal; deterministic checks still apply.' }],
      ],
      focus: [...cPaths.length === 0 ? [] : C_FOCUS, ...hdlPaths.length === 0 ? [] : HDL_FOCUS],
      checks,
      ...degradedReasons.length === 0 ? {} : { degradedReasons },
    }
  }

  private async compilationDatabase(request: EngineeringReviewRequest, degradedReasons: string[]): Promise<string | undefined> {
    if (this.config.compilationDatabase !== undefined) {
      const path = projectRelative(this.config.compilationDatabase, 'compilationDatabase')
      if (await request.hasFile(path)) return path
      degradedReasons.push(`engineering-review-hardware: configured compilationDatabase ${JSON.stringify(this.config.compilationDatabase)} does not exist; clang-tidy check skipped`)
      return undefined
    }
    for (const candidate of ['compile_commands.json', 'build/compile_commands.json']) {
      if (await request.hasFile(candidate)) return candidate
    }
    return undefined
  }

  private async verilatorArgsFile(request: EngineeringReviewRequest, degradedReasons: string[]): Promise<string | undefined> {
    if (this.config.verilatorArgsFile !== undefined) {
      const path = projectRelative(this.config.verilatorArgsFile, 'verilatorArgsFile')
      if (await request.hasFile(path)) return path
      degradedReasons.push(`engineering-review-hardware: configured verilatorArgsFile ${JSON.stringify(this.config.verilatorArgsFile)} does not exist; Verilator lint check skipped`)
      return undefined
    }
    for (const candidate of ['.dsh/verilator.args', 'verilator.f', 'verilator.args']) {
      if (await request.hasFile(candidate)) return candidate
    }
    return undefined
  }
}

/** Register the hardware-domain guidance until this plugin is disposed. */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.compilationDatabase !== undefined) projectRelative(config.compilationDatabase, 'compilationDatabase')
  if (config.verilatorArgsFile !== undefined) projectRelative(config.verilatorArgsFile, 'verilatorArgsFile')
  ctx.engineeringReview.registerAdapter(new HardwareReviewAdapter(config))
}

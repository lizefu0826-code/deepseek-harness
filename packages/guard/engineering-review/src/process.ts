/** Exact-argv process execution with bounded output and optional sandbox confinement. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Bounded exact-argv process outcome used by Git and project checks. */
export interface ArgvResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

/** Options for one exact-argv process. */
export interface ArgvOptions {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly env?: Readonly<Record<string, string>>
  readonly agent?: Agent
  readonly sandbox?: boolean
}

/**
 * Run exact argv without shell interpretation and await whole-process settlement.
 * @param ctx - runtime carrying subprocess and optional sandbox services.
 * @param argv - exact executable and argument vector.
 * @param options - cwd, owner, deadline, output cap, and confinement choice.
 * @returns classified exit facts and bounded output.
 */
export async function runArgv(ctx: Context, argv: readonly string[], options: ArgvOptions): Promise<ArgvResult> {
  if (argv.length === 0 || argv.some(value => value.length === 0)) {
    throw new TypeError('engineering-review: argv must contain non-empty entries')
  }
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => { controller.abort(options.signal.reason) }
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`process timed out after ${options.timeoutMs}ms`))
  }, options.timeoutMs)
  timer.unref()
  try {
    const executable = await ctx.subprocess.resolveExecutable(argv[0] as string, options.env, controller.signal)
    let resolvedArgv = [executable, ...argv.slice(1)]
    if (options.sandbox === true) {
      const policyService = ctx.get('sandboxPolicy')
      const policy: SandboxExecutionPolicy | undefined = policyService?.resolve(
        options.agent === undefined ? {} : { session: options.agent.session },
      )
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) {
          throw new Error(`engineering-review: sandbox mode ${JSON.stringify(policy.mode)} has no sandbox provider`)
        }
        resolvedArgv = sandbox.confine(resolvedArgv, policy as SandboxPolicy).argv
      }
    }
    const process = ctx.subprocess.spawn({
      argv: resolvedArgv,
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxOutputBytes },
        stderr: { maxBytes: options.maxOutputBytes },
      },
      graceMs: 5_000,
      signal: controller.signal,
      ...options.env === undefined ? {} : { env: options.env },
    })
    const outcome = await process.done
    const stdout = process.collected.stdout?.readFrom(0)
    const stderr = process.collected.stderr?.readFrom(0)
    return {
      ...outcome,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      truncated: stdout?.lossy === true || stderr?.lossy === true,
      timedOut,
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }
}

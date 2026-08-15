import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
const caseDir = process.env.ER_BENCH_CASE_DIR
const artifactDir = process.env.ER_BENCH_ARTIFACT_DIR
if (!workspace || !caseDir || !artifactDir) throw new Error('UART oracle requires benchmark paths')

const output = join(artifactDir, process.platform === 'win32' ? 'uart-oracle.exe' : 'uart-oracle')
const candidates = [...process.env.CC ? [process.env.CC] : [], 'clang', 'gcc', 'cc']
let compiler
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (!probe.error) {
    compiler = candidate
    break
  }
}
if (!compiler) process.exit(77)

const compile = spawnSync(compiler, [
  '-std=c11', '-Wall', '-Wextra', '-Werror',
  join(workspace, 'uart_timeout.c'),
  join(caseDir, 'oracle', 'harness.c'),
  '-I', workspace,
  '-o', output,
], { encoding: 'utf8', timeout: 5000, windowsHide: true })
if (compile.status !== 0) {
  process.stderr.write(`${compile.stdout ?? ''}${compile.stderr ?? ''}`)
  process.exit(1)
}
const execute = spawnSync(output, [], { encoding: 'utf8', timeout: 1000, windowsHide: true })
if (execute.error || execute.status !== 0) {
  process.stderr.write(`${execute.stdout ?? ''}${execute.stderr ?? ''}${execute.error?.message ?? ''}`)
process.exit(1)
}

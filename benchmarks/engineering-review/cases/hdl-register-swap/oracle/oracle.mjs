import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
const caseDir = process.env.ER_BENCH_CASE_DIR
const artifactDir = process.env.ER_BENCH_ARTIFACT_DIR
if (!workspace || !caseDir || !artifactDir) throw new Error('HDL oracle requires benchmark paths')

const source = join(workspace, 'register_swap.sv')
const testbench = join(caseDir, 'oracle', 'tb.sv')
const iverilog = spawnSync('iverilog', ['-V'], { encoding: 'utf8', windowsHide: true })
if (!iverilog.error) {
  const image = join(artifactDir, 'register-swap.vvp')
  const compile = spawnSync('iverilog', ['-g2012', '-s', 'tb', '-o', image, source, testbench], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  })
  if (compile.status !== 0) {
    process.stderr.write(`${compile.stdout ?? ''}${compile.stderr ?? ''}`)
    process.exit(1)
  }
  const execute = spawnSync('vvp', [image], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  process.stdout.write(execute.stdout ?? '')
  process.stderr.write(execute.stderr ?? '')
  process.exit(execute.status === 0 ? 0 : 1)
}

const verilator = spawnSync('verilator', ['--version'], { encoding: 'utf8', windowsHide: true })
if (verilator.error) process.exit(77)
const objectDir = join(artifactDir, 'obj')
const compile = spawnSync('verilator', [
  '--binary', '--timing', '--top-module', 'tb', '-Wno-fatal', '--Mdir', objectDir, source, testbench,
], { encoding: 'utf8', timeout: 15000, windowsHide: true })
if (compile.status !== 0) {
  process.stderr.write(`${compile.stdout ?? ''}${compile.stderr ?? ''}`)
  process.exit(1)
}
const binary = join(objectDir, process.platform === 'win32' ? 'Vtb.exe' : 'Vtb')
if (!existsSync(binary)) process.exit(1)
const execute = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000, windowsHide: true })
process.stdout.write(execute.stdout ?? '')
process.stderr.write(execute.stderr ?? '')
process.exit(execute.status === 0 ? 0 : 1)

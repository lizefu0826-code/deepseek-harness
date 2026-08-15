import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('resource oracle requires ER_BENCH_WORKSPACE')
const { loadConfig } = await import(`${pathToFileURL(join(workspace, 'load_config.mjs')).href}?run=${Date.now()}`)
let closes = 0
let rejected = false
try {
  await loadConfig(async () => ({
    readText: async () => '{invalid json',
    close: async () => { closes += 1 },
  }))
} catch {
  rejected = true
}
process.exit(rejected && closes === 1 ? 0 : 1)

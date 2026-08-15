import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('counter oracle requires ER_BENCH_WORKSPACE')
const { incrementCounter } = await import(`${pathToFileURL(join(workspace, 'counter.mjs')).href}?run=${Date.now()}`)
let value = 0
let readers = 0
const barrier = Promise.withResolvers()
let updateChain = Promise.resolve()
const store = {
  async read() {
    readers += 1
    if (readers === 2) barrier.resolve()
    await barrier.promise
    return value
  },
  async write(next) { value = next },
  update(mutator) {
    updateChain = updateChain.then(() => { value = mutator(value) })
    return updateChain
  },
}
await Promise.all([incrementCounter(store), incrementCounter(store)])
process.exit(value === 2 ? 0 : 1)

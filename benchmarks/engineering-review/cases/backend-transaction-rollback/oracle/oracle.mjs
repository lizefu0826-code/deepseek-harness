import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('transaction oracle requires ER_BENCH_WORKSPACE')
const { transferFunds } = await import(`${pathToFileURL(join(workspace, 'transfer.mjs')).href}?run=${Date.now()}`)
const calls = []
const transaction = {
  begin: async () => { calls.push('begin') },
  debit: async () => { calls.push('debit') },
  credit: async () => { calls.push('credit'); throw new Error('credit rejected') },
  commit: async () => { calls.push('commit') },
  rollback: async () => { calls.push('rollback') },
}
let rejected = false
try {
  await transferFunds(transaction, 'a', 'b', 10)
} catch {
  rejected = true
}
process.exit(rejected && calls.join(',') === 'begin,debit,credit,rollback' ? 0 : 1)

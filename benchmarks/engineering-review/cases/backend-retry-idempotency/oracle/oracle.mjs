import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('retry oracle requires ER_BENCH_WORKSPACE')
const { chargeWithRetry } = await import(`${pathToFileURL(join(workspace, 'charge.mjs')).href}?run=${Date.now()}`)
const requests = []
const client = {
  async createCharge(request) {
    requests.push(request)
    if (requests.length === 1) throw new Error('response lost after commit')
    return { id: 'charge-1' }
  },
}
await chargeWithRetry(client, { id: '42', amount: 500 })
const [first, second] = requests
const valid = requests.length === 2
  && typeof first?.idempotencyKey === 'string'
  && first.idempotencyKey.length > 0
  && first.idempotencyKey === second?.idempotencyKey
  && first.amount === 500
  && second.amount === 500
process.exit(valid ? 0 : 1)

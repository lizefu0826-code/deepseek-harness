import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('event counter oracle requires ER_BENCH_WORKSPACE')
const source = readFileSync(join(workspace, 'event_counter.c'), 'utf8')
const atomicExchange = /atomic_exchange_explicit\s*\(\s*&pending_events\s*,\s*0u\s*,/u.test(source)
const atomicProducer = /atomic_fetch_add_explicit\s*\(\s*&pending_events\s*,\s*1u\s*,/u.test(source)
process.exit(atomicExchange && atomicProducer ? 0 : 1)

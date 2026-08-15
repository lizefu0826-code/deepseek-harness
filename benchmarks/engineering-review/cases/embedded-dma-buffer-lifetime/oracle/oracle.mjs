import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.env.ER_BENCH_WORKSPACE
if (!workspace) throw new Error('DMA oracle requires ER_BENCH_WORKSPACE')
const source = readFileSync(join(workspace, 'dma_sender.c'), 'utf8')
const durable = /static\s+uint8_t\s+dma_buffer\s*\[64\]/u.test(source)
const ownership = /static\s+bool\s+dma_in_flight/u.test(source)
  && /dma_in_flight\s*\|\|/u.test(source)
  && /dma_send_complete[\s\S]*dma_in_flight\s*=\s*false/u.test(source)
const startFailure = /platform_dma_start[\s\S]*!=\s*0[\s\S]*dma_in_flight\s*=\s*false/u.test(source)
process.exit(durable && ownership && startFailure ? 0 : 1)

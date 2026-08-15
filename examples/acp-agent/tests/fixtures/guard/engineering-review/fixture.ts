/** Model adapter that fails if the keyless composition unexpectedly starts a turn. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class CompositionOnlyAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('engineering-review Loader composition must not invoke a model')
  }
}

export const name = 'engineering-review-loader-fixture'
export const inject = ['llm']

/** Register a route solely to complete the keyless agent composition. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new CompositionOnlyAdapter())
}

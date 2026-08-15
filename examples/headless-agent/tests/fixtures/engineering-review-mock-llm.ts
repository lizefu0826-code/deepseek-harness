import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

const WRITE_ARGS = JSON.stringify({ file_path: 'driver.c', content: 'int changed(void) { return 1; }\n' })

const BLOCKER_FINDINGS = JSON.stringify({
  findings: [{
    category: 'blocking-and-concurrency',
    severity: 'high',
    confidence: 'high',
    title: 'Unbounded device wait',
    evidence: [{ path: 'driver.c', line: 1, detail: 'The device wait has no timeout.' }],
    impact: 'A failed device can stall progress forever.',
    recommendation: 'Add a bounded deadline and propagate timeout failure.',
    validation: 'Run with a device that never becomes ready.',
  }],
})

function toolCall(id: string, name: string, args: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
}

function text(value: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** Keyless adapter that scripts the gate's root turns and its reviewer child. */
class EngineeringReviewMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.messages[0]?.content?.find(block => block.type === 'text')?.text ?? ''
    // The session-title provider must not consume a gate turn.
    if (system.includes('Create a concise title')) {
      yield* text('Change the driver.')
      return
    }
    // The isolated reviewer child receives the engineering-review prompt; it
    // answers with one structured_output call carrying a blocker finding.
    if (JSON.stringify(options.messages).includes('Review the engineering change independently')) {
      yield* toolCall('er-reviewer-findings', 'structured_output', JSON.stringify(JSON.parse(BLOCKER_FINDINGS)))
      return
    }
    const last = options.messages.at(-1)
    const lastText = JSON.stringify(last)
    // The gate blocks the post-final-report write; its error result ends the script.
    if (lastText.includes('file modification is disabled after the final blocker report')) {
      yield* text('Final blocker report.')
      return
    }
    if (lastText.includes('"Correction pass 1/1"') || lastText.includes('Correction pass 1/1')) {
      yield* text('Correction attempted.')
      return
    }
    if (lastText.includes('"Final blocker report required"') || lastText.includes('Final blocker report required')) {
      yield* toolCall('er-root-write-2', 'write', WRITE_ARGS)
      return
    }
    if (lastText.includes('er-root-write-1')) {
      yield* text('Initial completion.')
      return
    }
    yield* toolCall('er-root-write-1', 'write', WRITE_ARGS)
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter serving the gate scenario. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new EngineeringReviewMockAdapter())
}

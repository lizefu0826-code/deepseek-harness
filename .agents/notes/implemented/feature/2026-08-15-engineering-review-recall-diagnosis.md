# Agent Note: Engineering-review recall — reviewer did not apply a task-declared contract

Status: implemented

English | [中文](2026-08-15-engineering-review-recall-diagnosis.zh.md)

## Problem

The 2026-08-15 six-case paired A/B calibration ([benchmark README](../../../../benchmarks/engineering-review/README.md)) surfaced the gate's first isolated-reviewer miss, on `embedded-dma-buffer-lifetime`: gate Recall 0 while the final outcome still passed (root Recall 1). The missed gold finding is a stack-local frame buffer outlived by an asynchronous DMA transfer.

An earlier draft of this note attributed the miss to information access: "fast review sees only the diff, and the retention contract lives outside it." That diagnosis is contradicted by the prompt construction and was corrected. The fast reviewer's prompt includes a `User task requirements:` section (`reviewer.ts`, `reviewerPrompt`) populated by `latestUserTask` from the root agent's user message; the benchmark passes the full `task.md` text as that message (`cli.ts` calibration task assembly), so the reviewer received the declared contract verbatim ("platform_dma_start retains the supplied buffer until dma_send_complete is called") together with the bounded diff. It still returned no findings (193-token subagent output, `findings: []`). The miss is therefore a reviewer behavior problem — the reviewer did not apply the task-declared contract to the changed lines — not an information-access problem; granting file access would not have changed what the reviewer saw.

## Evidence

- `reviewer.ts` — `reviewerPrompt` emits `User task requirements:\n${request.taskContext ?? '(not available)'}`; `latestUserTask` returns the latest user-sourced text message.
- `benchmarks/engineering-review/src/cli.ts` — calibration task assembly embeds the full `task.md` text (including the retention contract) as the root agent's user task.
- `benchmarks/engineering-review/cases/embedded-dma-buffer-lifetime/buggy.patch` — the frame buffer is stack-local; `platform_dma_start(frame, length)` retains it until `dma_send_complete`.
- `.artifacts/engineering-review-bench/2026-08-15T153825-336Z-*/embedded-dma-buffer-lifetime/buggy/run-1/treatment/result.json` — `gateBugRecall: 0`, reviewer subagent output 193 tokens, `engineeringResults[0].findings: []`; root model matched the gold finding.

## Decision

1. **Classify the DMA miss as a reviewer-behavior limitation.** The reviewer had the task contract and bounded diff, so granting broader file access is not the corrective action.
2. **Keep contract-application emphasis as a measured follow-up.** Any prompt change must be evaluated with the paired A/B protocol on the DMA case and the fixed variants that currently produce False Block 0.
3. **Retain the prompt/session instrumentation option.** A future benchmark run may persist the reviewer input and session so the observed behavior can be verified directly.

## Alternatives considered

- Deep-mode file access for fast reviews: not supported by the evidence — the reviewer already received the contract in its prompt; file access would not have changed the outcome.
- Raising the reviewer output cap: does not address the miss — the reviewer completed normally at 193 tokens.
- Keeping the status quo: preserves the strong False Block record but leaves the DMA class of miss to the root model.

## Consequences

The note records a reviewer-behavior limitation and a measured follow-up; the benchmark's paired control/treatment scoring covers both Recall and False Block.

## Additional observation: reviewer output budget on diff-less (non-Git) sessions

A later degradation (2026-08-16, GUI session) showed a distinct but related reviewer-behavior failure: the reviewer stopped with `max-tokens` at the 8,192-token cap while reviewing a ~20-file change set. The persisted reviewer child transcript shows the mechanism: in non-Git mode the review request carries no textual diff (`diff: ''`, truncated), so the reviewer must read files to learn what changed; it ran 25 tool-call steps (including reads that failed and glob/grep attempts outside its tool filter) and then spent its entire output budget on a narrative investigation report (~35K characters at the final step) instead of emitting the structured findings JSON, so `result.structured` was never produced and the gate degraded. Three fixes are applied: (1) prompt-level — the reviewer now receives an explicit instruction that its final message must be exactly the JSON object with no prose, and that file inspection is only for verifying a specific candidate; (2) runtime-level — when a reviewer stops with `max-tokens` and no structured findings, `runReviewer` retries once with a fresh child, a concise-answer directive, no tools, and a doubled output budget; (3) structural-level — non-Git reviews now receive a real unified diff, because file contents are snapshotted at first mutation each turn and diffed at review time, and an empty diff grants no tools so the reviewer answers directly instead of hunting files. See the [hardening note](2026-08-16-engineering-review-hardening.md) for the full change set.

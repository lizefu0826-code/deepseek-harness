# Agent Note: Engineering-review hardening and reviewer robustness

Status: implemented

English | [中文](2026-08-16-engineering-review-hardening.zh.md)

## Problem

The initial engineering quality gate ([quality-gate note](2026-08-15-engineering-review-quality-gate.md)) shipped five latent correctness issues and a reviewer that could degrade or flail in practice:

1. Evidence admission checked only that a finding's path was in the change set, so a reviewer could block on an arbitrary pre-existing line of a touched file.
2. An already-cancelled check could still spawn a process that ran to its own timeout.
3. Explicit hardware-adapter configuration pointing at a missing tool input was silently ignored.
4. The post-final-report "stop modifying files" instruction was a hint, not an enforcement.
5. A throwing third-party adapter sank the whole review.
6. On non-Git reviews (no textual diff), the isolated reviewer reconstructed changes by reading the whole workspace (observed 21-31 tool steps), then spent its output budget on narrative prose instead of the structured JSON, stopping with `max-tokens` without findings and degrading the gate to self-review five times in one session. Files created and removed within one turn produced an empty diff that still granted read tools, driving a 25-step aimless file hunt.

## Decision

- **Line-level admission**: findings must cite a line inside the changed diff hunks (`changedLineRanges` parses the unified diff); a truncated or absent diff falls back to file-level admission.
- **Early abort**: `runArgv` calls `signal.throwIfAborted()` before spawning.
- **Adapter isolation**: each adapter contribution runs in its own guard; failures become explicit `degradedReasons` instead of aborting the review, and the hardware adapter reports explicit configuration pointing at missing `compilationDatabase`/`verilatorArgsFile` inputs.
- **Final-report freeze**: once the final blocker report is requested, mutation tools (`write`/`edit`/`str_replace_editor`) are rejected at `tools/execute` with an explicit error.
- **Reviewer prompt discipline**: the prompt requires the final message to be exactly the structured JSON, with no prose; file inspection is limited to verifying a specific candidate.
- **max-tokens retry**: a reviewer that stops with `max-tokens` and no structured findings is retried once with a fresh child, a concise-answer directive, no tools, and a doubled output budget.
- **Non-Git snapshot diff**: file contents are snapshotted at first mutation each turn and diffed at review time (`createTwoFilesPatch`), so the reviewer receives a real unified diff covering create/edit/delete/truncation; an empty diff grants no tools so the reviewer answers directly instead of hunting files.
- **Web overlay**: `reviewerMaxTokens` raised from 2048 to the package default 8192.
- **Reasoning-effort pin**: the isolated reviewer child runs with `reasoningEffort: off` regardless of the parent session's effort. A parent running with high reasoning effort (e.g. the apiproxy default) spent the entire output budget on chain-of-thought before the final message, stopping at `max-tokens` with no structured findings and no successful retry (observed twice: `reasoningTokens == outputTokens == maxTokens` on both attempts). The reviewer installs an `agent/request` waterfall listener on its child that forces the effort off on every request — the child's first request has no persisted header, so its seed config carries no effort and the adapter default would otherwise win — keeping the JSON-only prompt discipline sufficient on every deployment. The calibration CLI had already set the global effort to off, which is why its runs never hit this.

## Verification

- 99/99 unit/integration tests, 100% per-file coverage (statements/branches/functions/lines), oxlint clean, full-workspace typecheck clean, and the keyless headless snapshot scenario passes.
- Six-case paired A/B calibration (2026-08-15, one run per cell): final outcome Recall 6/6 in both conditions; treatment False Block 0/6 versus control 3/6; treatment finding precision rose from 0.5 to 1 on the retry and ISR cases. The single gate miss (DMA stack-lifetime) was traced to the reviewer not applying a task-declared contract that was already in its prompt — a behavior issue, not information access; see the [recall diagnosis note](2026-08-15-engineering-review-recall-diagnosis.md).
- Live GUI verification after restart: reviewer investigation dropped from 21-31 tool steps to 1 step on real diffs and 2 steps on create-then-delete turns; zero `max-tokens` degradations.
- 2026-08-17: two further `max-tokens` degradations on the benchmark-report change (a 9-line diff, ruling out data-noise bloat) traced to the parent session's `reasoningEffort: high` inherited by the reviewer child; usage logs show every output token spent on reasoning. Fixed by pinning the child's requests to `reasoningEffort: off` via an `agent/request` waterfall listener; a dedicated integration test asserts the pin.

## Consequences

The gate now runs end-to-end without degradation: deterministic checks, an isolated reviewer that completes on the first attempt or one retry, and findings subject to line-level admission. The False Block record (0/6 treatment) is the strongest evidence of value. The DMA-class miss remains a known limitation, and the release-level acceptance bar still requires the repeated paired A/B sampling (24 variants x 10 runs) recorded in the benchmark README before publishing Recall/Precision claims.

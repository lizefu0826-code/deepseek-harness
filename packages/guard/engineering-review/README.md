# @deepseek-ai/dsh-engineering-review

English | [中文](README.zh.md)

An opt-in engineering quality gate for DeepSeek Harness. It records the current turn's code changes, runs existing deterministic project checks, requests an isolated structured review when risk warrants it, and steers evidence-backed blockers to the originating agent for at most two correction passes. The rubric covers general engineering failure modes rather than naming one language, protocol, or device.

> **Experimental test release:** enable this package explicitly and validate its findings against project-owned checks. Its configuration and review behavior may change before the first stable release.

## Composition

Mount the service after the agent, filesystem, subprocess, skill, tool, and subagent services. The default reviewer provider is the fresh one-shot `spawn` backend; the reviewer inherits the parent agent's LLM provider and model unless `reviewerProvider` or `reviewerModel` is configured. Each reviewer request has an independent `reviewerMaxTokens` output cap, defaulting to 8192.

```yaml
- id: engineering-review
  name: '@deepseek-ai/dsh-engineering-review'
  config:
    automatic: true
    riskThreshold: medium
    maxCorrectionPasses: 2
    maxDiffBytes: 524288
    maxFiles: 100
    checkTimeoutMs: 120000
    subagentProvider: spawn
    reviewerMaxTokens: 8192
```

The package registers `ctx.engineeringReview`, the `engineering_review` tool, and the `engineering-review` skill. A project-level `.dsh/skills/engineering-review` overrides the bundled skill through the normal skill precedence rules. The detailed rubric remains a package-owned skill reference and is supplied directly to the isolated reviewer.

## Change evidence and fingerprints

At the first `agent/pre-step`, a Git workspace captures a read-only baseline. Git calls use fixed argument arrays, `--no-optional-locks`, `--no-ext-diff`, and `--no-textconv`; worktree and index object identities cover staged, unstaged, untracked, renamed, and deleted paths without invoking repository-controlled filters. Automatic review compares the stopping boundary with that baseline, so pre-existing dirty work is not attributed to the current turn unless this turn changes it. Bounded file and diff caps become explicit high-risk evidence instead of silently hiding overflow.

Outside Git, successful `write`, `edit`, and `str_replace_editor` results provide changed paths and snapshot the pre-mutation file content; review time diffs that baseline against the current text, so the reviewer receives a real unified diff covering new, modified, deleted, and truncated files instead of an empty change list. A turn that creates and removes a file within the same turn yields an empty diff with no reviewer tools, so the reviewer answers from the prompt alone instead of hunting files. A successful shell or terminal call may have arbitrary effects, so the runtime records an unknown mutation scope and raises risk instead of claiming complete tracking. Each agent has isolated state, and one immutable fingerprint/depth/focus tuple shares in-flight and completed review work. A later code mutation creates a new fingerprint and is reviewed again.

## Checks, review, and stopping behavior

Explicit `.dsh/engineering-review.yml` checks take precedence over conservative discovery. Without that file, JavaScript workspaces may run existing `typecheck` and `lint` scripts (`test` is added for a manual deep review), while Cargo workspaces may run `cargo check` (`cargo test` for deep review). The runtime neither generates build metadata nor installs tools. Every check uses exact argv under the existing subprocess sandbox policy; command shells, package installation, automatic fixes, migrations, deployments, path escape, and duplicate ids fail validation.

Warnings do not prevent completion. A required check that fails or is unavailable, or a reviewer finding whose source severity is critical/high with high confidence, becomes a blocker. Optional analyzer failures are non-blocking degradation: the runtime explicitly steers one rubric-based self-review to the main agent. A reviewer that exhausts its output budget before emitting structured findings is retried once with a concise-answer directive, no tools, and a doubled budget; only a second failure degrades to the self-review steer. Blockers steer correction back to the same agent. After `maxCorrectionPasses`, the runtime requests one final evidence report and allows the next stopping boundary to finish, preventing an infinite loop. Setting the correction budget to zero selects report-only behavior: the first blocker requests the final report without authorizing a repair pass.

The independent reviewer is a fresh one-shot child with no inherited conversation reasoning. It receives at most 16 KiB of text from the latest direct user task, plus bounded change evidence, checks, project instructions, the winning skill, and the rubric. Agent output and plugin steering are excluded from the task projection. The prompt requires the final message to be exactly the structured JSON object with no prose, and file inspection is limited to verifying a specific candidate. A fast review with a complete diff gets no navigation tools; deep review, a truncated diff, or an absent diff uses available read-only file, image, LSP, and Git navigation tools. The reviewer cannot invoke write, edit, shell, terminal, deployment, or automatic-fix tools. `reviewerMaxTokens` bounds each child request even when the parent route has a larger provider default.

The runtime admits only high-confidence critical/high candidates that cite at least one changed file line falling inside the changed diff hunks (line-level admission; a truncated or absent diff falls back to file-level admission). Lower-confidence candidates, low/medium advice, diagnostics preferences, API-style suggestions, optional hardening, and candidates evidenced only outside the change do not enter the report. The structured schema limits category to a stable engineering taxonomy covering concurrency, lifecycle, recovery, data integrity, real-time behavior, state and compatibility, safety, verification, and HDL-specific clock/reset/CDC and width/sequential semantics. Admitted findings also carry confidence, file and line evidence, impact, recommendation, and validation; the runtime generates stable ids and maps every admitted candidate to a blocker.

## Project checks

The project file is versioned and contains only data, never a shell string:

```yaml
version: 1
checks:
  - id: firmware-build
    argv: [cmake, --build, build, --target, firmware]
    cwd: .
    files: ['firmware/**/*.c', 'firmware/**/*.h']
    timeoutMs: 120000
    required: true
  - id: unit-tests
    argv: [ctest, --test-dir, build, --output-on-failure]
    files: ['src/**', 'tests/**']
    required: true
```

`cwd` and `files` are workspace-relative. A check without `files` applies to every changed fingerprint. Optional checks report failures as degradation and request self-review; required failures block.

## Extension API

`ctx.engineeringReview.registerAdapter(adapter)` registers one HMR-safe adapter, and `ctx.engineeringReview.review(request)` runs the shared cached engine. An adapter can contribute risk signals, reviewer focus, exact-argv checks, and degraded-reason reports. It cannot emit findings, so a regex or file extension match can guide scrutiny but cannot declare a bug.

The companion package [`@deepseek-ai/dsh-engineering-review-hardware`](../engineering-review-hardware) is the first adapter. It adds C/C++/embedded and Verilog/SystemVerilog focus, uses `clang-tidy` only when an existing compilation database is present, and uses Verilator `--lint-only` only with an existing or explicitly configured argument file.

## Durable result

One compact `engineering-review/result` log event is appended per reviewed fingerprint. It retains the fingerprint, risk, pass/fail state, check statuses, short finding identities/titles, category/confidence, file-and-line coordinates, and degradation reasons. Evidence prose, large diffs, analyzer output, reviewer prompts, and repeated reports are deliberately excluded. The package invariant verifies that `passed` is exactly the inverse of required-check and finding blockers.

Design: [generic engineering quality gate](../../../.agents/notes/implemented/feature/2026-08-15-engineering-review-quality-gate.md). Service reference: [engineering review subsystem](../../../docs/subsystems/engineering-review.md).

## Model Experience

### Automatic stopping gate

#### What the model sees

No content is added when a turn has no engineering change or when a reviewed fingerprint passes. A degraded reviewer or optional analyzer contributes one plugin-sourced self-review message. A blocker contributes a plugin-sourced correction message containing required-check summaries and normalized blocker ids, titles, fixes, and validation methods. After the correction budget, one final-report message tells the model to stop editing and report unresolved evidence.

#### Token effect

The normal passing path adds no model tokens. Degradation and blocker messages are retained conversation history; check summaries and reviewer findings are bounded before rendering.

#### KV Cache effect

All steering messages are append-only after the reusable request prefix. A correction that changes code creates a new review fingerprint but does not change the tool catalog or system prompt.

### Engineering review tool

#### What the model sees

The [`engineering_review` schema](../../../docs/tool-catalog.md#deepseek-aidsh-engineering-review) accepts optional `depth: fast|deep` and `focus`. It returns the canonical report as formatted JSON in the existing generic tool card. `deep` always requests an independent reviewer; `fast` follows the configured risk threshold. The automatic stopping gate already reviews completion, so the model calls this tool only for an explicitly requested extra review or an earlier focused review.

#### Token effect

The stable tool schema is paid according to ToolRuntime mode. A manual call retains its arguments and bounded JSON result in conversation history; automatic review does not synthesize a tool call.

#### KV Cache effect

The schema is stable for the mounted deployment. Manual call arguments and results append after the reusable prefix.

### Bundled skill and reviewer request

#### What the model sees

The skill catalog advertises `engineering-review`; the body enters context only when the model loads the skill. The isolated reviewer receives a separate one-shot request containing the bounded latest direct user task, diff, paths, checks, project instructions, workflow, rubric, and focus. That child request is not inserted into the parent conversation.

#### Token effect

The parent pays only the skill catalog entry unless it loads the skill. High-risk/deep review pays a separate child request whose diff is capped by `maxDiffBytes` and whose output is capped by `reviewerMaxTokens`; the durable event does not replay that request.

#### KV Cache effect

Loading the skill or receiving a gate message extends the parent conversation. Reviewer context belongs to a fresh child and does not invalidate the parent's cache.

## Known Limitations and Deferred Work

- Non-Git review evidence is built from first-mutation content snapshots; files created and removed within one turn, and paths that cannot be read, yield an empty diff with no reviewer tools, so such changes are reviewed from the prompt alone. Arbitrary shell effects are intentionally classified as unknown high risk rather than reconstructed.
- Git path and diff caps preserve bounded work but can reduce reviewer precision; overflow remains visible through risk and truncation markers.
- Automatic standard-check discovery is intentionally small. Projects with nonstandard build graphs should commit `.dsh/engineering-review.yml`.
- A missing optional analyzer cannot produce its domain-specific diagnostics; the main-model self-review is a visible fallback, not equivalent evidence.
- Reviewer quality remains model-dependent. Stable blocker policy limits escalation, while forward evaluations must continue to measure recall and false blockers across domains.

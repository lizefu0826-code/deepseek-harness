# Engineering review

English | [中文](engineering-review.zh.md)

The engineering-review subsystem is an opt-in completion gate for code-producing agent turns. It combines deterministic project evidence with risk-triggered independent judgment, then returns only high-confidence blockers to the agent that made the change. The core remains domain-neutral; adapters add risk, focus, and check recipes without gaining authority to declare findings.

> **Experimental test release:** deployments must opt in and keep project-owned verification authoritative until the subsystem reaches its first stable release.

Service Definition: [`@deepseek-ai/dsh-engineering-review`](../../packages/guard/engineering-review) (`ctx.engineeringReview`, the `engineering_review` tool, the bundled skill, and `engineering-review/result`). The first Service Consumer is [`@deepseek-ai/dsh-engineering-review-hardware`](../../packages/guard/engineering-review-hardware), which registers one C/C++/embedded and HDL adapter. The design rationale lives in [the engineering quality gate Agent Note](../../.agents/notes/implemented/feature/2026-08-15-engineering-review-quality-gate.md).

## Review pipeline

At the first pre-step of each turn, the service captures a Git object-identity baseline or starts a non-Git window that snapshots each touched file's pre-mutation content. At the stopping boundary it derives changed paths, a bounded diff (for non-Git turns, a real unified diff built from the content snapshots), and a fingerprint. No change means no review. An already reviewed fingerprint reuses its result; a later mutation changes the fingerprint and re-enters the pipeline.

The engine loads versioned project checks or discovers only existing standard scripts, merges adapter contributions, and runs applicable exact-argv checks under the mounted subprocess sandbox. Risk at or above the configured threshold starts a fresh structured reviewer. `deep` manual review always starts it; `fast` uses the threshold. Critical/high findings block only at high confidence. Required check failures also block, while warnings do not.

```text
pre-step baseline
  -> stopping fingerprint
  -> deterministic checks
  -> risk contributions
  -> optional isolated reviewer
  -> pass | steer correction | final blocker report
```

Reviewer and optional analyzer failure is a visible degradation, not silent success. A reviewer that exhausts its output budget before emitting structured findings is retried once with a concise-answer directive, no tools, and a doubled budget; only a second failure reaches the degradation path, where the main agent receives one focused self-review request for that fingerprint. A blocker receives at most `maxCorrectionPasses` correction requests. The next unresolved boundary receives one stop-editing final-report request; the following boundary closes normally. A zero correction budget is a report-only mode and sends the first blocker directly to that final-report boundary.

## Evidence and safety boundaries

Git inspection disables optional locks, external diff, and text conversion, and hashes staged/worktree identities without running repository filters. Non-Git evidence snapshots each touched file at first mutation and diffs that baseline against the current text, so the reviewer receives real content instead of an empty change list; a file created and removed within one turn, or an unreadable path, yields an empty diff with no reviewer tools. Shell and terminal success marks mutation scope unknown and raises risk. File count, diff bytes, analyzer output, and logged summaries are bounded.

Project checks are data-only exact argv. The runtime rejects direct command shells, package installation, automatic-fix flags, migrations, deployments, duplicate ids, and workspace-relative path escape. It never installs dependencies, creates build metadata, or asks an analyzer to rewrite code. Checks run inside existing sandbox authority and do not request broader approval automatically.

The one-shot reviewer receives only a 16 KiB-bounded text projection of the latest direct user task, paths, bounded diff, check outcomes, project instructions, skill workflow, rubric, and focus. It receives neither parent-agent output nor plugin steering. The prompt requires the final message to be exactly the structured JSON object with no prose, and file inspection is limited to verifying a specific candidate. Fast review gets no navigation tools when the diff is complete; deep review, a truncated diff, or an absent diff may use available read-only file/image, LSP, and Git navigation tools. The structured schema requires one stable category from the shared engineering taxonomy. The parent runtime admits only high-confidence critical/high candidates whose cited line falls inside the changed diff hunks (line-level admission; a truncated or absent diff falls back to file-level admission), generates finding ids, and maps every admitted finding to a blocker. Lower-confidence candidates are omitted instead of becoming warnings.

## Adapter contract

`registerAdapter()` owns registration lifetime through Cordis effects. An adapter's asynchronous `contribute()` method may return risk signals, reviewer focus, exact-argv checks, and degraded-reason reports. It cannot return a finding or blocker. `review()` caches the immutable fingerprint/depth/focus request per agent, sharing concurrent callers while keeping agents isolated.

Hardware classification is deliberately only a selector. C/C++ paths contribute embedded concurrency, memory, timing, and recovery focus; HDL paths contribute clock, reset, width, handshake, synthesis, timing, and assertion focus. `clang-tidy` requires an existing compilation database. Verilator requires existing project arguments and always uses `--lint-only`.

## Durable projection

One `engineering-review/result` event per fingerprint retains compact decision evidence: fingerprint, risk, pass/fail, check id/status/required triples, finding identity/category/severity/confidence, file-and-line coordinates, and optional degradation reasons. It excludes evidence prose, the diff, full analyzer output, prompts, and repeated cached reports. The event is log-only and does not enter ordinary model history.

The package invariant rejects a result whose `passed` value is not exactly the inverse of its required failed/unavailable checks and blocker findings.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxengineeringreview--engineeringreviewruntime"></a>

### `ctx.engineeringReview` — `EngineeringReviewRuntime`

Generic engineering review engine and adapter registry.

```ts cordis-catalog
/**
 * Register one adapter until the calling plugin is disposed.
 * @param adapter - domain contribution provider with one stable id.
 * @returns the exact Cordis effect disposer for this registration.
 */
registerAdapter(adapter: EngineeringReviewAdapter): () => void

/**
 * Review one immutable change fingerprint, sharing in-flight and completed work.
 * @param request - bounded evidence, route owner, depth, and workspace readers.
 * @returns the canonical deterministic and reviewer report.
 */
review(request: EngineeringReviewRequest): Promise<EngineeringReviewReport>
```

Source: [`packages/guard/engineering-review/src/index.ts:238`](../../packages/guard/engineering-review/src/index.ts)
<!-- END GENERATED cordis-surface -->

# Agent Note: Generic engineering quality gate

Status: implemented

English | [中文](2026-08-15-engineering-review-quality-gate.zh.md)

## Problem

Engineering changes can be locally plausible while omitting routine system constraints: bounded progress, cancellation, ownership, partial I/O, cleanup, state commit order, compatibility, real-time limits, or adequate negative verification. A detector dedicated to one UART pattern or one language would miss the same failure shape elsewhere, while a permanent large checklist or unconditional second model call would tax every turn without enforcing project checks.

## Decision

Provide an opt-in `@deepseek-ai/dsh-engineering-review` service at the agent lifecycle boundary. Capture a per-turn Git identity baseline when available and successful mutation-tool observations otherwise; uncertain shell effects become explicit high risk. Key review work by immutable change fingerprint so unchanged stops deduplicate and later edits re-enter review.

Run project-owned deterministic checks before model judgment. Configuration is the versioned `.dsh/engineering-review.yml` exact-argv format; absent configuration permits only conservative discovery of existing standard scripts. The runtime rejects command shells, installation, automatic fixes, migrations, deployments, and path escape. Required failure blocks; optional analyzer failure requests a visible main-model self-review.

Use adapters only for risk signals, reviewer focus, and check recipes. They cannot emit findings. The first adapter covers C/C++/embedded and Verilog/SystemVerilog, and invokes `clang-tidy` or Verilator lint only when the project already supplies the required metadata.

At the risk threshold, start a fresh one-shot structured reviewer with the parent route by default, bounded evidence, project instructions, the winning skill, and a package rubric. Supply at most 16 KiB of text from the latest direct user task so the reviewer can test the change against its contract without inheriting parent-agent output, reasoning, or plugin steering. A fast review with a complete diff has no navigation tools; deep review or truncated evidence permits only available read-only navigation. Require a category from the stable engineering taxonomy and admit only high-confidence critical/high candidates with evidence on a changed line. Omit lower-confidence candidates instead of retaining them as warnings. Send admitted blockers to the originating agent for at most the configured correction budget, then request one final unresolved-blocker report and allow the following stopping boundary to close. A zero budget provides report-only review without authorizing a repair pass.

Cap reviewer output at 8,192 tokens by default, with an explicit `reviewerMaxTokens` override. Automatic lifecycle review is the normal gate; the `engineering_review` tool is reserved for an explicitly requested extra or focused review so an agent does not duplicate the same model call.

Persist one compact `engineering-review/result` event per fingerprint. Keep the decision facts and degradation reasons; exclude large diffs, prompts, analyzer streams, and repeated cached reports.

## Alternatives considered

- Put one exhaustive checklist in every system prompt. This spends tokens on unchanged and low-risk turns, weakens prompt focus, and cannot run deterministic project checks.
- Add pattern detectors for known mistakes such as blocking serial calls. Pattern matches lack enough execution context to declare defects and do not generalize across domains.
- Implement the policy directly inside the agent loop. The existing lifecycle and service seams are sufficient, and core ownership would make domain adapters and opt-in rollout harder.
- Start an independent reviewer for every change. This improves uniformity but imposes avoidable latency and model cost on low-risk changes.
- Let a reviewer edit the workspace. Independent evidence and correction ownership would blur, and a child with mutation tools would widen the authority surface.

## Consequences

The gate catches broad engineering failure classes through one reusable pipeline and lets projects promote their own build and test evidence to required blockers. Review cost is concentrated on medium/high-risk changes and explicit deep calls. Hardware support validates extension without making the core hardware-specific.

Non-Git tracking remains exact only for observed mutation tools; arbitrary shell effects intentionally degrade to unknown scope. Missing optional analyzers and reviewer failures remain visible but cannot manufacture deterministic evidence. The rubric requires an applicable requirement and changed-line evidence, recognizes unsigned elapsed subtraction as rollover-safe within its documented timeout range, and excludes low/medium advice, generic API-style preferences, optional hardening, and undocumented boundary assumptions from findings.

Keyless verification covers cache sharing and retry, process limits, warning and blocker outcomes, reviewer disposal, unknown shell scope, Loader composition, and a built CLI Web-overlay boot. The manual benchmark keeps gold data and external oracles outside temporary workspaces, injects blinded candidates after baseline capture, isolates each Harness home, and scans artifacts for copied credential material.

The manual benchmark contains 12 paired families and 24 buggy/fixed variants: eight standard families, three combined-risk families, and one advanced HDL family across Embedded C/C++, HDL, and Backend code. Available external oracles rejected all eight non-HDL buggy variants and accepted their fixed counterparts; the eight HDL variants report `oracle-unavailable` on a host without Icarus Verilog or Verilator. The UART oracle accepts any nonzero timeout failure code rather than imposing an undocumented numeric convention. One-run review-only calibration of a standard resource-lifecycle case, a combined retry/idempotency case, and the advanced HDL width case used the product-default medium threshold, a 3,072-token reviewer cap, and zero correction budget. Each treatment made one reviewer call and its independent gate matched the gold finding at Recall and Precision of 1. A paired UART fix run passed both external oracles and assigned no residual gold finding after repair; fixed review runs report False Block separately for control and treatment, and aggregate attempted manual-review protocol violations. These stochastic samples validate the stratified lifecycle and scoring path but are not release evidence; repeated paired A/B sampling remains required.

# Agent Note: Reproducible benchmark report (v0.1 report infrastructure)

Status: implemented

English | [中文](2026-08-16-engineering-review-benchmark-report.zh.md)

## Problem

The calibration runner already produced per-cell `result.json` artifacts, but there was no way to turn them into a
repeatable, reviewable experiment summary. Interpreting numbers required ad-hoc shell greps over `.artifacts/`, and each
interpretation risked silently mixing development-pilot runs (runner defects) with clean post-hardening runs. The
project needs one command that regenerates a deterministic report answering cost, latency, value, and risk without
re-running any model.

## Decision

- **Extractor + aggregator in one module**: `benchmarks/engineering-review/src/report.ts` scans
  `.artifacts/engineering-review-bench/` for `calibrate` runs, walks each cell (`case/variant/run-N/condition/result.json`),
  and normalizes every cell into a single ML-experiment record (case_id, domain, difficulty, risk_tags, variant,
  condition, repetition, provider/model, token usage split root vs reviewer, reviewer calls, correction passes,
  durationMs, oracle statuses, matched/missed findings, bugRecall/findingPrecision/gateBugRecall/gateFindingPrecision/falseBlock,
  harness revision, run timestamp).
- **Deterministic outputs** in `benchmarks/engineering-review/report/`: `results.csv` (one row per cell),
  `results.json` (records + headline aggregates), `report.md` (the human report).
- **Headline batch selection**: only runs recorded on the clean post-hardening revision `23bbce1d` feed the headline
  aggregates; the older `47f94385` development-pilot runs remain in the raw data but are excluded from headline
  numbers. The selection is a revision constant, so the report is reproducible from the same artifacts.
- **Honest experiment framing**: the report states task mode is review-only (Repair Success deliberately unmeasured),
  records model + harness revision + reviewer budget/risk-threshold config, flags the DMA gate miss as a known
  limitation, and labels every number as a model-dependent snapshot rather than a permanent guarantee.
- **No model cost**: generation is pure file processing; the regression command
  `pnpm exec tsx benchmarks/engineering-review/src/cli.ts report` costs zero tokens.

## Verification

- `tsc --noEmit -p benchmarks/engineering-review/tsconfig.json` clean; benchmark `cli.spec.ts` 7/7 passes.
- Generated report matches the session's observed numbers: treatment False Block 0/7 vs control 3/7; gate Recall 6/7
  (only DMA missed); treatment finding precision 0.81 vs control 0.65; median latency delta +18.5 s; reviewer marginal
  cost ≈20.4K input / 23.7K output tokens per gate call.

## Consequences

v0.1 report infrastructure is complete: one command regenerates the CSV/JSON/markdown report from existing artifacts,
with the regression dataset and headline batch pinned by revision. The next agreed steps (risk classifier, adaptive
reviewer, golden-set expansion, Correction benchmark) are deliberately not started; the project is in maintenance mode
for the engineering-review feature itself.

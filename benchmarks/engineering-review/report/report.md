# Engineering Review — benchmark report

Generated from calibration artifacts under `.artifacts/engineering-review-bench/`. Regenerate with
`pnpm exec tsx benchmarks/engineering-review/src/cli.ts report` — the command is deterministic and costs no model tokens.

## Experiment configuration

- **Headline batch:** 28 cells across 7 runs on harness revision `23bbce1d` (6 unique cases)
- **Model:** deepseek-official/deepseek-v4-flash
- **Reasoning effort:** off; **root output cap:** 8192; **reviewer output cap:** 3072; **risk threshold:** medium
- **Task mode:** review (detection only — the candidate is never repaired; Repair Success is deliberately not measured here)
- **Scoring:** outcome Recall/Precision on the assistant's final tagged report; gate Recall/Precision on the independent reviewer event only

> LLM benchmark, not a software test: every number below is a snapshot of this model at this revision. A change to the model, reviewer prompt, reviewer budget, or risk threshold can shift it. Treat these as experiment records, not permanent guarantees.

## Headline results (control vs treatment)

| Metric | control | treatment (gate) |
|---|---|---|
| Cells | 14 | 14 |
| Outcome bug Recall (mean) | 1.00 | 1.00 |
| Outcome finding Precision (mean) | 0.65 | 0.81 |
| Gate Recall (mean, independent reviewer) | — | 0.86 |
| Gate Precision (mean) | — | 1.00 |
| False Block Rate (fixed cases) | 0.43 | 0.00 |
| Median latency (ms) | 19962 | 38463 |
| Input tokens (incl. cache) | 476534 | 1008796 |
| Reviewer calls | 0 | 14 |

## The four questions

### Cost — how much does one review cost?

Treatment spent 1008796 input tokens and 62030 output tokens across 14 cells
(≈ 72057 input / 4431 output per cell),
of which the isolated reviewer used 20433 input and 23747 output tokens (14 reviewer calls).
Control spent 476534 input tokens. The gate's marginal cost is the reviewer call on high/medium-risk changes only.

### Latency — how much delay does it add?

Median 19962 ms (control) vs 38463 ms (treatment)
— a median delta of 18501 ms (93%).
The delay applies only to changes that reach the risk threshold.

### Value — does it reduce false blockers?

False Block Rate on fixed (clean) cases: **control 0.43 vs treatment 0.00**.
The gate's high-confidence + changed-line admission filters the bare model's false high/critical reports;
treatment finding precision is 0.81 vs 0.65 for control.

### Risk — does it miss high-severity issues?

Gate Recall (the independent reviewer alone) is 0.86; the assistant's final outcome Recall is 1.00.
Known miss this batch: embedded-dma-buffer-lifetime — the isolated reviewer returned no finding while the
assistant's report caught the defect (see the recall-diagnosis note). The gate is a second set of eyes, not the sole detector.

## Per-case detail

| case | difficulty | control Recall/Prec | control FalseBlock | treatment Recall/Prec | treatment gate Recall/Prec | treatment FalseBlock |
|---|---|---|---|---|---|---|
| backend-retry-idempotency | combined | 1.00 / 0.50 | 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 |
| embedded-dma-buffer-lifetime | combined | 1.00 / 0.25 | 1.00 | 1.00 / 0.25 | 0.00 / n/a | 0.00 |
| embedded-isr-event-loss | standard | 1.00 / 0.50 | 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 |
| embedded-uart-timeout | standard | 1.00 / 1.00 | 0.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 |
| hdl-clock-domain-crossing | combined | 1.00 / 1.00 | 0.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 |
| hdl-expression-width | advanced | 1.00 / 1.00 | 0.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 |

## Raw data

All calibration runs with cells are included in `results.csv` / `results.json`; the headline batch above uses only the
`23bbce1d` clean runs. Earlier `47f94385` runs were development pilots with runner defects
(candidate injection, oracle, or observation failures) and are excluded from headline aggregates.

## Limitations

- Detection-only: Repair Success is deferred to a separate Correction benchmark (review vs fix are different experiments).
- Single-sample cells: one run per case×variant×condition; variance is not yet measured.
- Model-dependent: numbers are a snapshot of deepseek-official/deepseek-v4-flash at report time.
- Reviewer output budget and prompt are part of the experiment config; changing them changes the numbers.

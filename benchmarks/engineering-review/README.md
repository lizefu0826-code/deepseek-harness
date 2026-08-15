# Engineering Review benchmark

English | [中文](README.zh.md)

This manual benchmark evaluates engineering-review with paired buggy and fixed variants. It is not a pnpm workspace member, default Vitest input, CI job, or shipped profile. Commands write only under the repository-ignored `.artifacts/engineering-review-bench/` and operating-system temporary directories.

The initial corpus contains 12 paired scenario families and 24 independently runnable buggy/fixed variants across Embedded C/C++, Verilog/SystemVerilog, and Backend code. Eight families are standard, three combine interacting risks, and one is an advanced HDL expression-sizing case, keeping general cases dominant while retaining a small stretch sample. HDL oracles use Icarus Verilog or Verilator and report `oracle-unavailable` when neither tool exists. Gold manifests, reference patches, and oracle sources stay outside the temporary agent workspace.

Validate manifests, apply every variant to a fresh Git repository, and run available external oracles:

```sh
pnpm exec tsx benchmarks/engineering-review/src/cli.ts validate
```

The command prints the artifact directory. `run.json` records the repository revision and host tool versions; `results.jsonl` records one row per variant.

Run the isolated with-key calibration explicitly:

```sh
pnpm exec tsx benchmarks/engineering-review/src/cli.ts calibrate --runs 3 --variant all --condition all
```

Use `--case ID`, `--variant buggy|fixed|all`, or `--condition control|treatment|all` to narrow a pilot. `--task-mode fix` measures repair and external-oracle success. `--task-mode review` sets the treatment correction budget to zero, keeps the candidate unchanged, and isolates finding Recall/Precision. Both conditions must emit the same marked JSON report; control scoring uses that report, while treatment scoring uses the independent gate event and records whether the root report was well formed. Gold matching also enforces the declared minimum severity. The runner reads the managed DeepSeek credential from `DSH_HOME/.credentials.yaml`, copies only the required Harness settings into a temporary home, and removes it after each process. It fails and removes the run artifact directory if the credential appears in any persisted result.

Each candidate is injected after baseline capture. Control and treatment receive the same task, disabled reasoning, and 8,192-token root response cap; treatment only adds the automatic engineering-review overlay, with the product-default medium-risk threshold and a 3,072-token reviewer cap. Tasks explicitly prohibit manual `engineering_review` calls. Results split root and subagent usage, record automatic review observation and correction passes, preserve final patches, and run the external oracle independently of agent claims. Outcome Recall/Precision scores the final marked report for both conditions; separate gate Recall/Precision scores only treatment's independent review event, so successful fallback self-review remains visible without hiding reviewer misses. In fix mode, a passing final oracle leaves no expected residual defect and scoring uses only the last gate result; defect Recall belongs to review mode, while Fix Success measures repair. False Block Rate is reported separately for control and treatment on fixed review cases: control uses high or critical findings from its marked report, while treatment uses the actual gate outcome. Summary output also counts attempted manual review calls and runs with such protocol violations. Gold matching requires an exact category or an explicitly declared cross-category equivalent, minimum severity, evidence path, and line inside the declared range; category-and-path matches without an in-range line enter the manual-review queue instead of receiving keyword credit.

Run the benchmark-owned keyless protocol and scorer tests explicitly with `node node_modules/vitest/vitest.mjs run --config benchmarks/engineering-review/vitest.config.ts`.

Do not treat a small pilot as release evidence. One-run review-only calibration across a standard resource-lifecycle case, a combined retry/idempotency case, and the advanced HDL width case produced gate Recall and Precision of 1 for all three treatment samples. Treatment added one reviewer call and took 29.2, 35.5, and 37.6 seconds, compared with 10.8, 15.0, and 19.6 seconds for their controls. The HDL oracle remained unavailable on this host. Tool-attempt records also showed that a root model can try the disabled manual review tool despite the task prohibition; the attempt does not count as a reviewer call. These stochastic samples validate the stratified path and expose protocol behavior, but repeated paired A/B sampling remains necessary before release claims.

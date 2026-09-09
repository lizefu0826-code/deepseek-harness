# @deepseek-ai/dsh-engineering-review-hardware

English | [中文](README.zh.md)

The first domain adapter for [`@deepseek-ai/dsh-engineering-review`](../engineering-review): it recognizes changed C/C++/embedded and Verilog/SystemVerilog paths, raises their engineering risk, and contributes focused review questions and existing-project analyzer recipes. It never treats a file extension or text pattern as a finding.

> **Experimental test release:** use this adapter with the experimental engineering-review package and verify analyzer results against the project's own toolchain.

## Install

Install the core package first, then add the fixed adapter artifact from the public release:

```sh
pnpm add https://github.com/lizefu0826-code/deepseek-harness/releases/download/engineering-review-v0.2-rc.1/deepseek-ai-dsh-engineering-review-hardware-0.1.0-rc.5.tgz
```

## Configuration and behavior

```yaml
- id: engineering-review-hardware
  name: '@deepseek-ai/dsh-engineering-review-hardware'
  config:
    compilationDatabase: build/compile_commands.json
    verilatorArgsFile: .dsh/verilator.args
```

Both fields are optional workspace-relative paths. Without explicit paths, C/C++ review looks only for `compile_commands.json` or `build/compile_commands.json`; HDL review looks only for `.dsh/verilator.args`, `verilator.f`, or `verilator.args`. The adapter never creates these files, infers a build graph, installs either executable, or passes an automatic-fix option.

When an existing compilation database is available, the adapter contributes optional `clang-tidy -p <directory> <changed paths...>`. When an existing Verilator argument file is available, it contributes optional `verilator --lint-only -f <file>`. Missing executables or failed optional runs degrade to explicit main-model self-review through the core gate and do not become deterministic blockers by themselves.

C/C++ focus includes blocking progress, ISR/thread sharing, lock and I/O interaction, heap/stack, DMA/cache coherency, timeout and wraparound arithmetic, buffers, partial I/O, register access, lifetime, and recovery. Added C/C++ control flow that appears to poll hardware state without an observable bound raises review risk to high; this remains a scheduling signal and never declares a finding. HDL focus includes CDC, reset release, width/signedness, latch inference, assignment semantics, handshake backpressure, synthesis semantics, timing constraints, and assertions.

## Model Experience

Indirectly, through dsh-engineering-review risk, focus, analyzer results, and reviewer or self-review messages; this adapter registers no prompt section or tool schema of its own.

#### KV Cache effect

The adapter itself adds no stable model context; any resulting gate message is append-only, and an isolated reviewer request belongs to a fresh child.

## Known Limitations and Deferred Work

- The adapter does not synthesize compilation databases, Verilator argument lists, timing constraints, or testbenches.
- Analyzer recipes are optional because tool availability and project flags are deployment-owned; projects can promote equivalent configured checks to `required` in `.dsh/engineering-review.yml`.
- Language classification is extension-based and only selects scrutiny. Final findings still require file and line evidence from deterministic tools or engineering review.

# Engineering review rubric

## Context and assumptions

- Confirm execution environment, ownership, units, ordering, timing, hardware and protocol assumptions that affect correctness.
- Check that defaults, partial configurations, unsupported modes, and version differences fail safely and visibly.
- Do not turn a generic possibility into a finding. A stalled clock, invalid caller input, missing cancellation source, scheduler starvation, or unsupported deployment requires evidence in the changed code, an applicable contract, a call site, project configuration, or a failing check.
- Admit a finding only when the evidence identifies a violated task, project, interface, or execution requirement, a concrete failure path, and at least one changed file line. If the evidence supports only a diagnostic preference, API design opinion, optional hardening, or maintainability suggestion, return no finding.
- Return only high-confidence critical/high correctness defects. Omit medium/low-confidence candidates and low/medium suggestions rather than filling the report with non-blocking advice.
- Preserve explicit interface semantics. In wait-until-ready APIs, an already-satisfied condition may intentionally win over a deadline; report that ordering only when an applicable contract requires the deadline to win.

## Blocking and concurrency

- Identify blocking I/O, polling, waits, locks, interrupts, callbacks, worker boundaries, backpressure, and cancellation behavior on each affected path.
- Check deadlock order, reentrancy, atomicity, memory visibility, interrupt/thread shared state, unbounded queues, lost wakeups, and work performed while holding a lock.

## Resources and lifecycle

- Pair acquisition with release across success, error, cancellation, retry, teardown, and partial initialization.
- Check file descriptors, processes, tasks, subscriptions, buffers, memory, DMA ownership, clocks, resets, sessions, transactions, and temporary artifacts.

## Timeout, cancellation, and recovery

- Require bounded progress where external state may stall. Preserve independent timeout, cancellation, exit, and partial-result facts.
- Verify retry idempotency, cleanup before retry, degraded modes, restart behavior, rollback, and recovery after partial success.

## Boundaries and data integrity

- Check lengths, indices, integer width and sign, overflow and wraparound, encoding, endianness, units, partial reads/writes, framing, truncation, validation, and serialization compatibility.
- Treat data from files, devices, processes, networks, models, plugins, and persisted state as boundary input.

## Performance and real-time behavior

- Check algorithmic growth, allocation, copies, blocking sections, interrupt latency, stack use, cache/DMA coherency, hot-loop logging, and work that violates a stated deadline.
- Do not label an optimization issue a correctness blocker without an applicable latency, memory, throughput, or power requirement.
- A synchronous bounded poll is not a finding by itself. Require evidence that it holds a lock, masks the producer, runs in an interrupt, violates a stated scheduling or power requirement, or prevents its own completion condition.

## State consistency and compatibility

- Trace authoritative state, derived projections, commit points, notification order, cache invalidation, restart/replay, schema versions, API compatibility, and feature negotiation.
- Check that failure does not publish success state or leave readers observing a partially committed transition.

## Security and safety

- Check authority, path containment, injection, credential exposure, unsafe defaults, privilege changes, denial handling, memory safety, dangerous hardware states, and fail-open behavior.

## Observability and verification

- Require diagnostics that identify the failed subject and corrective action without leaking secrets or overwhelming hot paths.
- Match tests and checks to the risk: deterministic negative cases, boundary values, cancellation and teardown, concurrency schedules, hardware assertions, lint/synthesis, integration paths, and recovery behavior.
- A passing test is evidence only for the behavior it actually observes.

## C/C++ and embedded focus

- Inspect blocking paths, ISR/thread sharing, volatile versus atomic semantics, lock and I/O interaction, heap and stack use, DMA/cache ownership, timeout arithmetic, counter wraparound, buffer bounds, register access, partial I/O, and hardware error recovery.
- For an unsigned N-bit tick and a timeout within the documented unambiguous range, `(uintN_t)(now - start)` is rollover-safe across a counter wrap. Do not recommend `now > start + timeout`, which is not rollover-safe.
- Treat `elapsed > timeout` versus `elapsed >= timeout` as interface boundary semantics. Without a contract that defines the exact deadline tick or says zero means no wait, do not report either comparison solely from preference.

## Verilog and SystemVerilog focus

- Inspect clock-domain crossings, synchronizers, reset assertion and release, width and signedness, latch inference, blocking/nonblocking assignments, handshake backpressure, synthesis versus simulation semantics, timing constraints, and assertions.

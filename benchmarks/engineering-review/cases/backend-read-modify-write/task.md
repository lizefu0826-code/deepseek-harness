Validate and finish `incrementCounter`. Multiple workers may call it concurrently against the same store. Every successful call must contribute exactly one increment; the store provides an atomic `update(mutator)` operation in addition to ordinary reads and writes.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

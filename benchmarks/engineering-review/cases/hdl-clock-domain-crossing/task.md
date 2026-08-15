Validate and finish the single-bit level synchronizer. `async_level` is stable for at least three destination clock edges. `synced_level` must be produced through the conventional two-stage destination-domain synchronizer; this block intentionally has no reset.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

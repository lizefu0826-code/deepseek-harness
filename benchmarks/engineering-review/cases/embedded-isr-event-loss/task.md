Validate and finish the candidate event counter. Interrupts may record events while the main loop consumes all pending events. A successfully recorded event must be returned by the current or a later consume operation; do not silently lose an interrupt between snapshot and clear.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

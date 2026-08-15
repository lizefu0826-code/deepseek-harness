Validate and finish `deadline_expired` for a wrapping unsigned 32-bit platform tick. Timeouts are always less than half the counter range. Return false before the interval elapses and true after it elapses, including when the counter wraps.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

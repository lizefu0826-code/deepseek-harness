Validate and finish `loadConfig`. `openConfig` returns a handle with asynchronous `readText()` and `close()` methods. The handle must be closed exactly once after acquisition whether reading, parsing, or returning succeeds or fails.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

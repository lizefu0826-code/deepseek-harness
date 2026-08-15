Validate and finish `chargeWithRetry`. A request may complete at the payment service while its response is lost, so one retry is allowed only when both attempts carry the same stable idempotency key derived from the order identity. Preserve the original amount.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

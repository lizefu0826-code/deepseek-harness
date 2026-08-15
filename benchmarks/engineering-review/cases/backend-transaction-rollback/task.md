Validate and finish `transferFunds`. The transaction object exposes `begin`, `debit`, `credit`, `commit`, and `rollback`. A failure after begin must roll back before the original error is propagated; commit must occur only after both balance changes succeed.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.

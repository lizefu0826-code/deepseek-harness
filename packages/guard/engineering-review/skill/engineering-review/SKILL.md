---
name: engineering-review
description: Review changed engineering code for systemic correctness risks before completion. Use for implementation or review work involving blocking and concurrency, resource lifetime, timeout and recovery, boundaries and data integrity, performance and real-time behavior, state consistency, compatibility, security, observability, or validation adequacy.
---

# Engineering Review

1. Establish the changed paths, bounded diff, project instructions, and deterministic check outcomes. Distinguish changes made in this turn from pre-existing dirty work.
2. Read [references/rubric.md](references/rubric.md) when the change contains engineering code or the requested focus names a rubric category.
3. Trace affected execution paths and state transitions. Verify assumptions against definitions, call sites, configuration, and tests; do not infer a bug from a pattern match alone.
4. Report only high-confidence critical/high correctness defects backed by an applicable requirement and at least one changed line. Omit diagnostics preferences, API-style suggestions, optional hardening, generic possibilities, and any candidate whose confidence is medium or low. For each finding, name the category, severity, confidence, file and line evidence, impact, smallest safe fix, and a verification method.
5. Treat every admitted finding as a blocker. Do not emit lower-confidence candidates or low/medium suggestions as warnings.
6. When deterministic required checks fail, fix the change and rerun the narrow relevant checks. Do not install tools, generate build configuration, run automatic fixes, migrations, or deployments.

This skill is guidance for engineering judgment, not a regex checklist. A project-level `.dsh/skills/engineering-review` may replace it with stricter local instructions.

# Architecture and extension points

The CLI connects to one loopback Fastify runtime. That owner writes incremental
SQLite state, runs one worker and controls one persistent Chromium context. React
uses validated API mutations with CSRF/Host protection. No cloud backend.

Feed → source observations/jobs → unique application queue → guarded adapter →
READY/NEEDS REVIEW/SKIPPED → human submission → passive/manual SUBMITTED.

## Modules

- `config`: Zod profile, authorized paths and private setup.
- `db`: Drizzle schema, transactional versioned SQL migration and lifecycle methods.
- `feed`: all-category parsing, age rules and stable identity/canonicalization.
- `answers`: canonical scoped facts, alias rules, typed mapping, history and corrections.
- `browser` / `forms`: ownership, submit guard, host circuits, inspection, upload and validation.
- `ats`: vendor signatures and stage/navigation rules using shared services.
- `llm` / `verification` / `security`: text-only generation, correlated mail and Keychain.
- `runs` / `cli`: queue, recovery, attempts, API and notifications.

## Adding an adapter

Implement ATSAdapter or extend StructuredAdapter with vendor rules/hooks. Provide
strong signatures, stable job identification patterns, permitted stage transitions,
safe navigation controls and strong success detection. Never import Playwright or
add direct mutation methods in adapter code; ESLint enforces the boundary.

Form inspection/resolution must remain shared. Add small semantic helpers to the
guarded layer when controls truly differ. Final buttons, Enter and native application
submission remain prohibited. A generic label does not prove action semantics.

Add local HTML fixtures with a fake final-submit counter, then test both supported
flows and ambiguous/security-control failures. Update coverage to distinguish fixture
support from supervised live-validated variants. Never use CI to apply at employers.

## Facts and conflicts

Fact uniqueness is `(canonicalKey, scope)`, with `global`, `company:normalized name`
and `job:local job ID` scope identifiers. Stability and scope are independent.
Values have types, provenance, confirmation/expiry and revision history. Unknown
creates an invalidation tombstone. Profile changes use recorded import baselines
to distinguish newly conflicting values from stale files after a human correction.

Canonical aliases must be explicitly confirmed when not confidently recognized.
Transformations such as citizenship→Yes/No do not blindly copy stored strings.
Combined/qualified questions that cannot establish individual facts require review.

## Limitations requiring evidence

Third-party JavaScript, session drafts and request endpoints are not universally
predictable. The code action invariant is enforceable; all server-side side effects
cannot be proven absent. Prior applications outside this database also cannot be
universally discovered. Fail closed on ambiguity and document real limitations.

# Approved implementation checklist

Build sequentially; no live application submissions in validation.

- [x] Configuration, private file protection, scoped project repository
- [x] SQLite/Drizzle, migrations, feed, identities, state machine, dry-run
- [x] Persistent canonical facts, aliases, corrections, conflicts, invalidation
- [x] Guarded browser actions, resume uploads, inspection and preflight
- [x] Greenhouse, Workday, Ashby, iCIMS, Oracle and generic adapters
- [x] Loopback dashboard, human takeover, history/import, recovery, 10-tab cap
- [x] Keychain, optional text-only AI and Gmail verification
- [x] Unit/integration tests, real-feed dry-run, documentation and QA

Coverage is fixture-tested, not live-validated. See [adapter boundaries](ADAPTERS.md).
Private profile, credentials and optional provider/OAuth setup remain user configuration.

Locked decisions: final submit human-only; no anti-bot bypass; sequential worker;
ambiguous login never triggers registration; early human-unlockable failures are
NEEDS REVIEW; unverified recovered READY forms downgrade to NEEDS REVIEW;
SSNs, government IDs, signatures and consent are never persisted;
browser corrections require confirmation; scoped facts never overwrite conflicts.

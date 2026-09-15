# Application Desk

A local macOS job-application preparation agent. It reads every category in
SimplifyJobs/New-Grad-Positions, finds open jobs aged **0–7 days inclusive**, and
prepares unseen applications sequentially. You review exceptions and perform
the final submission yourself.

The repository now contains the worker, persistent SQLite database, learned-fact
store, dashboard, guarded Playwright workflows, Keychain helper, optional AI and
Gmail integrations, and local tests. Live employer/tenant coverage is **not yet
validated**; see [adapter coverage](docs/ADAPTERS.md).

## Safety model

- The worker prepares applications and cannot invoke an identified final job
  submission action. Review pages transfer to human ownership.
- A centralized action guard rejects final/ambiguous actions, native application
  form submission, and automation advancement from REVIEW. Account-only login,
  registration and verification are distinct permitted workflows.
- ATS adapters cannot import Playwright or directly click/press/evaluate pages;
  shared browser services perform guarded mutations.
- Known final submission endpoints are blocked while automation owns a page.
  You submit normally after human takeover; there is no automation Submit API.
- No CAPTCHA solving/bypass, stealth, spoofing, proxies, security-control bypass,
  assessment completion, password resets, or parallel application workers.
- Unknown factual answers and personal legal attestations remain human.
- Remote site JavaScript can have hidden side effects. The guard is a tested
  software invariant, not a universal guarantee about third-party server code.
  Unverified flows stop rather than guessing what a button does.

## Installation

Use an updated supported Node LTS and npm. Xcode command-line tools are needed
for the small macOS Keychain helper (`xcode-select --install` if absent).

```sh
npm ci --legacy-peer-deps
./node_modules/node/bin/node ./node_modules/playwright/cli.js install chromium
npm run setup
npm run build
```

Scripts use the project-local Node 24 executable installed as a dev dependency;
they do not replace your system Node. The dedicated SQLite driver uses Node-API
to avoid Node-version ABI rebuilds. This is a local application: no deployment,
cloud database, dashboard accounts, or scheduler is needed.

## Private setup

Setup creates `private/profile.local.json` from the dummy example without
overwriting existing files, and initializes `data/agent.sqlite`. You can use
`npm run setup -- --no-credentials` to configure the password later.

Edit the private profile with your actual contact information, structured
education/employment, explicit authorization/demographic facts, and resume path.
Omit unknown facts; never substitute example values. The real profile remains
editable and is never committed. Live preparation rejects placeholder identity
and missing resumes.

`preferences.jobSource` is the reusable answer for normal referral/source
questions and defaults to `LinkedIn`. Text fields receive that value directly;
choice controls prefer a LinkedIn option and conservatively fall back to `Other`.

Optional demographic facts include `demographics.race` (a string or list),
`demographics.transgender` (boolean), and `demographics.sexualOrientation`
(a string or list). Configured values are answered consistently; missing values
remain unanswered. Specific race values take precedence over a generic parent
category when both are offered by a form.

`resume.path` can be an absolute path or a path relative to the project. One
primary resume is used. PDF text extraction is available with:

```sh
./node_modules/node/bin/node --import tsx src/cli/index.ts extract-resume
```

Review extracted text before saving it into an ignored private text file and
setting `resume.verifiedTextPath`. Only explicitly reviewed text becomes verified
AI context; extraction alone does not establish factual accuracy.

### ATS password in Keychain

```sh
npm run credentials -- ats
```

The prompt does not echo input. A tiny compiled Security.framework helper stores
the password under service `job-apply-agent`, account `ats-default-password`.
Secret input travels over stdin, not argv, shell commands, environment files,
JSON, SQLite, or logs. Keychain may request your normal macOS access approval.

One dedicated password is used only for ATS accounts. A tenant receives at most
one credential attempt per run. Ambiguous failed login never triggers registration.
Explicitly absent accounts can use normal registration. Password-policy rejection,
existing different credentials, MFA and ambiguous authentication require review.
The ATS password is never used for Google/Microsoft/Apple/GitHub identity providers.

### Optional AI

Add this nonsecret configuration to your private profile:

```json
{
  "ai": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "YOUR_CONFIGURED_MODEL",
    "structuredOutput": false
  }
}
```

Then run `npm run credentials -- ai` to store the API key in Keychain. A compatible
local endpoint is also supported at HTTP localhost/127.0.0.1. Model and endpoint
are explicit; no model/key is fabricated. Compatible endpoints must return the
requested JSON answer/evidence shape; schema mode is optional.

Only approved relevant facts, reviewed resume text, application question and
sanitized job text are sent. The provider has no tools, browser, shell, mail or
secret access. Generated claims/limits are checked, stored with provenance, and
shown in the dashboard. This validation is conservative and cannot prove every
natural-language claim; review the indicated generated answers before submitting.
Without AI, open-ended questions become NEEDS REVIEW. Required cover-letter files
remain manual in V1; text cover letters use the same safe answer generation.

### Optional Gmail verification

1. Create a Google Cloud project, enable Gmail API, configure the OAuth consent
   screen for your own account, and create an **OAuth Desktop application** client.
2. Save the client JSON to `private/gmail-client.local.json`.
3. Add `gmail: { enabled: true, clientPath: "private/gmail-client.local.json",
trustedOrigins: {} }` to the private profile.
4. Run `npm run gmail` and complete Google's normal OAuth flow.

Only `gmail.readonly` is requested. This scope technically grants mailbox-wide
reading; the implementation searches narrow recent recipient/sender/verification
queries and fetches only candidate messages. No sending, deletion or modification.
Refresh tokens remain in Keychain. Gmail contents never enter the LLM or logs.
Google testing/personal-app restrictions may require periodic reauthorization.

Verified links must use the active ATS origin or origins explicitly approved
under `gmail.trustedOrigins[tenantIdentifier]`. Redirects to unknown origins are
blocked before navigation. Ambiguous messages, reset/recovery alerts, unfamiliar
intermediaries and uncorrelated codes become NEEDS REVIEW. Gmail failure does not
block the rest of the run.

## Commands

```sh
npm run dry-run                       # Feed + dedupe report only; no employer visits
npm run dry-run -- --lookback 7
npm run dry-run -- --limit 1         # Show one selected new job; write no state
npm run dry-run -- --ats workday
npm run apply                         # Start/connect runtime, ingest and prepare
npm run apply -- --lookback 7
npm run apply -- --limit 1           # Safest first live run: prepare one new job
npm run apply -- --ats workday --limit 1
npm run dashboard                     # Dashboard/runtime without preparing jobs
npm run status
npm run retry -- --application APPLICATION_UUID
npm run history -- --url 'https://employer.example/jobs/123' --company 'Example' --role 'Engineer'
```

The dashboard binds **only** to `http://127.0.0.1:4317`. Its API enforces Host,
same-origin and CSRF checks. The runtime owns one persistent Chromium profile in
`data/browser`, never your personal Chrome profile. Keep the runtime running while
reviewing; stopping it can lose unsaved forms. Do not start multiple owners.

## Review workflow and statuses

- **READY:** Supported fields are completed, upload/validation checks passed, and
  the final submission control is available. Review and press Submit yourself.
- **NEEDS REVIEW:** A specific human action can reasonably unlock/resume the
  application, even early: unknown answer, authentication, verification, unsupported
  widget, attestation, ambiguous identity, or lost form/session.
- **SKIPPED:** Normal preparation cannot reasonably continue: closed/inaccessible
  job, early blocking CAPTCHA, locked account, unsupported architecture/assessment,
  or technical failure. Reasons and retryability are retained.
- **SUBMITTED:** Strong passive success observation or your explicit confirmation.
  Terminal; its browser tab closes automatically and it never queues again.

Open/Focus transfers a PROCESSING page to human control and pauses its automation.
Only explicit Resume returns it to the worker. The dashboard never presses Submit.
Use Mark Submitted if observation is uncertain. Mere navigation/button disappearance
is insufficient confirmation.

At **10 retained review tabs**, preparation pauses and preserves the remaining queue.
Submit applications or explicitly close tabs, then press Continue queue. Closing
an unsaved tab warns about data loss. READY downgrades to NEEDS REVIEW if the tab
or verified form is lost. Review counts are historical until recovery verifies it.

## Persistent application facts

Known factual questions use typed canonical facts, confirmed aliases and conservative
semantic rules. Citizenship, sponsorship time qualifiers, company-specific employment,
experience and location-specific willingness are not interchangeable.

Answer unresolved questions in Details. Unambiguous known factual answers are saved
with scope; conflicts require correction confirmation. Combined sponsorship and
negative citizenship answers cannot establish multiple underlying facts automatically.
Unknown mappings can be saved application-only; add a fact and an explicit question
alias in My Application Facts to enable reuse.

Edit/Correct facts to affect future applications immediately. Delete/Mark Unknown
invalidates reuse without letting stale profile imports resurrect a value. Fact
history records revisions. A value previously imported only from the private
profile follows later profile edits. Human-confirmed/corrected facts retain
precedence and expose later profile disagreement for review.
Expired temporary facts are unavailable. Confirmed experience numbers are reused,
not automatically inflated with time.

Before an outcome is assigned, required controls with known semantic facts are
reconciled against their actual UI state. A dropped email, phone, location or
choice is retried once and reported as an automation error if the site still does
not retain it. Correct existing values are left intact.

Details can check visible browser corrections and stage them for confirmation;
it does not record arbitrary keystrokes or silently modify shared facts. Human edits
on hidden/review-only controls may need dashboard entry. Open-ended motivation
answers remain application history, not global reusable facts.

Never persist passwords, SSNs/government IDs, signatures, certifications or consent.
Other explicitly approved sensitive facts are local and reusable only with clear
wording/scope. Screenshots are omitted on credential/identifier pages.

## Dedupe, retry and recovery

The permanent database tracks ATS tenant/requisition identities and canonical URL
aliases, with unique job/application constraints. Tracking parameters are removed
conservatively; actual IDs are retained. Similar titles never establish duplicates.
Closed rows lacking IDs/URLs remain source observations without fabricated identities.

Each run inspects the rolling window independently of the last-run timestamp.
Already READY/NEEDS REVIEW applications are retained rather than redone. A queued
job does not disappear merely because it ages past seven days while paused.
Record applications made before installation through the dashboard or history CLI.
Unknown historical submissions cannot be detected universally.

`--limit` is applied only after the complete rolling-window scan and permanent
dedupe. All eligible jobs are recorded as discovered, but only the selected new
jobs receive application rows or attempts. Deferred jobs therefore remain new and
can be selected on a later run. Existing applications do not consume the limit.
Omitting the option preserves the normal unlimited queue behavior. Limits must be
positive integers.

`--ats` accepts `workday`, `greenhouse`, `ashby`, `icims`, `oracle`, or
`generic`. Selection applies rolling lookback and permanent application dedupe
first, filters the remaining new jobs by ATS, and applies `--limit` last. Jobs
excluded by ATS or limit receive no application/attempt record and remain eligible
for later runs. Dry-run reports the total new queue, ATS matches, exclusions, and
the final number that would be processed without changing SQLite.

One to two transient navigation retries are permitted; preparation has three attempts
maximum. Resume is explicit. Security challenges/429s pause a host for the run;
repeated main-document 403s do likewise. No CAPTCHA retries or credential resets. After normal human resolution, open the skipped tab and explicitly confirm its blocker is resolved before resuming. Host circuits remain active for the current run; start a fresh manual run if that host is paused.
Startup retains interrupted attempts, downgrades stale PROCESSING/READY to review,
and uses normal ATS drafts where available. Persistent cookies do not guarantee
unsaved form restoration. Ambiguous identity/account recovery stops safely.

The CLI retry command is isolated: it resumes only the named existing application
and does not drain other queued jobs afterward. Adapter false negatives recorded
with the legacy “No supported application fields” reason are automatically
reclassified as retryable after the inspector fix.

Before an unsupported-form fallback, the worker saves a private JSON diagnostic in
`data/artifacts/` alongside the screenshot. It includes bounded control counts and
labels plus value-scrubbed form markup. Credentials, cookies and tokens are excluded.

## Development and debugging

```sh
npm run format
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm audit
npm run check:secrets
```

Integration tests use local synthetic ATS forms and fake submit counters; no employer
traffic or real submissions. Artifacts and screenshots are under ignored `data/`.
Structured events show stages/provenance without credentials, cookies or mail bodies.
See [architecture](docs/ARCHITECTURE.md) for adding an adapter.

Before publishing: verify `git status`, keep `private/`, `data/`, `.env.local`, resume,
tokens, browser sessions, screenshots and generated answers ignored, and run the staged
secret check. An optional pre-commit hook can invoke `npm run check:secrets`; it is not
installed globally. SQLite/artifacts are private but not separately encrypted at rest;
use macOS account protection/FileVault for disk-level privacy.

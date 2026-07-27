# Project audit and next-step plan

Audit date: 27 July 2026

## Current position

The state-v3 product work is feature-complete for the agreed beta scope. XP, levels, scoring, rewards, achievements, and AI integration are deliberately absent. The remaining work is release validation and operations, followed by a smaller maintainability and product-depth backlog.

Local release evidence on the current worktree:

- Clean `npm ci` and production dependency audit with no known high or critical vulnerabilities.
- Typecheck, lint, state-v3 fixture guard, retired-gamification guard, AI-exclusion guard, and service-worker safety guard pass.
- 376 unit tests across 27 files pass.
- The production build passes on Next.js 16.2.11; 22 JavaScript chunks total 1,385,666 bytes.
- 28 local browser tests pass, including accessibility, keyboard, mobile, PWA/offline, recovery, erasure, evidence, and workflow coverage. Four cloud tests are intentionally skipped without a local Supabase stack.
- Manual desktop and 390 px mobile review passed after correcting dashboard and header horizontal overflow.

This evidence is not a production release approval. The final commit, hosted database job, cloud browser tests, deployment environment, and production cutover still need verification.

## Completed product scope

### Data safety and recovery

- Anonymous and per-account workspaces are isolated in generation-fenced IndexedDB records.
- Sign-in reconciliation uses server revisions and compare-and-swap writes; cloud writes remain closed until reconciliation succeeds.
- Anonymous-to-account handoff offers explicit account, device, and lossless merge choices. Merge remaps identifiers and evidence references while retaining both originals.
- Imports, local records, and cloud snapshots pass through the same versioned runtime schema with size, depth, count, and future-version limits.
- Corrupt data restores from valid history or remains quarantined and exportable instead of being silently replaced.
- Evidence bodies live outside workspace state in IndexedDB and private Supabase Storage, with preview, download, rename, delete, compensation, and stale-generation protection.
- Account erasure has durable checkpoints, exact-account ownership, partial-failure reporting, retry, tombstones, stale-tab fencing, and Storage verification.

### Core workflows

- All four honest progress models are supported: numeric, weighted milestones, consistency, and open reflection.
- Goals, metrics, milestones, actions, mappings, status, archive/restore, and permanent deletion are editable.
- Actions support one-off, repeating, habit, session, and outcome behaviour; shared goal links; notes; actual duration; evidence notes; exact metric changes; and immutable occurrence history.
- Open-ended progress uses timestamped check-ins rather than a fabricated percentage. Completing a measured goal preserves its actual outcome.
- Dashboard due logic, goal board columns, archive/restore, templates, global terminology, deep links, and dashboard arrangement are implemented.

### Analytics and experience

- Permanent source records drive timeline, recent activity, 30/90/365-day quality history, area activity/time, connected-goal links, and review context.
- Weekly and monthly reviews prepare movement, lifecycle, comparison, and source-link context.
- Histories are retained and progressively paginated rather than truncated.
- The PWA has versioned safe caching, dedicated offline handling, install/update prompts, production icons, local reminders, and reconnect retry behaviour.
- Keyboard/focus management, inert modal/drawer backgrounds, live regions, accessible names, mobile parity, safe areas, reduced motion, and automated axe coverage are in place.
- Security headers, noindex beta metadata, opt-in bounded telemetry, pinned toolchains, Dependabot, CI, SQL fixtures, and two-user RLS tests are present.

## Release-critical next steps

Complete these in order; do not promote `main` early.

1. Freeze and commit the intended state-v3 worktree on the release branch. Inspect the staged set and confirm no environment file or secret is included.
2. Push the exact commit and run both hosted CI jobs. The database job must prove fresh migrations, populated legacy upgrade, two-user RLS, cloud evidence, revision conflict, account isolation, merge handoff, and account erasure.
3. Prepare a state-v3-compatible Vercel deployment without promoting it. Verify production environment variables, Supabase auth redirect allow-list, CSP/security headers, no private telemetry, and the service-worker version.
4. Record a current Supabase backup identifier/time, migration dry-run output, deployment owner, rollback owner, and an agreed edit-pause window for old clients.
5. With explicit production approval, pause old-client editing, apply the full migration chain through `202607270009` with Supabase CLI 2.109.1, and immediately promote the compatible client.
6. Smoke-test sign-in, account isolation, local/account/merge handoff, sync/reconnect, evidence, recovery, export/import, and erasure against production. Use a forward state-v3 hotfix for rollback; never deploy pre-v3 commit `ca81723` after cutover.
7. Complete the deployment record, require both CI checks in branch protection, then merge and push `main`.

## Post-release engineering backlog

### P1 — Reduce coordination risk

- Split the roughly 3,000-line `AppProvider` coordinator into dedicated auth, reconciliation, evidence, erasure, recovery, command, and selector hooks. Existing pure modules are the starting seam.
- Replace full-workspace clone/validation on routine mutations with bounded domain transactions and profile performance using a near-limit workspace.
- Move merge evidence copying and metadata activation toward one durable operation journal or a transaction boundary that removes the remaining same-target, two-tab contention edge case.
- Add component-level tests for the offline, waiting-to-sync, saving, conflict, error, and synced status transitions rather than relying mainly on cloud browser coverage.
- Guard progress-model transitions so numeric and consistency goals cannot be saved without a positively weighted metric, and require period metadata for consistency metrics at the state-v3 schema boundary.
- Add a visible capacity forecast before the 5 MiB workspace limit, then partition immutable history from mutable workspace state or provide an explicit records archive-and-reset workflow.
- Add a bundled evidence export/import format or bulk evidence download so a records-only JSON backup is not mistaken for a complete recovery package.
- Add Firefox and WebKit smoke coverage for IndexedDB, downloads, service workers, offline navigation, and authentication before claiming broad browser support. Until then, document Chromium as the fully automated beta target.

### P2 — Deepen product truthfulness

- Decide whether weighted milestone definitions must total exactly 100%. They currently block totals above 100% but permit a deliberate partial plan below 100%.
- Decide whether action definitions need reusable changes for multiple metrics; completion already supports changes across all linked metrics.
- Persist an immutable generated-context snapshot with each review if historical reviews must remain identical after later deletion or reorganisation.
- Decide whether completing a goal freezes later measurement changes. If the goal remains editable, persist an immutable completion-outcome snapshot so its state at completion can always be reconstructed.
- If users need a direct personal-quality trend rather than activity connected to a quality, add explicit quality measurements. Current analytics intentionally report source-record activity counts.

### P2 — Operational and experience follow-up

- Complete manual screen-reader announcement, keyboard, zoom, reduced-motion, touch-target, iOS safe-area, Android install/update, and slow/offline network checks on real devices.
- Add scheduled background push only if reminders must work while Evolvra is closed; the beta reminder is intentionally local and runs while a tab or installed window is open.
- Add production synthetic checks for security headers, manifest/icons, service-worker MIME behaviour, telemetry rejection, and auth callback exclusions.
- Run periodic restore and account-erasure drills against a disposable Supabase project and record recovery time and evidence-object cleanup results.
- Track the development-only `minimatch`/`brace-expansion` denial-of-service advisory until the ESLint plugin chain accepts a patched major. Production dependencies are clear; do not force an API-incompatible transitive override merely to silence the audit.

## Decisions needed from the owner

No product decision blocks the release branch or hosted CI. Production cutover requires explicit approval plus:

- the deployment/rollback owner;
- the database backup identifier and time;
- confirmation that old-client editing can be paused during the migration/client promotion window;
- confirmation that the Supabase dry-run and migration application may be executed against the linked production project.

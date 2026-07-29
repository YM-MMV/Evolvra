# Project audit and next-step plan

Audit date: 28 July 2026

## Executive assessment

Evolvra is substantially feature-complete for the agreed beta scope. The original safety and workflow gaps have been addressed: account-scoped local storage, revision-safe sync, strict state migration, evidence stored outside the workspace document, verified erasure, complete goal/action workflows, source-traceable analytics, recovery, offline support, accessibility foundations, CI, and operations documentation are present.

XP, levels, scoring, rewards, achievements, and AI integration are intentionally absent. They are not unfinished beta work.

The release is not complete yet. The current worktree is newer than the last pushed release-branch commit, `main` and production still run the pre-v3 application, and no hosted CI result exists for the final in-flight changes. Production still serves the old `evolvra-shell-v1` worker and lacks the candidate security headers; the linked database was last verified with only the immutable `202607150001` baseline applied, so its retired XP-era schema is not removed until the forward chain is deployed. The next priority is therefore a controlled release, not another broad feature cycle.

## Evidence at this audit

- Current branch: `agent/remove-xp-levels`.
- Pushed branch head: `dec0d30`; current worktree contains additional reviewed but uncommitted changes.
- `origin/main` and the production application remain at the pre-v3 line rooted at `ca81723`.
- A clean `npm ci` succeeds and the production dependency audit reports zero vulnerabilities.
- The complete local `npm run check` passes on the candidate tree.
- The current unit suite contains 35 files and 493 tests.
- The production build and bundle gate pass: 22 JavaScript chunks total 1,420,515 bytes.
- The local Chromium gate passes 29 workflows, including accessibility, keyboard, mobile, offline, recovery, evidence, and terminology. Four cloud workflows are intentionally skipped locally without the Supabase stack and remain required in hosted CI.
- Routine near-limit workspace mutations use copy-on-write structural sharing. The 5,179,473-byte fixture completed in about 23.83 ms cold and 7.65 ms warm under 100 ms and 25 ms ceilings, without serialising the whole workspace or timeline.
- The previously pushed `dec0d30` commit passed both hosted GitHub jobs, but that result is not evidence for the current worktree.
- Exact-commit hosted CI, protected Preview review, linked database dry-run, and the production smoke test remain outstanding.

## Completed beta scope

### Data safety, privacy, and recovery

- Anonymous and per-account workspaces are isolated in generation-fenced IndexedDB records.
- Account changes close writers synchronously before a new authenticated identity is published. The outgoing workspace is settled before the destination opens, undo history never crosses accounts, and cloud writes remain closed until reconciliation finishes.
- Anonymous-to-account handoff offers explicit account, device, or lossless-merge choices. Merge remaps identifiers and evidence references while preserving the anonymous original.
- Cloud snapshots use server revisions and compare-and-swap writes rather than client-clock last-write-wins.
- Imports, local records, cloud snapshots, and legacy upgrades share versioned validation with byte, node, depth, string, collection, and future-version limits.
- Corrupt records recover from valid history where possible or remain quarantined, exportable, and write-protected.
- Evidence bytes live in IndexedDB and private Supabase Storage. Workspace state holds metadata only; preview, download, rename, upload, delete, compensation, and stale-scope protection are implemented.
- Account erasure has durable ownership, tombstones, exact-account checks, partial-failure reporting, retries, Storage verification, and stale-tab fencing.

### Core product workflows

- Numeric, weighted-milestone, consistency, and open-reflection progress models are supported without fabricated percentages.
- Goals, metrics, milestones, actions, mappings, statuses, archives, restores, and permanent deletion are editable.
- Actions support one-off and recurring work, multiple linked goals, notes, actual duration, evidence annotations, metric changes, due-state rules, and immutable completion history.
- Open goals preserve real measured progress when marked complete; open-reflection goals use dated check-ins.
- Goal templates, board/list views, due/upcoming/anytime action views, custom terminology, dashboard arrangement, deep links, and archive/restore workflows are present.

### Analytics and reviews

- Immutable source records retain goal, area, and personal-quality attribution as it existed when an action or measurement occurred.
- Timeline, recent activity, 30/90/365-day quality activity, area activity/time, goal links, and review context trace back to source records.
- Weekly and monthly reviews prepare movement, lifecycle, comparison, and source-link context.
- Histories are paginated rather than silently truncated.
- Consistency views show seven-day activity, 30-day activity, total sessions, recorded time, and current-versus-previous 30-day momentum.

### Platform and release foundations

- The service worker uses bounded, versioned caches; safe request/response admission; exact known-goal route preparation; multi-tab manifest union; activation carry-forward; pinned build dependencies; acknowledgement; and retry after reconnect/controller change.
- Authentication, callbacks, APIs, evidence, unsafe responses, token-bearing requests, and arbitrary goal-route discovery are excluded from caching.
- Install/update prompts, production icons, local reminders, responsive layouts, safe areas, reduced motion, keyboard/focus handling, live regions, and automated axe checks are present.
- Security headers, beta `noindex`, opt-in bounded telemetry, pinned toolchains, dependency automation, bundle limits, state-v3 fixtures, two-user RLS tests, cloud browser tests, recovery docs, and deployment docs are present.

## Phase 0 — Freeze and release the current beta

These steps are sequential and block `main`.

1. Finish the provider integration review and deliberately include or exclude every in-flight file.
2. Inspect the complete diff and staged set. Confirm that no environment file, credential, browser artifact, build output, or unrelated user change is included.
3. Run a clean install, production dependency audit, and the complete `npm run check` gate on the frozen tree.
4. Commit and push the exact release candidate to `agent/remove-xp-levels`.
5. Require both hosted GitHub jobs on that exact SHA:
   - application validation, build, bundle, Chromium workflows, and accessibility;
   - fresh and legacy database migration, SQL lint, two-user RLS, revisions, cloud evidence, handoff, and erasure.
6. Review a staged Production build from the exact commit with automatic production-domain assignment disabled. Verify Production environment variables, Supabase redirect allow-list, CSP/security headers, no private telemetry, manifest/icons, and service-worker version.
7. Record the database backup identifier and time, migration dry-run output, deployment owner, rollback owner, and an edit-pause window.
8. With explicit production approval, pause old-client editing, apply migrations through `202607270010`, and immediately promote the compatible staged client without rebuilding.
9. Smoke-test sign-in, account isolation, account/device/merge handoff, sync and reconnect, conflict recovery, evidence, import/export, quarantine recovery, erasure, PWA update, offline known-route navigation, and security headers.
10. Complete the deployment record, require both CI checks in branch protection, merge the reviewed commit, and push `main`.

Definition of done:

- The release SHA is identical in the local gate, hosted CI, staged artifact, production deployment, and `main`.
- Production uses state v3 and migration `202607270010`.
- Both hosted jobs and the production smoke test pass.
- The deployment record and forward-hotfix rollback owner are complete.

Important rollback rule: after the database cutover or a state-v3 workspace open, never deploy pre-v3 `ca81723`. Roll forward with a state-v3-compatible hotfix and a new additive migration when needed.

## Phase 1 — Reduce architecture and coordination risk

### Provider decomposition

Completed seams:

- domain command bindings;
- authentication controller and synchronous account boundary;
- goal-evidence operations and compensation;
- local bootstrap/recovery;
- state transactions and workspace profiling;
- status selectors;
- separate workspace, provider-status, and action contexts.

Next:

- Migrate consumers from compatibility `useApp()` to `useWorkspaceData()`, `useProviderStatus()`, and `useAppActions()` so unrelated state changes do not rerender every page.
- Stabilise the actions-context value instead of recreating its command object on each provider render.
- Extract reconciliation/cloud-save, account handoff, import/reset, and terminal-erasure coordinators from the remaining roughly 2,900-line provider.
- Add a focused component harness for every lifecycle state: local, device-saving, offline, unsaved, connecting, cloud-saving, conflict, error, handoff, erasure, and synced.

### Oversized boundary modules

Split these by responsibility while keeping one validation path:

- `lib/state-schema.ts` (about 2,024 lines): version migrations, current-schema validation, structural limits, and coherence rules.
- `lib/persistence.ts` (about 1,945 lines): IndexedDB schema, workspace repository, evidence repository, erasure fences, and legacy journal.
- `lib/account-erasure.ts` (about 945 lines): checkpoint state machine, local cleanup, cloud cleanup, and recovery presentation.

### Scale and storage

- Benchmark full cloud snapshot saves over slow and interrupted networks; the client still submits the complete workspace after its debounce.
- Add visible capacity forecasting well before the 5 MiB safety limit.
- Partition immutable completions, metric entries, reviews, and long history from frequently edited workspace metadata when real usage data justifies the migration.
- Provide an explicit archive/export-and-reset workflow before users reach the hard limit.
- Add property/fuzz tests for migrations, imports, merges, recurrence, and compensation journals.
- Add coverage thresholds for safety-critical modules, based on meaningful branch coverage rather than a repository-wide vanity percentage.

Definition of done:

- Account/sync/erasure lifecycles can be tested without rendering the product UI.
- Read-only pages do not rerender for unrelated command/status changes.
- Near-limit local edits and slow-network saves have recorded budgets.
- Users receive actionable warnings before a workspace can no longer be saved.

## Phase 2 — Complete portability and browser confidence

### Full backup portability

The JSON backup is intentionally records-only: it includes evidence metadata but not file bytes. Add either:

- a versioned bundled archive containing a manifest, workspace JSON, and verified evidence files; or
- a bulk evidence download plus restore manifest and clear reconciliation workflow.

The import must validate every path, MIME type, size, hash, account mapping, and compensation step before activating metadata.

### Browser and device matrix

- Add Firefox and WebKit smoke projects for IndexedDB, downloads, file previews, auth callbacks, service-worker update/offline routing, and evidence.
- Complete manual checks at 320 px and 390 px, tablet, landscape, 200% and 400% zoom, enlarged text, forced colours, reduced motion, VoiceOver/NVDA, keyboard-only operation, Android installation/update, iOS safe areas, and slow/offline networks.
- Add primary-route visual-regression snapshots in dark/light and desktop/mobile modes.
- Review the life-calendar day detail for keyboard and touch exploration; it currently exposes an accessible summary but keeps individual cells visual.
- Validate the maskable icon against Android safe-zone crops and create a separately padded asset if device testing shows clipping.

Definition of done:

- No serious or critical automated accessibility findings.
- Core keyboard and screen-reader workflows pass manually.
- Chromium, Firefox, and WebKit pass the agreed smoke suite.
- Release screenshots detect layout regressions rather than capturing only test failures.

## Phase 3 — Product-truthfulness decisions

These require product-owner choices; none should be silently inferred.

1. Consistency language: keep seven/30-day session counts, rename them explicitly, or calculate target-relative completion rates from metric targets and periods.
2. Review history: decide whether a saved review must retain the generated context and source IDs exactly as they appeared at creation.
3. Completion outcomes: decide whether later measurement edits are allowed; if so, persist an immutable goal-outcome snapshot at completion.
4. Weighted plans: decide whether milestones must total exactly 100%. They currently reject totals above 100% but allow a deliberate partial plan below 100%.
5. Reusable action defaults: decide whether an action definition needs default changes for multiple metrics. Completion already supports all linked metrics.
6. Personal-quality trends: current analytics truthfully show activity connected to a quality, not a subjective quality score. Add explicit non-scoring quality reflections only if users need a direct trend.

Definition of done:

- Every displayed summary has an unambiguous definition and links to its source records.
- Historical views remain stable to the degree promised by the product.
- Activity is never presented as proof of personal worth or development.

## Phase 4 — Operational hardening

- Add production synthetic checks for headers, auth-callback cache exclusion, manifest/icon MIME, service-worker version, offline fallback, and telemetry rejection.
- Run scheduled restore, conflict, and account-erasure drills against a disposable Supabase project; record recovery time and orphan evidence cleanup.
- Give evidence Storage its own backup/protection plan because a Postgres backup does not contain Storage objects.
- Investigate CSP nonces/hashes to reduce production `unsafe-inline` allowances when Next.js compatibility permits.
- Add infrastructure-wide telemetry throttling and an explicit retention/deletion policy before enabling telemetry.
- Document that `workspace_snapshots` is authoritative and the normalised domain tables are not dual-written application state. Restrict or retire unused surfaces before future contributors assume otherwise.
- Verify branch protection requires both hosted jobs and prevents direct unreviewed `main` pushes.
- Continue tracking the development-only `minimatch`/`brace-expansion` advisory until the ESLint chain supports a compatible patched version; do not force an incompatible override.

Definition of done:

- Recovery and erasure are rehearsed, not merely documented.
- Production health checks catch broken deployment configuration quickly.
- Database, Storage, telemetry, and rollback ownership are explicit.

## Phase 5 — Optional discovery after a stable beta

Potential discovery items, ordered behind reliability:

- global search or command palette;
- planner/calendar view;
- user-created goal templates;
- background push reminders when Evolvra is closed;
- a separate public marketing surface and custom domain;
- carefully scoped integrations.

AI remains deferred. If reconsidered later, it requires a separate privacy, consent, threat-model, data-retention, failure-mode, and non-authoritative-suggestion plan; it must not be slipped into the current release.

## Owner input required for production

Production cutover cannot proceed without:

- the current database backup identifier and time;
- the deployment and rollback owner;
- confirmation that editing from old clients can pause during migration and promotion;
- explicit approval to run the linked-production Supabase dry-run and migration application.

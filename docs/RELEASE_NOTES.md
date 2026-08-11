# Release notes — state v3 safety and workflow completion

Release candidate audit date: 2 August 2026

## What changed

- Removed XP, levels, awards, scoring, achievement mechanics, and every related product surface. Supported v1 and v2 workspaces migrate to state v3 while stripping retired fields and records.
- Completed goal, multi-metric, milestone, recurring/shared-action, check-in, typed evidence, review, dashboard-arrangement, globally configurable terminology, archive/restore, and permanent-history workflows.
- Enforced measured-progress invariants at the UI, command, current-schema, and legacy-migration boundaries. Numeric and consistency goals require a positively weighted metric, consistency metrics require valid period metadata, and recoverable legacy gaps are repaired without discarding content or history.
- Added source-ledger consistency summaries for seven- and 30-day rates, total sessions, recorded time, and current-versus-previous 30-day momentum, including immutable shared-goal attribution.
- Added immutable area/quality attribution snapshots and causal completion links so later goal edits cannot rewrite historical analytics or collapse distinct same-time records.
- Added generation-fenced account-scoped IndexedDB persistence, atomic cross-tab local revisions, strict imports, structural and byte budgets, last-valid-history recovery, an explicit quarantine recovery screen, crash-safe v1 import journalling, anonymous-to-account local/account/merge consent with durable per-revision acknowledgement, server revisions, explicit device-saving/offline/unsynced states, blocking conflict recovery, and private evidence storage. A newer cloud revision with the exact validated local state is safely recognised as a lost save acknowledgement rather than a false conflict.
- Raised the persistence database to IndexedDB v4 as a rolling-client fence for
  the token-staged evidence protocol. A current tab closes an already-open v3
  connection through `versionchange`; an old bundle cannot reopen v3. The
  upgrade preserves v3 live bytes, assigns missing `writeId` values, and creates
  a separate staging store that live reads and backups never enumerate.
- Made evidence promotion atomic with the exact workspace local revision,
  added a monotonic per-account `evidenceRevision`, and bound deletion,
  metadata compensation, backup, reset, import, bootstrap, handoff, and cloud migration
  to exact identities and revisions. Stale rollback can remove only its own
  staging token, and stale compare-delete cannot overwrite newer bytes.
- Added durable, cross-tab account-erasure ownership and recovery. Uncertain final cloud responses remain ambiguous until exact-account re-authentication and an explicit retry; local cleanup never signs out another account, and stale tabs cannot reopen a tombstoned writer.
- Added durable metadata-first evidence deletion, exact Blob metadata validation, and Storage-API account erasure. Tokenised cleanup intents are recorded before metadata deletion and recover after a crash against exact live-write identities. For signed-in cleanup, `.011` atomically claims only path batches absent from the authoritative cloud workspace; permanent claims block later snapshot and Storage resurrection before deletion. Only a definitive `referenced` response permits metadata compensation. An ambiguous claim or Storage response retains deletion metadata and the journal for safe retry without recreating bytes. File rename is metadata-only and never moves object bytes.
- Made authoritative device-workspace replacement enumerate and sweep unreferenced evidence in the same IndexedDB transaction. Even an otherwise identical replacement advances the local CAS revision, so a stale tab cannot add an orphan after the sweep. Remote replacement cleanup waits for authoritative sync and the same permanent server-side claims.
- Made complete portable restore atomic across the IndexedDB workspace,
  evidence, and account-scope stores. Merge and replace commit byte-backed
  evidence with the resulting metadata or publish nothing; both choices clear
  recent undo history and are explicitly non-undoable.
- Blocked portable restore inspection/application while cloud or sync conflicts
  and pending/rendered account-handoff decisions leave the source of truth
  unresolved. Export remains available during those recovery states.
- Bound anonymous archive-and-reset permission to a one-use receipt for the
  exact persisted revision represented by the downloaded archive. A later save
  in any tab invalidates reset and requires a fresh backup.
- Bound every new connected-account erasure to a complete archive receipt for
  the exact local revision, cloud snapshot revision, and monotonic private
  evidence revision. The database compares the cloud boundary under the
  account-lifecycle lock. A second-device save or evidence mutation after the
  download keeps the lifecycle active, preserves cloud data, cancels the
  unstarted local deletion fence, and requires a fresh backup.
- Added a synchronous authentication boundary that closes every workspace/cloud writer before a changed Supabase identity is published, and refuses cloud mode when the live auth listener cannot be installed.
- Replaced whole-workspace cloning and validation for routine commands with copy-on-write structural sharing, cached exact JSON profiles, and incremental current-v3 coherence checks. Near-limit command tests cover byte, node, depth, collection, linked-goal, and action-to-metric integrity while preserving full validation at untrusted boundaries.
- Split command bindings, authentication, goal-evidence operations, local bootstrap/recovery, status selectors, state transactions, and public provider contexts into focused seams. Reconciliation, cloud-save, handoff, import/reset, and terminal-erasure coordination remain intentionally centralised for a later low-risk extraction.
- Made compare-and-swap misses return an immediate PostgREST HTTP conflict instead of a retry-class database serialization error, while the client continues to understand the pre-cutover code.
- Bound each cloud snapshot save to the account that owned the queued client
  state. Migration `.011` rejects the retired two-argument save during the
  maintenance cutover, preventing an asynchronously resolved access token from
  writing one account's state into a newly authenticated account.
- Added time-windowed, source-traceable analytics, automatic weekly/monthly review context, paginated canonical history, PWA installation/update behavior, safe offline routing, reminders, keyboard/focus hardening, security headers, privacy-safe diagnostics, CI, bundle limits, unit tests, Playwright workflows, and axe scans.
- Unified ordinary modals and bootstrap, quarantine, and terminal recovery on a
  shared reference-counted overlay lease. Recovery priorities ensure only the
  highest blocker owns focus, background isolation, Escape handling, and scroll
  lock; ordinary modal cleanup cannot release an active blocker.
- Updated Next.js to `16.2.11`, forced the patched `sharp` `0.35.3` runtime, and removed the charting dependency. Pinned dependency, audit, production-build, and bundle-budget gates are defined; their final result must be recorded against the frozen candidate SHA. Mobile command-centre panels and header actions are width-contained at the 390 px release viewport.
- AI integration remains intentionally excluded.

## Database migrations

The linked production chain is aligned through
`202608020011_account_erasure_backup_boundary.sql`. On 11 August the pinned
CLI passed Docker-backed fresh and populated-legacy migration, lint, RLS, and
all seven cloud-browser scenarios. The linked dry-run reported `.011` as the
only pending migration; deployment owner `YM-MMV` explicitly approved it,
after which it was applied and a clean follow-up dry-run reported the remote
database up to date. The compatible application deployment remains pending.

Apply these in timestamp order:

1. `202607150001_initial_schema.sql`
2. `202607180001_remove_legacy_gamification_columns.sql`
3. `202607180002_progress_history_foundation.sql`
4. `202607180003_workspace_revisions.sql`
5. `202607180004_account_deletion_cleanup.sql`
6. `202607180005_consistency_and_completion_context.sql`
7. `202607180006_harden_parent_ownership_rls.sql`
8. `202607180007_quest_kinds.sql`
9. `202607180008_shared_quest_goal_links.sql`
10. `202607270009_non_retrying_workspace_conflicts.sql`
11. `202607270010_rename_interface_intensity.sql`
12. `202608020011_account_erasure_backup_boundary.sql`

The initial migration remains the immutable legacy baseline; every current change is carried by a later forward migration. CI applies the complete chain both from empty state and over representative populated legacy rows, then asserts preservation, backfills, retired-column removal, neutral interface-intensity naming, RLS, and account erasure. Migration `.011` adds an `evidence_revision` lifecycle coordinate, increments it for private evidence object mutations, and makes the three-argument account-deletion RPC atomically compare the backed workspace/evidence revisions before moving an active lifecycle to `deleting`. It also replaces snapshot saving with an exact-account three-argument RPC; the retired two-argument save fails closed so a delayed old tab cannot write state after an account switch. Its private cleanup-claim RPC serializes against snapshot and Storage writes, accepts only owned immutable four-segment path batches, refuses any currently referenced batch without partially claiming it, and leaves permanent tombstones that prevent resurrection. The retained one-argument deletion signature is resume-only during rollout, so an old client cannot begin deleting an active account without a verified backup. The final schema reasserts owner/parent RLS, explicit authenticated Data API privileges, private Storage policies, quest-kind constraints, shared-action relationships, and the account-deletion RPC. Evidence bytes are removed and verified through the Storage API before final account deletion; SQL never deletes Storage objects.

## Offline cache

- Service-worker version: `2026-08-02.3`
- The worker bounds navigation/static caches, excludes auth/API/token-bearing requests, validates static response status/origin/MIME, precaches core shell routes, and proactively prepares every exact goal route in each live tab's current workspace. Per-client manifests form a bounded union, so one tab or account transition cannot erase another tab's routes. A persisted data-free union survives worker activation, versioned build dependencies are pinned separately from evictable runtime assets, and the client reports acknowledged complete or partial coverage with reconnect/controller retries. Unknown or arbitrary goal routes are never admitted by navigation.
- Deploying the release or a compatible forward hotfix activates a new worker/cache set. The in-app **Update now** control performs an origin-wide compatibility cutover and reloads every open Evolvra tab after activation so an old bundle cannot keep writing beside the IndexedDB-v4 client.

## Recovery and rollback

- Export **Complete portable backup** before risky personal-data changes. It includes validated workspace records and all referenced evidence bytes available on the device or through the exact account's verified private cloud path. The records-only JSON export remains available separately.
- Resolve cloud/sync conflicts and account-handoff choices before restoring a
  portable archive. Both merge and replace are non-undoable and commit workspace
  metadata, imported evidence bytes, and replace cleanup in one IndexedDB
  transaction. Archive-and-reset is authorised only for the exact downloaded
  revision; any later save requires a fresh archive. New connected-account
  erasure is likewise authorised only for the downloaded archive's exact local
  and cloud workspace/evidence boundary.
- Corrupt current IndexedDB state restores the newest valid undo snapshot when possible. If no valid history exists, an unrecoverable record remains quarantined and write-protected while the recovery screen offers raw download, strict backup restore, or explicit device-copy erasure.
- Once the database chain is applied or state v3 is opened, pre-v3 commit `ca81723` is not a rollback target: it uses the retired localStorage shape and direct snapshot writes. After this candidate is released, IndexedDB-v3-and-earlier clients and clients that lack the `.011` erasure-backup boundary are also incompatible rollback targets. Recover with a state-v3/IndexedDB-v4-compatible forward hotfix and correct database problems with a new additive migration.
- Full procedures are in [RECOVERY.md](RECOVERY.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Known limitations and required deployment inputs

- Reminders run only while a browser tab or installed app window is open; no push/background server is used.
- Chromium carries the complete automated browser gate; focused IndexedDB, download, navigation, and responsive smoke paths also run in Firefox and WebKit. Real-device PWA, screen-reader, and hardware-specific checks remain manual release evidence.
- Records-only JSON deliberately excludes private evidence file bytes and account-scoped object paths. Complete `.evolvra` archives bundle validated evidence bytes without exporting private account paths and require an explicit merge or destructive replace choice.
- Private cross-device sync and cloud evidence require a correctly migrated Supabase project. The app remains fully usable as a local-first workspace without it.
- A sync-enabled deployment requires a coordinated cutover: prepare the state-v3/IndexedDB-v4 build, pause old-client editing, prove `.011` on a Docker-backed local Supabase stack, retain the linked dry-run, obtain explicit `.011` approval, apply it with Supabase CLI `2.109.1`, and immediately promote the compatible client.
- Before a production deployment, the operator must record the current database backup, rollback owner, environment variables, auth redirect allow-list, and successful hosted CI run in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
- The 2 August candidate has implemented automated accessibility, browser,
  device-emulation, visual, migration/RLS/cloud, archive, and recovery coverage,
  but the exact frozen-SHA local/hosted gate run is not yet recorded.
- Branch-protection enforcement, manual VoiceOver/NVDA and real-device testing,
  and authenticated production smoke remain unrecorded.
- The first retained private-Storage byte restore drill remains unrecorded; the
  historical backup inventory contained no Storage objects and a PostgreSQL
  dump is not a substitute.
- Production telemetry remains disabled pending a deliberate observability,
  ownership, review, alerting, and retention decision. Further `AppProvider` and
  persistence-boundary decomposition remains maintainability work rather than a
  completed release claim.

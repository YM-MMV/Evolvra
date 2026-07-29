# Release notes — state v3 safety and workflow completion

Release candidate date: 28 July 2026

## What changed

- Removed XP, levels, awards, scoring, achievement mechanics, and every related product surface. Supported v1 and v2 workspaces migrate to state v3 while stripping retired fields and records.
- Completed goal, multi-metric, milestone, recurring/shared-action, check-in, typed evidence, review, dashboard-arrangement, globally configurable terminology, archive/restore, and permanent-history workflows.
- Enforced measured-progress invariants at the UI, command, current-schema, and legacy-migration boundaries. Numeric and consistency goals require a positively weighted metric, consistency metrics require valid period metadata, and recoverable legacy gaps are repaired without discarding content or history.
- Added source-ledger consistency summaries for seven- and 30-day rates, total sessions, recorded time, and current-versus-previous 30-day momentum, including immutable shared-goal attribution.
- Added immutable area/quality attribution snapshots and causal completion links so later goal edits cannot rewrite historical analytics or collapse distinct same-time records.
- Added generation-fenced account-scoped IndexedDB persistence, atomic cross-tab local revisions, strict imports, structural and byte budgets, last-valid-history recovery, an explicit quarantine recovery screen, crash-safe v1 import journalling, anonymous-to-account local/account/merge consent with durable per-revision acknowledgement, server revisions, explicit device-saving/offline/unsynced states, blocking conflict recovery, and private evidence storage. A newer cloud revision with the exact validated local state is safely recognised as a lost save acknowledgement rather than a false conflict.
- Added durable, cross-tab account-erasure ownership and recovery. Uncertain final cloud responses remain ambiguous until exact-account re-authentication and an explicit retry; local cleanup never signs out another account, and stale tabs cannot reopen a tombstoned writer.
- Added durable metadata-first evidence deletion/move compensation, exact Blob metadata validation, and Storage-API account erasure. A crash can leave an unreferenced object for later cleanup, but cannot leave durable metadata pointing to intentionally deleted bytes.
- Added a synchronous authentication boundary that closes every workspace/cloud writer before a changed Supabase identity is published, and refuses cloud mode when the live auth listener cannot be installed.
- Replaced whole-workspace cloning and validation for routine commands with copy-on-write structural sharing, cached exact JSON profiles, and incremental current-v3 coherence checks. Near-limit command tests cover byte, node, depth, collection, linked-goal, and action-to-metric integrity while preserving full validation at untrusted boundaries.
- Split command bindings, authentication, goal-evidence operations, local bootstrap/recovery, status selectors, state transactions, and public provider contexts into focused seams. Reconciliation, cloud-save, handoff, import/reset, and terminal-erasure coordination remain intentionally centralised for a later low-risk extraction.
- Made compare-and-swap misses return an immediate PostgREST HTTP conflict instead of a retry-class database serialization error, while the client continues to understand the pre-cutover code.
- Added time-windowed, source-traceable analytics, automatic weekly/monthly review context, paginated canonical history, PWA installation/update behavior, safe offline routing, reminders, keyboard/focus hardening, security headers, privacy-safe diagnostics, CI, bundle limits, unit tests, Playwright workflows, and axe scans.
- Updated Next.js to `16.2.11`, forced the patched `sharp` `0.35.3` runtime, and removed the charting dependency; the clean production dependency audit is clear and 22 production JavaScript chunks total 1,420,515 bytes. Mobile command-centre panels and header actions are width-contained at the 390 px release viewport.
- AI integration remains intentionally excluded.

## Database migrations

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

The initial migration remains the immutable legacy baseline; every current change is carried by a later forward migration. CI applies the complete chain both from empty state and over representative populated legacy rows, then asserts preservation, backfills, retired-column removal, neutral interface-intensity naming, RLS, and account erasure. The final schema reasserts owner/parent RLS, explicit authenticated Data API privileges, private Storage policies, quest-kind constraints, shared-action relationships, and the account-deletion RPC. Evidence bytes are removed and verified through the Storage API before that RPC is invoked; SQL never deletes Storage objects.

## Offline cache

- Service-worker version: `2026-07-28.1`
- The worker bounds navigation/static caches, excludes auth/API/token-bearing requests, validates static response status/origin/MIME, precaches core shell routes, and proactively prepares every exact goal route in each live tab's current workspace. Per-client manifests form a bounded union, so one tab or account transition cannot erase another tab's routes. A persisted data-free union survives worker activation, versioned build dependencies are pinned separately from evictable runtime assets, and the client reports acknowledged complete or partial coverage with reconnect/controller retries. Unknown or arbitrary goal routes are never admitted by navigation.
- Deploying the release or a compatible forward hotfix activates a new worker/cache set; use the in-app **Update now** control or reload after activation.

## Recovery and rollback

- Export **Workspace JSON backup** before deployment or data maintenance. It includes workspace records and evidence metadata, not device-only evidence file bytes.
- Corrupt current IndexedDB state restores the newest valid undo snapshot when possible. If no valid history exists, an unrecoverable record remains quarantined and write-protected while the recovery screen offers raw download, strict backup restore, or explicit device-copy erasure.
- Once the database chain is applied or state v3 is opened, pre-v3 commit `ca81723` is not a rollback target: it uses the retired localStorage shape and direct snapshot writes. Recover with a state-v3-compatible forward hotfix and correct database problems with a new additive migration.
- Full procedures are in [RECOVERY.md](RECOVERY.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Known limitations and required deployment inputs

- Reminders run only while a browser tab or installed app window is open; no push/background server is used.
- Chromium is the fully automated beta browser target. Firefox, WebKit, and real-device PWA checks remain a post-release validation item.
- Workspace JSON is a records-only backup: it excludes private evidence file bytes and account-scoped object paths. Reattach files after restore until a bundled evidence backup is implemented.
- Private cross-device sync and cloud evidence require a correctly migrated Supabase project. The app remains fully usable as a local-first workspace without it.
- A sync-enabled deployment requires a coordinated cutover: prepare the state-v3 build, pause old-client editing, apply migrations with Supabase CLI `2.109.1`, and immediately promote the compatible client.
- Before a production deployment, the operator must record the current database backup, rollback owner, environment variables, auth redirect allow-list, and successful hosted CI run in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

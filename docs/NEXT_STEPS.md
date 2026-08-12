# Project audit and next-step plan

Audit refreshed: 11 August 2026

## Executive assessment

Evolvra now covers the agreed non-gamified beta product plan from end to end.
The original P0 data-safety risks and the major workflow gaps are implemented,
and a final read-only audit found no remaining P0 product or data-safety defect.
AI remains deliberately deferred and is not an unfinished release item.

The maintenance release is deployed from reviewed candidate
`694c532500ce9e84f33f410138b3c51fd09a3b8b` and merge commit
`4a8478fce73a4f682361f30d03d6b12c90e596a6`. Candidate and merge trees are
identical, exact-main hosted CI and Vercel promotion passed, and public,
anonymous, and authenticated production smokes passed on 12 August.

Production editing remains paused until deployment/rollback owner `YM-MMV`
explicitly reopens it. Migration
`202608020011_account_erasure_backup_boundary.sql` is applied, the linked
ledger is aligned through `.011`, and the compatible application and complete
production smoke are now deployed and recorded.

## Current release facts

- Reviewed application branch: `agent/finish-product-plan`.
- Reviewed candidate: `694c532500ce9e84f33f410138b3c51fd09a3b8b`.
- Production application and `main` merge commit:
  `4a8478fce73a4f682361f30d03d6b12c90e596a6`.
- Candidate and merge tree:
  `3a63c22e8224fc1f72103de6b53832f7fe3d45c8`.
- Pull request: <https://github.com/YM-MMV/Evolvra/pull/11>.
- Candidate CI: <https://github.com/YM-MMV/Evolvra/actions/runs/31519483155>.
- Exact-main CI: <https://github.com/YM-MMV/Evolvra/actions/runs/31520061880>.
- Production deployment: `dpl_59Y4N17D8s3VNeYTmpnndQtrzaVc`.
- Stable production URL: <https://evolvra-seven.vercel.app>.
- Linked Supabase project: `gmityvwkrhrraubhmyez`, PostgreSQL
  `17.6.1.141`, production migrations aligned through `202608020011`.
- Fresh verified pre-release backup:
  `evolvra-production-backup-20260809T133841Z`, created from
  `2026-08-09T13:38:41Z` through `13:42:08Z`. Its checksum ledger
  `cf72fd9a57f27eb639833bc7ab4520e419588ab715c2b2480e1a5e5ceda89e5d`
  was reverified on 11 August. It contains database/Auth/Storage metadata, the
  migration ledger, retained dry-run output, release baseline SHA, and a
  separately hashed evidence inventory. There were no Auth users, workspace
  rows, or Storage objects; the empty inventory is current backup evidence but
  not a non-empty restore drill. PostgreSQL dumps never contain Storage bytes.
- Deployment and rollback owner: `YM-MMV`.
- The owner paused production editing and authorised the fresh backup, local
  and linked `.011` verification, application, merge, deployment, and smoke.
  Those actions are complete. Reopening editing remains the owner's decision.
- Required rollback strategy: roll forward with a state-v3/IndexedDB-v4-
  compatible hotfix; never deploy a pre-v3 application or an IndexedDB-v3-or-
  earlier persistence client after the v4 fence has opened.
- Candidate service-worker cache version: `2026-08-02.3`.

## Completed scope

### Account isolation, sync, validation, and erasure

- Anonymous and per-account device workspaces are isolated by account and
  generation.
- Account changes close writer barriers before publishing the new identity.
  Undo history, device evidence, and cloud writes cannot cross accounts.
- Anonymous-to-account handoff offers explicit account, device, or lossless
  merge choices.
- Cloud snapshots use server revisions and compare-and-swap conflict handling,
  with reconnect retries and honest local/saving/offline/conflict/error states.
- Local, cloud, legacy, and imported state share strict current-version
  validation, structural limits, migration, quarantine, and recovery.
- Evidence bytes live outside workspace JSON in IndexedDB and private Supabase
  Storage, with exact-account immutable paths, durable metadata compensation,
  permanent server-side cleanup claims, and stale-scope fencing. Claims are
  created only after authoritative metadata drops a path and prevent both
  snapshot and Storage resurrection before byte deletion.
- Account erasure uses durable checkpoints, verified cloud and device phases,
  tombstones, exact-account retry rules, and explicit partial-failure recovery.
  A new connected erasure also requires a complete portable-backup receipt
  bound to its exact local revision plus cloud workspace/evidence revisions.
  A later cross-device save or evidence mutation is rejected as stale while
  the account lifecycle and data remain active.

### Goals, actions, progress, and history

- Numeric, weighted milestone, consistency, and open-reflection models are
  editable without fabricated progress.
- Goals, measurements, milestones, actions, mappings, statuses, archives, and
  restore/delete workflows support CRUD and ordering.
- Actions support one-off and recurring work, multiple connected goals,
  reusable changes for multiple metrics, notes, actual duration, evidence, and
  immutable occurrence history.
- Recurrence uses real occurrences and due periods; repeated clicks cannot
  duplicate a completion.
- Weighted plans reject totals above 100%. Deliberate partial plans below 100%
  are normalized across their defined milestones and labelled accordingly.
- Completing a measured goal preserves the real outcome. The first completion
  also stores an immutable outcome snapshot so later edits do not rewrite it.
- Open-reflection goals use dated check-ins rather than percentages.
- Consistency measurements roll at their actual period boundary before
  completion snapshots and show explicitly named seven-day, 30-day, lifetime,
  recorded-time, and previous-period context.
- Timeline and histories are paginated rather than silently truncated.

### Analytics, reviews, and dashboard truth

- Immutable activity records retain goal, area, personal-quality, metric-label,
  metric-unit, and causal attribution as it existed at the time.
- Metric history never relabels old values with the current unit and never
  draws a continuous trend across mixed units.
- Weekly review movement is split at unit boundaries, so an earlier value is
  never presented under a later unit.
- Weekly and monthly review context includes movement, lifecycle, time by area,
  comparison, source identifiers, and links to underlying records.
- Saved reviews retain bounded context as it appeared when they were saved.
- Personal-quality analytics describe connected activity, not a score or claim
  about personal worth.
- All eight dashboard regions can be shown, hidden, and reordered.
- Dashboard due, upcoming, recently active, and momentum language maps to the
  underlying records it actually describes.

### Portability, capacity, and recovery

- Records-only JSON and timeline CSV exports remain available and are
  accurately labelled as excluding evidence bytes.
- A versioned `.evolvra` archive contains canonical workspace JSON, a
  checksummed manifest, and every referenced evidence payload.
- Export uses device bytes first and an exact-authenticated-account cloud
  fallback. A missing or mismatched file prevents a “complete backup” result.
- Import validates archive framing, canonical JSON, schema, file metadata,
  lengths, hashes, duplicate keys, extra bytes, and completeness before showing
  an explicit merge or destructive replace choice.
- Import commits the resulting workspace envelope, imported evidence bytes,
  and replace cleanup of superseded account-scoped device evidence in one
  IndexedDB transaction under the active account, generation, and exact local
  revision. An abort publishes none of them.
- Both merge and replace clear recent undo history and are explicitly
  non-undoable. Restore inspection/application stays blocked during unresolved
  cloud/sync conflicts and pending or rendered account-handoff choices; export
  remains available while the source of truth is resolved.
- Replace sweeps device evidence inside the same IndexedDB transaction and
  advances the workspace CAS even when metadata is otherwise identical. It
  records remote cleanup intents before commit, waits for normal revision-safe
  sync to make replacement metadata authoritative, then obtains permanent
  database claims before removing paths that lost their final reference.
- Capacity forecasting warns before the 5 MiB workspace ceiling and estimates
  remaining activity headroom without presenting the estimate as a guarantee.
- Archive-and-reset refuses incomplete backups and requires a one-use receipt
  bound to the exact persisted revision represented by the downloaded archive.
  A later save in any tab makes that receipt stale and forces a fresh backup
  before anonymous data can be reset. Connected erasure extends the receipt to
  cloud snapshot/evidence coordinates and cancels its unstarted local fence
  after an authoritative stale-backup rejection.

### Architecture and automated assurance

- Product consumers use separate workspace-data, provider-status, and stable
  action contexts; the compatibility all-in-one consumer has been removed.
- Cloud reconciliation, cloud save, portable archive coordination, domain
  commands, provider state, evidence operations, lifecycle presentation,
  account-erasure checkpoints, historical snapshots, capacity analysis, and
  state migrations have focused seams and tests.
- Safety-critical modules have explicit coverage thresholds. Property tests
  exercise migrations, imports, merges, recurrence, and compensation behavior.
- IndexedDB v4 rollout coverage proves that a current client closes a live v3
  connection, preserves v3 live evidence while assigning `writeId`, creates
  the separate staging store, and prevents an old v3 bundle from reopening the
  newer persistence database.
- CI covers pinned install, dependency audit, retired-mechanic and no-AI guards,
  typecheck, lint, unit/coverage, service worker, icons, build/bundle, Chromium,
  Firefox, WebKit, accessibility, database migration, RLS, and cloud workflows.
- Bootstrap, quarantine, and terminal recovery blockers share a labelled modal
  alert boundary and explicit priority. Only the highest attached blocker owns
  focus containment, inert background, Escape safety, and scroll lock; ordinary
  modals share reference-counted overlay ownership and cannot release it.
- Device tests cover 320 px through desktop layouts, zoom/reflow,
  forced-colour behavior, reduced motion, and safe areas.
- The maskable icon has an automated Android safe-zone check.
- Production synthetics verify routes, security headers, manifest/icon MIME,
  service-worker version, and telemetry rejection.
- Weekly disposable Supabase drills re-run migration, RLS, sync, conflict,
  evidence, handoff, backup-first erasure, and cross-device stale-backup paths.
- Storage backup tooling inventories private objects, downloads bytes,
  records hashes, detects drift, and supports restore verification without
  treating a database dump as file protection.

## Release phase — required now

Current pre-commit evidence on 11 August: the fresh backup and empty Storage
inventory are verified; the complete `npm run check` worktree gate passed with
682 unit tests, 436 focused coverage tests, and 69 non-cloud browser tests
across Chromium, Firefox, and WebKit (the seven local-Supabase cases were
intentionally skipped there). All 28 reviewed visual snapshots matched. The
disposable Docker-backed `.011` gate then passed fresh and populated-legacy
migration paths, SQL lint, two RLS regressions, the cloud build, and all seven
cloud browser integrations. The linked dry-run showed only `.011`; the owner
approved it, it was applied, the ledger aligned through `.011`, and the clean
follow-up dry-run reported the remote database up to date.

These steps are sequential. Do not reopen production editing between them.

1. Freeze the shared tree and review every modified or untracked path.
2. Create and verify a fresh database/Auth/Storage-metadata backup for this
   candidate. Inventory and download/hash any Storage object bytes separately;
   a PostgreSQL dump is not evidence-file protection.
3. Generate the 28 primary-route visual baselines in dark/light and
   desktop/mobile modes, inspect representative images, then prove a clean
   non-update run.
4. Run the complete local gate on the frozen tree:
   clean install, production dependency audit, guards, typecheck, lint, all
   unit tests, coverage thresholds, service-worker/icon checks, production
   build, bundle budget, and all local browser projects.
5. With Docker running, reproduce the hosted database job on the frozen SHA:
   fresh migration/reset, populated-legacy upgrade, SQL lint, RLS regression,
   cloud-enabled build, and `npm run test:e2e:cloud`. Retain the
   cross-device stale-backup result.
6. Retain the linked Supabase `db push --linked --dry-run --yes` output. Confirm
   production starts aligned through `202607270010` and the only pending item
   is `202608020011_account_erasure_backup_boundary.sql`; stop on any other
   result.
7. Present the Docker/local and linked dry-run evidence to the
   deployment/rollback owner and obtain explicit `.011` approval. The existing
   approval through `.010` is insufficient. Apply `.011` only after approval,
   then record a linked migration list aligned through `202608020011`.
8. Commit and push the exact candidate to `agent/finish-product-plan`.
9. Open a reviewed pull request and require both hosted jobs on that exact SHA:
   application validation and database/RLS/cloud integration.
   Verify repository branch protection requires those checks; this external
   setting has not yet been recorded.
10. Merge only that reviewed tree to `main` and confirm exact-main hosted CI.
11. Deploy the exact `main` commit with the existing production variables.
   Verify that the deployment metadata identifies the same commit and that the
   `2026-08-02.3` worker is live and its explicit update cutover reloads every
   open Evolvra tab.
12. Run the read-only production synthetic and a fresh anonymous browser smoke
   for onboarding, navigation, local persistence, offline known routes,
   portable export/import preview, recovery, PWA update, and security headers.
13. With a disposable production account and non-valuable fixture data, record:
   magic-link sign-in; same-browser account isolation; authenticated save and
   reconnect; an intentional two-client conflict and recovery; evidence
   upload/download/rename/delete; portable backup round-trip; backup-first
   account erasure; and a second-device post-backup mutation that is rejected
   without tombstoning or deleting the active account, cloud state, or evidence.
14. Record the release commit, PR, CI runs, deployment IDs, smoke evidence, any
   limitation, and the owner decision to reopen production editing.

Steps 1–13 are complete. Step 14 is complete except for the owner's explicit
decision to reopen production editing. The production harness is retained as
`npm run test:e2e:production` and `npm run test:e2e:production:cloud`.

Release definition of done:

- The reviewed application commit tree, hosted CI tree, `main` tree, and
  deployed application artifact are identical. The post-release harness and
  evidence record are a separate non-runtime follow-up.
- Every automated gate passes on that exact tree.
- Public and authenticated production smoke evidence is recorded.
- Required branch protection is verified, not inferred from workflow files.
- Production editing is reopened only by the deployment/rollback owner.

## Next engineering work after a stable release

These are not represented as completed release evidence. Some are manual or
external confidence gates; the longer-term items should be prioritized from
real use and operational evidence.

### P1 — Manual browser and assistive-technology confidence

- Complete keyboard and VoiceOver/NVDA walkthroughs on real hardware.
- Check 200% and 400% zoom, enlarged system text, 320/390 px phones, tablet,
  landscape, forced colours, reduced motion, iOS safe areas, Android install
  and update, and slow/interrupted networks.
- Check life-calendar day exploration with keyboard and touch users; add
  individually interactive cells only if the current accessible summary is not
  sufficient.
- Verify the maskable icon on real Android launchers despite the automated
  safe-zone proof.

The automated accessibility, cross-browser, reflow, and device-emulation suites
are implemented, but the real-device and assistive-technology walkthroughs
above were still unrecorded at the 2 August audit.

### P1 — Operational rehearsal

- Run the first quarterly private-Storage inventory/download/restore drill once
  real Storage objects exist, retain its signed-off manifest and checksums, and
  record recovery time.
- Run a complete `.evolvra` merge and replace rehearsal in a disposable browser
  profile and verify the documented remote-orphan retention behavior.
- Capture future Supabase dry-run output and hosted Auth redirect configuration
  as durable release artifacts instead of recording only that they were
  reviewed.
- Keep weekly synthetics and disposable cloud drills monitored as incidents,
  even when no code changes.

### P2 — Architecture and scale based on evidence

- Continue extracting account handoff, records-only import/reset, and terminal
  erasure coordination from `AppProvider` when a change next touches those
  paths.
- Split IndexedDB workspace, evidence, erasure-fence, and legacy-journal
  repositories from the large persistence boundary while preserving one
  transactional API.
- Benchmark complete cloud snapshot saves on genuinely slow and interrupted
  networks. Partition immutable histories from frequently edited metadata only
  when real workspace size or latency demonstrates the need.
- Consider streaming archive hashing if real evidence sets approach the
  supported upper bound and browser memory profiling shows pressure.
- Tighten CSP from compatible `unsafe-inline` allowances to nonces or hashes
  when the deployed Next.js runtime supports it without breaking hydration.
- Keep production telemetry disabled until its operational ownership, review,
  alerting, and retention controls are deliberately accepted; the disabled
  state is not evidence that production observability has been completed.

### P3 — Optional product discovery

- Global search or command palette.
- Planner/calendar view.
- More user-created templates.
- Background push reminders when the application is closed.
- A separate public marketing surface and custom domain.
- Carefully scoped external integrations.

AI remains deferred. Reconsidering it requires a separate privacy, consent,
threat-model, retention, failure-mode, and non-authoritative-suggestion plan;
it must not be introduced as an incidental enhancement.

## Owner assistance required

Branch protection and authenticated production smoke are verified. Owner
assistance is now required only to decide whether to reopen production editing
and to accept or schedule the non-blocking real-device/assistive-technology
walkthrough. The Storage restore drill requires real retained objects and
remains unrecorded rather than being treated as satisfied by an empty inventory.

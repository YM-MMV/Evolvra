# Release checklist

Current-candidate audit: 11 August 2026. Evolvra remains labelled beta until
every applicable item is verified for the exact release commit. A checked
automation item below means the coverage or workflow exists; it does not mean
the still-changing candidate has already passed its exact-SHA release run.

Production editing is paused. Deployment/rollback owner `YM-MMV` authorised
the fresh backup, Docker/local and linked `.011` review, production `.011`
application, merge to `main`, deployment, and smoke testing. Migration
`202608020011_account_erasure_backup_boundary.sql` was applied on 11 August
after that evidence and explicit approval; the linked ledger is aligned and a
follow-up dry-run is clean. The unchecked items remain evidence to collect.

## Automation implemented

- [x] The local gate defines pinned clean install, dependency audit,
  retired-mechanics/no-AI/state-v3 guards, typecheck, lint, unit/coverage,
  service-worker/icon checks, production build, bundle budget, and Playwright
  browser projects.
- [x] GitHub Actions defines application validation and disposable
  database/RLS/cloud-integration jobs, including fresh and populated-legacy
  migration paths through `202608020011`, two-user isolation, and backup-bound
  account erasure.
- [x] Portable archive tests cover byte-backed evidence, strict framing and
  validation, exact-scope cloud fallback, atomic IndexedDB merge/replace,
  non-undoable restore history, conflict/handoff fences, and exact-revision
  archive-and-reset receipts. Connected erasure coverage verifies its exact
  cloud workspace/evidence boundary and cross-device stale-backup refusal.
- [x] IndexedDB rollout coverage proves a v4 client closes a live v3
  connection, preserves v3 live evidence while assigning `writeId`, creates
  the separate staging store, and prevents the old bundle from reopening at v3.
- [x] Recovery tests cover shared overlay ownership and priority, simultaneous
  blockers, focus containment/restoration, background isolation, Escape safety,
  and the rule that ordinary modal cleanup cannot release a blocker.
- [x] Automated Chromium accessibility/keyboard, cross-browser smoke,
  responsive/zoom/reflow, forced-colour, reduced-motion, safe-area, visual, and
  maskable-icon checks are implemented.
- [x] Weekly disposable Supabase assurance is configured for migration, RLS,
  sync, conflict, handoff, evidence, and erasure workflows.

## Candidate gate and exact-SHA publication evidence

- [ ] Freeze and review every modified and untracked path; record the exact
  candidate SHA.
- [x] Run the complete worktree `npm run check` gate successfully; repeat it
  from the clean committed SHA in hosted CI before merge.
- [x] With Docker running, reproduce the hosted Supabase database job on the
  candidate tree: fresh migration/reset, populated-legacy upgrade, SQL lint,
  RLS regression, cloud-enabled build, and `npm run test:e2e:cloud`. The
  retained successful log is
  `/private/tmp/evolvra-local-011-gate-20260811T153024Z.log` with SHA-256
  `276d0f91e05060fb43142ef46caca74986d0608d6a306cc0736c9267587023bf`.
- [x] Generate/inspect the approved visual baselines and record a clean
  non-update run on the candidate tree; hosted CI must repeat it on the SHA.
- [ ] From a clean checkout of the committed SHA, run `npm ci`, dependency
  audit, and the complete local `npm run check` gate successfully.
- [ ] Push the same SHA and record both hosted GitHub Actions jobs passing.
- [ ] Verify repository branch protection requires those hosted checks; workflow
  files alone do not prove the external setting is enforced.
- [ ] Merge only the reviewed tree to `main` and record exact-main hosted CI.

## Manual product evidence — not replaced by automation

- [ ] Complete and record keyboard/focus/announcement review with VoiceOver
  and/or NVDA on real hardware.
- [ ] Complete and record real-device PWA install/update, 200%/400% zoom,
  enlarged system text, 320/390 px phones, tablet/landscape, forced colours,
  reduced motion, safe areas, touch interaction, and slow/interrupted networks.

## Operations gate — current candidate

- [x] Create and verify a fresh database/Auth/Storage-metadata backup; record its
  identifier, timestamp, checksums, and owner. Backup
  `evolvra-production-backup-20260809T133841Z` completed from
  `2026-08-09T13:38:41Z` through `13:42:08Z`; its checksum ledger is
  `cf72fd9a57f27eb639833bc7ab4520e419588ab715c2b2480e1a5e5ceda89e5d`.
- [x] Inventory and download/hash any private Storage object bytes separately.
  The verified current inventory contained zero objects/bytes with manifest
  digest `25bac6a513c99ecc1f7de4a5976f87ba4182ee604c0046237ef745b18a2cf353`.
  A PostgreSQL dump protects neither existing nor future evidence bytes, and
  this empty inventory is not a non-empty restore drill.
- [x] Retain the approved linked-project `db push --dry-run` output and confirm
  the project starts aligned through `202607270010` and reports exactly
  `202608020011_account_erasure_backup_boundary.sql` as pending. Stop if any
  other migration appears.
- [x] Obtain and record the deployment/rollback owner's explicit approval for
  `.011` after the Docker/local Supabase gate and linked dry-run are reviewed.
  The earlier authorisation through `.010` is not sufficient.
- [x] After that approval, apply `.011`, rerun the linked migration list, and
  retain evidence that production is aligned through `202608020011`.
- [ ] Retain the production environment and authenticated redirect allow-list
  review as a release artifact.
- [ ] Deploy the exact `main` SHA and verify deployment metadata, production
  variables, security headers, and service-worker version `2026-08-02.3`.
- [ ] Record the public/read-only production synthetic and fresh anonymous
  onboarding, persistence, offline, recovery, portable-preview, PWA, and header
  smoke results.
- [ ] Record authenticated production isolation, save/reconnect, intentional
  two-client conflict/recovery, evidence lifecycle, portable round-trip, and
  backup-first account-erasure smoke with disposable non-valuable data. Also
  record that a second-device save/evidence upload after backup is rejected as
  stale while the account lifecycle, cloud state/evidence, and local scope stay
  active.
- [ ] Perform and sign off the first Storage inventory/download/restore drill
  once retained Storage objects exist. The prior empty inventory does not count
  as a byte restore.
- [x] The rollback target remains a state-v3/IndexedDB-v4-compatible forward
  hotfix, never `ca81723`, another pre-v3 build, or—after this release—an
  IndexedDB-v3-or-earlier client that lacks token staging, evidence revision
  fences, or the `.011` backup-bound erasure contract.
- [ ] Record an explicit production-observability decision and its ownership,
  review, alerting, and retention controls. Telemetry remains disabled; enabling
  it is not itself a release requirement.
- [ ] Record release SHA, PR, hosted runs, backup, dry-run, deployment IDs,
  public/authenticated smoke evidence, limitations, and the owner's explicit
  decision before reopening production editing.

## Non-blocking maintainability follow-up

- [ ] Continue extracting handoff, import/reset, and terminal-erasure lifecycles
  from `AppProvider` when those paths next change.
- [ ] Split the large IndexedDB persistence boundary behind one transactional
  API without weakening generation, revision, archive, or erasure fences.
- [ ] Decide whether to operationalise privacy-safe production telemetry or
  formally retain the disabled beta posture.

## Deployment record — 29 July 2026

- Release candidate / `main`: `bd1ac837bb1c7ca437033c58ea981086043ff1d9` / `292d4bc81bcacb8097a082006be3dc60f1aab8a2` (identical tree).
- Prepared deployment identifier: `dpl_FA2smv9HXRzbZ1YiZySuxjkGMxJg`.
- Final deployment identifier: `dpl_E57meBP6uJe8QgYbBUVuKsxdKNmf`.
- Database backup identifier/time: `evolvra-production-backup-20260729T140907Z` / `2026-07-29T14:09:07Z`.
- Supabase project/Postgres version: `gmityvwkrhrraubhmyez` / `17.6.1.141`.
- Migration list/dry-run review: clean dry-run; applied and aligned through `202607270010`; console output not retained.
- Deployment and rollback owner: `YM-MMV` (operator-confirmed).
- Hosted CI run: <https://github.com/YM-MMV/Evolvra/actions/runs/30460220225>.
- State-v3 cutover: 29 July 2026 after the 14:09:07Z backup; exact start/end timestamps were not retained.
- Production smoke result: public routes, headers, PWA assets, worker, fresh onboarding, and isolated offline settings passed. Authenticated production mutation/erasure smoke remains pending.
- Detailed evidence and limitations: [Production release record](./RELEASE_RECORD_2026-07-29.md).

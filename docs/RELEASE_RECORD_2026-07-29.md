# Production release record — 29 July 2026

This record closes the state-v3, non-gamified beta cutover. It records what was
actually verified and calls out evidence that was not retained. It must not be
read as proof of the still-pending authenticated production mutation smoke.

## Ownership and edit pause

- Deployment owner: `YM-MMV` (confirmed by the operator in the release task).
- Rollback owner: `YM-MMV` (confirmed by the operator in the release task).
- Production editing: paused for backup, migration, promotion, and read-only
  smoke testing. Reopening remains an owner decision after the authenticated
  smoke is recorded.
- Rollback rule: after migration `202607270010` or any state-v3 workspace open,
  never redeploy `ca81723` or another pre-v3 client. Roll forward with a
  state-v3-compatible hotfix and, when required, a new additive migration.

## Exact release identity

- Reviewed release candidate: `bd1ac837bb1c7ca437033c58ea981086043ff1d9`.
- `main` merge commit: `292d4bc81bcacb8097a082006be3dc60f1aab8a2`.
- Candidate and merge trees: identical
  (`7aef904091da3cf51cde5504480be10bce9d7eb7`).
- Pull request: <https://github.com/YM-MMV/Evolvra/pull/2>.
- Exact-main hosted CI:
  <https://github.com/YM-MMV/Evolvra/actions/runs/30460220225>.
- Hosted checks: `Validate` passed; `Database, RLS, and cloud browser
  integration` passed.

## Backup and database cutover

- Backup created: `2026-07-29T14:09:07Z`.
- Durable operator copy:
  `Evolvra Production Backups/evolvra-production-backup-20260729T140907Z`.
- Backup manifest SHA-256:
  `cc5209734a6f29d0f0b88f075aa6416001540e2aed874cc3b9b7869b34098046`.
- Checksum ledger SHA-256:
  `e91e5bae27785513c943497d1f8054373ffa7122cc27a8369fdc59a7ef5aaf85`.
- Included logical artifacts: filtered roles, application schema, data
  including Auth/Storage metadata, pre-cutover migration ledger, and release
  SHA. Every listed artifact passed its recorded SHA-256 check.
- Supabase project: `gmityvwkrhrraubhmyez`.
- Project health at cutover: `ACTIVE_HEALTHY`.
- PostgreSQL server version: `17.6.1.141`.
- Supabase CLI: `2.109.1`.
- Dump client: PostgreSQL `18.4`.
- Pre-cutover remote migration: `202607150001`.
- Approved and applied forward chain:
  `202607180001` through `202607180008`, then `202607270009` and
  `202607270010`.
- Post-cutover migration ledger: local and remote aligned through
  `202607270010`.
- Dry-run result: clean before application. The console output itself was not
  retained as a release artifact; this limitation cannot be reconstructed
  after application and is recorded rather than silently treated as evidence.

At backup time, the database contained no Auth users, workspace snapshots, or
Storage object metadata. A logical database dump never contains Supabase
Storage object bytes. Evidence bytes therefore require a separate object
protection/export procedure before the service is used for important files.

## Deployment

- Prepared Production deployment: `dpl_FA2smv9HXRzbZ1YiZySuxjkGMxJg`.
- Final exact-main Production deployment:
  `dpl_E57meBP6uJe8QgYbBUVuKsxdKNmf`.
- Immutable final URL:
  <https://evolvra-h3filu81r-ym-mmv1.vercel.app>.
- Stable production URL: <https://evolvra-seven.vercel.app>.
- Final deployment state: `Ready`.
- Production metadata SHA: exact `main` merge commit
  `292d4bc81bcacb8097a082006be3dc60f1aab8a2`.

The hosted Supabase Auth settings were reviewed in the signed-in dashboard:
the Site URL was `https://evolvra-seven.vercel.app`, and the redirect allow-list
included the stable production URL, the reviewed Vercel deployment URL, and
the intended localhost development callbacks. An exact exported settings
artifact was not retained; a future release should capture one.

## Smoke evidence

Passed after final production-domain assignment:

- HTTP 200 and correct HTML for `/`, `/goals`, `/quests`, `/stats`, `/reviews`,
  `/timeline`, and `/settings`.
- HTTP 200 and expected MIME for the manifest, service worker, SVG icon, normal
  PNG icons, and maskable PNG icon.
- CSP, `frame-ancestors`, `nosniff`, deny framing, referrer policy,
  permissions policy, HSTS, and absence of `X-Powered-By`.
- Service-worker version `2026-07-28.1` and exact committed worker digest.
- Isolated fresh-Chromium onboarding, route rendering, service-worker control,
  offline `/settings` reload, and local settings interactivity.
- The post-release read-only synthetic in `scripts/check-production.mjs`.

One optional lazy Supabase-client chunk returned an expected offline-only 504
in the isolated smoke. The same versioned chunk returned 200 online; no page
error occurred and local settings remained interactive.

Pending owner-assisted production evidence:

- magic-link authentication in the production browser profile;
- authenticated save and reconnect;
- an intentional two-client revision conflict and recovery choice;
- private evidence upload, download, rename, and deletion;
- disposable-account erasure and verification.

These paths passed the hosted disposable local-Supabase cloud integration gate,
but that is not substituted for the pending hosted-production smoke.

## 11 August maintenance-candidate preflight

This section records evidence gathered for the still-unreleased maintenance
application candidate. It does not amend the 29 July application deployment
identity. It does record the separately approved `.011` database cutover.

- Fresh production backup:
  `evolvra-production-backup-20260809T133841Z`, captured from
  `2026-08-09T13:38:41Z` through `13:42:08Z` while production editing remained
  paused.
- Reverified checksum-ledger SHA-256:
  `cf72fd9a57f27eb639833bc7ab4520e419588ab715c2b2480e1a5e5ceda89e5d`.
- Evidence inventory: zero objects and zero bytes; manifest SHA-256
  `25bac6a513c99ecc1f7de4a5976f87ba4182ee604c0046237ef745b18a2cf353`.
  This is a valid current empty backup, not a non-empty restore drill.
- The final Docker/local gate passed fresh and populated-legacy migration,
  preservation assertions, SQL lint, two RLS regressions, the cloud-enabled
  build, and all seven browser integrations. Successful log:
  `/private/tmp/evolvra-local-011-gate-20260811T153024Z.log`; log SHA-256
  `276d0f91e05060fb43142ef46caca74986d0608d6a306cc0736c9267587023bf`;
  migration SHA-256
  `476d5b1281e5f7de472a7d77f0a6194bc141a184345195dc37f54eafc354e729`.
- The refreshed linked ledger was aligned through `202607270010`, and the
  dry-run reported only `202608020011_account_erasure_backup_boundary.sql`.
  Deployment/rollback owner `YM-MMV` then explicitly approved `.011`. CLI
  `2.109.1` applied it, the linked migration list aligned through `.011`, and a
  follow-up dry-run reported the remote database up to date.
- The complete non-cloud worktree gate passed on the exact final worktree on
  11 August: dependency audit, no-gamification/no-AI guards, typecheck, lint,
  682 unit tests, 436 focused coverage tests, service-worker and icon checks,
  production build, bundle budget, 69 browser tests, and 28 unchanged visual
  snapshots. The seven Docker-backed cloud tests were intentionally skipped by
  this gate and remain part of the separate local `.011` gate below.
- Reviewed candidate:
  `694c532500ce9e84f33f410138b3c51fd09a3b8b`; pull request
  <https://github.com/YM-MMV/Evolvra/pull/11>.
- Candidate hosted run:
  <https://github.com/YM-MMV/Evolvra/actions/runs/31519483155>; both application
  validation and database/RLS/cloud integration passed, with Vercel successful.
- Main merge commit:
  `4a8478fce73a4f682361f30d03d6b12c90e596a6`; candidate and merge tree are
  identical at `3a63c22e8224fc1f72103de6b53832f7fe3d45c8`.
- Exact-main hosted run:
  <https://github.com/YM-MMV/Evolvra/actions/runs/31520061880>; both required
  jobs passed. Protected `main` required `Validate`, `Database, RLS, and cloud
  browser integration`, and `Vercel`, with strict checks, administrator
  enforcement, and required conversation resolution.
- Exact-merge Vercel status passed for deployment
  `dpl_59Y4N17D8s3VNeYTmpnndQtrzaVc`; stable production is
  <https://evolvra-seven.vercel.app>.
- On 12 August, the read-only production synthetic passed all seven routes,
  security headers, manifest/icons, privacy probe, and service-worker version
  `2026-08-02.3`.
- Eight isolated fresh-Chromium anonymous production checks passed: onboarding
  and persistence, primary routes/accessibility, offline known-route safety,
  offline edit and reconnect, strict JSON recovery, evidence preview/export,
  complete portable archive round-trip, and same-device conflict recovery.
- Seven authenticated production checks passed using freshly created,
  non-valuable `@evolvra.test` users: account isolation; explicit handoff;
  two-client conflict/reconnect; Storage revision boundary; deletion claims and
  anti-resurrection; second-device evidence upload/download/rename/delete plus
  backup-first erasure; and stale-backup rejection preserving the active
  account, cloud state, evidence, and local scope. Preflight and final cleanup
  both reported zero remaining disposable users and zero remaining objects.
- Supabase Auth URL Configuration was reviewed read-only: the Site URL and
  stable production redirect are `https://evolvra-seven.vercel.app`; the
  allow-list also retains one immutable prior deployment URL and the intended
  localhost development origins.
- Production editing remains paused. Deployment/rollback owner `YM-MMV` must
  explicitly reopen it; no reopening decision is inferred from passing smoke.

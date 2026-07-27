# Release checklist

Evolvra remains labelled beta until every applicable item is verified for the release commit.

## Automated gate

- [ ] `npm ci` succeeds from a clean checkout.
- [ ] `npm run check` passes: retired-mechanics and state-v3 SQL-fixture guards, typecheck, lint, unit tests, service-worker checks, production build, bundle budget, and the Playwright browser release gate.
- [ ] Both GitHub Actions jobs pass on the exact release commit.
- [ ] Production dependency audit has no known high or critical vulnerability.
- [ ] Supabase CLI `2.109.1` applies the immutable migration chain to a fresh database and a seeded legacy database; post-upgrade preservation/backfill assertions pass.
- [ ] Two-user RLS regression tests pass.

## Product gate

- [ ] Keyboard-only onboarding, goal creation/editing, quest completion, review, settings, export/import, and delete flows pass.
- [ ] Desktop and mobile layouts have no blocked or unreachable controls.
- [ ] Anonymous → account local/account/merge selection is explicit, merge preserves both sources, and account A → account B never leaks data.
- [ ] Offline reload, visited goal navigation, queued mutation recovery, explicit offline/unsynced status, update prompt, and missing-asset MIME behavior pass.
- [ ] Recurring actions cannot be completed before their next occurrence.
- [ ] Open goals never display fabricated percentages; completed measured goals retain their real measurement.
- [ ] Evidence upload, retry, download, rename, and deletion pass locally and with private storage.
- [ ] Export, strict import, undo-after-import, conflict resolution, and erase-all partial-failure paths pass.
- [ ] Automated accessibility scan reports no serious or critical violations, followed by a manual focus/announcement review.

## Operations gate

- [ ] Production environment variables and auth redirect allow-lists are correct.
- [ ] Security headers are present.
- [ ] No private data appears in logs, web-vital events, notifications, or error monitoring.
- [ ] The linked Supabase project, Postgres major version, migration list, and `db push --dry-run` output were reviewed with CLI `2.109.1`.
- [ ] A current database backup, evidence-protection plan, and deployment/rollback owner are recorded.
- [ ] A protected state-v3 deployment is ready before the database cutover; active old-client sync is stopped until it is promoted.
- [ ] The rollback target is a state-v3-compatible forward hotfix, never `ca81723` or another pre-v3 build.
- [ ] Release notes describe migrations, offline-cache version, known limitations, and recovery steps.

## Deployment record (complete before production deployment)

- Release commit: `________________`
- Prepared deployment URL/identifier: `________________`
- Database backup identifier/time: `________________`
- Supabase project/Postgres version: `________________`
- Migration list/dry-run review: `________________`
- Deployment and rollback owner: `________________`
- Hosted CI run: `________________`
- State-v3 cutover start/end: `________________`
- Production smoke-test time/result: `________________`

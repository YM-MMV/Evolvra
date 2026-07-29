# Deployment and rollback

## Migration integrity

Timestamped migrations are append-only once committed or applied. Never rewrite an existing migration to make a fresh install look current; add a new forward migration instead. `202607150001_initial_schema.sql` deliberately remains the original legacy baseline. The complete ordered chain produces the current schema, and CI proves both a fresh install and a populated legacy upgrade.

Use Supabase CLI `2.109.1` for this release. The CI workflow and operator commands must stay on the same version so they parse the same project configuration and use the same local service images.

## Prepare

1. Use Node 24 and npm 11 (`.nvmrc` and `packageManager` are authoritative).
2. From a clean checkout of the release commit, run `npm ci` and `npm run check`.
3. Require both hosted GitHub Actions jobs to pass on that exact commit.
4. Use the protected Preview deployment for visual review, then prepare a **staged Production deployment** from the exact release commit with automatic production-domain assignment disabled. A normal Preview → Production promotion performs a fresh build with Production environment variables, so the Preview artifact is not the cutover artifact. A staged Production deployment can be inspected with Production variables and promoted without rebuilding; follow Vercel's [staged Production deployment procedure](https://vercel.com/docs/deployments/promoting-a-deployment#staging-and-promoting-a-production-deployment).
5. Configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the target environment before building the staged Production deployment. Never expose a service-role key. In hosted Supabase Auth, verify the production Site URL and every callback URL used for the release deployment. The stable release-branch preview alias is `https://evolvra-git-agent-remove-xp-levels-ym-mmv1.vercel.app`; immutable Vercel deployment URLs change on every build and should not be used as the long-lived callback. The local `supabase/config.toml` documents the intended allow-list, but `db push` applies migrations only—verify or update hosted Auth configuration separately. Leave `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED` unset or `false` unless the release owner has intentionally approved the privacy-safe hosting-log sink, retention policy, and infrastructure-wide traffic controls; the beta default is off.
6. Link the intended Supabase project and inspect its migration history with `npx supabase@2.109.1 migration list --linked`. Stop if the project, Postgres major version, or applied migration list is unexpected.
7. Create and record a current provider-supported database backup. Record the deployment/rollback owner and how private evidence objects are protected; a workspace JSON export contains evidence metadata, not device-only file bytes.
8. Review the pending database change with `npx supabase@2.109.1 db push --dry-run`.

## Coordinated state-v3 cutover

This release cannot safely mix the old client and new database contract. Migration `202607180003_workspace_revisions.sql` closes direct snapshot upserts in favour of revision-checked saves, while the state-v3 client moves the legacy browser workspace from localStorage into account-scoped IndexedDB.

When production Supabase sync is enabled:

1. Set a short cutover window and stop active signed-in editing on the old client. Close or reload old Evolvra tabs so they cannot attempt a stale direct save during the transition.
2. Confirm the staged Production deployment was built from the exact release commit with the reviewed Production environment variables and is ready to promote without rebuilding.
3. Apply the full pending chain with `npx supabase@2.109.1 db push`.
4. Immediately promote the prepared state-v3 deployment.
5. Re-run `npx supabase@2.109.1 migration list --linked` and record the result.
6. Smoke-test onboarding/local recovery, signed-in load/save, a revision conflict, private evidence upload/download/delete, account callback handling, install/update, offline navigation, and security headers.
7. Complete the deployment record in `RELEASE_CHECKLIST.md` before ending the cutover window.

For a fully local-only production deployment, database cutover steps may be marked not applicable, but the application and PWA smoke tests still apply.

## Rollback and incident response

After the database chain is applied or any browser has opened state v3, do **not** redeploy `ca81723` or another pre-v3 build. Those builds read the removed `evolvra:workspace:v1` localStorage record, expect retired state fields, and bypass the revision-safe snapshot RPC; they are not a safe rollback target.

1. Deploy a forward hotfix based on the state-v3 release commit. Disable the affected UI or sync path if necessary while preserving IndexedDB, state-v3 import/export, and the compare-and-swap database contract.
2. Correct database problems with a new additive migration. Do not edit applied migrations or destructively roll the database backward.
3. Preserve export and recovery access throughout the incident. Validate a local JSON export and a cloud snapshot before reopening writes.
4. Give every hotfix service worker a new cache version. Users can select **Update now** or reload after the compatible deployment is live.
5. Record the incident commit, database action, smoke result, and owner in the release record.

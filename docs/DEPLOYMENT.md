# Deployment and rollback

## Migration integrity

Timestamped migrations are append-only once committed or applied. Never rewrite an existing migration to make a fresh install look current; add a new forward migration instead. `202607150001_initial_schema.sql` deliberately remains the original legacy baseline. The complete ordered chain produces the current schema, and CI proves both a fresh install and a populated legacy upgrade.

Use Supabase CLI `2.109.1` for this release. The CI workflow and operator commands must stay on the same version so they parse the same project configuration and use the same local service images.

The maintenance release adds `202608020011_account_erasure_backup_boundary.sql`. It
binds account erasure to the exact cloud workspace and private-evidence
revisions captured by the downloaded complete backup. It also introduces
permanent evidence cleanup claims: an active account can delete an immutable
four-segment path only after the database proves the complete batch is absent
from authoritative workspace metadata, and claimed paths cannot be referenced
or uploaded again. For the current cutover, the Docker/local and linked gates
passed on 11 August, deployment owner `YM-MMV` explicitly approved `.011`, and
the production ledger is now aligned through it. The compatible application
must still pass hosted CI and deployment smoke before editing is reopened.

Before requesting that approval, Docker must be running and the exact candidate
must pass the local Supabase equivalents of the hosted database job:

1. reset a fresh local database, lint `public,private`, and run
   `supabase/tests/rls_two_user_regression.sql`;
2. reset to `202607150001`, load
   `supabase/tests/legacy_upgrade_fixture.sql`, apply the remaining chain, run
   `supabase/tests/legacy_upgrade_assertions.sql`, lint, and rerun the RLS
   regression;
3. build with credentials exported by the local stack and run
   `npm run test:e2e:cloud`, including the cross-device stale-backup erasure
   case; and
4. stop the disposable stack with `supabase stop --no-backup`.

The commands and credential guard are maintained in the **Database, RLS, and
cloud browser integration** job in `.github/workflows/ci.yml`. They deliberately
refuse to run destructive browser tests against a non-local Supabase URL.

## Prepare

1. Use Node 24 and npm 11 (`.nvmrc` and `packageManager` are authoritative).
2. From a clean checkout of the release commit, run `npm ci` and `npm run check`.
3. Require both hosted GitHub Actions jobs to pass on that exact commit.
4. Use the protected Preview deployment for visual review, then prepare a **staged Production deployment** from the exact release commit with automatic production-domain assignment disabled. A normal Preview → Production promotion performs a fresh build with Production environment variables, so the Preview artifact is not the cutover artifact. A staged Production deployment can be inspected with Production variables and promoted without rebuilding; follow Vercel's [staged Production deployment procedure](https://vercel.com/docs/deployments/promoting-a-deployment#staging-and-promoting-a-production-deployment).
5. Configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the target environment before building the staged Production deployment. Never expose a service-role key. In hosted Supabase Auth, verify the production Site URL and every callback URL used for the release deployment. Immutable Vercel deployment URLs and branch aliases are not approved callback targets unless the release owner records and allow-lists them explicitly; production smoke uses `https://evolvra-seven.vercel.app`. The local `supabase/config.toml` documents the intended local and production allow-list, but `db push` applies migrations only—verify or update hosted Auth configuration separately. Leave `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED` unset or `false` unless the release owner has intentionally approved the privacy-safe hosting-log sink, retention policy, and infrastructure-wide traffic controls; the beta default is off.
6. Link the intended Supabase project and inspect its migration history with `npx supabase@2.109.1 migration list --linked`. Stop if the project, Postgres major version, or applied migration list is unexpected.
7. Create and record a current provider-supported database backup. Record the deployment/rollback owner and how private evidence objects are protected; a workspace JSON export contains evidence metadata, not device-only file bytes.
8. After the Docker/local Supabase gates pass, review the pending database
   change with `npx supabase@2.109.1 db push --linked --dry-run --yes`. The
   expected pending set is `.011` only. Stop on any other change, retain the
   complete output, and obtain the deployment owner's explicit `.011`
   approval before a real push.

## Coordinated state-v3 cutover

This release cannot safely mix arbitrary old clients and new database contracts. Migration `202607180003_workspace_revisions.sql` closes direct snapshot upserts in favour of revision-checked saves, while the state-v3 client moves the legacy browser workspace from localStorage into account-scoped IndexedDB. Candidate migration `.011` changes active-account erasure to require the exact cloud workspace/evidence boundary carried by the compatible client and binds snapshot saves to the client state owner's exact account ID. Its retired two-argument snapshot-save RPC fails closed during the maintenance cutover. Its retained one-argument deletion RPC is resume-only: an older bundle may finish a server lifecycle already in `deleting`, but it cannot save an active workspace or begin deleting an active account without the compatible client and verified backup.

When production Supabase sync is enabled:

1. Set a short cutover window and stop active signed-in editing on the old client. Close or reload old Evolvra tabs so they cannot attempt a stale direct save during the transition. Opening IndexedDB v4 will close a cooperating v3 persistence connection through `versionchange`; the old bundle then receives `VersionError` instead of reopening v3 without the staging, `writeId`, and `evidenceRevision` protocol.
2. Confirm the staged Production deployment was built from the exact release commit with the reviewed Production environment variables and is ready to promote without rebuilding.
3. Confirm the owner has explicitly approved `.011`, then apply the reviewed
   pending set with `npx supabase@2.109.1 db push --linked --yes`. Do not treat
   the earlier approval through `.010` as approval for this step.
4. Immediately promote the prepared state-v3/IndexedDB-v4 deployment. Use the
   in-app update action to activate the new worker, which reloads every open
   same-origin Evolvra tab as one compatibility cutover.
5. Re-run `npx supabase@2.109.1 migration list --linked` and record the result.
6. Smoke-test onboarding/local recovery, signed-in load/save, a revision conflict, private evidence upload/download/delete, account callback handling, install/update, offline navigation, and security headers. With disposable data, also prove that connected erasure succeeds only after its `.evolvra` download and that a second device save/evidence upload after the download produces a fresh-backup refusal while the account lifecycle, cloud snapshot, evidence, and local persistence scope remain active.
7. Complete the deployment record in `RELEASE_CHECKLIST.md` before ending the cutover window.

For a fully local-only production deployment, database cutover steps may be marked not applicable, but the application and PWA smoke tests still apply.

## Rollback and incident response

After the database chain is applied or any browser has opened state v3, do **not** redeploy `ca81723` or another pre-v3 build. Those builds read the removed `evolvra:workspace:v1` localStorage record, expect retired state fields, and bypass the revision-safe snapshot RPC; they are not a safe rollback target. After IndexedDB v4 is released, also do not roll back to a build that opens IndexedDB v3 or earlier, lacks token-staged evidence and evidence-revision backup fences, uses the retired two-argument snapshot-save RPC, or expects the former unrestricted one-argument deletion RPC. The database makes older IndexedDB clients fail closed, but such a client is operationally incompatible.

1. Deploy a forward hotfix based on the state-v3/IndexedDB-v4 release commit. Disable the affected UI or sync path if necessary while preserving IndexedDB v4's rolling-client fence, staged-evidence protocol, state-v3 import/export, compare-and-swap snapshots, and the `.011` erasure-backup boundary.
2. Correct database problems with a new additive migration. Do not edit applied migrations or destructively roll the database backward.
3. Preserve export and recovery access throughout the incident. Validate a local JSON export and a cloud snapshot before reopening writes.
4. Give every hotfix service worker a new cache version. Users can select **Update now** or reload after the compatible deployment is live.
5. Record the incident commit, database action, smoke result, and owner in the release record.

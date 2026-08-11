# Private evidence Storage backup and restore

Evolvra's records-only JSON export contains evidence metadata, not private
Supabase Storage bytes. User-owned `.evolvra` archives can bundle one
workspace's currently available evidence, but they are not an operator backup
of the whole bucket. The operator utility at
`scripts/supabase-storage-evidence.mjs` protects the private `evidence` bucket
without loading application `.env` files or printing credentials.

The utility is deliberately separate from normal deployment:

- it reads credentials only from the explicitly named process environment;
- it accepts only normalized absolute backup and report paths;
- a backup destination must not already exist;
- remote object names are SHA-256-mapped to local filenames and can never
  traverse the chosen directory;
- list pagination, downloads, and restores are bounded;
- every object's bytes and canonical metadata are hashed;
- the bucket inventory is listed again after download, so editing during a
  backup makes the run fail;
- `manifest.json` and `MANIFEST.sha256` are fsynced and atomically published,
  and the completed directory appears only after a final atomic rename;
- any partial download or restore makes the process exit nonzero;
- restore is create-only unless `--upsert` is explicitly supplied, and every
  upload is downloaded again and matched to the backup hash.

Run all commands from a clean checkout of the recorded release commit with the
repository's Node 24 runtime. Shell history must not contain key values. Use
your shell, password manager, CI secret store, or an ephemeral restricted
terminal session to set the environment variables.

## Create a fresh production backup

Production editing must remain paused from before this command starts until it
prints a completed manifest hash. Choose a new path on owner-controlled,
encrypted storage; the final path must not exist yet.

```sh
EVOLVRA_STORAGE_SOURCE_URL='https://PROJECT.supabase.co' \
EVOLVRA_STORAGE_SOURCE_SERVICE_ROLE_KEY='<service-role-secret>' \
node scripts/supabase-storage-evidence.mjs backup \
  --output '/absolute/owner-controlled/evidence-2026-07-29T140907Z'
```

The defaults are a 100-row page, four concurrent downloads, a 60-second request
timeout, and 64 MiB per object. Evolvra currently limits individual evidence
uploads to 10 MiB, so the default leaves recovery headroom. The operator can
set bounded values with `--page-size`, `--concurrency`,
`--request-timeout-ms`, and `--max-object-bytes`.

Record all of the following in the release record:

- UTC start and completion times;
- source Supabase project reference;
- owner and protected destination;
- object count and total bytes;
- the printed manifest SHA-256;
- the release commit and migration ceiling;
- the result of the independent verification below.

If the command fails, it exits nonzero and leaves a sibling path containing
`.incomplete-` in its name for diagnosis. If publishing has already performed
the final rename when its parent-directory durability check fails, the utility
renames the directory back to that incomplete path before reporting failure;
the requested destination is not left as a completed backup. Treat the partial
directory as sensitive, retain the `FAILURE.json` report only as long as
incident analysis requires, then securely remove it according to the storage
provider's deletion procedure. Do not claim it as a backup.

## Verify a backup without credentials

Verification reads no Supabase credentials. Run it immediately after backup,
after every copy to archival storage, before restore, and during scheduled
retention audits:

```sh
node scripts/supabase-storage-evidence.mjs verify \
  --input '/absolute/owner-controlled/evidence-2026-07-29T140907Z'
```

Match the printed manifest SHA-256 to the release record. A changed manifest,
metadata record, missing object, symlink, byte count, or object hash exits
nonzero.

## Restore drill

Use a disposable local Supabase project where possible. The restore validates
the entire backup before making a network request, uploads objects without
overwriting existing names, re-downloads each result, and writes an atomic
owner-chosen report.

```sh
EVOLVRA_STORAGE_TARGET_URL='http://127.0.0.1:54321' \
EVOLVRA_STORAGE_TARGET_SERVICE_ROLE_KEY='<local-service-role-secret>' \
node scripts/supabase-storage-evidence.mjs restore \
  --input '/absolute/owner-controlled/evidence-2026-07-29T140907Z' \
  --report '/absolute/owner-controlled/drill-2026-08-01.json' \
  --target-kind drill
```

For a remote non-production drill, the utility requires both an exact
production URL to exclude and a separate flag:

```sh
EVOLVRA_STORAGE_TARGET_URL='https://DRILL_PROJECT.supabase.co' \
EVOLVRA_STORAGE_TARGET_SERVICE_ROLE_KEY='<drill-service-role-secret>' \
EVOLVRA_STORAGE_PRODUCTION_URL='https://PRODUCTION_PROJECT.supabase.co' \
node scripts/supabase-storage-evidence.mjs restore \
  --input '/absolute/owner-controlled/evidence-2026-07-29T140907Z' \
  --report '/absolute/owner-controlled/drill-2026-08-01.json' \
  --target-kind drill \
  --allow-remote-drill
```

If any name already exists, the create-only drill fails instead of changing
it. Start with an empty `evidence` bucket. Use `--upsert` only when the drill
plan intentionally tests replacement and the target is disposable. Restore
recreates object paths, bytes, content types, and safe cache-control values;
provider-managed object IDs and timestamps remain preserved in the backup
manifest for audit but are newly assigned by the target Storage service.

Migration `.011` stores permanent cleanup claims in the database. The service
role used by this operator tool can bypass end-user Storage policies, so never
restore an object onto a path that the target database has already claimed and
then treat it as usable evidence. A drill should use a fresh disposable target.
A production incident restore must reconcile the database backup and Storage
manifest as one boundary; claimed paths remain tombstoned unless a separately
reviewed forward migration deliberately changes that invariant.

After a successful drill:

1. confirm the report has `status: "complete"`, zero failures, and the recorded
   source manifest hash;
2. compare its object count and sampled downloads with the source release
   record;
3. exercise an authenticated Evolvra evidence download from the drill project;
4. destroy the disposable project or restored objects;
5. retain the report with the release record.

## Production restore

Production restore is an incident operation, not a routine deployment step.
Keep editing paused, preserve the damaged bucket, and obtain approval from the
deployment/rollback owner. The target URL must exactly equal the separately
provided production URL, and both a command flag and an exact environment
confirmation are required:

```sh
EVOLVRA_STORAGE_TARGET_URL='https://PRODUCTION_PROJECT.supabase.co' \
EVOLVRA_STORAGE_TARGET_SERVICE_ROLE_KEY='<production-service-role-secret>' \
EVOLVRA_STORAGE_PRODUCTION_URL='https://PRODUCTION_PROJECT.supabase.co' \
EVOLVRA_CONFIRM_PRODUCTION_STORAGE_RESTORE='RESTORE_EVIDENCE_TO_PRODUCTION' \
node scripts/supabase-storage-evidence.mjs restore \
  --input '/absolute/owner-controlled/evidence-2026-07-29T140907Z' \
  --report '/absolute/owner-controlled/production-restore-2026-08-01.json' \
  --target-kind production \
  --allow-production-restore
```

This remains create-only. If incident analysis proves existing objects must be
replaced, take a new backup of the current bucket first and add `--upsert` as a
second explicit decision. A failed production restore can be partial; keep
editing paused, inspect the report, and reconcile its path hashes against the
manifest before retrying.

## Retention and recurring drills

Keep at least three independently verified generations: the current
pre-deployment backup, the prior known-good release backup, and one older
recovery point. Store at least one encrypted copy in a separate failure domain.
Restrict access to the rollback owner and named backup custodians. Provider
versioning or object lock is preferred for the archival copy.

Suggested operating schedule:

- create and verify a fresh backup before every database or application
  cutover that can change evidence metadata or lifecycle behavior;
- verify all retained copies monthly;
- run a full restore drill quarterly and after changing Storage policies,
  bucket configuration, evidence path rules, or this utility;
- rotate service-role credentials after suspected exposure and according to
  the provider's key policy;
- expire backups according to the approved personal-data retention policy,
  including incomplete runs and drill targets;
- record every creation, verification, drill, expiration, and exceptional
  production restore without recording secret values or raw object paths.

The script's focused safety test can be run without credentials or network:

```sh
npm run test:storage-backup
```

# Portable workspace archives

Evolvra's portable archive is a user-owned `.evolvra` file containing one
workspace snapshot and byte-backed evidence for its file references. Device
bytes are preferred; for a signed-in workspace, an otherwise missing file may
be fetched only from the exact authenticated account's verified private cloud
path. It is separate from the operator-only Supabase Storage backup. The
operator backup protects the private bucket as infrastructure; the portable
archive lets one person move or restore their own workspace.

## Format and integrity

Format version 1 is deterministic when given the same workspace, evidence
bytes, and creation timestamp:

1. fixed `EVOLVRA-WORKSPACE-ARCHIVE` header;
2. unsigned 32-bit big-endian manifest length;
3. raw SHA-256 digest of the canonical manifest;
4. canonical UTF-8 JSON manifest;
5. canonical UTF-8 JSON workspace;
6. raw evidence file segments in manifest-key order.

The manifest records the workspace byte length and digest. Each evidence entry
records its goal and evidence identifiers, portable key, file name, MIME type,
byte length, availability, and digest. Account identifiers and private Storage
paths are not written to the archive.

The archive is checksummed, not authenticated or encrypted. Its hashes detect
accidental corruption and changes that do not also rewrite the manifest; they
are not a digital signature and cannot prove who created the file. The archive
contains readable private workspace content and evidence bytes, so the
downloaded file must remain in owner-controlled storage and must not be
attached to support messages or placed in a public repository.

Import validation checks the header, version, manifest digest, canonical
encoding, declared total length, workspace digest and schema, evidence
references and metadata, and every included file digest. It rejects future
versions, duplicate references, undeclared bytes, truncation, metadata drift,
and checksum drift before producing restore data. A valid checksum does not
make an untrusted archive safe or authentic; strict schema and path validation
still run before any restore plan is produced.

## Incomplete archives

`createPortableWorkspaceArchive` reports three evidence sets:

- included files;
- referenced files whose device bytes were unavailable;
- orphaned device records that are not referenced by the workspace.

Missing bytes remain explicit as `missing` entries in the checksummed manifest.
Every entry described as included is backed by the exact bytes carried in the
archive and covered by its recorded length and digest. The resulting artifact
can be retained for diagnosis, but `requireValidPortableWorkspaceArchive`
refuses it for restore. The product must not describe an incomplete artifact as
a successful full backup.

For a signed-in workspace, a file may exist only in private cloud Storage.
The integration should download that file under the exact authenticated account
and workspace fence, validate it against the workspace metadata, and include it
in the source evidence records before archive creation.

## Restore choices

`preparePortableWorkspaceArchiveImport` is side-effect free and returns both
choices so the UI can ask explicitly:

- **Replace** discards the current workspace and replaces its referenced device
  evidence. It requires destructive confirmation.
- **Merge** preserves the current workspace and evidence, deterministically
  remaps imported identifiers, and provides each evidence byte with its exact
  target goal and evidence identifiers.

Both choices are deliberate restore boundaries and are not added to recent
undo history. The preview states that neither merge nor replace can be undone
with the ordinary undo action.

The plan contains the resulting state, evidence write list, byte/file totals,
policies, and merge remap. Creating a plan never writes IndexedDB, cloud
Storage, or a cloud snapshot.

## Provider integration

The Settings interface exposes the complete archive separately from the
records-only JSON export. Creation captures the active account, persistence
generation, workspace scope, and local change version, drains the device write
queue, and enumerates that account's IndexedDB evidence. Device bytes are used
first. A referenced file with no device bytes is downloaded only when its
private path belongs to the exact authenticated account, and the account and
workspace fences are checked before and after every awaited boundary. File
size and MIME metadata are validated before the archive is checksummed.

If any referenced bytes remain unavailable, creation fails visibly and no
artifact is reported as a complete download. Orphaned device records are not
silently included.

Import first performs a side-effect-free inspection and shows the archive
timestamp, evidence totals, and explicit **Merge** versus destructive
**Replace** choices. Inspection and application are blocked while a cloud
revision conflict, sync conflict, or pending/rendered account-handoff decision
leaves the source of truth unresolved. Export remains available so a user can
retain the in-memory state before resolving that conflict. The preview is also
invalidated by any intervening workspace edit or scope change.

Applying a choice drains the same account write queue and rejects ambiguous
merge collisions. The resulting workspace envelope, every imported evidence
blob, and—during replace—deletion of superseded account-scoped device evidence
are committed in one IndexedDB `readwrite` transaction across the workspace,
evidence, and account-scope stores. The transaction checks the captured
persistence generation and exact local revision before writing, enumerates
live evidence inside that transaction, and advances the workspace CAS even for
an otherwise identical replacement. A stale tab therefore cannot add an
unreferenced live row after the sweep with the old revision. An abort
exposes none of the proposed metadata, imported bytes, or cleanup; no later
best-effort compensation is used to repair a partially published restore.

Both merge and replace start with empty recent undo history and are reported as
non-undoable. For a signed-in replace, Evolvra records exact cleanup intents for
superseded device writes and account-owned private object paths before the
replacement transaction. Device cleanup is part of the exact local replacement
boundary. Remote deletion remains deferred until ordinary revision-based cloud
sync proves the replacement metadata is authoritative. The database then
atomically claims only path batches absent from that authoritative snapshot;
each permanent claim blocks later snapshot and Storage resurrection before
deletion begins. A failed, interrupted, or ambiguous claim/removal retains the
cleanup journal for retry and never deletes cloud bytes based only on the
proposed import.

## Backup-bound destructive-action receipts

Anonymous archive-and-reset creates a one-use receipt only after a complete
archive has been downloaded. The receipt records the account scope,
persistence generation, workspace boundary, local-change version, and exact
persisted local revision represented by that download. Reset consumes the
receipt and, inside the destructive IndexedDB transaction, compares that exact
revision again before rotating the generation and deleting local workspace and
evidence records. A save from this or another tab after download makes the
receipt stale: reset is refused and a fresh backup is required. A receipt is
therefore evidence for one exact downloaded revision, not general permission to
delete whatever data exists later.

For a connected account, **Erase everything** opens this archive flow rather
than offering an unbacked destructive confirmation. Account-erasure archive
creation additionally requires settled private sync and reads the exact cloud
workspace revision plus the account lifecycle's monotonic evidence revision
before and after assembling the artifact. It also re-lists private evidence
paths, so a concurrent upload, rename, move, or deletion cannot be hidden by an
unchanged workspace document. The one-use receipt carries those cloud
coordinates beside the existing exact-account and local-revision boundary; the
archive itself still contains no account identifier or private Storage path.

At confirmation, migration
`202608020011_account_erasure_backup_boundary.sql` compares the backed cloud
workspace/evidence revisions under the account-lifecycle lock before moving an
active account to `deleting`. A second-device mutation after download returns a
stale-backup conflict before cloud cleanup. The client verifies that the server
lifecycle remains active, cancels the unstarted local tombstone/checkpoint,
closes the confirmation, and requires a fresh complete backup. The newer cloud
snapshot and evidence remain intact. The former one-argument deletion RPC is
resume-only during rollout, so a retired client cannot initiate deletion of an
active account without this boundary.

No credentials or account identifier enter the archive, and the provider's
workspace, persistence-generation, exact-revision, write-queue, source-of-truth
conflict, account-handoff, and terminal-erasure barriers remain authoritative.

The device evidence store opens at IndexedDB version 4. That version is a
rolling-client compatibility fence for token-staged, identity-owned evidence:
it closes an already-open v3 connection and prevents a retired v3 bundle from
reopening the database. The upgrade preserves existing live evidence, assigns
missing `writeId` values, and creates the staging store needed for atomic
workspace/evidence promotion, so archive export never enumerates pending rows.

## Focused verification

```sh
npx vitest run lib/portable-workspace-archive.test.ts
npx vitest run lib/provider-portable-archive.test.ts
npx playwright test e2e/portable-archive.spec.ts --project=chromium
npx playwright test e2e/persistence-version-fence.spec.ts --project=chromium
npx eslint lib/portable-workspace-archive.ts lib/provider-portable-archive.ts
npm run typecheck
```

The connected-account boundary additionally requires Docker and the disposable
local Supabase migration/RLS/cloud-browser gate in `.github/workflows/ci.yml`,
including `npm run test:e2e:cloud`. Migration `.011` requires explicit
deployment-owner approval after that evidence and the linked dry-run are
reviewed. The current production application followed that procedure on
11 August and is aligned through `.011`.

# Recovery and data ownership

## Normal recovery

1. Reload the application. The latest valid account-scoped IndexedDB envelope and undo history are restored automatically. If the current snapshot is damaged, Evolvra recovers the newest usable undo snapshot and shows a durable notice.
2. If another open tab saved the same device workspace first, Evolvra blocks both device and cloud autosaves in the stale tab. Download its privacy-sanitised in-memory records if needed, then reload to open the latest IndexedDB copy.
3. If private sync is connected, use **Customise → Sync & privacy → Retry sync**.
4. If a cloud revision conflict appears, compare the timestamps and explicitly keep the device or cloud copy.
5. Use **Customise → Your data → Complete portable backup** before risky changes. The checksummed `.evolvra` file includes workspace records and byte-backed evidence for every referenced file available on the device or at the exact account's verified private cloud path. If a file is unavailable, Evolvra refuses to call the result a complete backup.
6. Resolve any cloud revision/sync conflict or pending account-handoff choice before restore. Evolvra disables inspection and application while the source of truth is ambiguous, although export remains available. Then use **Restore complete portable backup**. Evolvra validates the whole file before offering an explicit merge or destructive replace choice. Both choices clear recent undo history and cannot be undone with ordinary undo. Workspace metadata, imported evidence bytes, and replace cleanup of superseded device evidence commit together in one IndexedDB transaction or not at all.
7. **Records-only JSON backup** remains available for lightweight record export. **Restore records-only JSON** is size-bounded and strictly validated, but evidence bytes are not included and files must be reattached.

The one-time v1 browser migration uses a durable import journal. Old localStorage bytes are captured before asynchronous work begins and remain recoverable until their canonical state and evidence references are committed to IndexedDB. A crash or second tab resumes the same captured bytes; it cannot claim a different copy or resurrect data after an explicit discard.

IndexedDB version 4 is a compatibility fence rather than a destructive data
migration. It closes an already-open v3 connection through `versionchange` and
prevents an old v3 bundle from reopening the newer database. Existing live
evidence bytes remain readable; the upgrade assigns missing live `writeId`
values and creates a separate token-keyed staging store without moving or
deleting live bytes. If an old tab reports a persistence
version or blocked-open error during rollout, close or reload that tab into the
current build; do not clear site data as a first response.

## Evidence recovery

Signed-in files can be downloaded from their private cloud copy when the local
blob is missing. Complete portable backup uses that fallback only after
verifying the exact authenticated account and path, and validates downloaded
bytes against their recorded type and size. Device-only evidence must still be
present on the exporting device. Records-only JSON contains evidence metadata
and notes, not file bytes.

Intentional file and goal deletion writes a durable cleanup journal before
metadata can lose its final reference. After a reload, Evolvra compares that
journal with the persisted current/undo workspace and exact live `writeId`;
reintroduced metadata cancels cleanup, and a newer same-key write always
survives. Signed-in remote cleanup then asks the database to atomically claim
the exact immutable path batch. The claim succeeds only when the lifecycle is
active and the authoritative cloud workspace references none of those paths;
it permanently blocks later metadata or Storage resurrection. A definitive
`referenced` response restores foreground deletion metadata. Once a claim may
have committed, Evolvra never restores that path: deletion metadata and the
journal remain durable while Storage removal is retried. A cloud metadata save
whose response is lost is likewise verified by an authoritative read; if exact
commit status cannot be proven, the locally committed metadata and bytes remain
referenced and unsynced while reconciliation is forced.

Portable replace updates workspace metadata and device evidence atomically and
records exact cleanup intents for superseded account-owned object paths before
that local commit. The replacement transaction enumerates live device evidence
itself and advances the workspace CAS even when the requested metadata is
otherwise identical, closing the late-writer gap. It never deletes remote bytes
until revision-based sync proves the replacement metadata is authoritative and
the database has claimed the now-unreferenced paths. A crash before the
replacement commit leaves the old references in place and cancels cleanup; a
crash after commit leaves the intent durable for retry. The deployment owner
separately backs up and verifies private Storage bytes with
[the evidence Storage procedure](./EVIDENCE_STORAGE_BACKUP.md); a PostgreSQL
dump alone is not evidence-file protection.

## Backup-bound destructive actions

Anonymous archive-and-reset issues a one-use receipt for the exact persisted
local revision captured by the downloaded complete archive. The destructive
transaction checks that revision again before rotating the account generation
and deleting local workspace and evidence records. If this or another tab saves
after the download, the receipt is stale: reset is refused and the user must
make a fresh complete backup. Confirming that a file was downloaded does not
authorise deletion of a later revision.

A connected account must also download a complete backup before a new erasure
can begin. Creation is allowed only when private sync has one settled source of
truth. The receipt binds the exact account and local revision to the cloud
workspace revision and a monotonic private-evidence revision read before and
after the archive bytes are assembled. At confirmation, the database compares
both cloud coordinates while holding the account-lifecycle lock. A workspace
save, evidence upload, rename, move, or deletion on another device after the
download makes the backup stale. The server keeps the lifecycle `active`, no
cloud bytes are removed, and the client cancels its unstarted local
tombstone/checkpoint after verifying that active state. Download a fresh
complete backup from the reconciled workspace before trying again.

## Corruption or quota errors

The interface keeps the last usable workspace open and displays a durable persistence warning. Damaged current data is never silently replaced with an empty snapshot: the newest valid history state is recovered when possible. If no valid history remains, a recovery interstitial appears before onboarding and keeps the raw account-scoped record write-protected. Download that damaged JSON for inspection, restore a valid backup, or explicitly erase only that device copy. Ordinary onboarding edits cannot dismiss the quarantine. Invalid, oversized, deeply nested, or future-version imports never replace the current state.

## Recovery-dialog ownership

Bootstrap recovery, quarantine, and terminal account-erasure recovery share the
same full-screen alert/status boundary. They have explicit priority—bootstrap,
then quarantine, then terminal—and only the highest attached blocker owns
focus containment, initial focus, background `inert`/`aria-hidden`, Escape
safety, and scroll locking. Ordinary modals use the same reference-counted
overlay lease and back off while recovery owns the screen. Baseline background
attributes, body overflow, and focus are restored only after the final owner
releases its lease, so closing an ordinary modal cannot accidentally expose or
release an active recovery blocker.

## Archive versus permanent deletion

Archive keeps the goal, evidence references, and permanent activity history available for later restoration. **Permanently delete** is an explicit privacy/data-management operation that removes the goal, its evidence, completions, measurements, and connected timeline entries. Use archive unless a destructive purge is intended.

## Erasure

For a connected account, **Erase everything** first requires the one-use receipt
from **Download full backup, then review erasure**. The client atomically
installs an account-generation tombstone and durable deletion checkpoint for
the exact local revision, then presents the captured cloud workspace/evidence
boundary to the database. Migration
`202608020011_account_erasure_backup_boundary.sql` compares that boundary under
the account-lifecycle lock before changing the server lifecycle to `deleting`.
If it is stale, the database changes nothing and the client removes the
unstarted local fence as described above. Once accepted, the local and server
lifecycle fences wait for in-flight writes and block every new workspace or
Storage write from stale tabs while reads and supported deletes remain
available. The app then lists and removes every account evidence object through
the Supabase Storage API, verifies the prefix is empty, and invokes the
authenticated final account-deletion function to cascade cloud workspace
records and the auth account. The final function refuses to proceed if the
deletion fence was skipped or Storage metadata remains; it never deletes
Storage rows directly.

Final cloud deletion has exclusive, leased ownership. A lost or indeterminate final response is recorded as **ambiguous**, never silently retried. Device cleanup can finish without touching another signed-in account, but another cloud attempt requires the exact fenced account to authenticate successfully—proof that it still exists—and an explicit confirmation. Local workspace/evidence deletion is generation-checked and idempotent, and completed checkpoints remain as readable proof beside the permanent tombstone. The interface identifies every partial failure and keeps recovery retryable.

If retired v1 deletion bookkeeping is damaged, startup stays closed. Explicit repair first makes the old shared workspace permanently non-importable, removes its shared workspace/reminder bytes, and only then removes the unreadable marker. If any step fails, the marker remains blocking. An impossible tombstone on the reserved anonymous scope is never automatically unfenced or erased; it remains blocked for support-led recovery.

## Rehearsal schedule

The full GitHub CI workflow is configured to run every Sunday against a fresh
disposable Docker-backed local Supabase stack. It reapplies the fresh and
populated-legacy migration paths, executes the two-user RLS suite, and
rehearses account handoff, revision conflict, offline reconnect, private
evidence lifecycle, backup-first erasure, and cross-device stale-backup refusal
through the cloud browser gate. Migration `.011` passed the local gate and
received explicit deployment-owner approval before production application on
11 August; future projects or additive migrations require the same evidence.
A failed scheduled run is an operational incident even when no code changed.
That automation is implemented assurance; it does not establish
that the current frozen release SHA or a manual device drill has passed.

At least quarterly, the rollback owner also performs the Storage restore drill
in `EVIDENCE_STORAGE_BACKUP.md`, restores both a complete `.evolvra` archive
and a records-only JSON backup into a disposable browser/profile, exercises
merge, destructive replace, conflict recovery, and account erasure, records
recovery time, and confirms that replacement cleanup waits for authoritative
cloud metadata before removing superseded private objects.
Automated disposable tests are frequent assurance; they do not replace a
retained-backup restore. As of the 2 August 2026 audit, the first Storage-byte
restore drill is still unrecorded because the previous backup contained no
Storage objects, and the real-browser archive rehearsal and manual
assistive-technology/device walkthroughs are also unrecorded.

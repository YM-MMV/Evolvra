# Recovery and data ownership

## Normal recovery

1. Reload the application. The latest valid account-scoped IndexedDB envelope and undo history are restored automatically. If the current snapshot is damaged, Evolvra recovers the newest usable undo snapshot and shows a durable notice.
2. If another open tab saved the same device workspace first, Evolvra blocks both device and cloud autosaves in the stale tab. Download its privacy-sanitised in-memory records if needed, then reload to open the latest IndexedDB copy.
3. If private sync is connected, use **Customise → Sync & privacy → Retry sync**.
4. If a cloud revision conflict appears, compare the timestamps and explicitly keep the device or cloud copy.
5. Use **Customise → Your data → Workspace JSON backup** before risky changes.
6. Restore a JSON backup with **Restore workspace records**. Imports are size-bounded, strictly validated, and can be undone during the current recovery history.

The one-time v1 browser migration uses a durable import journal. Old localStorage bytes are captured before asynchronous work begins and remain recoverable until their canonical state and evidence references are committed to IndexedDB. A crash or second tab resumes the same captured bytes; it cannot claim a different copy or resurrect data after an explicit discard.

## Evidence recovery

Signed-in files can be downloaded from their private cloud copy when the local blob is missing. A device-only file is labelled as such and must be opened from the device where it was added before its cloud upload can be retried. JSON backups contain evidence metadata and notes, not device-only file bytes; copy those files separately or upload a private cloud copy before moving devices.

## Corruption or quota errors

The interface keeps the last usable workspace open and displays a durable persistence warning. Damaged current data is never silently replaced with an empty snapshot: the newest valid history state is recovered when possible. If no valid history remains, a recovery interstitial appears before onboarding and keeps the raw account-scoped record write-protected. Download that damaged JSON for inspection, restore a valid backup, or explicitly erase only that device copy. Ordinary onboarding edits cannot dismiss the quarantine. Invalid, oversized, deeply nested, or future-version imports never replace the current state.

## Archive versus permanent deletion

Archive keeps the goal, evidence references, and permanent activity history available for later restoration. **Permanently delete** is an explicit privacy/data-management operation that removes the goal, its evidence, completions, measurements, and connected timeline entries. Use archive unless a destructive purge is intended.

## Erasure

“Erase everything” first atomically installs a permanent account-generation tombstone and durable deletion checkpoint. That lifecycle fence waits for in-flight evidence writes and blocks every new workspace or Storage write from every stale tab while reads and deletes remain available. The app then lists and removes every account evidence object through the Supabase Storage API, verifies the prefix is empty, and invokes the authenticated final account-deletion function to cascade cloud workspace records and the auth account. The final function refuses to proceed if the deletion fence was skipped or Storage metadata remains; it never deletes Storage rows directly.

Final cloud deletion has exclusive, leased ownership. A lost or indeterminate final response is recorded as **ambiguous**, never silently retried. Device cleanup can finish without touching another signed-in account, but another cloud attempt requires the exact fenced account to authenticate successfully—proof that it still exists—and an explicit confirmation. Local workspace/evidence deletion is generation-checked and idempotent, and completed checkpoints remain as readable proof beside the permanent tombstone. The interface identifies every partial failure and keeps recovery retryable.

If retired v1 deletion bookkeeping is damaged, startup stays closed. Explicit repair first makes the old shared workspace permanently non-importable, removes its shared workspace/reminder bytes, and only then removes the unreadable marker. If any step fails, the marker remains blocking. An impossible tombstone on the reserved anonymous scope is never automatically unfenced or erased; it remains blocked for support-led recovery.

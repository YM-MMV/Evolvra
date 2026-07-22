# Architecture

Evolvra is a Next.js App Router client application with a local-first workspace document.

## Data boundaries

- `AppState` v3 is the versioned domain document. User-selected imports pass strict validation; stored legacy data passes a tolerant migration before rendering. Shared byte, depth, node, string, and collection limits apply at every persistence/import boundary.
- IndexedDB stores one workspace envelope per anonymous or authenticated account, byte-bounded recent undo snapshots, and evidence blobs in a separate object store. Every account scope has a monotonically increasing generation; reads and writes validate that generation atomically. Reset rotates it, while account deletion installs a permanent tombstone that stale tabs cannot bypass.
- Durable account-erasure checkpoints, reminder metadata, and the one-time v1 import journal live beside those scopes. The import journal captures old localStorage bytes before migration and retains them until a canonical IndexedDB envelope is committed. Damaged legacy-erasure repair disables re-import and removes shared bytes before it can discard the blocking marker.
- The optional Supabase `workspace_snapshots` row is the authoritative cloud copy. Compare-and-swap revisions prevent silent last-write-wins corruption.
- Private evidence uses Supabase Storage when signed in; workspace state contains typed metadata and references, not file bodies. Metadata is durably removed or moved before old bytes are deleted, with exact-byte compensation if cleanup fails. This ordering favours a recoverable orphan over a metadata record that points to missing bytes.
- Immutable `QuestCompletion`, `MetricEntry`, milestone, and check-in attribution snapshots retain their original goal, life-area, and quality context. Source completion IDs join action-generated measurement entries without timestamp heuristics. Reviews and timeline records support reconstruction of activity. "Immutable" means ordinary edits and recurrence cannot rewrite an occurrence; the explicitly destructive **Permanently delete** and **Erase everything** flows can still purge records by design. Archive is the non-destructive way to remove an item from active work.

## Sync lifecycle

Authentication changes first persist the outgoing account, clear in-memory history, and load the incoming account scope. A meaningful anonymous workspace always requires an explicit account, device, or lossless-merge choice; one authenticated account never seeds another. Merge keeps account identity/preferences authoritative, remaps every anonymous entity/reference, and preserves the anonymous original. Cloud and Storage writes remain blocked during handoff and begin only after reconciliation. Divergent dirty revisions require an explicit device/cloud choice and are never auto-merged.

Sync reports connecting, offline, device-saved/unsynced, saving, conflict, error, and synced states explicitly. Domain commands, persistence, authentication decisions, reconciliation, evidence compensation, recovery, and state transitions are isolated in dedicated modules; the provider is the coordination boundary. Forms commit logical changes on blur or submit, so a bounded undo snapshot is created once per operation rather than once per keystroke.

## Offline model

The service worker caches a bounded application shell, safe static assets, and visited goal routes. Authentication, API, callback, storage, evidence, unsafe responses, and sensitive query strings are excluded. Static responses must be successful, same-origin, non-redirected, and have the expected content type; missing assets never receive HTML. Update activation is tied to the service-worker event lifetime. Workspace mutations remain in IndexedDB and sync later.

## Privacy

The application is marked `noindex`. Operational telemetry is off by default during beta and does no network work unless `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED=true`. When deliberately enabled, the client samples 10% of allowlisted Web Vitals and reports allowlisted client-error name/digest fields. The `/api/telemetry` endpoint requires same-origin browser provenance, stops reading after 2 KiB, and accepts at most 120 requests per minute in each server process without retaining an IP address, cookie, account, or other limiter identifier. URLs, account identifiers, error messages, stack traces, and workspace values are rejected at the shared runtime boundary. Local reminders disclose only the number of ready actions. No AI integration or third-party activity analytics are enabled.

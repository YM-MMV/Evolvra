# Architecture

Evolvra is a Next.js App Router client application with a local-first workspace document.

## Data boundaries

- `AppState` v3 is the versioned domain document. User-selected imports pass strict validation; stored legacy data passes a tolerant migration before rendering. Shared byte, depth, node, string, and collection limits apply at every persistence/import boundary.
- Every newly created identifier is UUID-compatible. Tolerant v1/v2 migration preserves stable legacy identifiers so references and recovery evidence are never silently rewritten; universal UUID remapping is required only before any future normalised-table migration, not while the JSON workspace remains authoritative.
- IndexedDB stores one workspace envelope per anonymous or authenticated account, byte-bounded recent undo snapshots, and live evidence bytes in a separate object store. Evidence prepared by import, bootstrap, handoff, or cloud migration first enters a token-keyed `evidence-staging` store that live readers and backups never enumerate. The workspace CAS promotes exact staging tokens and metadata in one transaction; rollback can delete only its staging tokens. The same non-live store holds typed deletion intents written before metadata drops a file reference, so crash recovery can remove only the exact prior live write and retain remote-path provenance until Storage confirms deletion. Every new live write receives an opaque `writeId`, and compare-delete requires that identity plus the exact committed workspace revision. Each account scope carries a monotonic `evidenceRevision`, so backup/reset and delete/restore receipts cannot suffer an ABA race. IndexedDB schema version 4 is a rolling-client fence: opening it sends `versionchange` to an already-open v3 client and a retired v3 bundle cannot reopen the newer database. The v4 upgrade preserves v3 evidence bytes, assigns missing live write identities inside the upgrade transaction, and creates the separate staging store.
- Portable restore uses one IndexedDB `readwrite` transaction across the workspace, live evidence, staging, and account-scope stores. It validates the captured generation and exact local revision, then atomically writes the resulting workspace, promotes prepared evidence tokens, and removes every account-scoped device evidence row no longer referenced by the replacement current state or history. Even an otherwise identical replacement advances the workspace CAS revision, so a late stale-tab evidence write cannot land after the sweep. An abort exposes none of those changes. Both merge and replace deliberately begin with empty recent undo history.
- Anonymous archive-and-reset is authorised by a one-use receipt bound to the exact persisted revision represented by the downloaded complete archive. The deletion transaction compares that revision again before rotating the generation; any intervening save makes the receipt stale and requires a fresh backup. Connected-account erasure extends that boundary across the exact local revision, cloud workspace revision, and monotonic private-evidence revision captured while sync is settled. The database compares the cloud coordinates under the account-lifecycle lock before entering `deleting`; a newer save or Storage mutation on another device returns a stale-backup conflict instead of deleting newer data. After the server proves the lifecycle is still active, the client removes its unstarted local fence/checkpoint and requires a fresh complete backup.
- Durable account-erasure checkpoints, reminder metadata, and the one-time v1 import journal live beside those scopes. The import journal captures old localStorage bytes before migration and retains them until a canonical IndexedDB envelope is committed. Damaged legacy-erasure repair disables re-import and removes shared bytes before it can discard the blocking marker.
- The optional Supabase `workspace_snapshots` row is the authoritative cloud copy. Compare-and-swap revisions prevent silent last-write-wins corruption, and the save RPC compares the caller with the exact account that owned the queued state so an asynchronous token handoff cannot redirect that state into another account.
- The normalised domain tables in the migration baseline are not dual-written by the application and are not an alternate source of truth. They remain reserved for a separately designed future integration or server-side analytics migration; contributors must not read them as current workspace state.
- Private evidence uses Supabase Storage when signed in; workspace state contains typed metadata and references, not file bodies. New objects use immutable, claimable four-segment paths. Metadata is durably removed before old bytes are deleted, and a durable cleanup intent survives crashes between those phases. Before an active account can delete a path, the database locks the account lifecycle, proves the complete path batch is absent from the authoritative workspace, and writes permanent cleanup claims. Claims fence later snapshot references and Storage writes to those paths. A definitive `referenced` result permits metadata compensation; after a claim or ambiguous claim response, deletion metadata remains authoritative and the journal retries cleanup without recreating bytes. Local recovery additionally checks current and undo metadata plus the exact live `writeId`. Lost cloud-save or Storage responses retain the local commit or cleanup journal as explicitly unresolved instead of guessing.
- Immutable `QuestCompletion`, `MetricEntry`, milestone, and check-in attribution snapshots retain their original goal, life-area, and quality context. Source completion IDs join action-generated measurement entries without timestamp heuristics. Reviews and timeline records support reconstruction of activity. "Immutable" means ordinary edits and recurrence cannot rewrite an occurrence; the explicitly destructive **Permanently delete** and **Erase everything** flows can still purge records by design. Archive is the non-destructive way to remove an item from active work.

## Sync lifecycle

Authentication changes first persist the outgoing account, clear in-memory history, and load the incoming account scope. A meaningful anonymous workspace always requires an explicit account, device, or lossless-merge choice; one authenticated account never seeds another. Merge keeps account identity/preferences authoritative, remaps every anonymous entity/reference, and preserves the anonymous original. Cloud and Storage writes remain blocked during handoff and begin only after reconciliation. Divergent dirty revisions require an explicit device/cloud choice and are never auto-merged. Portable restore inspection and application are also blocked during a cloud/sync conflict or pending/rendered handoff because none of those states has one settled source of truth; export remains available.

Sync reports connecting, offline, device-saving/unsynced, cloud-saving, conflict, error, and synced states explicitly. Domain command bindings, authentication, goal-evidence compensation, local bootstrap/recovery, status selectors, and copy-on-write state transactions have dedicated modules and narrow ports. The provider remains the coordination boundary and still owns the larger reconciliation, cloud-save, handoff, import/reset, and terminal-erasure lifecycles; those are the next extraction seams. Every product consumer subscribes only to the workspace, provider-status, and/or action context it needs. The action context keeps stable command references while forwarding to the latest committed implementation, and `check:contexts` prevents the composed compatibility hook from returning to consumers.

Routine commands use lazy copy-on-write structural sharing, incremental current-v3 coherence validation, and cached exact JSON profiles. They retain untouched branches by identity, detach caller-owned inputs, reject dangling goal/metric references, and create one pre-command undo snapshot per logical operation. Untrusted import, cloud, and persistence boundaries still run complete validation. Forms commit logical changes on blur or submit rather than creating an undo entry for every keystroke.

## Modal and recovery ownership

Ordinary modals and full-screen recovery blockers acquire the same
reference-counted overlay lease. Bootstrap recovery, quarantine, and terminal
account-erasure recovery have ascending priorities; only the highest attached
blocker owns initial focus, focus containment, background
`inert`/`aria-hidden`, Escape handling, and body scroll lock. Lower-priority
blockers stay attached but hidden/inert, and an ordinary modal backs off while
recovery owns the boundary. Exact baseline attributes, overflow, and focus are
restored only after the final owner releases its lease.

Unit and browser tests exercise simultaneous blockers, modal cleanup, keyboard
containment, background isolation, and focus restoration. That automation is
implemented assurance, not a substitute for the manual VoiceOver/NVDA and
real-device walkthroughs that remained unrecorded at the 2 August 2026 audit.

## Offline model

The service worker caches a bounded application shell and proactively prepares exact routes for goals in each live tab's current workspace. Per-client manifests form one bounded origin-wide union, so switching or clearing one tab cannot erase another tab's offline routes. A data-free persisted union carries verified routes across worker activation; each goal document is published only after all discovered versioned build dependencies are pinned in a separate non-evicting build cache. The client consumes an explicit preparation acknowledgement, reports partial coverage honestly, and retries after reconnect or controller change. A user-approved update persists a cutover marker before `skipWaiting`; activation claims and navigates every same-origin window to the compatible bundle, even if the worker process restarted between those events. Authentication, API, callback, storage, evidence, unsafe responses, arbitrary goal visits, and sensitive query strings are excluded. Static responses must be successful, same-origin, non-redirected, and have the expected content type; missing assets never receive HTML. Workspace mutations remain in IndexedDB and sync later.

## Privacy

The application is marked `noindex`. Operational telemetry is off by default during beta and does no network work unless `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED=true`; production currently retains that disabled state, so production observability is still a deliberate maintainability/operations decision rather than completed telemetry coverage. When deliberately enabled, the client samples 10% of allowlisted Web Vitals and reports allowlisted client-error name/digest fields. The `/api/telemetry` endpoint requires same-origin browser provenance, stops reading after 2 KiB, and accepts at most 120 requests per minute in each server process without retaining an IP address, cookie, account, or other limiter identifier. URLs, account identifiers, error messages, stack traces, and workspace values are rejected at the shared runtime boundary. Local reminders disclose only the number of ready actions. No AI integration or third-party activity analytics are enabled.

## Content Security Policy

Production denies framing and objects, restricts connections to the application
and configured Supabase origin, upgrades insecure requests, and ships the
remaining security headers from `next.config.ts`. The current Next.js
server-rendered shell still requires generated inline bootstrap scripts and
inline styles, so `script-src` and `style-src` retain `unsafe-inline`.
Removing those allowances requires a separately tested nonce or build-hash
pipeline across HTML, streaming, service-worker updates, Preview, and
production. It must not be "fixed" by adding broader wildcard sources or by
silently breaking hydration. `frame-ancestors 'none'`, `object-src 'none'`,
same-origin defaults, no indexing, strict request admission, and automated
production header synthetics remain the compensating controls until that
pipeline is proven.

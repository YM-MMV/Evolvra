# Evolvra (beta)

Evolvra is a private, local-first personal command centre for meaningful goals, real-world progress, focused actions, milestones, custom life areas, personal qualities, and non-judgemental reviews.

The application keeps progress grounded in the outcome itself:

- Numeric, weighted-milestone, consistency, and reflective models cover different kinds of meaningful change.
- Quests identify useful next actions, while the timeline preserves what happened and what was learned.

AI integration is intentionally not included in this release.

Live application: [evolvra-seven.vercel.app](https://evolvra-seven.vercel.app)

Source repository: [github.com/YM-MMV/Evolvra](https://github.com/YM-MMV/Evolvra)

## What is included

- Guided onboarding with suggested or clean starting states
- Custom life areas and personal qualities, including hide, archive, restore, and reordering workflows
- Four honest goal-progress models
- Connections between goals and the qualities they help develop
- One-off and repeating actions, including shared actions that support multiple goals, with per-completion duration, notes, evidence annotations, and exact metric updates
- Multiple reorderable weighted metrics per numeric goal, plus editable milestones, actions, and goal-quality connections with timestamped check-ins
- Customisable command-centre dashboard, yearly life map, recent momentum, and responsive mobile layout
- Daily, weekly, and monthly reflective reviews with traceable source records
- Permanent searchable, filterable, and paginated timeline
- Custom terminology, themes, and visual intensity
- complete checksummed `.evolvra` backup/restore with evidence bytes, distinct
  records-only JSON and timeline CSV exports, and workspace erase controls
- Last-valid-history recovery, corruption quarantine/export/restore/erase choices, crash-safe legacy migration, and explicit anonymous-to-account local/account/merge consent
- Safe PWA caching, offline fallbacks, install/update prompts, and production icons
- Optional in-browser daily reminders while an Evolvra tab or installed app window is open
- Optional Supabase passwordless authentication, revision-safe private snapshots, and private evidence files
- Normalised Postgres schema, private Postgres RLS policies, evidence-storage policies, and an account-deletion function

## Run locally

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No account or database is needed for local-first use.

## Enable private cross-device sync

1. Create a Supabase project.
2. Apply every file in [`supabase/migrations`](supabase/migrations) in timestamp order, or link the project and run `npx supabase@2.109.1 db push` with the release-pinned CLI.
3. Copy `.env.example` to `.env.local`.
4. Add the project URL and anonymous key from Supabase Project Settings → API.
5. Restart the app, open Customise → Sync & privacy, and request a magic sign-in link.

Only the public anonymous key belongs in the browser. Never add a service-role key to `NEXT_PUBLIC_*` variables.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run audit:dependencies
npm run check:gamification
npm run check:no-ai
npm run check:sql-fixtures
npm run check:sw
npm run build
npm run check:bundle
npx playwright install chromium firefox webkit # first browser-test run only
npm run test:e2e
```

`npm run check` runs the complete local release gate, including the production dependency audit and the production Playwright and accessibility checks after the build.

GitHub Actions also boots a pinned local Supabase stack, applies the immutable migration chain from both fresh and seeded legacy starting points, asserts legacy data preservation/backfills, and runs the two-account RLS/account-erasure regression.

## Deployment

The application can be deployed through Vercel. Configure the two public Supabase environment variables separately for each environment before enabling optional workspace sync. Privacy-safe operational telemetry is off by default during beta and is enabled only when `NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED=true`; see the bounded collection policy in [Architecture](docs/ARCHITECTURE.md). State v3 and the revision-safe database write path require a coordinated cutover; follow the [deployment and rollback runbook](docs/DEPLOYMENT.md) rather than promoting a new client and database independently. The service worker is registered only in production builds.

## Privacy model

- Without Supabase configuration, account-scoped state and undo recovery stay in IndexedDB on the current device.
- With Supabase configured and a user signed in, the application can store an atomic workspace snapshot in a protected per-user row.
- The migration also provides reserved normalised domain tables for a future, separately designed integration or server-side analytics migration. The application does not dual-write them; `workspace_snapshots` is the only authoritative cloud workspace.
- Postgres RLS restricts every application table and evidence object to `auth.uid()`.
- Workspace-record export and erase controls are available from the application itself. Device-only evidence file bodies are not embedded in the JSON export.

## Product rule

Evolvra does not label goals as failures, punish missed days, or make silent automated changes.

## Operational documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Recovery and data ownership](docs/RECOVERY.md)
- [Deployment and rollback](docs/DEPLOYMENT.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Release notes](docs/RELEASE_NOTES.md)
- [Project audit and next steps](docs/NEXT_STEPS.md)

# Evolvra

Evolvra is a private, local-first personal command centre for meaningful goals, real-world progress, quests, milestones, custom life areas, character stats, and non-judgemental reviews.

The application keeps progress grounded in the outcome itself:

- Numeric, weighted-milestone, consistency, and reflective models cover different kinds of meaningful change.
- Quests identify useful next actions, while the timeline preserves what happened and what was learned.

AI integration is intentionally not included in this release.

Live application: [evolvra-seven.vercel.app](https://evolvra-seven.vercel.app)

Source repository: [github.com/YM-MMV/Evolvra](https://github.com/YM-MMV/Evolvra)

## What is included

- Guided onboarding with suggested or clean starting states
- Custom life areas and character stats
- Four honest goal-progress models
- Connections between goals and the qualities they help develop
- One-off and repeating quests with optional metric updates
- Command-centre dashboard, yearly life map, weekly momentum, and responsive mobile layout
- Daily, weekly, and monthly reflective reviews
- Permanent searchable timeline
- Custom terminology, themes, and visual intensity
- JSON backup and restore, timeline CSV export, and workspace erase controls
- PWA manifest and production service-worker shell
- Optional Supabase passwordless authentication and private workspace snapshot storage
- Normalised Postgres schema, private Postgres RLS policies, evidence-storage policies, and an account-deletion function

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No account or database is needed for local-first use.

## Enable private cross-device sync

1. Create a Supabase project.
2. Apply every file in [`supabase/migrations`](supabase/migrations) in timestamp order, or link the Supabase CLI and run `supabase db push`.
3. Copy `.env.example` to `.env.local`.
4. Add the project URL and anonymous key from Supabase Project Settings → API.
5. Restart the app, open Customise → Sync & privacy, and request a magic sign-in link.

Only the public anonymous key belongs in the browser. Never add a service-role key to `NEXT_PUBLIC_*` variables.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Deployment

The application can be deployed through Vercel. Configure the two public Supabase environment variables separately for each environment before enabling optional workspace sync. The service worker is registered only in production builds.

## Privacy model

- Without Supabase configuration, state stays in the current browser's local storage.
- With Supabase configured and a user signed in, the application can store an atomic workspace snapshot in a protected per-user row.
- The migration also provides normalised domain tables for future integrations and server-side analytics.
- Postgres RLS restricts every application table and evidence object to `auth.uid()`.
- Export and erase controls are available from the application itself.

## Product rule

Evolvra does not label goals as failures, punish missed days, introduce competitive leaderboards, or make silent automated changes.

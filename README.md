# Evolvra

Evolvra is a private, local-first personal command centre for meaningful goals, real-world progress, quests, milestones, permanent XP, character stats, and non-judgemental reviews.

The application deliberately keeps goal progress separate from XP:

- Goal progress measures the real outcome through numeric, weighted-milestone, consistency, or reflective models.
- XP records effort and development. It is never removed because of a missed day, paused goal, or change of direction.

AI integration is intentionally not included in this release.

Live application: [evolvra-seven.vercel.app](https://evolvra-seven.vercel.app)

Source repository: [github.com/YM-MMV/Evolvra](https://github.com/YM-MMV/Evolvra)

## What is included

- Guided onboarding with suggested or clean starting states
- Custom life areas and character stats
- Four honest goal-progress models
- Weighted stat connections and transparent XP scoring
- One-off and repeating quests with optional metric updates
- Milestone, goal, overall, and per-stat level progression
- Command-centre dashboard, yearly life map, weekly momentum, and responsive mobile layout
- Daily, weekly, and monthly reflective reviews
- Permanent searchable timeline
- Custom terminology, themes, scoring rules, and visual intensity
- JSON backup/restore, CSV export, recent-edit recovery, and complete data deletion
- Installable PWA shell with offline local operation
- Optional Supabase passwordless auth and cross-device snapshot sync
- Normalised Postgres schema, Row Level Security, private evidence storage, and account-deletion function

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No account or database is needed for local-first use.

## Enable private cross-device sync

1. Create a Supabase project.
2. Run [`supabase/migrations/202607150001_initial_schema.sql`](supabase/migrations/202607150001_initial_schema.sql) in the Supabase SQL editor, or link the Supabase CLI and run `supabase db push`.
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

The production project is connected to the GitHub repository and deployed through Vercel. Pushes to the production branch trigger deployments automatically. The two public Supabase environment variables are configured for Production, Preview, and Development, and the PWA service worker is registered in production builds.

## Privacy model

- Without Supabase configuration, state stays in the current browser's local storage.
- With Supabase configured and a user signed in, an atomic workspace snapshot is synced for reliable local-first operation.
- The migration also provides normalised domain tables for future integrations and server-side analytics.
- Row Level Security restricts every application table and evidence object to `auth.uid()`.
- Export and erase controls are available from the application itself.

## Product rule

Evolvra does not contain failed goals, XP loss, streak punishment, competitive leaderboards, reward shops, or silent automated changes.

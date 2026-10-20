# Hourline

Task, time and pay tracking for remote teams paid by the hour. Workers estimate the hours a task needs, managers approve, workers track time against the approved limit, managers review deliverables and approve time separately, and approved hours turn into payment records.

**To deploy, follow [SETUP.md](SETUP.md).**

## Stack

- **Next.js 15** (App Router, React 19, TypeScript) — server-rendered pages; small client components for timers, dialogs and uploads.
- **Supabase** — Postgres, email sign-in, private file storage, `pg_cron`.
- **Vercel** — hosting (any Node host that runs Next.js works).

## Where the rules live

All business rules and permissions are in the database, in `supabase/migrations`:

| File | Contents |
|---|---|
| `…01_schema.sql` | Tables, constraints, row-level security (read access) |
| `…02_functions.sql` | Every write: timers, limits, estimates, approvals, corrections, comments, rates, payments, audit log |
| `…03_storage.sql` | Private `task-files` bucket and access rules |
| `…04_schedule.sql` | `pg_cron` job that stops timers at their hour limit every minute |

The browser can only **read** rows its user is allowed to see, and can only **change** data by calling the public functions in `…02_functions.sql`. Each function checks the caller's role and ownership, uses the database clock, and writes the audit log in the same transaction. Internal helpers (prefixed `_`) can't be called from the browser.

Key guarantees enforced by the database, not the UI:

- One running timer per worker (primary key on `timers.worker_id`).
- Time entries for a worker never overlap (exclusion constraint), and manual entries and corrections are checked too.
- Paid time can't exceed a task's approved hours; timers are capped at the limit.
- Logged time is never updated or deleted; corrections are new rows that replace the original only when approved.
- Each entry stores the rate in effect when the work happened.
- Work approval and time approval are separate.
- The activity log is append-only.
- Workers can't read other workers' tasks, entries, rates or payments.

## Project layout

```
app/
  (app)/            signed-in pages: dashboard, tasks, review, reports, team, timesheet, …
  api/              CSV export, private file links, invites (service key stays on the server)
  auth/             sign-in link handlers
  login/            sign-in page
components/         UI: dialogs, discussion, entry tables, task form, uploads
lib/                Supabase clients, formatting, periods, types
supabase/migrations database schema and rules
tests/db.test.mjs   50 checks of the database rules and permissions
```

## Local development

```bash
npm install
cp .env.example .env.local     # fill in your Supabase values
npm run dev                    # http://localhost:3000
```

Add `http://localhost:3000/**` to Supabase **Authentication → URL Configuration → Redirect URLs**.

## Tests

```bash
npm run test:db
```

Runs all migrations in an embedded Postgres (PGlite) with a stand-in for Supabase's auth schema, then exercises the rules as a manager and two workers: estimates, timers and limits, overlap prevention, corrections, extra hours, work review, questions, payments, rate changes, reassignment, deactivation, and that workers can't see or change each other's data.

`npm run typecheck` and `npm run build` check the app.

## Not included (by design or future work)

- No screenshot, keyboard or mouse monitoring.
- No payments are sent; Hourline records what's owed.
- Email for activity notifications is a future integration (sign-in and invite emails work today).

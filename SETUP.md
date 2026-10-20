# Setting up Hourline

This guide takes you from the code to a live app your team can sign in to. It takes about 30–45 minutes. You need two free-to-start accounts:

- **Supabase** (supabase.com) — the database, secure sign-in and private file storage.
- **Vercel** (vercel.com) — hosts the website.

For a business with 10–50 people, plan to move both to their paid plans: Supabase's free plan pauses inactive projects and has small limits, and Vercel's free plan is for non-commercial use. Check each site's pricing page for current prices.

If you have a developer, hand them this file and the code. Everything below is standard for both services.

---

## 1. Create the Supabase project

1. Sign in at supabase.com and click **New project**.
2. Pick a name (for example `hourline`), a strong database password (save it in your password manager), and the region closest to most of your team.
3. Wait for the project to finish setting up (1–2 minutes).

## 2. Create the database

1. In your Supabase project, open **SQL Editor** → **New query**.
2. Open the folder `supabase/migrations` in the code. Run the four files **in order**. For each one: copy the whole file, paste it into the editor, click **Run**, and check it says "Success".
   1. `20261019000001_schema.sql` — tables and access rules
   2. `20261019000002_functions.sql` — business rules (timers, limits, approvals, pay)
   3. `20261019000003_storage.sql` — private file storage
   4. `20261019000004_schedule.sql` — stops timers at their hour limit every minute
3. If step 4 says the `pg_cron` extension is missing: open **Database → Extensions**, turn on **pg_cron**, then run the file again.

Developers can instead run `supabase link` and `supabase db push` with the Supabase CLI.

## 3. Set your time zone

Hourline shows times and calculates days and pay periods in one organisation time zone. In the SQL Editor, run (change the zone to yours):

```sql
update app_settings set org_name = 'Your Company', timezone = 'Asia/Dubai';
```

You can change this later on the **Team & projects** page.

## 4. Configure sign-in

Hourline is invite-only and uses email sign-in links (no passwords to manage).

1. **Authentication → Sign In / Providers**: make sure **Email** is enabled. Turn **off** "Allow new users to sign up". Invites still work.
2. **Authentication → URL Configuration**:
   - **Site URL**: your app's address. Use the Vercel address from step 6 for now (for example `https://hourline-yourcompany.vercel.app`), and update it if you add your own domain later.
   - **Redirect URLs**: add `https://YOUR-APP-ADDRESS/**`
3. **Authentication → Email Templates**. Replace the link in two templates so sign-in works securely with this app:
   - **Invite user** — use this as the message body:
     ```html
     <h2>You've been invited to Hourline</h2>
     <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite">Accept the invite and sign in</a></p>
     ```
   - **Magic Link** — use this as the message body:
     ```html
     <h2>Sign in to Hourline</h2>
     <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a></p>
     ```
4. Recommended for a real team: **Authentication → Emails → SMTP Settings**. Connect your own email provider (for example Postmark, Resend, Amazon SES or Google Workspace SMTP). Supabase's built-in sender is rate-limited and meant for testing.

## 5. Copy your keys

In **Project Settings → API Keys** (or **API**), copy:

- **Project URL**
- **anon / publishable key** (safe to use in the browser)
- **service_role / secret key** (keep private; only the server uses it, to send invites)

## 6. Put the app online with Vercel

1. Put the code in a GitHub repository (your developer can do this, or ask Claude to help).
2. At vercel.com, click **Add New → Project**, import the repository and keep the detected **Next.js** settings.
3. Under **Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from step 5 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key |
   | `NEXT_PUBLIC_SITE_URL` | Your app address, for example `https://hourline-yourcompany.vercel.app` |

4. Click **Deploy**. When it finishes, open the address Vercel gives you.
5. If the address differs from what you entered in step 4, update **Site URL** and **Redirect URLs** in Supabase and `NEXT_PUBLIC_SITE_URL` in Vercel, then redeploy.

Optional: add your own domain (for example `hours.yourcompany.com`) in Vercel → **Settings → Domains**, then update the three places above.

## 7. Create the first manager (you)

1. In Supabase, open **Authentication → Users → Add user → Send invitation**, and enter your own email.
2. Open the email and click the link. You'll land in Hourline as the **manager**. The very first person always becomes the manager; everyone after that starts as a worker.

## 8. Add your team and first project

1. In Hourline, open **Team & projects**.
2. **Add project** for each area of work.
3. **Invite person** for each worker: name, email, hourly rate and payment currency. They get a sign-in email. You can invite other managers here too.
4. Create your first task from **Tasks → New task**. By default the worker is asked to estimate the hours, and you approve before work starts.

That's it. Workers sign in with the link in their email; next time they enter their email on the sign-in page and get a fresh link.

---

## How it works (for reference)

- **Estimates first.** New tasks wait for the worker's estimate. The hours you approve become the task's paid limit. The timer unlocks after approval.
- **Timers.** One timer per worker, enforced by the database across all devices and tabs. Times come from the server clock. At 80% of approved hours the worker and managers are notified; at 100% the timer stops itself (checked every minute, even if nobody has the app open). Recorded time is never lost.
- **Time approval is separate from work approval.** Approving a deliverable doesn't approve hours. Only approved hours count toward pay.
- **Corrections.** Logged time is never edited or deleted. Workers request corrections; the original stays in the history.
- **Rates.** Each time entry stores the rate in effect when the work happened, so changing a rate never changes past pay.
- **Payments.** Hourline creates payment records and lets you mark them paid. It never sends money.
- **Privacy.** Workers see only their own tasks, time, rate and pay. Files are private and opened with short-lived links. The activity log can't be edited or deleted.
- **No surveillance.** There are no screenshots, keyboard or mouse tracking.
- **Email.** Only sign-in and invite emails are sent. Other notifications are in-app.

## Backups and data

- Supabase paid plans include daily backups. Turn on **Point-in-time recovery** if losing a day of data would be costly.
- Export timesheets and payment records any time from **Reports & pay** (CSV).

## Troubleshooting

| Problem | Fix |
|---|---|
| Sign-in link says "invalid or expired" | Check the email templates in step 4 point to `/auth/confirm`, and that Site URL matches your app address. Links expire after one use. |
| Invites fail with "service role" error | `SUPABASE_SERVICE_ROLE_KEY` is missing in Vercel. Add it and redeploy. |
| Worker can't start a timer: "No hourly rate is set" | Set their rate on **Team & projects**. |
| Timers don't stop at the limit when the app is closed | `pg_cron` isn't enabled. See step 2.3. |
| Times look off by hours | Set your time zone (step 3 or **Team & projects → Settings**). |

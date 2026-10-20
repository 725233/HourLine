// Runs the database migrations in an embedded Postgres (PGlite) with a small
// stand-in for Supabase's auth schema, then exercises the business rules and
// permissions as different users. Run with: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite({ extensions: { btree_gist } });
const file = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
await db.exec(file('20261019000001_schema.sql'));
await db.exec(file('20261019000002_functions.sql'));

const M = '00000000-0000-0000-0000-00000000000a';
const W1 = '00000000-0000-0000-0000-0000000000b1';
const W2 = '00000000-0000-0000-0000-0000000000b2';
for (const [id, email, name] of [[M, 'maya@x.co', 'Maya'], [W1, 'dan@x.co', 'Daniel'], [W2, 'aisha@x.co', 'Aisha']]) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, jsonb_build_object('full_name', $3::text))`, [id, email, name]);
}

let passed = 0;
async function as(uid, sql, params = []) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
  try { return (await db.query(sql, params)).rows; }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function ok(name, fn) { await fn(); passed++; console.log('  ok  ', name); }
async function fails(name, re, fn) {
  try { await fn(); } catch (e) {
    assert.match(e.message, re, `${name}: unexpected error "${e.message}"`);
    passed++; console.log('  ok  ', name, '→', e.message.slice(0, 90)); return;
  }
  throw new Error(`${name}: expected an error matching ${re}`);
}
const one = async (uid, sql, p) => (await as(uid, sql, p))[0];
const su = async (sql, p = []) => (await db.query(sql, p)).rows;

console.log('Setup and roles');
await ok('first user is manager, others workers', async () => {
  const r = await su(`select email, role from profiles order by email`);
  assert.deepEqual(r.map((x) => x.role), ['worker', 'worker', 'manager']);
});
const project = (await one(M, `select create_project('Website rebuild', 'Website development') as id`)).id;
await fails('workers cannot create projects', /Only managers/, () => as(W1, `select create_project('x','y')`));
await fails('browser cannot write tables directly', /permission denied/, () => as(W1, `insert into projects (name) values ('x')`));
await fails('browser cannot call internal helpers', /permission denied/, () => as(W1, `select _stop_timer('${W2}', 'x', false, false, null)`));
await ok('manager sets rates', async () => {
  await as(M, `select set_rate($1, 28, 'usd', current_date)`, [W1]);
  await as(M, `select set_rate($1, 22, 'USD', current_date)`, [W2]);
});
await fails('rate cannot be backdated after the first one', /today or later/, () => as(M, `select set_rate($1, 30, 'USD', current_date - 1)`, [W1]));
await ok('workers only see their own rate', async () => {
  const r = await as(W2, `select worker_id from worker_rates`);
  assert.equal(r.length, 1); assert.equal(r[0].worker_id, W2);
});

console.log('Estimates');
const t1 = (await one(M, `select create_task($1, 'Pricing page', '', 'PR merged', array['Responsive', ' ', 'No errors'], $2, 'high', current_date + 5, true) as id`, [project, W1])).id;
await ok('task waits for estimate, criteria cleaned', async () => {
  const t = (await su(`select status, max_hours, criteria from tasks where id = $1`, [t1]))[0];
  assert.equal(t.status, 'needs_estimate'); assert.equal(Number(t.max_hours), 0); assert.deepEqual(t.criteria, ['Responsive', 'No errors']);
});
await fails('timer locked before estimate', /Submit your time estimate first/, () => as(W1, `select start_timer($1)`, [t1]));
await fails('other worker cannot see or estimate the task', /only do this on tasks assigned to you/, () => as(W2, `select submit_estimate($1, 3, 'breakdown here')`, [t1]));
await ok('other worker cannot read the task', async () => { assert.equal((await as(W2, `select id from tasks where id = $1`, [t1])).length, 0); });
await ok('worker submits estimate', () => as(W1, `select submit_estimate($1, 2, 'Layout 1h, toggle 1h')`, [t1]));
await fails('changing hours needs a note', /explaining why/, () => as(M, `select decide_estimate($1, true, 3, '')`, [t1]));
await fails('revision needs a note', /what to change/, () => as(M, `select decide_estimate($1, false, null, '')`, [t1]));
await ok('manager asks for revision, worker resubmits, manager approves with buffer', async () => {
  await as(M, `select decide_estimate($1, false, null, 'Include testing time')`, [t1]);
  assert.equal((await su(`select status from tasks where id=$1`, [t1]))[0].status, 'needs_estimate');
  await as(W1, `select submit_estimate($1, 2.5, 'Layout 1h, toggle 1h, testing 0.5h')`, [t1]);
  await as(M, `select decide_estimate($1, true, 3, 'Added 30 min buffer')`, [t1]);
  const t = (await su(`select status, est_hours, max_hours from tasks where id=$1`, [t1]))[0];
  assert.equal(t.status, 'todo'); assert.equal(Number(t.est_hours), 2.5); assert.equal(Number(t.max_hours), 3);
});

console.log('Timers');
await ok('worker starts timer; task moves to In Progress', async () => {
  await as(W1, `select start_timer($1)`, [t1]);
  assert.equal((await su(`select status from tasks where id=$1`, [t1]))[0].status, 'in_progress');
});
const t2 = (await one(M, `select create_task($1, 'Checkout fix', '', 'PR', array['Validated'], $2, 'urgent', null, false, 2, 2) as id`, [project, W1])).id;
await fails('only one timer per worker', /already have a timer running on T-/, () => as(W1, `select start_timer($1)`, [t2]));
await fails('stopping needs a summary', /at least 10 characters/, () => as(W1, `select stop_timer('short')`));
await ok('timer hits limit and is stopped at exactly the limit; time kept', async () => {
  await su(`update timers set started_at = now() - interval '3 hours 20 minutes' where worker_id = $1`, [W1]);
  const n = (await one(W2, `select sync_timers() as n`)).n;
  assert.equal(n, 1);
  const e = (await su(`select extract(epoch from ended_at - started_at)/3600 h, auto_stopped, needs_summary, rate, currency, status from time_entries where task_id=$1`, [t1]))[0];
  assert.equal(Math.round(Number(e.h) * 100) / 100, 3); assert.equal(e.auto_stopped, true); assert.equal(e.needs_summary, true);
  assert.equal(Number(e.rate), 28); assert.equal(e.currency, 'USD'); assert.equal(e.status, 'pending');
  assert.equal((await su(`select count(*)::int c from timers`))[0].c, 0);
  const notes = await as(W1, `select body from notifications order by id`);
  assert.ok(notes.some((x) => /reached its approved-hour limit/.test(x.body)));
});
await fails('cannot restart at the limit', /All approved hours on T-\d+ are used/, () => as(W1, `select start_timer($1)`, [t1]));
await ok('worker adds summary to auto-stopped entry', async () => {
  const id = (await su(`select id from time_entries where task_id=$1`, [t1]))[0].id;
  await as(W1, `select add_entry_summary($1, 'Built layout and toggle for pricing')`, [id]);
});

console.log('Extra hours');
const req = (await one(W1, `select request_hours($1, 2, 'Client added an FAQ section to the page') as id`, [t1])).id;
await fails('one pending request per task', /already waiting/, () => as(W1, `select request_hours($1, 1, 'Another request here')`, [t1]));
await fails('reject needs a note', /Add a note/, () => as(M, `select decide_hours($1, false, '')`, [req]));
await ok('approval raises the limit and is logged', async () => {
  await as(M, `select decide_hours($1, true, '')`, [req]);
  assert.equal(Number((await su(`select max_hours from tasks where id=$1`, [t1]))[0].max_hours), 5);
  const log = await su(`select body from activity where task_id=$1 order by id desc limit 1`, [t1]);
  assert.match(log[0].body, /from 3h 00m to 5h 00m/);
});
await ok('80% warning fires once when time crosses it', async () => {
  await as(W1, `select start_timer($1)`, [t1]);
  await su(`update timers set started_at = now() - interval '61 minutes' where worker_id = $1`, [W1]);
  await as(W1, `select sync_timers()`);
  assert.equal((await su(`select warned_80 from tasks where id=$1`, [t1]))[0].warned_80, true);
  const n = (await as(W1, `select count(*)::int c from notifications where body like '%of the approved hours on%'`))[0].c;
  assert.equal(n, 1);
  await as(W1, `select stop_timer('FAQ accordion and spacing fixes')`);
});

console.log('Manual entries, overlap and corrections');
const lastEnd = (await su(`select max(ended_at) e from time_entries where worker_id=$1`, [W1]))[0].e;
await fails('overlapping manual entry is refused', /overlaps entry #/, () =>
  as(W1, `select add_manual_entry($1, $2::timestamptz - interval '30 minutes', $2::timestamptz - interval '10 minutes', 'Testing overlap rule', 'Forgot timer')`, [t1, lastEnd]));
await fails('future time is refused', /future/, () =>
  as(W1, `select add_manual_entry($1, now() + interval '1 hour', now() + interval '2 hours', 'Future work entry', 'Forgot timer')`, [t1]));
await fails('manual entry needs a reason', /Explain why/, () =>
  as(W1, `select add_manual_entry($1, now() - interval '30 hours', now() - interval '29 hours', 'Proofreading pass', '')`, [t1]));
await fails('manual entry cannot exceed remaining hours', /approved time is left/, () =>
  as(W1, `select add_manual_entry($1, now() - interval '30 hours', now() - interval '27 hours', 'Proofreading pass', 'Forgot timer')`, [t1]));
const man = (await one(W1, `select add_manual_entry($1, now() - interval '30 hours', now() - interval '29 hours 30 minutes', 'Proofreading pass', 'Forgot timer') as id`, [t1])).id;
await ok('database constraint blocks overlap even for direct inserts', async () => {
  await assert.rejects(su(`insert into time_entries (task_id, worker_id, started_at, ended_at, kind, rate, currency) values ($1, $2, now() - interval '30 hours', now() - interval '29 hours', 'manual', 1, 'USD')`, [t1, W1]), /time_entries_no_overlap/);
});
const corr = (await one(W1, `select request_correction($1, now() - interval '30 hours', now() - interval '29 hours 45 minutes', 'Took a break mid-way') as id`, [man])).id;
await fails('only one pending correction per entry', /already waiting/, () =>
  as(W1, `select request_correction($1, now() - interval '30 hours', now() - interval '29 hours 50 minutes', 'Second try here')`, [man]));
await fails('workers cannot approve time', /Only managers/, () => as(W1, `select decide_entry($1, true, '')`, [corr]));
await ok('approved correction replaces original for pay; original kept with same rate', async () => {
  await as(M, `select decide_entry($1, true, '')`, [corr]);
  const o = (await su(`select superseded_by, rate from time_entries where id=$1`, [man]))[0];
  const c = (await su(`select rate, status from time_entries where id=$1`, [corr]))[0];
  assert.equal(Number(o.superseded_by), Number(corr)); assert.equal(Number(c.rate), Number(o.rate)); assert.equal(c.status, 'approved');
});
await fails('reject needs a reason', /Give a reason/, async () => {
  const id = (await su(`select id from time_entries where status='pending' order by id limit 1`))[0].id;
  await as(M, `select decide_entry($1, false, '')`, [id]);
});

console.log('Work review is separate from time approval');
await ok('submit requires all criteria', async () => {
  await assert.rejects(as(W1, `select submit_work($1, 'Pricing page is live on staging', '[]', array[0])`, [t1]), /Check every acceptance criterion/);
  await as(W1, `select submit_work($1, 'Pricing page is live on staging', '[{"label":"PR","url":"https://github.com/x/1"}]', array[0,1])`, [t1]);
});
await ok('approving work completes the task but leaves time pending', async () => {
  await as(M, `select decide_work($1, true, 'Great')`, [t1]);
  assert.equal((await su(`select status from tasks where id=$1`, [t1]))[0].status, 'completed');
  const p = (await su(`select count(*)::int c from time_entries where task_id=$1 and status='pending'`, [t1]))[0].c;
  assert.ok(p > 0);
});

console.log('Questions');
const q = (await one(W1, `select post_comment($1, 'question', 'Which browsers must be supported?') as id`, [t2])).id;
await ok('manager is notified; reply notifies the asker; resolve', async () => {
  assert.ok((await as(M, `select body from notifications where body like '%asked a question%'`)).length === 1);
  await as(M, `select post_comment($1, 'comment', 'Latest Chrome, Safari and Firefox.', $2)`, [t2, q]);
  assert.ok((await as(W1, `select body from notifications where body like '%answered your question%'`)).length === 1);
  await as(W1, `select set_question_status($1, true)`, [q]);
  assert.equal((await su(`select q_status from comments where id=$1`, [q]))[0].q_status, 'resolved');
});
await fails('other worker cannot comment on the task', /Task not found/, () => as(W2, `select post_comment($1, 'comment', 'hi there')`, [t2]));

console.log('Pay');
await ok('approve all and create payment records by currency', async () => {
  const ids = (await su(`select array_agg(id) a from time_entries where status='pending'`))[0].a;
  await as(M, `select decide_entries($1, true, '')`, [ids]);
  const n = (await one(M, `select create_payments(current_date - 30, current_date + 1) as n`)).n;
  assert.equal(n, 1);
  const p = (await su(`select hours, amount, currency from payments`))[0];
  assert.equal(p.currency, 'USD');
  assert.ok(Math.abs(Number(p.amount) - Number(p.hours) * 28) < 0.3, 'amount = exact approved time x stored rate');
});
await ok('rate change later does not change past entries', async () => {
  const before = (await su(`select sum(rate) s from time_entries`))[0].s;
  await as(M, `select set_rate($1, 40, 'USD', current_date + 1)`, [W1]);
  assert.equal((await su(`select sum(rate) s from time_entries`))[0].s, before);
});
await fails('paid entries cannot be corrected', /payment record/, async () => {
  const id = (await su(`select id from time_entries where payment_id is not null and kind='timer' limit 1`))[0].id;
  await as(W1, `select request_correction($1, now() - interval '50 hours', now() - interval '49 hours', 'Fix this please')`, [id]);
});
await ok('workers only see their own payments and entries', async () => {
  assert.equal((await as(W2, `select count(*)::int c from payments`))[0].c, 0);
  assert.equal((await as(W2, `select count(*)::int c from time_entries`))[0].c, 0);
  assert.ok((await as(W1, `select count(*)::int c from payments`))[0].c === 1);
});
await ok('mark paid is manager-only and logged', async () => {
  const id = (await su(`select id from payments limit 1`))[0].id;
  await assert.rejects(as(W1, `select set_payment_status($1, 'paid')`, [id]), /Only managers/);
  await as(M, `select set_payment_status($1, 'paid')`, [id]);
});

console.log('Blockers, reassignment, cancel, audit log');
await ok('blocker stops the running timer', async () => {
  await su(`update time_entries set started_at = started_at - interval '3 days', ended_at = ended_at - interval '3 days'`);
  await as(W1, `select start_timer($1)`, [t2]);
  await su(`update timers set started_at = now() - interval '20 minutes'`);
  await as(W1, `select report_blocker($1, 'Waiting for API keys')`, [t2]);
  assert.equal((await su(`select count(*)::int c from timers`))[0].c, 0);
  assert.equal((await su(`select status from tasks where id=$1`, [t2]))[0].status, 'blocked');
});
await ok('reassigning moves the task to the new worker only', async () => {
  await as(M, `select resolve_blocker($1)`, [t2]);
  await as(M, `select update_task($1, $2, 'Checkout fix', '', 'PR', array['Validated'], $3, 'urgent', null, 2, 3)`, [t2, project, W2]);
  assert.equal((await as(W1, `select count(*)::int c from tasks where id=$1`, [t2]))[0].c, 0);
  assert.equal((await as(W2, `select count(*)::int c from tasks where id=$1`, [t2]))[0].c, 1);
  const h = (await as(W2, `select logged from task_hours(array[$1::bigint])`, [t2]))[0];
  assert.ok(Number(h.logged) > 0, 'new assignee sees total hours logged on the task');
});
await fails('max hours cannot drop below logged time', /can't be lower/, () =>
  as(M, `select update_task($1, $2, 'Checkout fix', '', 'PR', array['Validated'], $3, 'urgent', null, 2, 0.1)`, [t2, project, W2]));
await ok('audit log cannot be edited', async () => {
  await assert.rejects(as(M, `update activity set body = 'x'`), /permission denied/);
  await assert.rejects(as(M, `delete from activity`), /permission denied/);
});
await ok('worker sees own task history but not rate changes', async () => {
  const rows = await as(W1, `select body from activity`);
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((r) => /rate/.test(r.body)));
});
await ok('deactivated user loses access', async () => {
  await as(M, `select update_profile($1, 'Aisha', 'Writer', 'worker', false)`, [W2]);
  assert.equal((await as(W2, `select count(*)::int c from tasks`))[0].c, 0);
  await assert.rejects(as(W2, `select start_timer($1)`, [t2]), /inactive/);
});
await fails('last manager cannot be demoted', /at least one active manager/, () => as(M, `select update_profile($1, 'Maya', '', 'worker', true)`, [M]));

console.log(`\n${passed} checks passed`);

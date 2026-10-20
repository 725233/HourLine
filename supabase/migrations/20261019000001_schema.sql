-- Hourline schema: tables, indexes and row-level security.
-- All writes go through the functions in 20261019000002_functions.sql, which check
-- permissions and business rules on the server. Browsers can only read
-- what the policies below allow.

create extension if not exists btree_gist;

create type public.user_role as enum ('manager', 'worker');
create type public.task_status as enum (
  'needs_estimate', 'estimate_submitted', 'todo', 'in_progress', 'blocked',
  'submitted', 'changes_requested', 'completed', 'cancelled'
);
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.entry_status as enum ('pending', 'approved', 'rejected');
create type public.entry_kind as enum ('timer', 'manual', 'correction');

-- Organisation-wide settings (one row).
create table public.app_settings (
  id int primary key default 1 check (id = 1),
  org_name text not null default 'Hourline',
  timezone text not null default 'UTC',
  long_session_hours numeric not null default 6 check (long_session_hours > 0),
  max_entry_hours numeric not null default 12 check (max_entry_hours > 0),
  warn_ratio numeric not null default 0.8 check (warn_ratio > 0 and warn_ratio < 1),
  max_file_bytes bigint not null default 10485760
);
insert into public.app_settings (id) values (1);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  title text not null default '',
  role public.user_role not null default 'worker',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Hourly rates with an effective date. Each time entry copies the rate in
-- effect when the work happened, so later changes never alter past pay.
create table public.worker_rates (
  id bigint generated always as identity primary key,
  worker_id uuid not null references public.profiles (id) on delete cascade,
  rate numeric(12, 2) not null check (rate > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  effective_from date not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (worker_id, effective_from)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'Other',
  archived boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.tasks (
  id bigint generated always as identity (start with 101) primary key,
  project_id uuid not null references public.projects (id),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  deliverable text not null default '',
  criteria text[] not null default '{}',
  assignee_id uuid not null references public.profiles (id),
  priority public.task_priority not null default 'medium',
  deadline date,
  est_hours numeric(8, 2) not null default 0 check (est_hours >= 0),
  max_hours numeric(8, 2) not null default 0 check (max_hours >= 0),
  status public.task_status not null default 'needs_estimate',
  blocker_text text,
  blocker_by uuid references public.profiles (id),
  blocker_at timestamptz,
  warned_80 boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_assignee_idx on public.tasks (assignee_id);
create index tasks_status_idx on public.tasks (status);

create table public.task_estimates (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  worker_id uuid not null references public.profiles (id),
  hours numeric(8, 2) not null check (hours > 0),
  notes text not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'revise')),
  approved_hours numeric(8, 2),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index task_estimates_task_idx on public.task_estimates (task_id);

create table public.hour_requests (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  worker_id uuid not null references public.profiles (id),
  hours numeric(8, 2) not null check (hours > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now()
);
create unique index hour_requests_one_pending on public.hour_requests (task_id) where status = 'pending';

-- The primary key guarantees one running timer per worker, across all tabs and devices.
create table public.timers (
  worker_id uuid primary key references public.profiles (id) on delete cascade,
  task_id bigint not null references public.tasks (id),
  started_at timestamptz not null default now()
);

create table public.payments (
  id bigint generated always as identity primary key,
  worker_id uuid not null references public.profiles (id),
  currency char(3) not null,
  period_start date not null,
  period_end date not null,
  hours numeric(10, 2) not null,
  amount numeric(14, 2) not null,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid')),
  paid_at timestamptz,
  paid_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.time_entries (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id),
  worker_id uuid not null references public.profiles (id),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  summary text not null default '',
  kind public.entry_kind not null,
  reason text not null default '',
  status public.entry_status not null default 'pending',
  rate numeric(12, 2) not null,
  currency char(3) not null,
  flagged boolean not null default false,
  flag_reason text not null default '',
  auto_stopped boolean not null default false,
  needs_summary boolean not null default false,
  corrects_id bigint references public.time_entries (id),
  superseded_by bigint references public.time_entries (id),
  payment_id bigint references public.payments (id),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  check (ended_at > started_at),
  -- Timer and manual entries for one worker can never overlap.
  -- Corrections are checked by request_correction() against everything else.
  constraint time_entries_no_overlap exclude using gist (
    worker_id with =,
    tstzrange(started_at, ended_at) with &&
  ) where (status <> 'rejected' and superseded_by is null and kind <> 'correction')
);
create index time_entries_task_idx on public.time_entries (task_id);
create index time_entries_worker_idx on public.time_entries (worker_id, started_at);
create unique index time_entries_one_pending_correction on public.time_entries (corrects_id)
  where kind = 'correction' and status = 'pending';

create table public.submissions (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  worker_id uuid not null references public.profiles (id),
  summary text not null,
  links jsonb not null default '[]',
  criteria jsonb not null default '[]',
  decision text check (decision in ('approved', 'changes')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  comment text not null default '',
  created_at timestamptz not null default now()
);
create index submissions_task_idx on public.submissions (task_id);

create table public.comments (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  author_id uuid not null references public.profiles (id),
  parent_id bigint references public.comments (id),
  kind text not null default 'comment' check (kind in ('comment', 'question', 'note')),
  body text not null check (length(trim(body)) > 0),
  q_status text check (q_status in ('open', 'resolved')),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index comments_task_idx on public.comments (task_id);

create table public.attachments (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  comment_id bigint references public.comments (id),
  submission_id bigint references public.submissions (id),
  kind text not null check (kind in ('file', 'link')),
  name text not null,
  size_bytes bigint,
  mime text,
  storage_path text unique,
  url text,
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
create index attachments_task_idx on public.attachments (task_id);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  task_id bigint references public.tasks (id) on delete set null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- Append-only audit log. No one can edit or delete rows through the API.
create table public.activity (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id),
  task_id bigint references public.tasks (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index activity_task_idx on public.activity (task_id, created_at desc);
create index activity_time_idx on public.activity (created_at desc);

-- ---------------------------------------------------------------------------
-- Access helpers (security definer so policies don't recurse)
-- ---------------------------------------------------------------------------
create function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'manager' and active);
$$;

create function public.can_see_task(p_task bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager()
      or exists (select 1 from tasks t join profiles p on p.id = auth.uid() and p.active
                 where t.id = p_task and t.assignee_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: read access only. Writes happen in functions.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_settings','profiles','worker_rates','projects','tasks','task_estimates',
    'hour_requests','timers','payments','time_entries','submissions','comments','attachments',
    'notifications','activity']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy "settings readable" on public.app_settings for select to authenticated using (true);
create policy "team names readable" on public.profiles for select to authenticated using (public.is_member());
create policy "rates: managers or own" on public.worker_rates for select to authenticated
  using (public.is_manager() or worker_id = auth.uid());
create policy "projects readable" on public.projects for select to authenticated using (public.is_member());
create policy "tasks: managers or assignee" on public.tasks for select to authenticated
  using (public.is_manager() or (assignee_id = auth.uid() and public.is_member()));
create policy "estimates: task access" on public.task_estimates for select to authenticated using (public.can_see_task(task_id));
create policy "hour requests: task access" on public.hour_requests for select to authenticated using (public.can_see_task(task_id));
create policy "submissions: task access" on public.submissions for select to authenticated using (public.can_see_task(task_id));
create policy "comments: task access" on public.comments for select to authenticated using (public.can_see_task(task_id));
create policy "attachments: task access" on public.attachments for select to authenticated using (public.can_see_task(task_id));
create policy "timers: managers or own" on public.timers for select to authenticated
  using (public.is_manager() or worker_id = auth.uid());
create policy "entries: managers or own" on public.time_entries for select to authenticated
  using (public.is_manager() or worker_id = auth.uid());
create policy "payments: managers or own" on public.payments for select to authenticated
  using (public.is_manager() or worker_id = auth.uid());
create policy "notifications: own" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "activity: managers, or own task history" on public.activity for select to authenticated
  using (public.is_manager() or (task_id is not null and public.can_see_task(task_id)));

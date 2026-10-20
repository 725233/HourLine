-- Hourline business rules. Every change in the app goes through one of these
-- functions. They run on the server with the signed-in user's identity
-- (auth.uid()), check permissions, use the database clock, and write the
-- audit log in the same transaction.

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser; see grants at the end)
-- ---------------------------------------------------------------------------
create function public._settings() returns public.app_settings
language sql stable security definer set search_path = public as $$ select * from app_settings where id = 1 $$;

create function public._me() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p profiles;
begin
  select * into p from profiles where id = auth.uid();
  if p.id is null or not p.active then
    raise exception 'You are not signed in, or your account is inactive.' using errcode = '28000';
  end if;
  return p;
end $$;

create function public._require_manager() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p profiles := _me();
begin
  if p.role <> 'manager' then raise exception 'Only managers can do this.' using errcode = '42501'; end if;
  return p;
end $$;

create function public._code(p_id bigint) returns text language sql immutable as $$ select 'T-' || p_id $$;

create function public._fmt_h(h numeric) returns text language plpgsql immutable as $$
declare m int := round(greatest(coalesce(h, 0), 0) * 60);
begin return (m / 60) || 'h ' || lpad((m % 60)::text, 2, '0') || 'm'; end $$;

create function public._label(s public.task_status) returns text language sql immutable as $$
  select case s
    when 'needs_estimate' then 'Needs Estimate' when 'estimate_submitted' then 'Estimate Submitted'
    when 'todo' then 'To Do' when 'in_progress' then 'In Progress' when 'blocked' then 'Blocked'
    when 'submitted' then 'Submitted for Review' when 'changes_requested' then 'Changes Requested'
    when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' end
$$;

create function public._name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name, ''), email) from profiles where id = p_user
$$;

create function public._task(p_id bigint) returns public.tasks
language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  select * into t from tasks where id = p_id for update;
  if t.id is null then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  return t;
end $$;

create function public._my_task(p_id bigint) returns public.tasks
language plpgsql security definer set search_path = public as $$
declare t tasks := _task(p_id);
begin
  if t.assignee_id is distinct from auth.uid() then
    raise exception 'You can only do this on tasks assigned to you.' using errcode = '42501';
  end if;
  return t;
end $$;

create function public._log(p_task bigint, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into activity (actor_id, task_id, body) values (auth.uid(), p_task, p_body)
$$;

-- Notify one user. Skips the person who caused the event unless p_force.
create function public._notify(p_user uuid, p_body text, p_task bigint, p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if not p_force and p_user = auth.uid() then return; end if;
  insert into notifications (user_id, body, task_id) values (p_user, p_body, p_task);
end $$;

create function public._notify_managers(p_body text, p_task bigint) returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, body, task_id)
  select id, p_body, p_task from profiles
  where role = 'manager' and active and id is distinct from auth.uid()
$$;

-- Hours that count toward a task's limit: pending + approved, excluding
-- rejected entries, replaced originals and corrections not yet approved.
create function public._logged(p_task bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(extract(epoch from ended_at - started_at) / 3600.0), 0)
  from time_entries
  where task_id = p_task and status <> 'rejected' and superseded_by is null
    and not (kind = 'correction' and status <> 'approved')
$$;

create function public._running(p_task bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(extract(epoch from now() - started_at) / 3600.0), 0) from timers where task_id = p_task
$$;

create function public._remaining(p_task bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(0, t.max_hours - _logged(t.id) - _running(t.id)) from tasks t where t.id = p_task
$$;

create function public._rate_at(p_worker uuid, p_at timestamptz, out rate numeric, out currency text)
language plpgsql stable security definer set search_path = public as $$
begin
  select r.rate, r.currency into rate, currency from worker_rates r
  where r.worker_id = p_worker and r.effective_from <= (p_at at time zone (_settings()).timezone)::date
  order by r.effective_from desc limit 1;
  if rate is null then
    raise exception 'No hourly rate is set for % yet. A manager needs to set one on the Team page.', _name(p_worker) using errcode = 'P0001';
  end if;
end $$;

-- Describe the first counted entry (or running timer) that overlaps a range.
create function public._overlap(p_worker uuid, p_start timestamptz, p_end timestamptz, p_ignore bigint) returns text
language plpgsql stable security definer set search_path = public as $$
declare e time_entries; tm timers; tz text := (_settings()).timezone;
begin
  select * into e from time_entries
  where worker_id = p_worker and id is distinct from p_ignore and status <> 'rejected' and superseded_by is null
    and started_at < p_end and p_start < ended_at
  order by started_at limit 1;
  if e.id is not null then
    return 'entry #' || e.id || ' on ' || _code(e.task_id) || ' (' || to_char(e.started_at at time zone tz, 'Mon DD HH24:MI')
      || '–' || to_char(e.ended_at at time zone tz, 'HH24:MI') || ')';
  end if;
  select * into tm from timers where worker_id = p_worker;
  if tm.worker_id is not null and tm.started_at < p_end and p_start < now() then
    return 'your running timer on ' || _code(tm.task_id);
  end if;
  return null;
end $$;

create function public._check_warn(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
declare t tasks; r numeric; w numeric := (_settings()).warn_ratio;
begin
  select * into t from tasks where id = p_task;
  if t.id is null or t.max_hours <= 0 then return; end if;
  r := (_logged(t.id) + _running(t.id)) / t.max_hours;
  if r >= w and r < 1 and not t.warned_80 then
    update tasks set warned_80 = true where id = t.id;
    perform _notify(t.assignee_id, 'You have used ' || round(r * 100) || '% of the approved hours on ' || _code(t.id)
      || '. ' || _fmt_h(t.max_hours * (1 - r)) || ' left.', t.id, true);
    perform _notify_managers(_code(t.id) || ' ' || t.title || ' has used ' || round(r * 100) || '% of its approved hours', t.id);
  elsif r < w and t.warned_80 then
    update tasks set warned_80 = false where id = t.id;
  end if;
end $$;

create function public._insert_entry(
  p_task bigint, p_worker uuid, p_start timestamptz, p_end timestamptz, p_summary text,
  p_kind public.entry_kind, p_reason text, p_corrects bigint, p_rate numeric, p_currency text,
  p_auto boolean, p_needs_summary boolean, p_flag text default ''
) returns public.time_entries
language plpgsql security definer set search_path = public as $$
declare e time_entries; dur numeric := extract(epoch from p_end - p_start) / 3600.0;
  flags text[] := '{}';
begin
  if dur > (_settings()).long_session_hours then
    flags := flags || ('Session longer than ' || (_settings()).long_session_hours || ' hours');
  end if;
  if coalesce(p_flag, '') <> '' then flags := flags || p_flag; end if;
  insert into time_entries (task_id, worker_id, started_at, ended_at, summary, kind, reason, corrects_id,
    rate, currency, flagged, flag_reason, auto_stopped, needs_summary)
  values (p_task, p_worker, p_start, p_end, coalesce(p_summary, ''), p_kind, coalesce(p_reason, ''), p_corrects,
    p_rate, p_currency, cardinality(flags) > 0, array_to_string(flags, '; '), p_auto, p_needs_summary)
  returning * into e;
  if e.flagged then
    perform _notify_managers('Flagged for review: ' || _name(p_worker) || ' logged ' || _fmt_h(dur) || ' on '
      || _code(p_task) || ' (' || e.flag_reason || ')', p_task);
  end if;
  return e;
end $$;

-- Stop a worker's timer and save the time. With p_cap the entry ends at the
-- approved-hour limit. Returns the new entry id, or null if nothing was logged.
create function public._stop_timer(p_worker uuid, p_summary text, p_cap boolean, p_auto boolean, p_why text) returns bigint
language plpgsql security definer set search_path = public as $$
declare tm timers; t tasks; v_start timestamptz; v_end timestamptz := now(); ov timestamptz;
  r record; e time_entries; flag text := '';
begin
  select * into tm from timers where worker_id = p_worker for update;
  if tm.worker_id is null then return null; end if;
  select * into t from tasks where id = tm.task_id for update;
  if p_cap and t.max_hours > 0 then
    v_end := least(v_end, tm.started_at + greatest(0, t.max_hours - _logged(t.id)) * interval '1 hour');
  end if;
  delete from timers where worker_id = p_worker;
  v_start := tm.started_at;
  -- Never overlap existing time: start after any entry that overlaps the session.
  select max(ended_at) into ov from time_entries
  where worker_id = p_worker and status <> 'rejected' and superseded_by is null
    and started_at < v_end and ended_at > v_start;
  if ov is not null then v_start := greatest(v_start, ov); flag := 'Start trimmed to avoid overlapping other time'; end if;
  if v_end - v_start < interval '1 second' then
    perform _log(t.id, 'Timer stopped; nothing to log');
    return null;
  end if;
  select * into r from _rate_at(p_worker, v_start);
  e := _insert_entry(t.id, p_worker, v_start, v_end, p_summary, 'timer', '', null, r.rate, r.currency,
    p_auto, p_auto, flag);
  perform _log(t.id, case when p_auto then 'Timer stopped automatically (' || p_why || '), logged '
    else 'Stopped timer, logged ' end || _fmt_h(extract(epoch from v_end - v_start) / 3600.0)
    || ' as entry #' || e.id || ' (pending approval)');
  perform _check_warn(t.id);
  return e.id;
end $$;

-- ---------------------------------------------------------------------------
-- Timers
-- ---------------------------------------------------------------------------

-- Stops any timer that has reached its task's approved-hour limit and sends
-- 80% warnings. Runs every minute from pg_cron and whenever the app loads.
create function public.sync_timers() returns int
language plpgsql security definer set search_path = public as $$
declare tm record; n int := 0; t tasks;
begin
  for tm in select * from timers for update skip locked loop
    select * into t from tasks where id = tm.task_id;
    if t.max_hours > 0 and _logged(t.id) + extract(epoch from now() - tm.started_at) / 3600.0 >= t.max_hours then
      perform _stop_timer(tm.worker_id, 'Timer stopped automatically at the approved-hour limit.', true, true,
        'approved-hour limit reached');
      perform _notify(tm.worker_id, _code(t.id) || ' reached its approved-hour limit (' || _fmt_h(t.max_hours)
        || '). Your timer was stopped and your time is saved. Request more hours to keep logging paid time.', t.id, true);
      perform _notify_managers(_code(t.id) || ' reached its approved-hour limit. ' || _name(tm.worker_id)
        || '''s timer was stopped.', t.id);
      n := n + 1;
    else
      perform _check_warn(t.id);
    end if;
  end loop;
  return n;
end $$;

create function public.start_timer(p_task bigint) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks; cur timers;
begin
  if me.role <> 'worker' then raise exception 'Only workers track time.'; end if;
  perform sync_timers();
  t := _my_task(p_task);
  if t.status not in ('todo', 'in_progress', 'changes_requested') then
    raise exception '%', case t.status
      when 'needs_estimate' then 'Submit your time estimate first. The timer unlocks once a manager approves it.'
      when 'estimate_submitted' then 'Your estimate is waiting for approval. The timer unlocks once it is approved.'
      when 'blocked' then 'This task is blocked. Mark the blocker resolved before tracking time.'
      else 'Time can''t be tracked while the task is ' || _label(t.status) || '.' end;
  end if;
  select * into cur from timers where worker_id = me.id;
  if cur.worker_id is not null then
    if cur.task_id = t.id then raise exception 'The timer is already running on this task.'; end if;
    raise exception 'You already have a timer running on %. Stop it first. Only one timer can run at a time.', _code(cur.task_id);
  end if;
  if _remaining(t.id) <= 0 then
    raise exception 'All approved hours on % are used. Request more hours to keep logging paid time.', _code(t.id);
  end if;
  perform _rate_at(me.id, now());
  if exists (select 1 from time_entries where worker_id = me.id and status <> 'rejected' and superseded_by is null and ended_at > now()) then
    raise exception 'You have a time entry that ends in the future. Ask a manager to fix it before starting a timer.';
  end if;
  begin
    insert into timers (worker_id, task_id) values (me.id, t.id);
  exception when unique_violation then
    raise exception 'You already have a timer running. Only one timer can run at a time.';
  end;
  if t.status = 'todo' then
    update tasks set status = 'in_progress', updated_at = now() where id = t.id;
    perform _log(t.id, 'Changed status from To Do to In Progress');
  end if;
  perform _log(t.id, 'Started timer');
  return now();
end $$;

create function public.stop_timer(p_summary text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me();
begin
  if length(trim(coalesce(p_summary, ''))) < 10 then
    raise exception 'Write a short summary of what you worked on (at least 10 characters).';
  end if;
  if not exists (select 1 from timers where worker_id = me.id) then raise exception 'No timer is running.'; end if;
  return _stop_timer(me.id, trim(p_summary), true, false, null);
end $$;

create function public.add_entry_summary(p_entry bigint, p_summary text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); e time_entries;
begin
  select * into e from time_entries where id = p_entry for update;
  if e.id is null or e.worker_id <> me.id then raise exception 'Entry not found.'; end if;
  if length(trim(coalesce(p_summary, ''))) < 10 then raise exception 'Write at least 10 characters.'; end if;
  update time_entries set summary = trim(p_summary), needs_summary = false where id = e.id;
  perform _log(e.task_id, 'Added work summary to entry #' || e.id || ' (logged time unchanged)');
end $$;

-- ---------------------------------------------------------------------------
-- Manual entries and corrections
-- ---------------------------------------------------------------------------
create function public._validate_range(p_start timestamptz, p_end timestamptz) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare dur numeric;
begin
  if p_start is null or p_end is null or p_end <= p_start then raise exception 'End time must be after the start time.'; end if;
  if p_end > now() then raise exception 'You can''t log time in the future.'; end if;
  dur := extract(epoch from p_end - p_start) / 3600.0;
  if dur > (_settings()).max_entry_hours then
    raise exception 'A single entry can''t be longer than % hours. Split it into separate entries.', (_settings()).max_entry_hours;
  end if;
  return dur;
end $$;

create function public.add_manual_entry(p_task bigint, p_start timestamptz, p_end timestamptz, p_summary text, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task); dur numeric; ov text; r record; e time_entries;
begin
  if t.status not in ('todo', 'in_progress', 'changes_requested') then
    raise exception 'Time can''t be added while the task is %.', _label(t.status);
  end if;
  dur := _validate_range(p_start, p_end);
  if length(trim(coalesce(p_summary, ''))) < 10 then raise exception 'Add a work summary of at least 10 characters.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explain why this is a manual entry (at least 5 characters).'; end if;
  if dur > _remaining(t.id) + 0.0001 then
    raise exception 'Only % of approved time is left on %. Request more hours first, or shorten the entry.', _fmt_h(_remaining(t.id)), _code(t.id);
  end if;
  ov := _overlap(me.id, p_start, p_end, null);
  if ov is not null then raise exception 'This overlaps %. Time entries can''t overlap.', ov; end if;
  select * into r from _rate_at(me.id, p_start);
  e := _insert_entry(t.id, me.id, p_start, p_end, trim(p_summary), 'manual', trim(p_reason), null, r.rate, r.currency, false, false);
  if t.status = 'todo' then
    update tasks set status = 'in_progress', updated_at = now() where id = t.id;
    perform _log(t.id, 'Changed status from To Do to In Progress');
  end if;
  perform _log(t.id, 'Added manual time entry #' || e.id || ' (' || _fmt_h(dur) || '). Reason: ' || trim(p_reason));
  perform _notify_managers(me.full_name || ' added a manual entry of ' || _fmt_h(dur) || ' on ' || _code(t.id) || ' for approval', t.id);
  perform _check_warn(t.id);
  return e.id;
end $$;

create function public.request_correction(p_entry bigint, p_start timestamptz, p_end timestamptz, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); o time_entries; dur numeric; extra numeric; ov text; e time_entries; tz text := (_settings()).timezone;
begin
  select * into o from time_entries where id = p_entry for update;
  if o.id is null or o.worker_id <> me.id then raise exception 'Entry not found.'; end if;
  if o.status = 'rejected' then raise exception 'Rejected entries can''t be corrected. Add a manual entry instead.'; end if;
  if o.superseded_by is not null then raise exception 'This entry was already replaced by a correction.'; end if;
  if o.kind = 'correction' then raise exception 'This is already a correction and can''t be corrected again. Ask a manager.'; end if;
  if o.payment_id is not null then raise exception 'This entry is in a payment record and can''t be corrected. Ask a manager.'; end if;
  if exists (select 1 from time_entries where corrects_id = o.id and status = 'pending') then
    raise exception 'A correction for this entry is already waiting for approval.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explain the correction (at least 5 characters).'; end if;
  if p_start = o.started_at and p_end = o.ended_at then raise exception 'The new times are the same as the original.'; end if;
  dur := _validate_range(p_start, p_end);
  extra := dur - extract(epoch from o.ended_at - o.started_at) / 3600.0;
  if extra > 0 and extra > _remaining(o.task_id) + 0.0001 then
    raise exception 'This adds % but only % of approved time is left. Request more hours first.', _fmt_h(extra), _fmt_h(_remaining(o.task_id));
  end if;
  ov := _overlap(me.id, p_start, p_end, o.id);
  if ov is not null then raise exception 'This overlaps %. Time entries can''t overlap.', ov; end if;
  e := _insert_entry(o.task_id, me.id, p_start, p_end, o.summary, 'correction', trim(p_reason), o.id, o.rate, o.currency, false, false);
  perform _log(o.task_id, 'Requested correction #' || e.id || ' for entry #' || o.id || ': '
    || to_char(o.started_at at time zone tz, 'HH24:MI') || '–' || to_char(o.ended_at at time zone tz, 'HH24:MI') || ' → '
    || to_char(p_start at time zone tz, 'HH24:MI') || '–' || to_char(p_end at time zone tz, 'HH24:MI') || '. Reason: ' || trim(p_reason));
  perform _notify_managers(me.full_name || ' requested a correction to entry #' || o.id || ' on ' || _code(o.task_id), o.task_id);
  return e.id;
end $$;

create function public.decide_entry(p_entry bigint, p_approve boolean, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); e time_entries; o time_entries; h numeric;
begin
  select * into e from time_entries where id = p_entry for update;
  if e.id is null then raise exception 'Entry not found.'; end if;
  if e.status <> 'pending' then raise exception 'Entry #% was already decided.', e.id; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason for rejecting entry #%.', e.id; end if;
  h := extract(epoch from e.ended_at - e.started_at) / 3600.0;
  update time_entries set status = case when p_approve then 'approved'::entry_status else 'rejected'::entry_status end,
    decided_by = me.id, decided_at = now(), decision_note = trim(coalesce(p_note, '')) where id = e.id;
  if e.kind = 'correction' then
    select * into o from time_entries where id = e.corrects_id for update;
    if p_approve then
      update time_entries set superseded_by = e.id where id = o.id;
      perform _log(e.task_id, 'Approved correction #' || e.id || ': entry #' || o.id || ' changed from '
        || _fmt_h(extract(epoch from o.ended_at - o.started_at) / 3600.0) || ' to ' || _fmt_h(h) || '. Original kept in history');
    else
      perform _log(e.task_id, 'Rejected correction #' || e.id || ': ' || trim(p_note) || '. Original entry #' || o.id || ' unchanged');
    end if;
  else
    perform _log(e.task_id, case when p_approve then 'Approved' else 'Rejected' end || ' time entry #' || e.id
      || ' (' || _fmt_h(h) || ')' || case when p_approve then '' else ': ' || trim(p_note) end);
  end if;
  perform _notify(e.worker_id, case when p_approve then 'Time entry #' || e.id || ' (' || _fmt_h(h) || ' on ' || _code(e.task_id) || ') was approved'
    else 'Time entry #' || e.id || ' on ' || _code(e.task_id) || ' was rejected: ' || trim(p_note) end, e.task_id);
  perform _check_warn(e.task_id);
end $$;

create function public.decide_entries(p_ids bigint[], p_approve boolean, p_note text default '') returns int
language plpgsql security definer set search_path = public as $$
declare i bigint; n int := 0;
begin
  perform _require_manager();
  foreach i in array coalesce(p_ids, '{}') loop
    perform decide_entry(i, p_approve, p_note);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Estimates and extra hours
-- ---------------------------------------------------------------------------
create function public.submit_estimate(p_task bigint, p_hours numeric, p_notes text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task); id bigint;
begin
  if t.status <> 'needs_estimate' then raise exception 'This task is not waiting for an estimate.'; end if;
  if p_hours is null or p_hours <= 0 or p_hours > 500 then raise exception 'Enter the number of hours you need (up to 500).'; end if;
  if length(trim(coalesce(p_notes, ''))) < 10 then raise exception 'Add a short breakdown of at least 10 characters.'; end if;
  insert into task_estimates (task_id, worker_id, hours, notes) values (t.id, me.id, round(p_hours * 4) / 4, trim(p_notes)) returning task_estimates.id into id;
  update tasks set status = 'estimate_submitted', updated_at = now() where tasks.id = t.id;
  perform _log(t.id, 'Submitted time estimate: ' || _fmt_h(p_hours) || '. Changed status from Needs Estimate to Estimate Submitted');
  perform _notify_managers(me.full_name || ' submitted a ' || _fmt_h(p_hours) || ' estimate for ' || _code(t.id) || ' ' || t.title, t.id);
  return id;
end $$;

create function public.decide_estimate(p_task bigint, p_approve boolean, p_hours numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); t tasks := _task(p_task); e task_estimates; n text := trim(coalesce(p_note, ''));
begin
  if t.status <> 'estimate_submitted' then raise exception 'There is no estimate waiting for review on this task.'; end if;
  select * into e from task_estimates where task_id = t.id and status = 'submitted' order by created_at desc limit 1 for update;
  if e.id is null then raise exception 'There is no estimate waiting for review on this task.'; end if;
  if p_approve then
    if p_hours is null or p_hours <= 0 then raise exception 'Enter the approved hours.'; end if;
    if round(p_hours * 4) / 4 <> e.hours and length(n) < 3 then
      raise exception 'Add a note explaining why the approved hours differ from the estimate.';
    end if;
    update task_estimates set status = 'approved', approved_hours = round(p_hours * 4) / 4, decided_by = me.id, decided_at = now(), note = n where id = e.id;
    update tasks set est_hours = e.hours, max_hours = round(p_hours * 4) / 4, status = 'todo', updated_at = now() where id = t.id;
    perform _log(t.id, 'Approved estimate. Approved hours set to ' || _fmt_h(p_hours)
      || case when round(p_hours * 4) / 4 <> e.hours then ' (worker estimated ' || _fmt_h(e.hours) || ')' else '' end
      || '. Changed status from Estimate Submitted to To Do');
    perform _notify(t.assignee_id, 'Your estimate for ' || _code(t.id) || ' was approved: ' || _fmt_h(p_hours) || ' paid limit'
      || case when n <> '' then '. ' || n else '' end || '. You can start the timer now.', t.id);
  else
    if length(n) < 3 then raise exception 'Tell the worker what to change in the estimate.'; end if;
    update task_estimates set status = 'revise', decided_by = me.id, decided_at = now(), note = n where id = e.id;
    update tasks set status = 'needs_estimate', updated_at = now() where id = t.id;
    perform _log(t.id, 'Asked for a revised estimate: ' || n || '. Changed status from Estimate Submitted to Needs Estimate');
    perform _notify(t.assignee_id, 'Please revise your estimate for ' || _code(t.id) || ': ' || n, t.id);
  end if;
end $$;

create function public.request_hours(p_task bigint, p_hours numeric, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task); id bigint;
begin
  if t.status not in ('todo', 'in_progress', 'blocked', 'changes_requested', 'submitted') then
    raise exception 'Extra hours can''t be requested while the task is %.', _label(t.status);
  end if;
  if p_hours is null or p_hours <= 0 or p_hours > 200 then raise exception 'Enter how many extra hours you need (up to 200).'; end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Explain what the extra time is for (at least 10 characters).'; end if;
  begin
    insert into hour_requests (task_id, worker_id, hours, reason) values (t.id, me.id, round(p_hours * 4) / 4, trim(p_reason))
    returning hour_requests.id into id;
  exception when unique_violation then
    raise exception 'A request for this task is already waiting for approval.';
  end;
  perform _log(t.id, 'Requested ' || _fmt_h(p_hours) || ' additional hours: ' || trim(p_reason));
  perform _notify_managers(me.full_name || ' requested ' || _fmt_h(p_hours) || ' more on ' || _code(t.id) || ' ' || t.title, t.id);
  return id;
end $$;

create function public.decide_hours(p_request bigint, p_approve boolean, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); r hour_requests; t tasks; n text := trim(coalesce(p_note, ''));
begin
  select * into r from hour_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'This request was already decided.'; end if;
  t := _task(r.task_id);
  if p_approve then
    update hour_requests set status = 'approved', decided_by = me.id, decided_at = now(), note = n where id = r.id;
    update tasks set max_hours = max_hours + r.hours, updated_at = now() where id = t.id;
    perform _log(t.id, 'Approved additional-hours request (+' || _fmt_h(r.hours) || '). Changed max approved hours from '
      || _fmt_h(t.max_hours) || ' to ' || _fmt_h(t.max_hours + r.hours));
    perform _notify(r.worker_id, 'Your request for ' || _fmt_h(r.hours) || ' more on ' || _code(t.id) || ' was approved. New limit: '
      || _fmt_h(t.max_hours + r.hours) || '.', t.id);
    perform _check_warn(t.id);
  else
    if length(n) < 3 then raise exception 'Add a note for the worker explaining the decision.'; end if;
    update hour_requests set status = 'rejected', decided_by = me.id, decided_at = now(), note = n where id = r.id;
    perform _log(t.id, 'Rejected additional-hours request (+' || _fmt_h(r.hours) || '): ' || n);
    perform _notify(r.worker_id, 'Your request for ' || _fmt_h(r.hours) || ' more on ' || _code(t.id) || ' was rejected: ' || n, t.id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Task status, blockers, work submission and review
-- ---------------------------------------------------------------------------
create function public.mark_started(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task);
begin
  if t.status <> 'todo' then raise exception 'Only tasks in To Do can be marked as started.'; end if;
  update tasks set status = 'in_progress', updated_at = now() where id = t.id;
  perform _log(t.id, 'Changed status from To Do to In Progress');
end $$;

create function public.report_blocker(p_task bigint, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task); txt text := trim(coalesce(p_text, ''));
begin
  if t.status not in ('todo', 'in_progress', 'changes_requested') then
    raise exception 'A blocker can''t be reported while the task is %.', _label(t.status);
  end if;
  if length(txt) < 5 then raise exception 'Describe what is blocking you (at least 5 characters).'; end if;
  if exists (select 1 from timers where worker_id = me.id and task_id = t.id) then
    perform _stop_timer(me.id, 'Stopped when blocker was reported: ' || txt, true, false, null);
  end if;
  update tasks set status = 'blocked', blocker_text = txt, blocker_by = me.id, blocker_at = now(), updated_at = now() where id = t.id;
  perform _log(t.id, 'Reported a blocker: ' || txt || '. Changed status from ' || _label(t.status) || ' to Blocked');
  perform _notify_managers(me.full_name || ' reported a blocker on ' || _code(t.id) || ': ' || txt, t.id);
end $$;

create function public.resolve_blocker(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _task(p_task);
begin
  if me.role <> 'manager' and t.assignee_id <> me.id then raise exception 'You can''t change this task.'; end if;
  if t.status <> 'blocked' then raise exception 'This task is not blocked.'; end if;
  update tasks set status = 'in_progress', blocker_text = null, blocker_by = null, blocker_at = null, updated_at = now() where id = t.id;
  perform _log(t.id, 'Marked blocker resolved. Changed status from Blocked to In Progress');
  if me.role = 'manager' then
    perform _notify(t.assignee_id, 'Blocker resolved on ' || _code(t.id) || ' ' || t.title, t.id);
  else
    perform _notify_managers('Blocker resolved on ' || _code(t.id) || ' ' || t.title, t.id);
  end if;
end $$;

create function public.submit_work(p_task bigint, p_summary text, p_links jsonb, p_checked int[]) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks := _my_task(p_task); n int; crit jsonb; l jsonb; id bigint;
begin
  if t.status not in ('in_progress', 'changes_requested') then
    raise exception 'Work can''t be submitted while the task is %.', _label(t.status);
  end if;
  if exists (select 1 from timers where worker_id = me.id and task_id = t.id) then
    raise exception 'Stop the timer before submitting your work.';
  end if;
  if length(trim(coalesce(p_summary, ''))) < 10 then raise exception 'Add a summary of at least 10 characters.'; end if;
  n := coalesce(array_length(t.criteria, 1), 0);
  if (select count(distinct c) from unnest(coalesce(p_checked, '{}')) c where c between 0 and n - 1) < n then
    raise exception 'Check every acceptance criterion before submitting.';
  end if;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]')) loop
    if coalesce(l ->> 'url', '') !~* '^https?://' then raise exception 'Links must start with http:// or https://'; end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('text', c, 'checked', true)), '[]') into crit from unnest(t.criteria) c;
  insert into submissions (task_id, worker_id, summary, links, criteria)
  values (t.id, me.id, trim(p_summary), coalesce(p_links, '[]'), crit) returning submissions.id into id;
  update tasks set status = 'submitted', updated_at = now() where tasks.id = t.id;
  perform _log(t.id, 'Submitted work for review. Changed status from ' || _label(t.status) || ' to Submitted for Review');
  perform _notify_managers(me.full_name || ' submitted ' || _code(t.id) || ' ' || t.title || ' for review', t.id);
  return id;
end $$;

create function public.decide_work(p_task bigint, p_approve boolean, p_comment text default '') returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); t tasks := _task(p_task); s submissions; c text := trim(coalesce(p_comment, ''));
begin
  if t.status <> 'submitted' then raise exception 'There is no submission waiting for review.'; end if;
  select * into s from submissions where task_id = t.id and decision is null order by created_at desc limit 1 for update;
  if s.id is null then raise exception 'There is no submission waiting for review.'; end if;
  if p_approve then
    update submissions set decision = 'approved', decided_by = me.id, decided_at = now(), comment = c where id = s.id;
    update tasks set status = 'completed', updated_at = now() where id = t.id;
    perform _log(t.id, 'Approved work submission. Changed status from Submitted for Review to Completed (time entries not affected)');
    perform _notify(t.assignee_id, 'Your work on ' || _code(t.id) || ' was approved' || case when c <> '' then ': ' || c else '' end
      || '. Time entries are reviewed separately.', t.id);
  else
    if length(c) < 5 then raise exception 'Describe what needs to change (at least 5 characters).'; end if;
    update submissions set decision = 'changes', decided_by = me.id, decided_at = now(), comment = c where id = s.id;
    update tasks set status = 'changes_requested', updated_at = now() where id = t.id;
    insert into comments (task_id, author_id, kind, body) values (t.id, me.id, 'comment', c);
    perform _log(t.id, 'Requested changes. Changed status from Submitted for Review to Changes Requested. Approved hours unchanged ('
      || _fmt_h(t.max_hours) || ')');
    perform _notify(t.assignee_id, 'Changes requested on ' || _code(t.id) || ': ' || c, t.id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Discussion and attachments
-- ---------------------------------------------------------------------------
create function public.post_comment(p_task bigint, p_kind text, p_body text, p_parent bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); t tasks; k text := coalesce(p_kind, 'comment'); b text := trim(coalesce(p_body, ''));
  par comments; id bigint; ex text; u uuid;
begin
  if not can_see_task(p_task) then raise exception 'Task not found.'; end if;
  select * into t from tasks where tasks.id = p_task;
  if t.status = 'cancelled' then raise exception 'This task is cancelled, so new messages are closed.'; end if;
  if b = '' then raise exception 'Write a message first.'; end if;
  if length(b) > 5000 then raise exception 'Messages can be up to 5,000 characters.'; end if;
  if k not in ('comment', 'question', 'note') then k := 'comment'; end if;
  if k = 'note' and me.role = 'manager' then k := 'comment'; end if;
  ex := left(b, 80) || case when length(b) > 80 then '…' else '' end;
  if p_parent is not null then
    select * into par from comments where comments.id = p_parent;
    if par.id is null or par.task_id <> t.id or par.parent_id is not null then raise exception 'You can only reply to a message on this task.'; end if;
    insert into comments (task_id, author_id, parent_id, kind, body) values (t.id, me.id, par.id, 'comment', b) returning comments.id into id;
    perform _log(t.id, case when par.kind = 'question' and par.author_id <> me.id then 'Answered a question' else 'Replied' end || ': “' || ex || '”');
    for u in select distinct x from (
        select par.author_id as x
        union select author_id from comments where parent_id = par.id
        union select case when me.role = 'manager' then t.assignee_id end) s
      where x is not null and x <> me.id
    loop
      perform _notify(u, me.full_name || case when par.kind = 'question' and par.author_id <> me.id and u = par.author_id
        then ' answered your question on ' else ' replied on ' end || _code(t.id) || ': ' || ex, t.id);
    end loop;
    if me.role = 'worker' and not exists (select 1 from profiles pr where pr.id = par.author_id and pr.role = 'manager') then
      perform _notify_managers(me.full_name || ' replied on ' || _code(t.id) || ': ' || ex, t.id);
    end if;
  else
    insert into comments (task_id, author_id, kind, body, q_status)
    values (t.id, me.id, k, b, case when k = 'question' then 'open' end) returning comments.id into id;
    perform _log(t.id, case k when 'question' then 'Asked a question: “' || ex || '”' when 'note' then 'Posted a work update' else 'Commented' end);
    if me.role = 'manager' then
      perform _notify(t.assignee_id, me.full_name || case k when 'question' then ' asked a question on ' else ' commented on ' end || _code(t.id) || ': ' || ex, t.id);
    else
      perform _notify_managers(me.full_name || case k when 'question' then ' asked a question on ' when 'note' then ' posted a work update on '
        else ' commented on ' end || _code(t.id) || ': ' || ex, t.id);
    end if;
  end if;
  return id;
end $$;

create function public.set_question_status(p_comment bigint, p_resolved boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); c comments; ex text;
begin
  select * into c from comments where id = p_comment for update;
  if c.id is null or not can_see_task(c.task_id) then raise exception 'Message not found.'; end if;
  if c.kind <> 'question' then raise exception 'Only questions can be resolved.'; end if;
  ex := left(c.body, 60) || case when length(c.body) > 60 then '…' else '' end;
  if p_resolved then
    update comments set q_status = 'resolved', resolved_by = me.id, resolved_at = now() where id = c.id;
    perform _log(c.task_id, 'Marked question resolved: “' || ex || '”');
    perform _notify(c.author_id, me.full_name || ' marked your question on ' || _code(c.task_id) || ' as resolved', c.task_id);
  else
    update comments set q_status = 'open', resolved_by = null, resolved_at = null where id = c.id;
    perform _log(c.task_id, 'Reopened question: “' || ex || '”');
    perform _notify(c.author_id, me.full_name || ' reopened your question on ' || _code(c.task_id), c.task_id);
  end if;
end $$;

create function public.add_link(p_task bigint, p_label text, p_url text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); id bigint; u text := trim(coalesce(p_url, ''));
begin
  if not can_see_task(p_task) then raise exception 'Task not found.'; end if;
  if u !~* '^https?://' then raise exception 'Links must start with http:// or https://'; end if;
  insert into attachments (task_id, kind, name, url, uploaded_by)
  values (p_task, 'link', coalesce(nullif(trim(p_label), ''), u), u, me.id) returning attachments.id into id;
  perform _log(p_task, 'Added link: ' || coalesce(nullif(trim(p_label), ''), u));
  return id;
end $$;

-- Register a file the browser has just uploaded to private storage.
create function public.register_attachment(p_task bigint, p_path text, p_name text, p_size bigint, p_mime text,
  p_comment bigint default null, p_submission bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _me(); id bigint; v_exists boolean := true;
begin
  if not can_see_task(p_task) then raise exception 'Task not found.'; end if;
  if p_path is null or p_path not like p_task || '/%' then raise exception 'Invalid file location.'; end if;
  if coalesce(p_size, 0) > (_settings()).max_file_bytes then raise exception 'Files can be up to % MB.', (_settings()).max_file_bytes / 1048576; end if;
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = ''task-files'' and name = $1)' into v_exists using p_path;
    if not v_exists then raise exception 'The upload did not finish. Try again.'; end if;
  end if;
  if p_comment is not null and not exists (select 1 from comments where comments.id = p_comment and task_id = p_task and author_id = me.id) then
    raise exception 'Message not found.';
  end if;
  if p_submission is not null and not exists (select 1 from submissions where submissions.id = p_submission and task_id = p_task and worker_id = me.id) then
    raise exception 'Submission not found.';
  end if;
  insert into attachments (task_id, comment_id, submission_id, kind, name, size_bytes, mime, storage_path, uploaded_by)
  values (p_task, p_comment, p_submission, 'file', left(coalesce(nullif(trim(p_name), ''), 'file'), 255), p_size, p_mime, p_path, me.id)
  returning attachments.id into id;
  if p_comment is null and p_submission is null then
    perform _log(p_task, 'Attached file: ' || coalesce(p_name, 'file'));
  end if;
  return id;
end $$;

-- ---------------------------------------------------------------------------
-- Projects and tasks (managers)
-- ---------------------------------------------------------------------------
create function public.create_project(p_name text, p_kind text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); id uuid;
begin
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Enter a project name.'; end if;
  insert into projects (name, kind, created_by) values (trim(p_name), coalesce(nullif(trim(p_kind), ''), 'Other'), me.id) returning projects.id into id;
  perform _log(null, 'Added project ' || trim(p_name));
  return id;
end $$;

create function public._clean_criteria(p text[]) returns text[] language sql immutable as $$
  select coalesce(array_agg(trim(c)) filter (where trim(c) <> ''), '{}') from unnest(coalesce(p, '{}')) c
$$;

create function public._check_assignee(p_user uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = p_user and role = 'worker' and active) then
    raise exception 'Choose an active worker to assign the task to.';
  end if;
end $$;

create function public.create_task(p_project uuid, p_title text, p_description text, p_deliverable text, p_criteria text[],
  p_assignee uuid, p_priority public.task_priority, p_deadline date, p_ask_estimate boolean,
  p_est numeric default 0, p_max numeric default 0) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); id bigint; crit text[] := _clean_criteria(p_criteria);
begin
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Enter a task title.'; end if;
  if not exists (select 1 from projects where projects.id = p_project) then raise exception 'Choose a project.'; end if;
  perform _check_assignee(p_assignee);
  if cardinality(crit) = 0 then raise exception 'Add at least one acceptance criterion.'; end if;
  if length(trim(coalesce(p_deliverable, ''))) = 0 then raise exception 'Describe the expected deliverable.'; end if;
  if not p_ask_estimate and (coalesce(p_est, 0) <= 0 or coalesce(p_max, 0) <= 0) then
    raise exception 'Enter estimated and maximum hours greater than zero.';
  end if;
  insert into tasks (project_id, title, description, deliverable, criteria, assignee_id, priority, deadline,
    est_hours, max_hours, status, created_by)
  values (p_project, trim(p_title), trim(coalesce(p_description, '')), trim(p_deliverable), crit, p_assignee,
    coalesce(p_priority, 'medium'), p_deadline,
    case when p_ask_estimate then 0 else p_est end, case when p_ask_estimate then 0 else p_max end,
    case when p_ask_estimate then 'needs_estimate'::task_status else 'todo'::task_status end, me.id)
  returning tasks.id into id;
  perform _log(id, 'Created task and assigned it to ' || _name(p_assignee)
    || coalesce('. Deadline ' || to_char(p_deadline, 'Mon DD, YYYY'), '')
    || case when p_ask_estimate then '. Waiting for the worker''s time estimate' else ', max ' || _fmt_h(p_max) end);
  perform _notify(p_assignee, 'You were assigned ' || _code(id) || ' ' || trim(p_title)
    || coalesce(' (due ' || to_char(p_deadline, 'Mon DD') || ')', '')
    || case when p_ask_estimate then '. Please submit your time estimate.' else '' end, id);
  return id;
end $$;

create function public.update_task(p_task bigint, p_project uuid, p_title text, p_description text, p_deliverable text,
  p_criteria text[], p_assignee uuid, p_priority public.task_priority, p_deadline date,
  p_est numeric default null, p_max numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); t tasks := _task(p_task); crit text[] := _clean_criteria(p_criteria);
  est numeric := t.est_hours; mx numeric := t.max_hours; st task_status := t.status; budget boolean;
begin
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Enter a task title.'; end if;
  if cardinality(crit) = 0 then raise exception 'Add at least one acceptance criterion.'; end if;
  perform _check_assignee(p_assignee);
  budget := t.status not in ('needs_estimate', 'estimate_submitted');
  if budget then
    est := coalesce(p_est, t.est_hours); mx := coalesce(p_max, t.max_hours);
    if est <= 0 or mx <= 0 then raise exception 'Enter estimated and maximum hours greater than zero.'; end if;
    if mx < _logged(t.id) - 0.0001 then
      raise exception 'Maximum approved hours can''t be lower than the % already logged.', _fmt_h(_logged(t.id));
    end if;
  end if;
  if t.assignee_id <> p_assignee then
    if exists (select 1 from timers where worker_id = t.assignee_id and task_id = t.id) then
      perform _stop_timer(t.assignee_id, 'Timer stopped because the task was reassigned.', true, true, 'task reassigned');
    end if;
    perform _log(t.id, 'Reassigned from ' || _name(t.assignee_id) || ' to ' || _name(p_assignee));
    perform _notify(p_assignee, 'You were assigned ' || _code(t.id) || ' ' || trim(p_title)
      || case when t.status in ('needs_estimate', 'estimate_submitted') then '. Please submit your time estimate.' else '' end, t.id);
    perform _notify(t.assignee_id, _code(t.id) || ' was reassigned to someone else', t.id);
    if t.status = 'estimate_submitted' then
      st := 'needs_estimate';
      perform _log(t.id, 'Changed status from Estimate Submitted to Needs Estimate so the new worker can estimate');
    end if;
  end if;
  if t.deadline is distinct from p_deadline then
    perform _log(t.id, 'Changed deadline from ' || coalesce(to_char(t.deadline, 'Mon DD, YYYY'), 'none') || ' to ' || coalesce(to_char(p_deadline, 'Mon DD, YYYY'), 'none'));
    perform _notify(p_assignee, 'Deadline for ' || _code(t.id) || ' changed to ' || coalesce(to_char(p_deadline, 'Mon DD, YYYY'), 'none'), t.id);
  end if;
  if mx <> t.max_hours then
    perform _log(t.id, 'Changed max approved hours from ' || _fmt_h(t.max_hours) || ' to ' || _fmt_h(mx));
    perform _notify(p_assignee, 'Approved hours for ' || _code(t.id) || ' changed to ' || _fmt_h(mx), t.id);
  end if;
  if est <> t.est_hours then perform _log(t.id, 'Changed estimate from ' || _fmt_h(t.est_hours) || ' to ' || _fmt_h(est)); end if;
  if t.priority <> p_priority then perform _log(t.id, 'Changed priority from ' || initcap(t.priority::text) || ' to ' || initcap(p_priority::text)); end if;
  if t.title <> trim(p_title) or t.description <> trim(coalesce(p_description, '')) or t.deliverable <> trim(coalesce(p_deliverable, ''))
     or t.criteria <> crit or t.project_id <> p_project then
    perform _log(t.id, 'Edited task details');
  end if;
  update tasks set project_id = p_project, title = trim(p_title), description = trim(coalesce(p_description, '')),
    deliverable = trim(coalesce(p_deliverable, '')), criteria = crit, assignee_id = p_assignee, priority = p_priority,
    deadline = p_deadline, est_hours = est, max_hours = mx, status = st, updated_at = now()
  where id = t.id;
  perform _check_warn(t.id);
end $$;

create function public.cancel_task(p_task bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); t tasks := _task(p_task); r text := trim(coalesce(p_reason, ''));
begin
  if t.status in ('completed', 'cancelled') then raise exception 'This task is already %.', _label(t.status); end if;
  if length(r) < 3 then raise exception 'Give a reason for cancelling.'; end if;
  if exists (select 1 from timers where task_id = t.id) then
    perform _stop_timer(t.assignee_id, 'Timer stopped because the task was cancelled.', true, true, 'task cancelled');
  end if;
  update tasks set status = 'cancelled', updated_at = now() where id = t.id;
  perform _log(t.id, 'Changed status from ' || _label(t.status) || ' to Cancelled. Reason: ' || r);
  perform _notify(t.assignee_id, _code(t.id) || ' ' || t.title || ' was cancelled: ' || r, t.id);
end $$;

create function public.reopen_task(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); t tasks := _task(p_task); st task_status;
begin
  if t.status not in ('completed', 'cancelled') then raise exception 'Only completed or cancelled tasks can be reopened.'; end if;
  st := case when t.max_hours > 0 then 'in_progress'::task_status else 'needs_estimate'::task_status end;
  update tasks set status = st, updated_at = now() where id = t.id;
  perform _log(t.id, 'Reopened task. Changed status from ' || _label(t.status) || ' to ' || _label(st));
  perform _notify(t.assignee_id, _code(t.id) || ' was reopened', t.id);
end $$;

-- ---------------------------------------------------------------------------
-- Team, rates and payments (managers)
-- ---------------------------------------------------------------------------
create function public.set_rate(p_worker uuid, p_rate numeric, p_currency text, p_from date) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); cur text := upper(trim(coalesce(p_currency, '')));
  today date := (now() at time zone (_settings()).timezone)::date; first boolean;
begin
  if not exists (select 1 from profiles where id = p_worker and role = 'worker') then raise exception 'Worker not found.'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Enter a rate above zero.'; end if;
  if cur !~ '^[A-Z]{3}$' then raise exception 'Use a 3-letter currency code such as USD.'; end if;
  first := not exists (select 1 from worker_rates where worker_id = p_worker);
  if not first and (p_from is null or p_from < today) then
    raise exception 'A new rate can start today or later. Past entries keep the rate they were logged at.';
  end if;
  insert into worker_rates (worker_id, rate, currency, effective_from, created_by)
  values (p_worker, round(p_rate, 2), cur, case when first then least(coalesce(p_from, today), today - 3650) else p_from end, me.id)
  on conflict (worker_id, effective_from) do update set rate = excluded.rate, currency = excluded.currency, created_by = excluded.created_by, created_at = now();
  perform _log(null, 'Set ' || _name(p_worker) || '''s rate to ' || round(p_rate, 2) || ' ' || cur || '/h'
    || case when first then '' else ' starting ' || to_char(p_from, 'Mon DD, YYYY') end || '. Past entries keep their rate');
  perform _notify(p_worker, 'Your hourly rate is ' || round(p_rate, 2) || ' ' || cur
    || case when first then '' else ' from ' || to_char(p_from, 'Mon DD, YYYY') end, null);
end $$;

create function public.update_profile(p_user uuid, p_full_name text, p_title text, p_role public.user_role, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); p profiles;
begin
  select * into p from profiles where id = p_user for update;
  if p.id is null then raise exception 'Person not found.'; end if;
  if (p_role <> 'manager' or not p_active) and p.role = 'manager'
     and not exists (select 1 from profiles where role = 'manager' and active and id <> p.id) then
    raise exception 'There must be at least one active manager.';
  end if;
  if not p_active and exists (select 1 from timers where worker_id = p.id) then
    perform _stop_timer(p.id, 'Timer stopped because the account was deactivated.', true, true, 'account deactivated');
  end if;
  update profiles set full_name = trim(coalesce(p_full_name, '')), title = trim(coalesce(p_title, '')), role = p_role, active = p_active
  where id = p.id;
  perform _log(null, 'Updated ' || coalesce(nullif(trim(p_full_name), ''), p.email) || ': role ' || p_role || ', ' || case when p_active then 'active' else 'deactivated' end);
end $$;

create function public.create_payments(p_start date, p_end date) returns int
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); tz text := (_settings()).timezone; g record; pid bigint; n int := 0;
  s timestamptz; e timestamptz;
begin
  if p_start is null or p_end is null or p_end <= p_start then raise exception 'Choose a valid period.'; end if;
  s := p_start::timestamp at time zone tz; e := p_end::timestamp at time zone tz;
  for g in
    select worker_id, currency, array_agg(id) ids,
      sum(extract(epoch from ended_at - started_at) / 3600.0) hours,
      sum(extract(epoch from ended_at - started_at) / 3600.0 * rate) amount
    from time_entries
    where status = 'approved' and superseded_by is null and payment_id is null and started_at >= s and started_at < e
    group by worker_id, currency
  loop
    insert into payments (worker_id, currency, period_start, period_end, hours, amount, created_by)
    values (g.worker_id, g.currency, p_start, p_end - 1, round(g.hours, 2), round(g.amount, 2), me.id) returning id into pid;
    update time_entries set payment_id = pid where id = any (g.ids);
    perform _log(null, 'Created payment record #' || pid || ' for ' || _name(g.worker_id) || ': ' || round(g.amount, 2) || ' ' || g.currency
      || ' (' || _fmt_h(g.hours) || ')');
    n := n + 1;
  end loop;
  return n;
end $$;

create function public.set_payment_status(p_payment bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager(); p payments;
begin
  if p_status not in ('paid', 'unpaid') then raise exception 'Invalid status.'; end if;
  select * into p from payments where id = p_payment for update;
  if p.id is null then raise exception 'Payment record not found.'; end if;
  update payments set status = p_status, paid_at = case when p_status = 'paid' then now() end,
    paid_by = case when p_status = 'paid' then me.id end where id = p.id;
  perform _log(null, 'Marked payment record #' || p.id || ' (' || _name(p.worker_id) || ', ' || p.amount || ' ' || p.currency || ') as ' || p_status);
  if p_status = 'paid' then
    perform _notify(p.worker_id, 'Payment record #' || p.id || ' (' || p.amount || ' ' || p.currency || ') was marked as paid', null);
  end if;
end $$;

create function public.update_settings(p_org_name text, p_timezone text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles := _require_manager();
begin
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'Unknown time zone.'; end if;
  update app_settings set org_name = coalesce(nullif(trim(p_org_name), ''), org_name), timezone = p_timezone where id = 1;
  perform _log(null, 'Updated settings: time zone ' || p_timezone);
end $$;

create function public.mark_notifications_read(p_ids bigint[] default null) returns void
language sql security definer set search_path = public as $$
  update notifications set read = true where user_id = auth.uid() and (p_ids is null or id = any (p_ids))
$$;

-- Hours per task, computed from all entries (workers can't see each other's
-- entries, so the app asks the server for totals).
create function public.task_hours(p_ids bigint[])
returns table (task_id bigint, logged numeric, approved numeric, pending numeric, running numeric, running_since timestamptz, running_worker uuid)
language sql stable security definer set search_path = public as $$
  select t.id,
    _logged(t.id),
    coalesce((select sum(extract(epoch from ended_at - started_at) / 3600.0) from time_entries e
      where e.task_id = t.id and e.status = 'approved' and e.superseded_by is null), 0),
    coalesce((select sum(extract(epoch from ended_at - started_at) / 3600.0) from time_entries e
      where e.task_id = t.id and e.status = 'pending' and e.superseded_by is null and e.kind <> 'correction'), 0),
    _running(t.id),
    (select started_at from timers where timers.task_id = t.id limit 1),
    (select worker_id from timers where timers.task_id = t.id limit 1)
  from tasks t
  where t.id = any (p_ids) and can_see_task(t.id)
$$;

-- ---------------------------------------------------------------------------
-- New sign-ins get a profile. The very first person becomes the manager;
-- everyone after that starts as a worker (a manager can change roles).
-- ---------------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, title, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'title', ''),
    case when exists (select 1 from profiles where role = 'manager') then 'worker'::user_role else 'manager'::user_role end)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Grants: only the public API functions are callable by signed-in users.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_member(), public.is_manager(), public.can_see_task(bigint),
  public.sync_timers(), public.start_timer(bigint), public.stop_timer(text), public.add_entry_summary(bigint, text),
  public.add_manual_entry(bigint, timestamptz, timestamptz, text, text),
  public.request_correction(bigint, timestamptz, timestamptz, text),
  public.decide_entry(bigint, boolean, text), public.decide_entries(bigint[], boolean, text),
  public.submit_estimate(bigint, numeric, text), public.decide_estimate(bigint, boolean, numeric, text),
  public.request_hours(bigint, numeric, text), public.decide_hours(bigint, boolean, text),
  public.mark_started(bigint), public.report_blocker(bigint, text), public.resolve_blocker(bigint),
  public.submit_work(bigint, text, jsonb, int[]), public.decide_work(bigint, boolean, text),
  public.post_comment(bigint, text, text, bigint), public.set_question_status(bigint, boolean),
  public.add_link(bigint, text, text), public.register_attachment(bigint, text, text, bigint, text, bigint, bigint),
  public.create_project(text, text),
  public.create_task(uuid, text, text, text, text[], uuid, public.task_priority, date, boolean, numeric, numeric),
  public.update_task(bigint, uuid, text, text, text, text[], uuid, public.task_priority, date, numeric, numeric),
  public.cancel_task(bigint, text), public.reopen_task(bigint),
  public.set_rate(uuid, numeric, text, date), public.update_profile(uuid, text, text, public.user_role, boolean),
  public.create_payments(date, date), public.set_payment_status(bigint, text), public.update_settings(text, text),
  public.mark_notifications_read(bigint[]), public.task_hours(bigint[])
to authenticated;

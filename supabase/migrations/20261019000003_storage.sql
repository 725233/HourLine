-- Private file storage for task attachments. Files live under
-- task-files/<task id>/... and can only be uploaded or read by people who
-- can see that task. The app hands out short-lived signed links for downloads.

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-files', 'task-files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.task_id_from_path(p_name text) returns bigint
language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9]{1,18}$' then split_part(p_name, '/', 1)::bigint end
$$;
grant execute on function public.task_id_from_path(text) to authenticated;

create policy "task files: upload to visible tasks" on storage.objects for insert to authenticated
  with check (bucket_id = 'task-files' and public.can_see_task(public.task_id_from_path(name)));

create policy "task files: read visible tasks" on storage.objects for select to authenticated
  using (bucket_id = 'task-files' and public.can_see_task(public.task_id_from_path(name)));

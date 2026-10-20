-- Every minute, stop timers that reached their approved-hour limit and send
-- 80% warnings, even if nobody has the app open.
-- Requires the pg_cron extension (Supabase: Database > Extensions > pg_cron).

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('hourline-sync-timers', '* * * * *', $$select public.sync_timers()$$);

begin;

create table if not exists public.plan_b_daily (
  issue_date date not null check (issue_date >= date '2026-11-21'),
  country text not null check (country in ('kz','uz','kg','tj','az')),
  step text not null check (step in ('preview','final','editorial','release','word','wechat','readback')),
  state text not null check (state in ('working','retry','blocked','ready')),
  attempt integer not null default 0 check (attempt between 0 and 2),
  lease_id uuid,
  lease_until timestamptz,
  retry_after timestamptz,
  receipt jsonb,
  updated_at timestamptz not null default statement_timestamp(),
  primary key (issue_date, country, step)
);

alter table public.plan_b_daily enable row level security;
revoke all on public.plan_b_daily from public, anon, authenticated;
grant select, insert, update on public.plan_b_daily to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plan-b-work', 'plan-b-work', false, 41943040,
        array['application/gzip','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'plan-b-work' and public is not false) then
    raise exception 'Plan B staging bucket must be private';
  end if;
end $$;

-- The existing reviewed_deliveries locks still govern every WeChat create.
-- This lease only serializes the preparation/Word/ingestion of the same step.
create or replace function public.claim_plan_b_step(
  target_issue date, target_country text, target_step text, owner uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  stamp timestamptz := statement_timestamp();
  bj_at timestamp := stamp at time zone 'Asia/Shanghai';
begin
  if target_issue is distinct from bj_at::date or not (
    case when target_step = 'preview' then bj_at::time >= time '04:45' and bj_at::time < time '05:50'
         when target_step in ('final','release','word','wechat') then bj_at::time >= time '06:00' and bj_at::time < time '09:00'
         when target_step = 'readback' then bj_at::time >= time '06:00' and bj_at::time < time '09:30'
         else false end
  ) then
    return false;
  end if;
  if target_step = 'wechat' then
    if not pg_try_advisory_xact_lock(hashtextextended('plan_b_wechat:' || target_issue::text, 0)) then
      return false;
    end if;
    if (select count(*) from public.plan_b_daily
        where issue_date = target_issue and step = 'wechat' and state = 'working' and lease_until > stamp) >= 2 then
      return false;
    end if;
  end if;
  insert into public.plan_b_daily as job (issue_date,country,step,state,attempt,lease_id,lease_until)
  values (target_issue,target_country,target_step,'working',1,owner,stamp+interval '18 minutes')
  on conflict (issue_date,country,step) do update set state='working',attempt=job.attempt+1,
    lease_id=owner,lease_until=stamp+interval '18 minutes',updated_at=stamp
  where job.attempt<2 and (job.state='retry' and job.retry_after<=stamp
      or job.state='working' and job.lease_until<=stamp);
  return found;
end;
$$;

revoke all on function public.claim_plan_b_step(date,text,text,uuid) from public, anon, authenticated;
grant execute on function public.claim_plan_b_step(date,text,text,uuid) to service_role;

commit;

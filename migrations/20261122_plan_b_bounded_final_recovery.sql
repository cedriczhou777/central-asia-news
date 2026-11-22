begin;

-- Existing rows and delivered manuscripts are not rewritten. Only future
-- finalization gets one additional focused recovery, never another full crawl.
alter table public.plan_b_daily drop constraint plan_b_daily_attempt_check;
alter table public.plan_b_daily add constraint plan_b_daily_attempt_check check (
  attempt between 0 and case when step='final' and issue_date>=date '2026-11-23' then 3 else 2 end
);

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
  ) then return false; end if;
  if target_step = 'wechat' then
    if not pg_try_advisory_xact_lock(hashtextextended('plan_b_wechat:' || target_issue::text, 0)) then return false; end if;
    if (select count(*) from public.plan_b_daily
        where issue_date = target_issue and step = 'wechat' and state = 'working' and lease_until > stamp) >= 2
      then return false; end if;
  end if;
  insert into public.plan_b_daily as job (issue_date,country,step,state,attempt,lease_id,lease_until)
  values (target_issue,target_country,target_step,'working',1,owner,stamp+interval '18 minutes')
  on conflict (issue_date,country,step) do update set state='working',attempt=job.attempt+1,
    lease_id=owner,lease_until=stamp+interval '18 minutes',updated_at=stamp
  where job.attempt < case when target_step='final' and target_issue>=date '2026-11-23' then 3 else 2 end
    and (job.state='retry' and job.retry_after<=stamp
      or job.state='working' and job.lease_until<=stamp
      or target_step='final' and target_issue>=date '2026-11-23' and job.state='blocked'
        and job.receipt->>'reason'='freeze_incomplete' and job.receipt ? 'cache');
  return found;
end;
$$;
revoke all on function public.claim_plan_b_step(date,text,text,uuid) from public, anon, authenticated;
grant execute on function public.claim_plan_b_step(date,text,text,uuid) to service_role;

commit;

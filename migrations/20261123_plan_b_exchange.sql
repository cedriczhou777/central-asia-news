begin;
-- One private exchange for parsed originals, immutable Work commands and audit.
-- No existing production rows, packages, delivery receipts or storage are changed.
create table public.plan_b_exchange (
 issue_date date not null,
 country text not null check(country in ('kz','uz','kg','tj','az','global')),
 kind text not null check(kind in ('original','manifest','health','word','checkpoint','submission','manual_authorization','manual_use')),
 record_key text not null check(length(record_key) between 1 and 512),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=2097152),
 state text not null default 'available' check(state in ('available','queued','working','accepted','rejected')),
 attempts integer not null default 0 check(attempts between 0 and 3),
 lease_until timestamptz,
 result jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(issue_date,country,kind,record_key)
);
alter table public.plan_b_exchange enable row level security;
revoke all on public.plan_b_exchange from public,anon,authenticated;
grant select,insert,update on public.plan_b_exchange to service_role;
create index plan_b_exchange_inbox on public.plan_b_exchange(issue_date,created_at)
 where kind in ('checkpoint','submission') and state in ('queued','working');

create function public.claim_plan_b_exchange(target_issue date)
returns setof public.plan_b_exchange language sql security invoker set search_path='' as $$
 with selected as (
   select issue_date,country,kind,record_key from public.plan_b_exchange
   where issue_date=target_issue and kind in ('checkpoint','submission') and attempts<3
    and (state='queued' or state='working' and lease_until<statement_timestamp())
   order by created_at,kind limit 5 for update skip locked
 )
 update public.plan_b_exchange q set state='working',attempts=q.attempts+1,
  lease_until=statement_timestamp()+interval '5 minutes',updated_at=statement_timestamp()
 from selected s where (q.issue_date,q.country,q.kind,q.record_key)=(s.issue_date,s.country,s.kind,s.record_key)
 returning q.*;
$$;
revoke all on function public.claim_plan_b_exchange(date) from public,anon,authenticated;
grant execute on function public.claim_plan_b_exchange(date) to service_role;
commit;

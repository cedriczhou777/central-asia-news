begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table public.reviewed_deliveries drop constraint reviewed_deliveries_state_check;
alter table public.reviewed_deliveries add constraint reviewed_deliveries_state_check check (state in ('preparing','failed','sending','succeeded','uncertain','updating'));
commit;

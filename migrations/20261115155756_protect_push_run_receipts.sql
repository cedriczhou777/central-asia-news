-- Applied through the project migration service after user authorization.
-- Version/name copied from the actual production migration record.
-- Operational push receipts are server-owned. Never expose them through client roles.
ALTER TABLE public.push_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.push_runs TO service_role;

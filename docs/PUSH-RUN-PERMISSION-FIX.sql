-- Applied production permission repair: 20261115155756_protect_push_run_receipts.
-- The receipt API uses the server-side service_role client without a user token.
-- Initially blocked by automatic review; applied after the user authorized this scope.
-- Verified: client roles denied, service_role SELECT/INSERT/UPDATE work with zero-row probes.
-- This reference file is not executed automatically by application deployment.
-- Operational push receipts are server-owned. Never expose them through client roles.
ALTER TABLE public.push_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.push_runs TO service_role;

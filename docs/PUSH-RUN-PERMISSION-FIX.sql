-- Proposed production permission repair; NOT applied automatically.
-- The receipt API uses the server-side service_role client without a user token.
-- Actual permission migration was rejected by automatic approval review.
-- Requires explicit user authorization for this production table permission change.
-- Operational push receipts are server-owned. Never expose them through client roles.
ALTER TABLE public.push_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.push_runs TO service_role;

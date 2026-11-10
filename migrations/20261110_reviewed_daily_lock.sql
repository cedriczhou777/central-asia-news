-- Prevent different revisions of the same issue from creating two drafts for one country.
-- Failed before sending and without a media_id may be retried in a later version.
-- Existing conflicting rows make CREATE UNIQUE INDEX fail; resolve only after
-- inspecting the existing drafts and receipts, never by automatically deleting rows.
CREATE UNIQUE INDEX IF NOT EXISTS reviewed_deliveries_one_active_daily_country
  ON public.reviewed_deliveries ((left(version, 10)), country)
  WHERE state <> 'failed' OR media_id IS NOT NULL;

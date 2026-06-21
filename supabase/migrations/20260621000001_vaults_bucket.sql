-- SPRINT-047: declare the `vaults` Storage bucket as a migration so it
-- exists in EMDEE-test (and any future Supabase project) without manual
-- dashboard creation. The bucket existed in EMDEE-prod only because it
-- was created via the dashboard during initial setup — never captured
-- as code. Discovered when EMDEE-test's seed failed with "Bucket not found".
--
-- Idempotent: ON CONFLICT DO NOTHING. Re-applies on prod as a no-op.
-- Private (public:false): the renderer fetches vault markdown via the
-- service-role admin client, never directly from the bucket. Files are
-- markdown only — no need for MIME-type restrictions.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vaults',
  'vaults',
  false,
  10485760,
  NULL
)
ON CONFLICT (id) DO NOTHING;

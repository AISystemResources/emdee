-- SPRINT-042: public image storage bucket for vault images uploaded via
-- the upload_image MCP tool. Public so image URLs work directly in
-- rendered markdown without a proxy. Service-role writes only
-- (the MCP tool uses adminClient — direct client uploads are refused).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vault-images',
  'vault-images',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

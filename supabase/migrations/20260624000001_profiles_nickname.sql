-- Add nickname column to profiles.
-- Used to pre-populate the owner node name (e.g. "Edmund", "Lisa") before a user
-- signs in, so vault seed uses the right name instead of deriving one from the email.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS nickname text;

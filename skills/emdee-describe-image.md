---
name: emdee-describe-image
description: |
  Use whenever you encounter an EMDEE vault doc under IMAGES/ whose summary is
  `_description pending_` or whose title looks like a timestamp
  (`IMAGE-14-19-31`, `PHOTO-2026-06-05-...`). The upload flow creates docs in
  this shape by design — this skill fills in the meaning.
---

# emdee-describe-image — rename + summarise uploaded images

When you see an EMDEE image doc that hasn't been described yet, run this workflow. Pure `emdee` CLI — no MCP calls. Every command routes through the authenticated cloud vault via `--remote`.

## Trigger patterns

Any vault doc where:
- Path matches `IMAGES/**/*.md` OR `images/**/*.md`, and
- Summary blockquote is exactly `_description pending_`, OR
- Title matches `IMAGE-\d{2}-\d{2}-\d{2}` or `PHOTO-\d{4}-\d{2}-\d{2}-.*`

## Workflow (4 steps)

### 1. Read the image

```bash
emdee get-image --doc-path <PATH> --out /tmp/img.png --remote
```

Then read `/tmp/img.png` — you'll see it as a visual content block and can describe what's in it.

### 2. Compose

- **Semantic title**, 3-6 words, UPPERCASE-with-HYPHENS. Describe the subject, not the container.
  - Good: `HANDSTAND-BALANCE-DRILL`, `AIDA-WORKSHOP-WHITEBOARD`, `KOBE-BRYANT-CAPS-SPEECH`
  - Bad: `PHOTO`, `IMAGE-OF-MAN-STANDING`, `image-14-19-31` (not uppercase, not descriptive)
- **One-line summary**, 15-30 words, that a future search would surface. What is this, why was it captured, what does it show?

### 3. Rename

```bash
emdee rename-doc --old-path <PATH> --new-title <TITLE> --remote
```

Atomically:
- Rewrites the H1
- Moves the file (default: same folder, `<TITLE>.md`)
- Updates every `[[<old title>]]` wiki-link across the vault

### 4. Replace the summary

Fetch the fresh preamble hash:

```bash
emdee get-doc --path <NEW-PATH> --remote --json
```

Take `preamble.content_hash` from the response, then:

```bash
emdee patch-preamble --path <NEW-PATH> \
  --body "> <your 15-30 word summary>" \
  --expected-hash <hash> --remote
```

## Batch mode

If several images need describing:

```bash
emdee list-docs --prefix "IMAGES/" --remote --format text | \
  xargs -I{} emdee get-summary --path {} --remote --format text
```

Filter for `_description pending_` in the output, then run the 4-step workflow per image. Cap at 20 per batch — image content is high-signal but you can misread ambiguous shots at scale.

## Failure modes

- **Title collision** — `rename-doc` returns `title_conflict`. Pick a more specific title (add a subject qualifier).
- **`_description pending_` was already replaced** — someone else already ran this. `emdee get-doc` will show the new summary; skip.
- **Image is illegible** — set the summary to `> Illegible / unable to describe from image alone.` and flag it in the user-facing report so they can annotate manually.

## What to report at the end

For each image processed:

```
<old-path> → <new-path>
  <title>
  <summary>
```

So the user can sanity-check without opening each doc.

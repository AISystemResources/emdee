---
name: emdee-describe-image
description: |
  Use whenever you encounter an EMDEE vault doc under IMAGES/ whose summary is
  `_description pending_` or whose title looks like a timestamp
  (`IMAGE-14-19-31`, `PHOTO-2026-06-05-...`). The upload flow creates docs in
  this shape by design — this skill fills in the meaning.
---

# emdee-describe-image — rename + summarise uploaded images

When you see an EMDEE image doc that hasn't been described yet, run this workflow. It uses the existing `get_image` + `rename_doc` + `patch_preamble` MCP tools (or their `emdee` CLI equivalents) — no new server-side dependencies.

## Trigger patterns

Any vault doc where:
- Path matches `IMAGES/**/*.md` OR `images/**/*.md`, and
- Summary blockquote is exactly `_description pending_`, OR
- Title matches `IMAGE-\d{2}-\d{2}-\d{2}` or `PHOTO-\d{4}-\d{2}-\d{2}-.*`

## Workflow (4 steps)

### 1. Read the image

```
get_image(doc_path=<PATH>)
```

Or via CLI (when SPRINT-091 chunk 4 lands `get-image`):

```
emdee get-image --path <PATH> --remote
```

The MCP tool returns the image as a visual content block — you can see it.

### 2. Compose

- **Semantic title**, 3-6 words, UPPERCASE-with-HYPHENS. Describe the subject, not the container.
  - Good: `HANDSTAND-BALANCE-DRILL`, `AIDA-WORKSHOP-WHITEBOARD`, `KOBE-BRYANT-CAPS-SPEECH`
  - Bad: `PHOTO`, `IMAGE-OF-MAN-STANDING`, `image-14-19-31` (not uppercase, not descriptive)
- **One-line summary**, 15-30 words, that a future search would surface. What is this, why was it captured, what does it show?

### 3. Rename

```
emdee rename-doc --old-path <PATH> --new-title <TITLE> --remote
```

The tool atomically:
- Rewrites the H1
- Moves the file (default: same folder, `<TITLE>.md`)
- Updates every `[[<old title>]]` wiki-link across the vault

### 4. Replace the summary

Fetch the fresh preamble hash:

```
emdee get-doc --path <NEW-PATH> --remote --json
```

Take `preamble.content_hash` from the response, then:

```
emdee patch-preamble --path <NEW-PATH> \
  --body "> <your 15-30 word summary>" \
  --expected-hash <hash> --remote
```

## Batch mode

If several images need describing:

```
emdee list-docs --prefix "IMAGES/" --remote | \
  xargs -I{} emdee get-summary --path {} --remote --format text
```

Filter for `_description pending_` in the output, then run the 4-step workflow per image. Cap at 20 per batch — image content is high-signal but you can misread ambiguous shots at scale.

## Failure modes

- **Title collision** — `rename_doc` returns `title_conflict`. Pick a more specific title (add a subject qualifier).
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

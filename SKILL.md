# EMDEE Conventions Skill

Operational conventions for working inside an EMDEE vault. Apply these rules in every session without needing to re-read INSTRUCTIONS docs.

---

## Media assets

EMDEE is the canonical media host. Every binary (image, future video/audio) is stored in Supabase Storage and its stable public URL is recorded in a vault node under `images/`. Consumers (whatelz.ai, content drafting, training sets) find assets by searching EMDEE and reading the URL from the node — never by guessing paths or storing copies.

### Storage

- **Bucket:** `vault-images` (public-read). Add new buckets for AV only when AV actually lands.
- **Object path convention:** `{userId}/{role}-{subject}[-{variant}]-{timestamp}.{ext}`
- **Upload endpoint:** `POST /api/media` — returns `{ public_url, storage_path }`. No vault doc is created; annotation is a separate step.
- **Public URL shape:** `{SUPABASE_URL}/storage/v1/object/public/vault-images/{userId}/{filename}` — stable, no expiry.

### Vault node shape

Every media asset gets one `.md` node under `images/`, child of `images/IMAGES.md`.

**Summary line format:** `MEDIA-{PROJECT}-{role} · {subject}[—{variant}] — {one-line description}`

The leading `MEDIA-{PROJECT}-{role}` is a **hyphenated key token** — a single contiguous substring used for reliable retrieval. `search` is a contiguous-substring matcher; space-separated words do not match `·`-separated text. The key token has no spaces, making it an exact hit.

Example summary: `MEDIA-WHATELZ-cover · whatelz — primary cover image for whatelz.ai`

**Required section:** `## Asset` — machine-readable key-value block. Parse this section for data; never scrape prose.

```markdown
## Asset

url: https://xyz.supabase.co/storage/v1/object/public/vault-images/user_xxx/cover-whatelz-2026-06-09T12-00-00.jpg
storage_bucket: vault-images
storage_path: user_xxx/cover-whatelz-2026-06-09T12-00-00.jpg
role: cover
project: WHATELZ
subject: whatelz
variant:
format: image/jpeg
dimensions: 1200x630
alt: Cover image for whatelz.ai
used_on: [[WHATELZ]]
status: active
captured: 2026-06-09
```

All fields are optional except `url`. Omit unknown fields rather than leaving them blank.

### Role vocabulary (controlled)

| Role | Slot type | Meaning |
|---|---|---|
| `cover` | single | Primary cover / hero image for a project or page |
| `hero` | single | Full-width banner hero image |
| `og-image` | single | Open Graph / social share image |
| `logo` | single | Project or brand logo |
| `icon` | single | App icon or favicon |
| `avatar` | single | Person or account avatar |
| `thumbnail` | multi | Small preview image |
| `screenshot` | multi | UI or product screenshot |
| `diagram` | multi | Architecture or flow diagram |
| `banner` | multi | Decorative banner image |
| `gallery` | multi | Gallery item — no slot constraint |

**Single-slot invariant:** at most one `status: active` per `(project, role)` pair for single-slot roles. Before activating a new cover/hero/logo, set the previous one to `status: archived`.

### Canonical query pattern

To find an asset: `search("MEDIA-{PROJECT}-{role}")` — matches the key token exactly because it is a single hyphenated substring with no separators.

Examples:
- `search("MEDIA-WHATELZ-cover")` → the active cover image for WHATELZ
- `search("MEDIA-ATLAS-screenshot")` → all screenshots for ATLAS

Extract the URL from `## Asset`, never from prose.

### Labelling stored images

Use the `get_image(doc_path)` MCP tool (available in both Chat and Code sessions via the HTTP connector). It fetches the binary from Supabase Storage and returns an MCP image content block — the calling model sees the pixels, not a base64 string. Workflow:

1. `list_docs` → find `images/*.md` with `_description pending_` in summary
2. `get_image("images/xxx.md")` → see the image
3. `patch_preamble` → write `MEDIA-{PROJECT}-{role} · {subject} — {description}` as the summary
4. `add_association` → link to relevant project/person/event

### Lint

`lint_doc` fires `media_asset_missing_url` when a `## Asset` section exists but has no `url:` line. Fix by adding the Supabase Storage URL before publishing the node.

### Workflow: upload → annotate

1. Upload binary via `POST /api/media` (role + subject + optional variant + file) → get `{ public_url, storage_path }`
2. Create vault node: `create_child(parent_path="images/IMAGES.md", title="MEDIA-{PROJECT}-{role} · {subject}", summary="MEDIA-{PROJECT}-{role} · {subject} — {one-line description}")`
3. `patch_section` the `## Asset` block with all known fields, `url:` first
4. `add_association` to the relevant project/person/event node
5. If replacing an active single-slot asset: `patch_section` the old node's `## Asset` to set `status: archived`

---

## Session start

Every Claude session — Chat or Code — does three things before anything else:

1. Identify which agent you are: **Claude Chat** or **Claude Code**. The protocols differ (see Lane model below).
2. Read the protocol section for your agent.
3. Tag every vault doc write with `— [agent name, YYYY-MM-DD]`.

After identifying, also read:
- **CONTEXT** before any product-related task. Don't invent features.
- **BUILD → Current Focus** before engineering work.
- **INBOX** (Chat only) — scan for `**Status:** proposed` items and triage (see INBOX coordination below).
- **Session end (Chat only):** sweep BUILD for `Status: shipped` items past archive window → migrate to LOGS, extract any LEARNINGS first.

---

## Lane model

### Claude Chat
- Reads everything.
- Writes to: CONTEXT, INSTRUCTIONS, BUILD specs (not close-outs).
- Drafts Claude Code prompts. Does not execute engineering itself.
- Never writes BUILD close-outs — that's Claude Code's lane.
- Surfaces and proposes; doesn't commit decisions without human confirmation.

### Claude Code
- Reads BUILD → target sprint section, in that order.
- Works one sprint at a time.
- Flips status `queued → in-progress` before writing code.
- Appends close-out to the same sprint section: commit SHA, files touched, follow-ups.
- Flips to `blocked` with context if stuck — never silently drops a sprint.
- **Never writes to CONTEXT or INSTRUCTIONS.**

---

## Sprint conventions

Sprint IDs are monotonic integers: `NNN-AREA-NAME`. Never reused. One sprint = one section in BUILD. Spec and close-out live in the same section.

### Frontmatter schema

```
**Type:** dev | ops
**Category:** feature | bug | tech-debt | refactor | spike | chore | docs
**Status:** queued | in-progress | blocked | shipped
**Owner:** chat | code
```

### Archive rules (BUILD → LOGS)

- dev sprints: `Status: shipped` AND last updated > 3 days ago
- ops sprints: `Status: shipped` AND last updated > 24 hours ago
- `Severity: critical` ops: skip until a LEARNING is extracted first

---

## Writing discipline

1. **Tag every entry** — `— [agent name, YYYY-MM-DD]`. Without attribution there's no way to know which agent made a change or when.
2. **Append before overwrite.** Overwriting is irreversible — appending preserves history.
3. **`patch_section` replaces the whole section.** Anything not in the payload is gone. Use `append_section` for additive changes.
4. **Never `write_doc` without a preview pass** (`write_doc_preview` first).
5. **Short entries win.** Context windows are finite; dense docs slow every future read.
6. **One sprint, one section, full story.** Spec + close-out in the same section.
7. **Don't rewrite archived sprints.** Reference beats rewrite — rewriting history breaks the audit trail.
8. **Patches to INSTRUCTIONS must cite a reason.** Rules without reasons accumulate silently.

---

## INBOX coordination

INBOX is the coordination layer between a project and external agents. External agents write structured proposals; Claude Chat triages at session start.

### Four triage decisions

| Decision | When | Chat autonomous? |
|---|---|---|
| Accept | Clear, in-scope, authorized | ✅ Yes |
| Acknowledge | Requires human sign-off | ⛔ No |
| Reject | Out of scope / malformed / covered | ✅ Yes |
| Defer | Valid but not actionable now | ✅ Yes |

**Chat must NOT** unilaterally update CONTEXT or INSTRUCTIONS based on an INBOX proposal — always surface to human first.

### Proposal format

Heading: `NNN-FROM-AGENT-SHORT-NAME`. Required body fields: `**From:**`, `**Date:**`, `**Status:**`, `### Proposal`, `### Why`, `### Action requested`, `### Response`.

// One-off: write the four shipped sprints (SPRINT-008..011) describing
// the work landed this session, then update EMDEE_OS — LOGS to link
// them. Storage stays canonical; the vault_files cache is mirrored in
// the same call so the UI/MCP see them immediately.
//
// Run from project root: node scripts/log-session-sprints.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const NAMESPACE = "user_3DbybqEDdQdhvmvBFTmpZEAcQLS";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const bucket = sb.storage.from("vaults");

async function writeDoc(relPath, content) {
  const fullPath = `${NAMESPACE}/${relPath}`;
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error: upErr } = await bucket.upload(fullPath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (upErr) throw new Error(`upload ${fullPath}: ${upErr.message}`);
  const { error: cacheErr } = await sb
    .from("vault_files")
    .upsert(
      { namespace: NAMESPACE, file_path: relPath, content, updated_at: new Date().toISOString() },
      { onConflict: "namespace,file_path" }
    );
  if (cacheErr) throw new Error(`cache ${relPath}: ${cacheErr.message}`);
  console.log(`  wrote ${relPath}`);
}

const SPRINT_008 = `# EMDEE_OS — SPRINT-008

> 008-SHARING-V1. Multi-user node sharing with email-based invites, hierarchy cascade, and read-only cross-namespace access for grantees. Extends the access-control spec from [[EMDEE_OS — SPRINT-006]] with real UX, an invitation flow that survives signup, and MCP integration so the grantee's Claude sees shared docs alongside their own vault.

## Child of

* [[EMDEE_OS — LOGS]]

## What shipped

* **Schema.** Added \`share_root\` to the existing \`doc_shares\` table (so cascade groups can be revoked atomically) and a new \`share_invitations\` table for invites to emails not yet on emdee — \`token\`, \`status: pending | accepted | revoked\`, \`expires_at\` not needed because the OAuth tokens carry the access window.
* **API.** \`POST /api/share\` creates a share if the email is a registered profile, otherwise pre-stages an invitation. Cascades by default through the hierarchy: walks \`## Parent of\` edges from the focal and writes one row per descendant tagged with \`share_root = focal_path\`. \`GET /api/share?path=\` returns shares grouped per recipient with a \`doc_count\`. \`GET /api/share/suggestions\` powers history-based autocomplete in the modal. \`GET /api/share/lookup?email=\` resolves an exact email to a profile. \`DELETE /api/share/:id?kind=\` revokes the whole cascade group in one query.
* **Web UI.** Share icon (top-right of graph bar) opens a Google-Drive-style modal:
  1. Partial input — no autocomplete; hint asks to keep typing.
  2. Complete email matching a registered profile — "Share with X (registered user)" and \`Enter\` to commit.
  3. Complete email not in the DB — "Invite X" creates a pending invitation row.
  Autocomplete-while-typing only surfaces previously-invited contacts. Recipients list with per-row Remove that revokes the entire cascade.
* **Grantee side.** A real \`SHARED.md\` doc is seeded into every namespace (\`scripts/seed-shared-doc.mjs\`, idempotent) and wired as a child of \`VAULT\`. The sidebar tree attaches synthetic per-share children under it; clicking renders the shared doc read-only with a yellow banner naming the owner. New \`/api/shared\` returns each shared doc's content via the cache so the sidebar populates in one round-trip. \`/api/doc\` GET added with cross-namespace authorization via a \`doc_shares\` lookup.
* **Email backfill + invitation auto-claim.** \`ensureProfile()\` now fetches the user's primary email from \`clerkClient\` when the row's \`email\` is null, then looks up any pending invitations addressed to that email and materializes them into \`doc_shares\` (marking the invitations accepted). Fires fire-and-forget from \`/api/index\` so existing users get backfilled on their next page load.
* **MCP exposure.** \`loadVaultIndex()\` merges in docs the user has been granted access to under \`__shared__/<owner_id>/<path>\` paths. \`readVaultFile\` dispatches reads cross-namespace with a permission check; \`writeVaultFile\` / \`deleteVaultFile\` refuse \`__shared__/\` paths so every write tool errors cleanly. Claude.ai can list, read, and search shared docs alongside the user's own.

## Why

I need to invite collaborators (DoubleLead devs, hackathon teammates) into specific project subtrees, give them read-only access, and have their Claude.ai pick it up too. The flow has to feel like Google Drive — type an email, hit Enter, done — and degrade gracefully when the email isn't on emdee yet (invitation pending, auto-materializes on signup).

## Technical notes

* **Cascade groups.** \`share_root\` carries the focal path of the cascade. Every descendant in a single share call gets the same \`share_root\`; revoke uses it to atomically remove the whole subtree of shares. The \`share_invitations\` table mirrors the same column so cascade invites work pre-signup too.
* **Title vs path resolution.** Wiki-links resolve by title across namespaces. Shared docs keep the owner's H1 titles; the synthetic SHARED branch uses sibling-common-prefix stripping in the tree renderer so \`ATLAS — BUILD\` displays as just \`BUILD\` under SHARED (see [[EMDEE_OS — SPRINT-011]]).
* **Single source of truth for permissions.** \`doc_shares\` is the only place access lives. MCP's per-doc check (\`shareAccess\`) and the API's \`/api/shared\` both read from there; nothing is cached client-side.

## Files touched

* \`src/lib/supabase/oauth.ts\` — \`ensureProfile\` + \`claimPendingInvitations\`
* \`app/api/share/route.ts\`, \`app/api/share/[id]/route.ts\`, \`app/api/share/suggestions/route.ts\`, \`app/api/share/lookup/route.ts\`, \`app/api/shared/route.ts\`
* \`app/api/doc/route.ts\` — GET + share-based access check
* \`app/components/ShareModal.tsx\`, \`app/components/App.tsx\`, \`app/components/GraphViewInner.tsx\`
* \`src/lib/mcp/tools/vault.ts\` — \`loadVaultIndex\` + cross-namespace \`readVaultFile\`
* \`scripts/seed-shared-doc.mjs\`

— Claude Opus 4.7, 2026-05-15
`;

const SPRINT_009 = `# EMDEE_OS — SPRINT-009

> 009-VAULT-FILES-CACHE. Postgres mirror of vault content as a fast bulk-read index. Storage stays canonical; \`vault_files\` is a derived cache that turns \`/api/index\` from ~150 HTTPS GETs into one SELECT.

## Child of

* [[EMDEE_OS — LOGS]]

## What shipped

* **Schema.** \`vault_files (namespace text, file_path text, content text, updated_at timestamptz, PK (namespace, file_path))\`. One row per .md file in the bucket. Backfilled from existing Storage via \`scripts/backfill-vault-files.mjs\`.
* **Cache pattern.** Storage is canonical — every write hits \`bucket.upload\` first; only after success does \`SupabaseStorage.write\` mirror the bytes into \`vault_files\`. Cache mirror failures are logged but never roll back the Storage write; the next read self-heals via the read-through path. \`delete()\` does the same in reverse. A cache miss in \`read()\` falls back to Storage and repopulates the row.
* **\`VaultStorage.listWithContent\`.** New bulk-fetch method. \`SupabaseStorage\` hits the cache in one SELECT keyed by namespace, falls back to per-file Storage downloads + repopulate on cold cache. \`FilesystemStorage\` (local dev) just walks the disk.
* **Callers switched.** \`/api/index\`, \`/api/shared\`, and MCP \`loadVaultIndex\` all go through \`listWithContent\` / cached \`read\`. Page load dropped from a few seconds to well under a second on the 146-file vault.
* **Schema cleanup.** Dropped the \`pat_tokens\` table while in the area — pre-OAuth auth path, replaced by \`oauth_tokens\` long ago, zero rows for months. Removed the corresponding \`/api/pat\` route and \`clerkIdFromPat\` helper.

## Why

\`/api/index\` was doing one HTTPS GET per .md file on every page load. Felt fine at 20 docs; at 150 it was 3-5 seconds of TLS handshakes. Moving content entirely to Postgres was floated and rejected — Storage is the right home for \`.md\` content (export, parity with local-dev filesystem, signed URLs available). A cache layer was the right compromise.

## Technical notes

* **Why not single source of truth in Postgres?** Storage gives us files-as-files: trivial export, S3-compatible, a clean local-dev parallel via \`FilesystemStorage\`. Losing that for a tens-of-ms speedup wasn't worth it. The cache is rebuildable from Storage at any moment (the backfill script is the recovery tool), so it doesn't carry information Storage doesn't already have. "Two physical stores, one source of truth" — same pattern as a search index or materialized view.
* **Local dev.** Unchanged — \`FilesystemStorage.listWithContent\` reads from disk, no Postgres roundtrip.

## Files touched

* \`src/lib/storage/VaultStorage.ts\`, \`src/lib/storage/SupabaseStorage.ts\`, \`src/lib/storage/FilesystemStorage.ts\`
* \`app/api/index/route.ts\`, \`app/api/shared/route.ts\`, \`src/lib/mcp/tools/vault.ts\`
* \`scripts/backfill-vault-files.mjs\`
* \`src/lib/supabase/admin.ts\` (\`clerkIdFromPat\` removed), \`app/api/pat\` (deleted)

— Claude Opus 4.7, 2026-05-15
`;

const SPRINT_010 = `# EMDEE_OS — SPRINT-010

> 010-DOC-OPS. First-class doc-management primitives: rename (web + MCP), PDF export, and small UX fixes. Builds on [[EMDEE_OS — SPRINT-009]]'s cache so the rename's vault-wide link rewrite stays fast.

## Child of

* [[EMDEE_OS — LOGS]]

## What shipped

* **Rename.** New \`rename_doc\` MCP tool + \`POST /api/doc/rename\` + web UI button (graph bar, between Associate and the trash icon). Atomic per-doc: rewrites the H1, moves the file path (default: same directory, sanitized title), rewrites every \`[[old_title]]\` / \`[[old_title|alias]]\` across the vault (case-insensitive, alias-preserving), and patches \`doc_shares.path_prefix\` / \`share_root\`, \`share_invitations\`, and \`sync_manifest.file_path\` rows. Pre-flight blocks destination-path collisions and title collisions with other docs. Shared core in \`src/lib/mcp/tools/rename_doc.ts\` so both surfaces (web + MCP) call the same code.
* **PDF export.** Export PDF button on the doc toolbar. Switches to rendered mode, tags \`<body class="printing-doc">\`, calls \`window.print()\`, cleans up on \`afterprint\`. \`@media print\` rules strip every chrome element (sidebar, graph, banners, editor toolbar, raw side) and lay out only the rendered markdown at A4 with 0.75in margins. Wiki-links print as plain underlined text. Zero new deps.
* **History view fix.** Clicking History used to trap the user — tree clicks didn't exit the view. Now any sidebar click switches back to main view, and the History button toggles off on a second click.
* **Sign out button** added below History in the sidebar for authenticated users.

## Why

Renaming a node used to require manually editing the file + grepping for wiki-links + updating every reference. Brittle and never fully consistent. Same story for export — users wanted a shareable PDF of a doc without writing a script. Both were obvious friction worth removing now that the cache makes the multi-file rewrite cheap.

## Technical notes

* **Rename atomicity.** The renamed doc writes first, then descendant-link rewrites land in sequence. If a mid-flight write fails the renamed doc stays at its new path; running with the same args is idempotent because the old-title regex won't match docs that have already been rewritten.
* **PDF stack.** \`window.print()\` + scoped print CSS, leveraging the existing Toast UI rendered preview. Browser's native "Save as PDF" target. No headless Chrome on Vercel, no extra deps.

## Files touched

* \`src/lib/mcp/tools/rename_doc.ts\`, \`src/lib/mcp/tools/index.ts\`
* \`app/api/doc/rename/route.ts\`
* \`app/api/mcp/route.ts\` (tool registration)
* \`app/components/App.tsx\`, \`app/components/GraphViewInner.tsx\`
* \`app/globals.css\` (print rules + button styles)

— Claude Opus 4.7, 2026-05-15
`;

const SPRINT_011 = `# EMDEE_OS — SPRINT-011

> 011-GRAPH-POLISH. Tighten the graph view's readability: lineage extends in the right direction, focal/sibling labels don't repeat the parent name, and chrome moves out of the way of the canvas. Adds a lineage breadcrumb in the bottom-left.

## Child of

* [[EMDEE_OS — LOGS]]

## What shipped

* **Layer-2 lineage fix.** Previously layer-2 picked any non-parent neighbor, so focal siblings appeared at 12 o'clock as if they were grandparents (MMI showed up above GBI). Now layer-2 extends in the same direction as its layer-1 hop: layer-1 parent → layer-2 grandparent (stacked above the focal); layer-1 child/associate → layer-2 grandchild (extends downstream). Root + 1-layer nodes naturally drop the upper layer-2 entry since they have no parents to walk.
* **Focal label prefix strip.** \`POKEAI — LOGS\` under parent \`POKEAI\` now renders as just \`LOGS\`. Picks the first declared parent's title for the strip; falls back to full title for orphans.
* **Layer-2 label strip against own parent.** Children of WHATELZ-AI like \`WHATELZ-AI — BUILD\` display as just \`BUILD\` under their layer-1 parent (the old strip used the focal's title which doesn't help two hops out).
* **Tree sibling-common-prefix strip.** Under SHARED, a flat list of \`[ATLAS, ATLAS — BUILD, ATLAS — CONTEXT, …]\` was repeating "ATLAS — " on every row. A new helper detects the longest "X — " prefix shared by every sibling and strips it so the tree shows \`ATLAS / BUILD / CONTEXT / …\`.
* **Pager moved.** Prev/Next out of the top bar, into a floating pill at bottom-center of the graph stage, sitting under the focal ring so it visually trails the 6-o'clock node.
* **Icon buttons.** Share and Delete collapsed to icon-only at the right edge of the graph bar (share triangle, trash can). Tooltips intact; hover paints semantic colors.
* **Lineage breadcrumb.** Floating nav in the bottom-left walks parent edges from focal up to a root ancestor (capped at 6 crumbs). Non-focal crumbs are clickable and re-center the graph; the focal crumb is bold and inert. Auto-hides when focal has no ancestors.

## Why

The graph is the main navigation surface. Every label that repeats redundant text, or shows the wrong relationship, costs the user attention. These were paper-cut polishes that accumulated over a session of real use.

## Files touched

* \`app/components/GraphViewInner.tsx\` (layout, label strips, breadcrumb, pager, icons)
* \`app/components/App.tsx\` (tree sibling-prefix strip in \`displayTitle\`)
* \`app/globals.css\` (pager, breadcrumb, icon-button styles)

— Claude Opus 4.7, 2026-05-15
`;

const LOGS = `# EMDEE_OS — LOGS

> Append-only chronological record for [[EMDEE_OS]]. Excluded from \`get_doc\` by default; fetch only when audit is needed.

## Child of

* [[EMDEE_OS]]

## Parent of

* [[EMDEE_OS — SPRINT-008]] — Sharing v1: cascade share, grantee read view, MCP exposure. **2026-05-15.**
* [[EMDEE_OS — SPRINT-009]] — Postgres \`vault_files\` cache; \`pat_tokens\` retired. **2026-05-15.**
* [[EMDEE_OS — SPRINT-010]] — Rename (web + MCP), PDF export, history-view fix, sign-out. **2026-05-15.**
* [[EMDEE_OS — SPRINT-011]] — Graph polish: lineage layer-2, label strips, breadcrumb, icon buttons, pager move. **2026-05-15.**
`;

console.log("Writing sprint docs and updating LOGS…");
await writeDoc("projects/EMDEE_OS/sprints/SPRINT-008.md", SPRINT_008);
await writeDoc("projects/EMDEE_OS/sprints/SPRINT-009.md", SPRINT_009);
await writeDoc("projects/EMDEE_OS/sprints/SPRINT-010.md", SPRINT_010);
await writeDoc("projects/EMDEE_OS/sprints/SPRINT-011.md", SPRINT_011);
await writeDoc("projects/EMDEE_OS/LOGS.md", LOGS);
console.log("\nDone.");

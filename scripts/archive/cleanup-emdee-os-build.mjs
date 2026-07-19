// One-off cleanup of the EMDEE_OS BUILD/LOGS pair.
//
// - SPRINT-001..003, 005..007 are reparented to LOGS with a Status line
//   reflecting what actually shipped (vs the spec text).
// - SPRINT-004 is reparented to LOGS too, marked superseded.
// - LOGS.md is rewritten as the canonical index of all 11 sprints.
// - BUILD.md is rewritten — no active sprints, just open threads ranked
//   for the next pickup.
//
// Storage + vault_files cache stay in lockstep.
//
// Run from project root: node scripts/cleanup-emdee-os-build.mjs
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

async function readDoc(relPath) {
  const { data } = await sb
    .from("vault_files")
    .select("content")
    .match({ namespace: NAMESPACE, file_path: relPath })
    .maybeSingle();
  return data?.content ?? null;
}

// Status line inserted between the summary blockquote and the existing
// `## Child of` section for each spec doc. Child of is then rewritten
// from BUILD → LOGS.
const SPRINT_STATUS = {
  "SPRINT-001": "**Status:** Shipped (modified). The `VaultStorage` interface lives at `src/lib/storage/VaultStorage.ts` with `FilesystemStorage` + `SupabaseStorage` implementations. `BlobStorage` was never built — leapfrogged for Supabase in [[EMDEE_OS — SPRINT-005]].",
  "SPRINT-002": "**Status:** Shipped (auth path changed). Renderer ported to Next.js App Router. The BASIC_AUTH signed-cookie was replaced by Clerk authentication during the cloud rollout — works out cleaner since OAuth + Clerk both terminate at the same identity layer.",
  "SPRINT-003": "**Status:** Shipped. claude.ai connects via OAuth 2.1 + PKCE; MCP server lives at `/api/mcp` with CORS for the claude.ai widget. OAuth tables (`oauth_clients`/`oauth_codes`/`oauth_tokens`) carry the flow.",
  "SPRINT-004": "**Status:** Superseded — won't ship. The `mane login` / `mane edit` / `mane list` / `mane search` cloud-PAT terminal client was overtaken by claude.ai becoming the de-facto cloud MCP client. `bin/emdee.js` stayed a thin local-dev wrapper around `next dev` / `next build`. Content migration happened via the in-UI sync flow, not a migration script. Closing without shipping.",
  "SPRINT-005": "**Status:** Shipped. `.md` files live in the Supabase Storage `vaults` bucket; `sync_manifest` tracks per-file hashes for conflict detection. Later complemented by the Postgres `vault_files` cache for fast bulk reads (see [[EMDEE_OS — SPRINT-009]]).",
  "SPRINT-006": "**Status:** Shipped (generalized in [[EMDEE_OS — SPRINT-008]]). The JSON `_access.json` ACL was replaced by the `doc_shares` Postgres table + `share_invitations` + cascade-by-hierarchy + MCP `__shared__/` path exposure. Grantees see shared docs under a real SHARED.md branch in their VAULT.",
  "SPRINT-007": "**Status:** Shipped. App runs on Next.js App Router; CLI shells out to `next dev` / `next start`. SSE-on-fs-watch replaced HMR for local file-change notifications; cloud mode polls `/api/changes-version` for the same purpose.",
};

const SPRINT_NUMBERS = ["SPRINT-001", "SPRINT-002", "SPRINT-003", "SPRINT-004", "SPRINT-005", "SPRINT-006", "SPRINT-007"];

function reparentSprint(content, statusLine) {
  // Insert the Status line after the blockquote summary (the first
  // `> ...` line and its trailing blank). The block lives between the
  // H1 and the `## Child of` heading.
  let next = content;

  // Drop any existing Status line so the script is idempotent.
  next = next.replace(/^\*\*Status:\*\*[^\n]*\n\n?/m, "");

  // Insert the status line right before `## Child of`.
  next = next.replace(
    /(^##\s+Child of\s*\n)/m,
    `${statusLine}\n\n$1`
  );

  // Rewrite the Child of target from BUILD → LOGS.
  next = next.replace(
    /(##\s+Child of\s*\n+\*\s*)\[\[EMDEE_OS — BUILD\]\]/,
    `$1[[EMDEE_OS — LOGS]]`
  );

  return next;
}

const LOGS = `# EMDEE_OS — LOGS

> Append-only chronological record for [[EMDEE_OS]]. Excluded from \`get_doc\` by default; fetch only when audit is needed.

## Child of

* [[EMDEE_OS]]

## Parent of

* [[EMDEE_OS — SPRINT-001]] — Foundation + VaultStorage interface. **Shipped (modified — BlobStorage leapfrogged for Supabase).**
* [[EMDEE_OS — SPRINT-002]] — Renderer migration to Next.js. **Shipped (Clerk replaced the BASIC_AUTH cookie spec).**
* [[EMDEE_OS — SPRINT-003]] — HTTP MCP + OAuth 2.1 PKCE for claude.ai. **Shipped.**
* [[EMDEE_OS — SPRINT-004]] — \`mane\` CLI rewrite + content migration. **Superseded — claude.ai is the cloud MCP client.**
* [[EMDEE_OS — SPRINT-005]] — SupabaseStorage (.md in \`vaults\` bucket, sync_manifest). **Shipped.**
* [[EMDEE_OS — SPRINT-006]] — Vault access control. **Shipped — generalized into [[EMDEE_OS — SPRINT-008]] (doc_shares, invites, cascade, MCP exposure).**
* [[EMDEE_OS — SPRINT-007]] — Vite → Next.js. **Shipped.**
* [[EMDEE_OS — SPRINT-008]] — Sharing v1: cascade share, grantee read view, MCP exposure. **2026-05-15.**
* [[EMDEE_OS — SPRINT-009]] — Postgres \`vault_files\` cache; \`pat_tokens\` retired. **2026-05-15.**
* [[EMDEE_OS — SPRINT-010]] — Rename (web + MCP), PDF export, history-view fix, sign-out. **2026-05-15.**
* [[EMDEE_OS — SPRINT-011]] — Graph polish: lineage layer-2, label strips, breadcrumb, icon buttons, pager move. **2026-05-15.**
`;

const BUILD = `# EMDEE_OS — BUILD

> Active sprints for [[EMDEE_OS]]. Hot working set — each sprint lives as its own file under \`sprints/\`; this doc is the curated index of what's open. When a sprint ships, its body stays at its own file and its line moves to [[EMDEE_OS — LOGS]].

## Child of

* [[EMDEE_OS]]

## Status

Cloud migration + sharing v1 are complete. Sprints 001–003, 005–011 are in [[EMDEE_OS — LOGS]]; 004 is logged as superseded. The vault is live on emdee.vercel.app, claude.ai connects via OAuth, cascade-share + grantee-read + MCP cross-namespace reads all operational. **No sprint currently active** — next move is to promote one of the open threads below into a real spec.

## Active sprints

*(none — pick from open threads below)*

## Open threads (ranked for next pickup)

* **BRAIN/PATTERN restructure.** Reclaim \`BRAIN\` at the vault level for personal operating principles (philosophy, mission, mindset, life learnings). Move current technical-pattern semantics to a polymorphic \`PATTERN\` primitive that lives at each branch (\`PROJECTS/PATTERN.md\`, \`HACKATHONS/PATTERN.md\`, \`PEOPLE/PATTERN.md\`, etc.). Current BRAIN is empty so migration cost ≈ zero. Surfaced during GBI seminar (2026-05-16). **Vault-architecture move, no app code.**
* **MCP activity log surfaced in renderer.** Log what claude.ai retrieved and wrote, surface in the UI alongside History so the human can see what the LLM has been touching. Real leverage now that claude.ai writes regularly and the renderer's auto-reload can lag.
* **"Mentioned in" backlinks panel** in the rendered doc view. \`doc.mentions\` is already populated by the indexer — this is a UI-only panel reading derived data. Lowest effort, smallest value.
* **\`archive_section\` MCP tool** for atomic sprint close-out (move section from BUILD.md to a LOGS file). The friction of doing today's cleanup by hand is what would drive this design.
* **\`promote_to_active\` MCP tool** for dynamic tier-file scaffolding under reference pillars when they earn it.
* **Type-filter chips on the graph view.** Category-coloring may have made this redundant; defer until cloud usage demands it.
* **Vector / embedding-based search.** Premature until the vault is much larger.

— Cleanup, 2026-05-16
`;

console.log("Reparenting sprint specs (BUILD → LOGS) with status lines…");
for (const name of SPRINT_NUMBERS) {
  const relPath = `projects/EMDEE_OS/sprints/${name}.md`;
  const current = await readDoc(relPath);
  if (!current) {
    console.warn(`  skip ${name}: not found`);
    continue;
  }
  const next = reparentSprint(current, SPRINT_STATUS[name]);
  if (next === current) {
    console.log(`  unchanged ${name}`);
    continue;
  }
  await writeDoc(relPath, next);
}

console.log("\nRewriting LOGS + BUILD…");
await writeDoc("projects/EMDEE_OS/LOGS.md", LOGS);
await writeDoc("projects/EMDEE_OS/BUILD.md", BUILD);

console.log("\nDone.");

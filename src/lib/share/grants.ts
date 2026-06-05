import { adminClient } from "@/src/lib/supabase/admin";

export interface SharedDocItem {
  shareId: string;
  path: string;
  title: string;
  content: string;
}

export interface SharedGroup {
  ownerId: string;
  ownerEmail: string | null;
  shareRoot: string;
  permission: "read" | "write";
  docs: SharedDocItem[];
  edges: { from: string; to: string; kind: "hierarchy" | "assoc" }[];
}

interface ShareRow {
  id: string;
  owner_id: string;
  path_prefix: string;
  share_root: string | null;
  permission: "read" | "write";
  owner: { email: string | null } | { email: string | null }[] | null;
}

interface EdgeRow {
  from_path: string;
  to_path: string;
}

function extractTitle(content: string, fallbackPath: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const base = fallbackPath.split("/").pop() ?? fallbackPath;
  return base.replace(/\.md$/, "");
}

/**
 * Docs shared with `granteeId`, grouped by (ownerId, shareRoot). Each group
 * carries the owner's hierarchy edges restricted to the shared paths so the
 * recipient can reconstruct the original subtree (DOUBLELEAD → BUILD → ...).
 *
 * Used by both `/api/shared` (sidebar, write-routing, permission metadata)
 * and `/api/index` (graph + sidebar merge — single source of truth for the
 * grantee's view of the vault).
 */
export async function fetchSharesForGrantee(granteeId: string): Promise<SharedGroup[]> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("doc_shares")
    .select("id, owner_id, path_prefix, share_root, permission, owner:profiles!doc_shares_owner_id_fkey(email)")
    .eq("grantee_id", granteeId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ShareRow[];
  if (rows.length === 0) return [];

  type GroupAcc = {
    ownerId: string;
    ownerEmail: string | null;
    shareRoot: string;
    permission: "read" | "write";
    rows: ShareRow[];
  };
  const groups = new Map<string, GroupAcc>();
  for (const r of rows) {
    const root = r.share_root ?? r.path_prefix;
    const key = `${r.owner_id} ${root}`;
    const owner = Array.isArray(r.owner) ? r.owner[0] : r.owner;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(r);
      if (r.permission === "write") existing.permission = "write";
    } else {
      groups.set(key, {
        ownerId: r.owner_id,
        ownerEmail: owner?.email ?? null,
        shareRoot: root,
        permission: r.permission,
        rows: [r],
      });
    }
  }

  return Promise.all(
    Array.from(groups.values()).map(async (g) => {
      const paths = g.rows.map((r) => r.path_prefix);

      const [filesRes, edgesRes, assocEdgesRes] = await Promise.all([
        admin
          .from("vault_files")
          .select("file_path, content")
          .eq("namespace", g.ownerId)
          .in("file_path", paths),
        admin
          .from("doc_edges")
          .select("from_path, to_path")
          .eq("namespace", g.ownerId)
          .eq("kind", "hierarchy")
          .in("from_path", paths),
        // Assoc edges between co-shared docs only. Querying from_path IN paths
        // is sufficient because doc_edges stores assoc rows in both directions
        // (A→B and B→A). We filter to edges whose other end is also shared.
        admin
          .from("doc_edges")
          .select("from_path, to_path")
          .eq("namespace", g.ownerId)
          .eq("kind", "assoc")
          .in("from_path", paths),
      ]);

      const contentByPath = new Map<string, string>();
      for (const f of (filesRes.data ?? []) as { file_path: string; content: string }[]) {
        contentByPath.set(f.file_path, f.content);
      }

      const pathSet = new Set(paths);
      const hierarchyEdges = ((edgesRes.data ?? []) as EdgeRow[])
        .filter((e) => pathSet.has(e.to_path))
        .map((e) => ({ from: e.from_path, to: e.to_path, kind: "hierarchy" as const }));

      // Deduplicate assoc edges: doc_edges stores A→B and B→A; normalise to
      // lo/hi so the graph renderer sees one undirected pair per association.
      const seenAssoc = new Set<string>();
      const assocEdges: { from: string; to: string; kind: "assoc" }[] = [];
      for (const e of (assocEdgesRes.data ?? []) as EdgeRow[]) {
        if (!pathSet.has(e.to_path)) continue;
        const [lo, hi] = e.from_path < e.to_path
          ? [e.from_path, e.to_path]
          : [e.to_path, e.from_path];
        const key = `${lo}::${hi}`;
        if (seenAssoc.has(key)) continue;
        seenAssoc.add(key);
        assocEdges.push({ from: lo, to: hi, kind: "assoc" });
      }

      const docs = paths.map((p) => {
        const content = contentByPath.get(p) ?? "";
        const row = g.rows.find((r) => r.path_prefix === p)!;
        return {
          shareId: row.id,
          path: p,
          title: extractTitle(content, p),
          content,
        };
      });

      return {
        ownerId: g.ownerId,
        ownerEmail: g.ownerEmail,
        shareRoot: g.shareRoot,
        permission: g.permission,
        docs,
        edges: [...hierarchyEdges, ...assocEdges],
      };
    })
  );
}

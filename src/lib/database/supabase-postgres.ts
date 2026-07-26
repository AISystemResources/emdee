// SPRINT-139: SupabasePostgresDatabase — concrete VaultDatabase impl
// wrapping the existing Supabase client. Keeps pagination discipline
// (SPRINT-117 + SPRINT-119) and atomic RPC (SPRINT-108) intact.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  VaultDatabase,
  VaultFileRow,
  EdgeRow,
  EdgeFilter,
  ListFilesOptions,
  SummaryDriftOptions,
} from "./types";

const CACHE_TABLE = "vault_files";
const EDGES_TABLE = "doc_edges";
const PAGE = 1000;

export class SupabasePostgresDatabase implements VaultDatabase {
  constructor(private client: SupabaseClient) {}

  async getFile(ns: string, path: string): Promise<VaultFileRow | null> {
    const { data, error } = await this.client
      .from(CACHE_TABLE)
      .select("*")
      .eq("namespace", ns)
      .eq("file_path", path)
      .maybeSingle();
    if (error) throw new Error(`getFile failed: ${error.message}`);
    return (data as VaultFileRow | null) ?? null;
  }

  async putFile(ns: string, path: string, content: string, meta?: {
    summary_hash?: string;
    content_hash_at_summary_write?: string;
  }): Promise<void> {
    const row: Record<string, unknown> = {
      namespace: ns,
      file_path: path,
      content,
      updated_at: new Date().toISOString(),
    };
    if (meta?.summary_hash !== undefined) row.summary_hash = meta.summary_hash;
    if (meta?.content_hash_at_summary_write !== undefined) {
      row.content_hash_at_summary_write = meta.content_hash_at_summary_write;
    }
    const { error } = await this.client
      .from(CACHE_TABLE)
      .upsert(row, { onConflict: "namespace,file_path" });
    if (error) throw new Error(`putFile failed: ${error.message}`);
  }

  async deleteFile(ns: string, path: string): Promise<void> {
    const { error } = await this.client
      .from(CACHE_TABLE)
      .delete()
      .match({ namespace: ns, file_path: path });
    if (error) throw new Error(`deleteFile failed: ${error.message}`);
  }

  async listFiles(ns: string, opts: ListFilesOptions = {}): Promise<VaultFileRow[]> {
    // Paginate — SPRINT-119 (HARD RULE 6): Postgres .select() capped at 1000.
    const select = opts.select ?? "*";
    const out: VaultFileRow[] = [];
    let cursor = opts.offset ?? 0;
    const stop = opts.limit ? cursor + opts.limit : Infinity;
    while (cursor < stop) {
      const pageEnd = Math.min(cursor + PAGE, stop) - 1;
      let q = this.client.from(CACHE_TABLE).select(select).eq("namespace", ns);
      if (opts.prefix) q = q.like("file_path", `${opts.prefix}%`);
      if (opts.order === "file_path_asc" || !opts.order) {
        q = q.order("file_path", { ascending: true });
      }
      const { data, error } = await q.range(cursor, pageEnd);
      if (error) throw new Error(`listFiles failed: ${error.message}`);
      const rows = (data ?? []) as unknown as VaultFileRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      cursor += PAGE;
    }
    return out;
  }

  async searchFiles(ns: string, query: string, limit: number, excludePath?: string): Promise<VaultFileRow[]> {
    let q = this.client
      .from(CACHE_TABLE)
      .select("*")
      .eq("namespace", ns)
      .textSearch("content_tsv", query, { type: "websearch", config: "english" });
    if (excludePath) q = q.neq("file_path", excludePath);
    const { data, error } = await q.limit(limit);
    if (error) throw new Error(`searchFiles failed: ${error.message}`);
    return (data ?? []) as VaultFileRow[];
  }

  async getSummaryDrift(ns: string, opts: SummaryDriftOptions = {}): Promise<VaultFileRow[]> {
    // Return raw rows with content + hash fields; caller derives drift status.
    const rows = await this.listFiles(ns, {
      prefix: opts.prefix,
      select: "file_path, content, content_hash_at_summary_write",
      order: "file_path_asc",
    });
    return rows;
  }

  async getEdges(ns: string, filter: EdgeFilter = {}): Promise<EdgeRow[]> {
    const out: EdgeRow[] = [];
    let cursor = 0;
    while (true) {
      let q = this.client
        .from(EDGES_TABLE)
        .select("from_path, to_path, kind, label, position")
        .eq("namespace", ns);
      if (filter.from_path) q = q.eq("from_path", filter.from_path);
      if (filter.to_path) q = q.eq("to_path", filter.to_path);
      if (filter.kind) q = q.eq("kind", filter.kind);
      const { data, error } = await q
        .order("from_path", { ascending: true })
        .order("to_path", { ascending: true })
        .range(cursor, cursor + PAGE - 1);
      if (error) throw new Error(`getEdges failed: ${error.message}`);
      const rows = (data ?? []) as Omit<EdgeRow, "namespace">[];
      out.push(...rows.map((r) => ({ ...r, namespace: ns })));
      if (rows.length < PAGE) break;
      cursor += PAGE;
    }
    return out;
  }

  async syncEdgesAtomic(ns: string, docPath: string, desired: EdgeRow[]): Promise<void> {
    // SPRINT-108 atomic RPC — DELETE-touching-doc + self-heal-delete + INSERT
    // in one transaction. Do NOT replicate this logic here; call the SQL RPC.
    const { error } = await this.client.rpc("sync_doc_edges_atomic", {
      p_namespace: ns,
      p_doc_path: docPath,
      p_desired: desired,
    });
    if (error) throw new Error(`syncEdgesAtomic failed: ${error.message}`);
  }

  async deleteEdges(ns: string, docPath: string): Promise<void> {
    const { error: e1 } = await this.client
      .from(EDGES_TABLE)
      .delete()
      .eq("namespace", ns)
      .eq("from_path", docPath);
    if (e1) throw new Error(`deleteEdges (from) failed: ${e1.message}`);
    const { error: e2 } = await this.client
      .from(EDGES_TABLE)
      .delete()
      .eq("namespace", ns)
      .eq("to_path", docPath);
    if (e2) throw new Error(`deleteEdges (to) failed: ${e2.message}`);
  }

  async clearEdges(ns: string): Promise<void> {
    const { error } = await this.client
      .from(EDGES_TABLE)
      .delete()
      .eq("namespace", ns);
    if (error) throw new Error(`clearEdges failed: ${error.message}`);
  }

  async insertEdges(rows: EdgeRow[]): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await this.client
        .from(EDGES_TABLE)
        .upsert(rows.slice(i, i + CHUNK));
      if (error) throw new Error(`insertEdges failed: ${error.message}`);
    }
  }
}

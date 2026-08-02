import type { VaultStorage } from "../../storage/VaultStorage";
import type { VaultDatabase } from "../../database/types";

// SPRINT-139 + SPRINT-140 (SIG-032 Phases 1–2): both local AND cloud
// contexts carry a VaultDatabase. Local mode → SqliteDatabase; cloud →
// SupabasePostgresDatabase. Tools should use ctx.db uniformly regardless
// of mode — the abstraction is the whole point of SIG-032.
// Local mode uses "local" as the namespace string (single-vault today).
export const LOCAL_NAMESPACE = "local";

export type ToolContext =
  | { mode: "local"; docsDir: string; db: VaultDatabase }
  | {
      mode: "cloud";
      storage: VaultStorage;
      userId: string;
      db: VaultDatabase;
      // SPRINT-178: OAuth scope claim (space-separated per RFC 6749 §3.3)
      // carried from the token that authorised this request. Enforcement
      // helpers live in src/lib/mcp/scopes.ts. Legacy tokens all carry
      // `"mcp"` (full-access superuser).
      scope: string;
    };

export type { DocIndex, DocNode, Link } from "../../../core/indexer";

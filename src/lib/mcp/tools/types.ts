import type { VaultStorage } from "../../storage/VaultStorage";
import type { VaultDatabase } from "../../database/types";

// SPRINT-139 (SIG-032 Phase 1): cloud contexts now carry a VaultDatabase
// alongside VaultStorage. Callers should prefer ctx.db over
// adminClient() so future backend swaps happen in one place.
// `db` is optional during the migration window — tools that don't yet
// use the abstraction can construct one via cloudDatabase() themselves.
export type ToolContext =
  | { mode: "local"; docsDir: string }
  | { mode: "cloud"; storage: VaultStorage; userId: string; db?: VaultDatabase };

export type { DocIndex, DocNode, Link } from "../../../core/indexer";

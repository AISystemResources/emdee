export interface ConflictInfo {
  path: string;
  localContent: string;
  remoteContent: string;
  localUpdatedAt: string;   // ISO 8601
  remoteUpdatedAt: string;  // ISO 8601
}

export type ConflictResolution = "local" | "remote";

/**
 * Syncs between a local (filesystem) vault and a remote (Blob) vault.
 *
 * Conflict detection strategy (future implementation):
 *   1. Maintain a "last-sync" manifest: a JSON file stored in both local and
 *      remote that records {path → contentHash, syncedAt} for every file at
 *      the time of the last successful sync.
 *   2. On sync: compare current content hashes against the manifest.
 *      - Only local changed  → push to remote (no conflict).
 *      - Only remote changed → pull to local (no conflict).
 *      - Both changed        → conflict; add to conflicts list, skip the file.
 *      - Neither changed     → no-op.
 *   3. resolveConflict picks a side and updates the manifest entry.
 */
export class SyncManager {
  constructor(
    private local: import("./LocalStorage.ts").LocalStorage,
    private remote: import("./VaultStorage.ts").VaultStorage,
  ) {}

  /** Push all local files that differ from remote to the cloud. */
  async syncToRemote(): Promise<{ pushed: string[]; conflicts: ConflictInfo[] }> {
    throw new Error("not implemented");
  }

  /** Pull all remote files that differ from local to disk. */
  async syncFromRemote(): Promise<{ pulled: string[]; conflicts: ConflictInfo[] }> {
    throw new Error("not implemented");
  }

  /** Return files that have been modified on both sides since the last sync. */
  async listConflicts(): Promise<ConflictInfo[]> {
    throw new Error("not implemented");
  }

  /**
   * Resolve a conflict by picking one side.
   * Writes the winning content to both stores and updates the sync manifest.
   */
  async resolveConflict(path: string, resolution: ConflictResolution): Promise<void> {
    throw new Error("not implemented");
  }
}

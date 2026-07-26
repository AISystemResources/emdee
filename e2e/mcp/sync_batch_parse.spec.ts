// SPRINT-142F: HARD RULE 11 regression spec.
//
// The 0.5.0 `emdee sync` shipped a parser that treated batch_get_doc's
// response as `Array<{path, doc_content_hash}>`. The actual envelope is
// `{ count, results: [...] }`, so every real run threw "parsed is not
// iterable" the first time it hit the cloud. This spec pins the parse
// against the real tool output produced from a local ToolContext.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { batchGetDoc } from "@/src/lib/mcp/tools/batch_get";
import { localToolContext } from "@/src/lib/mcp/tools/context";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { parseBatchGetHashes } from "@/src/cli/sync-command";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function unwrap(raw: unknown): string {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return r.content[0].text;
}

test.describe("sync: parseBatchGetHashes (SPRINT-142F)", () => {
  test("consumes the real batch_get_doc envelope shape", async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), "emdee-sync-batch-"));
    try {
      await writeFile(path.join(docsDir, "A.md"), "# A\n\n> First.\n");
      await writeFile(path.join(docsDir, "B.md"), "# B\n\n> Second.\n");
      const ctx: ToolContext = localToolContext(docsDir);

      const raw = await batchGetDoc(ctx, { paths: ["A.md", "B.md"] });
      const text = unwrap(raw);

      // The whole point of the spec: the same parse the CLI uses does
      // NOT throw on the real envelope, and returns one hash per doc.
      const hashes = parseBatchGetHashes(text);
      expect(hashes.size).toBe(2);
      expect(hashes.get("A.md")).toMatch(/^[a-f0-9]+$/);
      expect(hashes.get("B.md")).toMatch(/^[a-f0-9]+$/);
      expect(hashes.get("A.md")).not.toBe(hashes.get("B.md"));
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });

  test("empty results array does not throw", () => {
    const hashes = parseBatchGetHashes(JSON.stringify({ count: 0, results: [] }));
    expect(hashes.size).toBe(0);
  });

  test("error envelope surfaces as thrown Error", () => {
    expect(() =>
      parseBatchGetHashes(JSON.stringify({ error: "paths_required", hint: "..." }))
    ).toThrow(/batch_get_doc: paths_required/);
  });

  test("results with missing doc_content_hash are skipped, not crashed", () => {
    const hashes = parseBatchGetHashes(
      JSON.stringify({
        count: 2,
        results: [
          { path: "OK.md", doc_content_hash: "abc123" },
          { path: "MISSING.md", error: "not_found" },
        ],
      })
    );
    expect(hashes.size).toBe(1);
    expect(hashes.get("OK.md")).toBe("abc123");
  });
});

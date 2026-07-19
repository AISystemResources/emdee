import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex } from "../core/indexer";
import { callTool, unwrapText } from "./remote-client";
import { NeedsLoginError } from "./auth";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));

async function cmdList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prefix: { type: "string" },
      remote: { type: "boolean" },
    },
    strict: true,
  });
  const prefix = values.prefix ?? "";
  if (values.remote) {
    // SPRINT-091: route through cloud MCP. Uses `format: "text"` so the
    // server returns bytes-only paths (no JSON envelope on the wire).
    const args: Record<string, unknown> = { format: "text" };
    if (prefix) args.prefix = prefix;
    const result = await callTool("list_docs", args);
    const text = unwrapText(result);
    // list_docs text format is newline-delimited paths; local prefix filter
    // is applied server-side via the tool's own prefix param if supplied,
    // so this branch just streams whatever the server returned.
    if (prefix) {
      for (const line of text.split("\n")) {
        if (line.startsWith(prefix)) process.stdout.write(line + "\n");
      }
    } else {
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    }
    return;
  }
  const idx = await buildIndex(docsDir);
  for (const d of idx.docs) {
    if (!prefix || d.path.startsWith(prefix)) process.stdout.write(d.path + "\n");
  }
}

async function cmdDriftBatch(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: "string", default: "10" },
      offset: { type: "string", default: "0" },
      prefix: { type: "string" },
      remote: { type: "boolean" },
    },
    strict: true,
  });
  const limit = Math.max(1, Number(values.limit) | 0);
  const offset = Math.max(0, Number(values.offset) | 0);
  if (values.remote) {
    const args: Record<string, unknown> = { limit, offset };
    if (values.prefix) args.prefix = values.prefix;
    const result = await callTool("list_summary_drift", args);
    const text = unwrapText(result);
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    return;
  }
  const idx = await buildIndex(docsDir);
  const filtered = idx.docs
    .filter((d) => !values.prefix || d.path.startsWith(values.prefix))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(offset, offset + limit);
  for (const d of filtered) {
    process.stdout.write(`--- ${d.path}\n`);
    process.stdout.write(`${d.summary ?? ""}\n\n`);
    process.stdout.write(`${d.content}\n\n`);
  }
}

const [, , sub, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (sub) {
    case "list":
      await cmdList(rest);
      return;
    case "drift-batch":
      await cmdDriftBatch(rest);
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub ?? "(none)"}\n`);
      process.stderr.write(`usage: emdee <list|drift-batch> [--prefix P] [--limit N] [--offset K] [--remote]\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof NeedsLoginError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

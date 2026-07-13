import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex } from "../core/indexer";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));

async function cmdList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { prefix: { type: "string" } },
    strict: true,
  });
  const idx = await buildIndex(docsDir);
  const prefix = values.prefix ?? "";
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
    },
    strict: true,
  });
  const limit = Math.max(1, Number(values.limit) | 0);
  const offset = Math.max(0, Number(values.offset) | 0);
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
      process.stderr.write(`usage: emdee <list|drift-batch> [--prefix P] [--limit N] [--offset K]\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

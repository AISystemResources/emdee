#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import readline from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
// Version comes from package.json — `npm version <bump>` is the one
// place the string ever needs to change. createRequire works on any
// Node >= 14 without depending on the newer `import ... with { type: "json" }`
// attribute syntax (stable only in Node 20.10+).
const pkg = createRequire(import.meta.url)("../package.json");

// SPRINT-090: `start` and `serve-next` shell out to Vite / Next.js against
// the full repo. Those files (app/, next.config.*, etc.) aren't in the
// published tarball, so when the CLI is installed via `npm install -g`
// those commands need to bail loudly rather than crash with a confusing
// Vite / Next stack.
async function ensureRepoCheckout(commandName) {
  try {
    await access(path.join(pkgRoot, "app"));
  } catch {
    console.error(
      `emdee ${commandName} requires a repo checkout — clone https://github.com/AISystemResources/emdee\n` +
        `The published npm package ships the CLI + MCP server only, not the web viewer.`
    );
    process.exit(1);
  }
}

// SPRINT-093: keep owner-title derivation logic in lockstep with
// src/lib/owner/identity.ts. The published tarball is plain JS (no tsx),
// so this duplicates the 15-line function rather than pull in a runtime
// compilation step. `e2e/cli/init.spec.ts` pins the two copies together —
// if they ever diverge, the consistency test fails.
function normalizeOwnerTitle(input) {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[._\s]/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "OWNER";
}

function ownerNodeScaffold(title) {
  return `# ${title}

> Your personal subtree. Top-level content (projects, people, notes, etc.) lives here. Renameable any time via \`rename_doc\` — inbound wiki-link references update atomically across the vault.

## Child of

* [[EMDEE]]

## Parent of

## Associated with

## Notes
`;
}

const program = new Command();
program.name("emdee").description("Emdee — local docs + knowledge graph + MCP").version(pkg.version);

program
  .command("init")
  .description("Create a docs/ folder with your owner node. The 5 system nodes (EMDEE, VAULT, SHARED, GRAVEYARD, IMAGES) are virtual — never written to disk.")
  .option("--nickname <name>", "Display name for the owner node (required non-interactively)")
  .action(async (opts) => {
    const cwd = process.cwd();
    const docsDir = path.join(cwd, "docs");
    await mkdir(docsDir, { recursive: true });

    let nickname = (opts.nickname ?? "").trim();
    if (!nickname) {
      if (!process.stdin.isTTY) {
        console.error("emdee init needs --nickname when running non-interactively.");
        process.exit(1);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      nickname = (await rl.question("Your name (owner node title): ")).trim();
      rl.close();
      if (!nickname) {
        console.error("emdee init: nickname cannot be empty.");
        process.exit(1);
      }
    }

    const title = normalizeOwnerTitle(nickname);
    if (title === "OWNER") {
      console.error(`emdee init: "${nickname}" normalised to the fallback OWNER — pick a name with ASCII letters.`);
      process.exit(1);
    }

    const target = path.join(docsDir, `${title}.md`);
    try {
      await access(target);
      console.log(`Already initialised at docs/${title}.md — leaving it alone.`);
    } catch {
      await writeFile(target, ownerNodeScaffold(title), "utf8");
      console.log(`Created docs/${title}.md — your owner node.`);
    }
    console.log(
      `\nThe 5 system nodes (EMDEE, VAULT, SHARED, GRAVEYARD, IMAGES) are virtual — they appear in \`emdee list\` and \`get_doc\` without being written to disk.`
    );
  });

program
  .command("start")
  .description("Start the Emdee viewer against ./docs — requires a repo checkout")
  .option("-p, --port <port>", "port", "5173")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .action(async (opts) => {
    await ensureRepoCheckout("start");
    const docs = path.resolve(process.cwd(), opts.docs);
    const child = spawn("npx", ["vite", "--port", opts.port], {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("serve-next")
  .description("Start the Emdee viewer using Next.js (App Router) — requires a repo checkout")
  .option("-p, --port <port>", "port", "3000")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .action(async (opts) => {
    await ensureRepoCheckout("serve-next");
    const docs = path.resolve(process.cwd(), opts.docs);
    const child = spawn("npx", ["next", "dev", "--port", opts.port], {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("mcp")
  .description("Run the Emdee MCP server over stdio")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .action((opts) => {
    const docs = path.resolve(process.cwd(), opts.docs);
    const child = spawn("npx", ["tsx", path.join(pkgRoot, "src/mcp/server.ts")], {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("list")
  .description("Print one doc path per line (token-cheap; local docs/ only)")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .option("--prefix <prefix>", "filter to paths starting with this prefix")
  .action((opts) => {
    const docs = path.resolve(process.cwd(), opts.docs);
    const args = ["tsx", path.join(pkgRoot, "src/cli/read-commands.ts"), "list"];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    const child = spawn("npx", args, {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("drift-batch")
  .description("Print a batch of docs (path + summary + body) for offline summariser workflows")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .option("--limit <n>", "docs per batch", "10")
  .option("--offset <k>", "skip the first K docs", "0")
  .option("--prefix <prefix>", "filter to paths starting with this prefix")
  .action((opts) => {
    const docs = path.resolve(process.cwd(), opts.docs);
    const args = [
      "tsx",
      path.join(pkgRoot, "src/cli/read-commands.ts"),
      "drift-batch",
      "--limit", opts.limit,
      "--offset", opts.offset,
    ];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    const child = spawn("npx", args, {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parseAsync();

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
  .description("Print one doc path per line. Local by default; --remote reads your live vault via emdee.tech.")
  .option("-d, --docs <dir>", "docs directory (local mode)", "docs")
  .option("--prefix <prefix>", "filter to paths starting with this prefix")
  .option("--remote", "route through emdee.tech (requires `emdee login`)")
  .action((opts) => {
    const docs = path.resolve(process.cwd(), opts.docs);
    const args = ["tsx", path.join(pkgRoot, "src/cli/read-commands.ts"), "list"];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    if (opts.remote) args.push("--remote");
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
  .option("-d, --docs <dir>", "docs directory (local mode)", "docs")
  .option("--limit <n>", "docs per batch", "10")
  .option("--offset <k>", "skip the first K docs", "0")
  .option("--prefix <prefix>", "filter to paths starting with this prefix")
  .option("--remote", "route through emdee.tech (requires `emdee login`)")
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
    if (opts.remote) args.push("--remote");
    const child = spawn("npx", args, {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// SPRINT-091: PKCE login against emdee.tech. Credentials stashed in
// ~/.config/emdee/credentials.json for `--remote` calls to pick up.
function shellAuth(sub, extra = []) {
  const child = spawn(
    "npx",
    ["tsx", path.join(pkgRoot, "src/cli/auth-commands.ts"), sub, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// SPRINT-091 chunk 2: write verbs shell through the dispatcher.
function shellWrite(verb, opts, extra = []) {
  const docs = opts.docs ? path.resolve(process.cwd(), opts.docs) : path.join(process.cwd(), "docs");
  const child = spawn(
    "npx",
    ["tsx", path.join(pkgRoot, "src/cli/write-commands.ts"), verb, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env, EMDEE_DOCS: docs } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// SPRINT-091 chunk 3: structured read verbs share read-commands.ts dispatcher.
function shellRead(verb, opts, extra = []) {
  const docs = opts.docs ? path.resolve(process.cwd(), opts.docs) : path.join(process.cwd(), "docs");
  const child = spawn(
    "npx",
    ["tsx", path.join(pkgRoot, "src/cli/read-commands.ts"), verb, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env, EMDEE_DOCS: docs } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Every write verb takes the same core flag surface; a small helper builds
// the extra-args array from commander's parsed opts + a spec of which flags
// map to which write-commands.ts flag names.
function argsFromOpts(opts, mapping) {
  const extra = [];
  for (const [optKey, cliFlag] of Object.entries(mapping)) {
    const v = opts[optKey];
    if (Array.isArray(v)) {
      for (const item of v) extra.push(cliFlag, item);
    } else if (typeof v === "string" && v.length > 0) {
      extra.push(cliFlag, v);
    } else if (v === true) {
      extra.push(cliFlag);
    }
  }
  return extra;
}

program
  .command("login")
  .description("Sign in to emdee.tech via browser (PKCE). Stashes tokens in ~/.config/emdee/.")
  .option("--host <url>", "override the cloud host (defaults to $EMDEE_CLOUD_URL or https://emdee.tech)")
  .action((opts) => {
    const extra = opts.host ? ["--host", opts.host] : [];
    shellAuth("login", extra);
  });

program
  .command("logout")
  .description("Remove stored credentials.")
  .action(() => shellAuth("logout"));

program
  .command("whoami")
  .description("Print the currently logged-in email + namespace.")
  .action(() => shellAuth("whoami"));

// SPRINT-094: install the EMDEE Claude Code skills into ~/.claude/skills/
program
  .command("skills-install")
  .description("Copy packaged skills/*.md into a Claude Code skills directory (default ~/.claude/skills/).")
  .option("--dir <path>", "Target directory")
  .action((opts) => {
    // Resolve --dir against the user's original cwd (not pkgRoot). We resolve
    // here in the shell so the child process sees an absolute path regardless
    // of where tsx runs from.
    const resolvedDir = opts.dir ? path.resolve(process.cwd(), opts.dir) : "";
    const extra = resolvedDir ? ["--dir", resolvedDir] : [];
    const child = spawn(
      "npx",
      ["tsx", path.join(pkgRoot, "src/cli/skills-install.ts"), ...extra],
      { cwd: pkgRoot, stdio: "inherit", env: { ...process.env } },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// -----------------------------------------------------------------------
// SPRINT-091 chunk 2: write-side CLI verbs.
// Each mirrors the corresponding MCP tool. --remote routes through cloud;
// --json returns the raw MCP envelope for machine consumption.
// -----------------------------------------------------------------------

program
  .command("patch-section")
  .description("Replace an H2 section's body — version-guarded. Same shape as the patch_section MCP tool.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--body <text>", "New section body")
  .requiredOption("--expected-hash <hash>", "Prior content_hash from get_doc")
  .option("--section-id <id>", "Section id (preferred over --heading)")
  .option("--heading <heading>", "H2 heading text (without ##)")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", expectedHash: "--expected-hash",
      sectionId: "--section-id", heading: "--heading", gateOn: "--gate-on",
      remote: "--remote", json: "--json",
    });
    shellWrite("patch-section", opts, extra);
  });

program
  .command("append-section")
  .description("Append markdown to the end of an existing H2 section. --create-if-missing adds it at end of file.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--body <text>", "Content to append")
  .option("--section-id <id>", "Section id (preferred over --heading)")
  .option("--heading <heading>", "H2 heading text (without ##)")
  .option("--create-if-missing", "Create the section at end of file if not found")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", sectionId: "--section-id",
      heading: "--heading", createIfMissing: "--create-if-missing",
      gateOn: "--gate-on", remote: "--remote", json: "--json",
    });
    shellWrite("append-section", opts, extra);
  });

program
  .command("append-doc")
  .description("Append to the end of a doc (after every section). Ideal for LOGS, daily notes.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--body <text>", "Content to append")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", gateOn: "--gate-on",
      remote: "--remote", json: "--json",
    });
    shellWrite("append-doc", opts, extra);
  });

program
  .command("patch-preamble")
  .description("Replace the region between H1 and first H2 (blockquote summary + intro paragraphs).")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--body <text>", "New preamble body")
  .requiredOption("--expected-hash <hash>", "Prior preamble content_hash from get_doc")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", expectedHash: "--expected-hash",
      gateOn: "--gate-on", remote: "--remote", json: "--json",
    });
    shellWrite("patch-preamble", opts, extra);
  });

program
  .command("create-child")
  .description("Atomic write + parent-of patch: create a new doc as child of an existing one.")
  .requiredOption("--parent-path <path>", "Parent doc path")
  .requiredOption("--title <title>", "New doc's H1 title")
  .option("--body <text>", "Optional body appended after ## Notes")
  .option("--summary <text>", "Optional blockquote summary (placeholder if omitted)")
  .option("--child-path <path>", "Override the derived child path")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      parentPath: "--parent-path", title: "--title", body: "--body",
      summary: "--summary", childPath: "--child-path", gateOn: "--gate-on",
      remote: "--remote", json: "--json",
    });
    shellWrite("create-child", opts, extra);
  });

program
  .command("add-association")
  .description("Atomic two-sided assoc patch. Hard-refuses hierarchy or sibling duplicates.")
  .requiredOption("--a-path <path>", "First doc path")
  .requiredOption("--b-path <path>", "Second doc path")
  .option("--label <text>", "Shared label on both bullets")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      aPath: "--a-path", bPath: "--b-path", label: "--label",
      gateOn: "--gate-on", remote: "--remote", json: "--json",
    });
    shellWrite("add-association", opts, extra);
  });

program
  .command("move-doc")
  .description("Atomic reparent: three-side edge update (child's Child of + both parents' Parent of).")
  .requiredOption("--path <path>", "Child doc to reparent")
  .requiredOption("--new-parent-path <path>", "New parent doc")
  .option("--old-parent-path <path>", "Old parent (required if child has multiple Child of bullets)")
  .option("--position <n>", "0-indexed position in new parent's Parent of")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", newParentPath: "--new-parent-path",
      oldParentPath: "--old-parent-path", position: "--position",
      gateOn: "--gate-on", remote: "--remote", json: "--json",
    });
    shellWrite("move-doc", opts, extra);
  });

program
  .command("rename-doc")
  .description("Rewrite H1, move file, update every [[old_title]] wiki-link across the vault. DESTRUCTIVE.")
  .requiredOption("--old-path <path>", "Existing doc path")
  .requiredOption("--new-title <title>", "New H1 title")
  .option("--new-path <path>", "Override the derived new path")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      oldPath: "--old-path", newTitle: "--new-title", newPath: "--new-path",
      remote: "--remote", json: "--json",
    });
    shellWrite("rename-doc", opts, extra);
  });

// -----------------------------------------------------------------------
// SPRINT-091 chunk 3: full-file writes + lifecycle.
// -----------------------------------------------------------------------

program
  .command("write-doc")
  .description("Create or overwrite an entire doc. DESTRUCTIVE — always run write-doc-preview first.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--content <text>", "Full markdown content")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", content: "--content", gateOn: "--gate-on",
      remote: "--remote", json: "--json",
    });
    shellWrite("write-doc", opts, extra);
  });

program
  .command("write-doc-preview")
  .description("Diff + list of sections that would be removed by write-doc. Always call before write-doc.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--content <text>", "Proposed full markdown content")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", content: "--content",
      remote: "--remote", json: "--json",
    });
    shellWrite("write-doc-preview", opts, extra);
  });

program
  .command("trash-doc")
  .description("Sidecar-based soft delete. Restore is lossless (edges preserved).")
  .requiredOption("--path <path>", "Vault doc path")
  .option("--original-parent-path <path>", "Override the auto-derived restore target")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", originalParentPath: "--original-parent-path",
      remote: "--remote", json: "--json",
    });
    shellWrite("trash-doc", opts, extra);
  });

program
  .command("restore-doc")
  .description("Reverse a previous trash-doc. Edges were never touched.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, { path: "--path", remote: "--remote", json: "--json" });
    shellWrite("restore-doc", opts, extra);
  });

program
  .command("delete-doc")
  .description("Permanently remove a doc. NO UNDO. Returns inbound_edges + title_conflicts.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, { path: "--path", remote: "--remote", json: "--json" });
    shellWrite("delete-doc", opts, extra);
  });

// -----------------------------------------------------------------------
// SPRINT-091 chunk 3: structured reads (get-doc, get-summary, get-neighbors,
// get-context, search, read-doc-section, list-docs, list-summary-drift).
// -----------------------------------------------------------------------

program
  .command("get-doc")
  .description("Fetch a doc's envelope (title + summary + preamble + section headings). Pass --full for the body.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("--full", "Include the full markdown body")
  .option("--format <fmt>", "text | json (default text for --full)")
  .option("--expected-hash <hash>", "Short-circuit if focal unchanged")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", full: "--full", format: "--format",
      expectedHash: "--expected-hash", remote: "--remote", json: "--json",
    });
    shellRead("get-doc", opts, extra);
  });

program
  .command("get-summary")
  .description("Return {path, title, summary} for one doc — cheapest way to preview.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("--format <fmt>", "text | json")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", format: "--format", remote: "--remote", json: "--json",
    });
    shellRead("get-summary", opts, extra);
  });

program
  .command("get-neighbors")
  .description("Return the doc + 1-hop neighbours categorised by relationship type.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, { path: "--path", remote: "--remote", json: "--json" });
    shellRead("get-neighbors", opts, extra);
  });

program
  .command("get-context")
  .description("Return the focal doc + multi-hop neighbourhood within a token budget.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("--hops <n>", "Max BFS depth (1-3, default 2)")
  .option("--budget-tokens <n>", "Rough token cap (default 8000)")
  .option("--include-full", "Inline focal + hop-1 bodies")
  .option("--include-associates", "Include assoc edges in the walk")
  .option("--expected-hash <hash>", "Short-circuit if focal unchanged")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", hops: "--hops", budgetTokens: "--budget-tokens",
      includeFull: "--include-full", includeAssociates: "--include-associates",
      expectedHash: "--expected-hash", remote: "--remote", json: "--json",
    });
    shellRead("get-context", opts, extra);
  });

program
  .command("search")
  .description("Case-insensitive substring match over titles, summaries, content.")
  .requiredOption("--query <text>", "Search query")
  .option("--limit <n>", "Max results (default 10)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      query: "--query", limit: "--limit", remote: "--remote", json: "--json",
    });
    shellRead("search", opts, extra);
  });

program
  .command("read-doc-section")
  .description("Read one H2 section's body without paying for the whole doc.")
  .requiredOption("--path <path>", "Vault doc path")
  .option("--section-id <id>", "Section id (preferred over --heading)")
  .option("--heading <heading>", "H2 heading text (without ##)")
  .option("--expected-hash <hash>", "Short-circuit if unchanged")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", sectionId: "--section-id", heading: "--heading",
      expectedHash: "--expected-hash", remote: "--remote", json: "--json",
    });
    shellRead("read-doc-section", opts, extra);
  });

program
  .command("list-docs")
  .description("Enumerate every doc in the vault. Structured (vs `list` which is bytes-only).")
  .option("--format <fmt>", "text | json (default text)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      format: "--format", remote: "--remote", json: "--json",
    });
    shellRead("list-docs", opts, extra);
  });

program
  .command("list-summary-drift")
  .description("Return paths whose body has drifted since their summary was last authored.")
  .option("--prefix <p>", "Path prefix filter")
  .option("--limit <n>", "Max candidates (default 20)")
  .option("--offset <k>", "Skip first N candidates")
  .option("--format <fmt>", "text | json (default text)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      prefix: "--prefix", limit: "--limit", offset: "--offset",
      format: "--format", remote: "--remote", json: "--json",
    });
    shellRead("list-summary-drift", opts, extra);
  });

program.parseAsync();

#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import readline from "node:readline/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
// Version comes from package.json — `npm version <bump>` is the one
// place the string ever needs to change. createRequire works on any
// Node >= 14 without depending on the newer `import ... with { type: "json" }`
// attribute syntax (stable only in Node 20.10+).
const pkg = createRequire(import.meta.url)("../package.json");

// SPRINT-124: config file at ~/.emdee/config.json for user-level defaults.
// Currently supported keys:
//   - default_mode: "remote" | "local" — when "remote", commands act as if
//     --remote was passed. Explicit --local overrides. Reduces typing on
//     every command for users whose primary workflow is cloud.
//   - default_docs: absolute path — default value for -d/--docs.
// Loaded once on startup; env vars still take precedence.
let userConfig = {};
try {
  const cfgPath = path.join(os.homedir(), ".emdee", "config.json");
  const raw = await readFile(cfgPath, "utf8");
  userConfig = JSON.parse(raw);
} catch {
  // Missing / unreadable config is fine — every flag has its own default.
}

function applyRemoteDefault(opts) {
  if (opts.remote === true || opts.local === true) return opts;
  // Explicit -d/--docs signals local intent — don't remote-default.
  if (typeof opts.docs === "string" && opts.docs.length > 0) return opts;
  if (userConfig.default_mode === "remote") opts.remote = true;
  return opts;
}

// SPRINT-129: prefer pre-bundled dist/ over `npx tsx` when present.
// Bundled path is ~40× faster (3.1s → 79ms tsx cold-start eliminated).
// Falls back to tsx for repo checkouts that haven't run `npm run build:cli`.
function resolveExecutor(relTsPath) {
  const bundledPath = path.join(pkgRoot, relTsPath.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
  if (existsSync(bundledPath)) return { cmd: "node", args: [bundledPath] };
  return { cmd: "npx", args: ["tsx", path.join(pkgRoot, relTsPath)] };
}

// SPRINT-125: read newline-delimited paths from stdin. Enables shell
// composition — `emdee list | emdee batch-get-summary --stdin`. Empty
// lines are skipped; the whole input is capped at 50 paths (matching
// the batch tool's MAX_BATCH).
async function readStdinPaths() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => {
      const paths = buf.split("\n").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50);
      resolve(paths);
    });
    process.stdin.on("error", reject);
  });
}

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
    const exec = resolveExecutor("src/mcp/server.ts");
    const child = spawn(exec.cmd, exec.args, {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("list")
  .alias("ls")
  .description("Print one doc path per line. Local by default; --remote reads your live vault via emdee.tech.")
  .option("-d, --docs <dir>", "docs directory (local mode)", "docs")
  .option("--prefix <prefix>", "filter to paths starting with this prefix")
  .option("--remote", "route through emdee.tech (requires `emdee login`)")
  .action((opts) => {
    applyRemoteDefault(opts);
    const docs = path.resolve(process.cwd(), opts.docs);
    const exec = resolveExecutor("src/cli/read-commands.ts");
    const args = [...exec.args, "list"];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    if (opts.remote) args.push("--remote");
    const child = spawn(exec.cmd, args, {
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
    applyRemoteDefault(opts);
    const docs = path.resolve(process.cwd(), opts.docs);
    const exec = resolveExecutor("src/cli/read-commands.ts");
    const args = [
      ...exec.args,
      "drift-batch",
      "--limit", opts.limit,
      "--offset", opts.offset,
    ];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    if (opts.remote) args.push("--remote");
    const child = spawn(exec.cmd, args, {
      cwd: pkgRoot,
      stdio: "inherit",
      env: { ...process.env, EMDEE_DOCS: docs },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// SPRINT-091: PKCE login against emdee.tech. Credentials stashed in
// ~/.config/emdee/credentials.json for `--remote` calls to pick up.
function shellAuth(sub, extra = []) {
  const exec = resolveExecutor("src/cli/auth-commands.ts");
  const child = spawn(
    exec.cmd,
    [...exec.args, sub, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// SPRINT-091 chunk 2: write verbs shell through the dispatcher.
function shellWrite(verb, opts, extra = []) {
  const docs = opts.docs ? path.resolve(process.cwd(), opts.docs) : path.join(process.cwd(), "docs");
  const exec = resolveExecutor("src/cli/write-commands.ts");
  const child = spawn(
    exec.cmd,
    [...exec.args, verb, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env, EMDEE_DOCS: docs } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// SPRINT-091 chunk 3: structured read verbs share read-commands.ts dispatcher.
function shellRead(verb, opts, extra = []) {
  const docs = opts.docs ? path.resolve(process.cwd(), opts.docs) : path.join(process.cwd(), "docs");
  const exec = resolveExecutor("src/cli/read-commands.ts");
  const child = spawn(
    exec.cmd,
    [...exec.args, verb, ...extra],
    { cwd: pkgRoot, stdio: "inherit", env: { ...process.env, EMDEE_DOCS: docs } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Every write verb takes the same core flag surface; a small helper builds
// the extra-args array from commander's parsed opts + a spec of which flags
// map to which write-commands.ts flag names.
//
// SPRINT-124: honour ~/.emdee/config.json default_mode by injecting
// opts.remote before mapping when the user has opted in and hasn't
// explicitly overridden with --local. Central hook so every command
// benefits without per-verb edits.
function argsFromOpts(opts, mapping) {
  applyRemoteDefault(opts);
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

// SPRINT-142 (SIG-032 Phase 3): one-shot bidirectional sync.
program
  .command("sync")
  .description("One-shot bidirectional sync between local vault and cloud. Uses version-guards (SPRINT-141). Same-section conflicts preserve the local draft under .emdee/conflicts/ and adopt the cloud version. Not a daemon — run manually or via cron.")
  .option("-d, --docs <dir>", "docs directory")
  .option("--dry-run", "Show planned actions without writing anything")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    // SPRINT-142F: always resolve --docs against the user's CWD before spawning.
    // The child runs with cwd: pkgRoot, so process.cwd() inside the child is
    // the install directory — the fallback would silently resolve to
    // <install>/docs (a phantom path) instead of the user's vault.
    const docs = opts.docs
      ? path.resolve(process.cwd(), opts.docs)
      : path.join(process.cwd(), "docs");
    const extra = ["--docs", docs];
    if (opts.dryRun) extra.push("--dry-run");
    if (opts.json) extra.push("--json");
    const exec = resolveExecutor("src/cli/sync-command.ts");
    const child = spawn(
      exec.cmd,
      [...exec.args, ...extra],
      { cwd: pkgRoot, stdio: "inherit", env: { ...process.env } },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
  });

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
    const exec = resolveExecutor("src/cli/skills-install.ts");
    const child = spawn(
      exec.cmd,
      [...exec.args, ...extra],
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
  .alias("p")
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
  .option("--expected-hash <hash>", "Optional doc_content_hash from get_doc — write rejected on mismatch (SPRINT-141a)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", sectionId: "--section-id",
      heading: "--heading", createIfMissing: "--create-if-missing",
      gateOn: "--gate-on", expectedHash: "--expected-hash",
      remote: "--remote", json: "--json",
    });
    shellWrite("append-section", opts, extra);
  });

program
  .command("append-doc")
  .description("Append to the end of a doc (after every section). Ideal for LOGS, daily notes.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--body <text>", "Content to append")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("--expected-hash <hash>", "Optional doc_content_hash — write rejected on mismatch (SPRINT-141a)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", body: "--body", gateOn: "--gate-on",
      expectedHash: "--expected-hash",
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
  .alias("cc")
  .description("Atomic write + parent-of patch: create a new doc as child of an existing one.")
  .requiredOption("--parent-path <path>", "Parent doc path")
  .requiredOption("--title <title>", "New doc's H1 title")
  .option("--body <text>", "Optional body appended after ## Notes")
  .option("--summary <text>", "Optional blockquote summary (placeholder if omitted)")
  .option("--child-path <path>", "Override the derived child path")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("--expected-parent-hash <hash>", "Optional parent doc_content_hash — parent-side write rejected on mismatch (SPRINT-141b)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      parentPath: "--parent-path", title: "--title", body: "--body",
      summary: "--summary", childPath: "--child-path", gateOn: "--gate-on",
      expectedParentHash: "--expected-parent-hash",
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
  .option("--expected-a-hash <hash>", "Optional a_path doc_content_hash (SPRINT-141b)")
  .option("--expected-b-hash <hash>", "Optional b_path doc_content_hash (SPRINT-141b)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      aPath: "--a-path", bPath: "--b-path", label: "--label",
      gateOn: "--gate-on",
      expectedAHash: "--expected-a-hash", expectedBHash: "--expected-b-hash",
      remote: "--remote", json: "--json",
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
  .option("--expected-child-hash <hash>", "Optional child doc_content_hash (SPRINT-141b)")
  .option("--expected-old-parent-hash <hash>", "Optional old-parent doc_content_hash (SPRINT-141b)")
  .option("--expected-new-parent-hash <hash>", "Optional new-parent doc_content_hash (SPRINT-141b)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", newParentPath: "--new-parent-path",
      oldParentPath: "--old-parent-path", position: "--position",
      gateOn: "--gate-on",
      expectedChildHash: "--expected-child-hash",
      expectedOldParentHash: "--expected-old-parent-hash",
      expectedNewParentHash: "--expected-new-parent-hash",
      remote: "--remote", json: "--json",
    });
    shellWrite("move-doc", opts, extra);
  });

program
  .command("rename-doc")
  .description("Rewrite H1, move file, update every [[old_title]] wiki-link across the vault. DESTRUCTIVE.")
  .requiredOption("--old-path <path>", "Existing doc path")
  .requiredOption("--new-title <title>", "New H1 title")
  .option("--new-path <path>", "Override the derived new path")
  .option("--expected-hash <hash>", "Optional source doc_content_hash — rename rejected on mismatch (SPRINT-141c). Downstream wiki-link rewrites are NOT guarded.")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      oldPath: "--old-path", newTitle: "--new-title", newPath: "--new-path",
      expectedHash: "--expected-hash",
      remote: "--remote", json: "--json",
    });
    shellWrite("rename-doc", opts, extra);
  });

program
  .command("rename-title")
  .description("Bulk-safe wiki-link rewrite. Finds every [[old-title]] across the vault and rewrites to [[new-title]]. Does NOT touch the doc that owns the title — use rename-doc for that.")
  .requiredOption("--old-title <title>", "Current title to search for")
  .requiredOption("--new-title <title>", "Replacement title")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      oldTitle: "--old-title", newTitle: "--new-title",
      remote: "--remote", json: "--json",
    });
    shellWrite("rename-title", opts, extra);
  });

// -----------------------------------------------------------------------
// SPRINT-091 chunk 3: full-file writes + lifecycle.
// -----------------------------------------------------------------------

program
  .command("write-doc")
  .alias("w")
  .description("Create or overwrite an entire doc. DESTRUCTIVE — always run write-doc-preview first.")
  .requiredOption("--path <path>", "Vault doc path")
  .requiredOption("--content <text>", "Full markdown content")
  .option("--gate-on <code...>", "Lint codes to hard-block on")
  .option("--expected-hash <hash>", "Optional doc_content_hash — overwrite rejected on mismatch. Create case is guard-passthrough (SPRINT-141a).")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", content: "--content", gateOn: "--gate-on",
      expectedHash: "--expected-hash",
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
  .option("--expected-hash <hash>", "Optional doc_content_hash — trash rejected on mismatch (SPRINT-141b)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", originalParentPath: "--original-parent-path",
      expectedHash: "--expected-hash",
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
  .option("--expected-hash <hash>", "Optional doc_content_hash — delete rejected on mismatch (SPRINT-141a)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", expectedHash: "--expected-hash",
      remote: "--remote", json: "--json",
    });
    shellWrite("delete-doc", opts, extra);
  });

// -----------------------------------------------------------------------
// SPRINT-091 chunk 3: structured reads (get-doc, get-summary, get-neighbors,
// get-context, search, read-doc-section, list-docs, list-summary-drift).
// -----------------------------------------------------------------------

program
  .command("get-doc")
  .alias("g")
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
  .alias("gs")
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
  .alias("gn")
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
  .alias("s")
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

program
  .command("lint-doc")
  .description("Audit one doc for quality defects (missing preamble, asymmetric edges, sibling assocs, etc).")
  .requiredOption("--path <path>", "Vault doc path")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, { path: "--path", remote: "--remote", json: "--json" });
    shellRead("lint-doc", opts, extra);
  });

program
  .command("lint-vault")
  .description("Batch-lint every doc in the vault. Returns aggregated warnings by code + per-doc punch list. Pass --auto-fix to mechanically clean up Tier-1 redundant-associate bullets (dry-run by default; add --yes to actually write).")
  .option("--prefix <p>", "Path prefix filter (scope to a subtree)")
  .option("--limit <n>", "Max docs in the punch list (default: all)")
  .option("--auto-fix", "Run Tier-1 auto-fix (sibling_assoc_redundant + associate_duplicates_hierarchy) instead of a plain scan. Dry-run by default.")
  .option("--yes", "With --auto-fix: actually apply the fixes instead of dry-run.")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    if (opts.autoFix) {
      // SPRINT-102: dispatch to autofix tool. Dry-run by default; --yes flips it.
      const extra = argsFromOpts(opts, { yes: "--yes", remote: "--remote", json: "--json" });
      shellRead("lint-vault-autofix", opts, extra);
      return;
    }
    const extra = argsFromOpts(opts, {
      prefix: "--prefix", limit: "--limit", remote: "--remote", json: "--json",
    });
    shellRead("lint-vault", opts, extra);
  });

// -----------------------------------------------------------------------
// Deferred parity gap closers (post-SPRINT-091): 4 remaining tool verbs.
// -----------------------------------------------------------------------

program
  .command("get-image")
  .description("Fetch an image doc's binary. Default output prints metadata JSON; --out writes decoded bytes to file.")
  .requiredOption("--doc-path <path>", "Path to the image doc (e.g. images/PHOTO-...md)")
  .option("--out <path>", "Write the decoded image bytes to this file")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Pretty-print metadata")
  .action((opts) => {
    const outResolved = opts.out ? path.resolve(process.cwd(), opts.out) : "";
    const extra = ["--doc-path", opts.docPath];
    if (outResolved) extra.push("--out", outResolved);
    if (opts.remote) extra.push("--remote");
    if (opts.json) extra.push("--json");
    shellRead("get-image", opts, extra);
  });

program
  .command("distill-doc")
  .description("Read-only intake for split planning: returns section boundaries + rubric-quoted vault context.")
  .requiredOption("--path <path>", "Doc to distill")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path", remote: "--remote", json: "--json",
    });
    shellWrite("distill-doc", opts, extra);
  });

program
  .command("materialize-subgroup")
  .description("Promote an H3 subgroup inside a doc's Parent of into a real intermediate parent doc.")
  .requiredOption("--source-path <path>", "Source doc holding the subgroup")
  .requiredOption("--subgroup-heading <heading>", "H3 heading text (without ###)")
  .option("--new-doc-title <title>", "Override the derived new doc title")
  .option("--new-doc-path <path>", "Override the derived new doc path")
  .option("--summary <text>", "Blockquote summary for the new intermediate")
  .option("--expected-source-hash <hash>", "Optional source doc_content_hash (SPRINT-141b)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      sourcePath: "--source-path", subgroupHeading: "--subgroup-heading",
      newDocTitle: "--new-doc-title", newDocPath: "--new-doc-path",
      summary: "--summary",
      expectedSourceHash: "--expected-source-hash",
      remote: "--remote", json: "--json",
    });
    shellWrite("materialize-subgroup", opts, extra);
  });

program
  .command("split-doc")
  .description("Atomically refactor a doc into concept nodes. Extracts array read from a JSON file.")
  .requiredOption("--source-path <path>", "Source doc being split")
  .requiredOption("--rewrite-source-content <text>", "New markdown for the source (with wiki-links to extracts)")
  .requiredOption("--extracts-file <path>", 'JSON file: [{"path":"<new>.md","content":"<md>"}, ...]')
  .option("--expected-hash <hash>", "Optional source doc_content_hash — split rejected on mismatch (SPRINT-141a)")
  .option("-d, --docs <dir>", "docs directory (local mode)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extractsResolved = path.resolve(process.cwd(), opts.extractsFile);
    const extra = argsFromOpts(opts, {
      sourcePath: "--source-path",
      rewriteSourceContent: "--rewrite-source-content",
      expectedHash: "--expected-hash",
      remote: "--remote", json: "--json",
    });
    extra.push("--extracts-file", extractsResolved);
    shellWrite("split-doc", opts, extra);
  });

program
  .command("batch-get-summary")
  .description("Fetch {path, title, summary} for many docs in one call. Pass --path repeatedly OR --stdin for newline-delimited paths (max 50 combined).")
  .option("--path <p...>", "Doc path (repeat for multiple)")
  .option("--stdin", "Read newline-delimited paths from stdin (composable with pipes)")
  .option("-d, --docs <dir>", "docs directory")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action(async (opts) => {
    applyRemoteDefault(opts);
    const extra = [];
    const paths = Array.isArray(opts.path) ? opts.path : (opts.path ? [opts.path] : []);
    if (opts.stdin) {
      const stdinPaths = await readStdinPaths();
      paths.push(...stdinPaths);
    }
    for (const p of paths) extra.push("--path", p);
    if (opts.remote) extra.push("--remote");
    if (opts.json) extra.push("--json");
    shellWrite("batch-get-summary", opts, extra);
  });

program
  .command("batch-get-doc")
  .description("Fetch envelope (no body) for many docs in one call. Pass --path repeatedly OR --stdin for newline-delimited paths (max 50 combined).")
  .option("--path <p...>", "Doc path (repeat for multiple)")
  .option("--stdin", "Read newline-delimited paths from stdin (composable with pipes)")
  .option("-d, --docs <dir>", "docs directory")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action(async (opts) => {
    applyRemoteDefault(opts);
    const extra = [];
    const paths = Array.isArray(opts.path) ? opts.path : (opts.path ? [opts.path] : []);
    if (opts.stdin) {
      const stdinPaths = await readStdinPaths();
      paths.push(...stdinPaths);
    }
    for (const p of paths) extra.push("--path", p);
    if (opts.remote) extra.push("--remote");
    if (opts.json) extra.push("--json");
    shellWrite("batch-get-doc", opts, extra);
  });

program
  .command("find-similar")
  .description("Find docs with vocabulary overlap to a source doc (Postgres FTS). Zero-cost, zero-dep semantic-adjacent search. Cloud-only.")
  .requiredOption("--path <path>", "Source doc path")
  .option("--limit <n>", "Max results (default 10, max 50)")
  .option("-d, --docs <dir>", "docs directory (local mode — find-similar is cloud-only, this errors)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path",
      limit: "--limit",
      remote: "--remote",
      json: "--json",
    });
    shellWrite("find-similar", opts, extra);
  });

program
  .command("lint-orphans")
  .description("Scan for orphan nodes (docs with no incoming hierarchy edge in doc_edges). Reports by kind: data_layer_drift (auto-fixable), markdown_drift (needs human), structural_orphan (may be intentional). Pass --fix to auto-repair data-layer cases via per-doc reconcile. Cloud-only.")
  .option("--fix", "Auto-fix data_layer_drift orphans by running per-doc reconcile")
  .option("-d, --docs <dir>", "docs directory (local mode — lint-orphans is cloud-only, this errors)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      fix: "--fix",
      remote: "--remote",
      json: "--json",
    });
    shellWrite("lint-orphans", opts, extra);
  });

program
  .command("reconcile")
  .description("Repair doc_edges drift. Per-doc with --path, or full namespace with --all. Rebuilds edges from markdown truth. Cloud only.")
  .option("--path <path>", "Doc path to reconcile (either --path OR --all required)")
  .option("--all", "Full-namespace rebuild via backfillNamespace")
  .option("-d, --docs <dir>", "docs directory (local mode — reconcile is cloud-only, this errors)")
  .option("--remote", "Route through emdee.tech")
  .option("--json", "Machine-parseable output")
  .action((opts) => {
    const extra = argsFromOpts(opts, {
      path: "--path",
      all: "--all",
      remote: "--remote",
      json: "--json",
    });
    shellWrite("reconcile", opts, extra);
  });

// SPRINT-124: config subcommand — inspect, set, or init the user
// config at ~/.emdee/config.json. Keeps the config surface discoverable
// (no docs-diving to figure out what keys exist).
program
  .command("config")
  .description("Manage ~/.emdee/config.json. `emdee config` prints current. `emdee config set <key> <value>` writes. `emdee config init` writes a starter file.")
  .argument("[action]", "get | set | init | path (default: get)")
  .argument("[key]", "config key (for set)")
  .argument("[value]", "config value (for set)")
  .action(async (action, key, value) => {
    const cfgDir = path.join(os.homedir(), ".emdee");
    const cfgPath = path.join(cfgDir, "config.json");

    const printCurrent = () => {
      console.log(`config: ${cfgPath}`);
      console.log(JSON.stringify(userConfig, null, 2));
    };

    if (!action || action === "get") return printCurrent();

    if (action === "path") { console.log(cfgPath); return; }

    if (action === "init") {
      await mkdir(cfgDir, { recursive: true });
      try { await access(cfgPath); console.log(`already exists at ${cfgPath}`); return; } catch {}
      const starter = { default_mode: "remote" };
      await writeFile(cfgPath, JSON.stringify(starter, null, 2) + "\n", "utf8");
      console.log(`wrote ${cfgPath}`);
      console.log(JSON.stringify(starter, null, 2));
      return;
    }

    if (action === "set") {
      if (!key || value === undefined) {
        console.error("usage: emdee config set <key> <value>");
        process.exit(1);
      }
      await mkdir(cfgDir, { recursive: true });
      const next = { ...userConfig, [key]: value };
      await writeFile(cfgPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      console.log(`set ${key}=${value} in ${cfgPath}`);
      return;
    }

    console.error(`unknown action: ${action}. Use get | set | init | path`);
    process.exit(1);
  });

// SPRINT-128: cache management. Inspect stats, purge, or configure TTL.
program
  .command("cache")
  .description("Manage the read-response cache at ~/.emdee/cache/. Actions: stats (default), clear, ttl <seconds>.")
  .argument("[action]", "stats | clear | ttl (default: stats)")
  .argument("[value]", "For `ttl` action: seconds")
  .action(async (action, value) => {
    const cacheDir = path.join(os.homedir(), ".emdee", "cache");
    const cfgPath = path.join(os.homedir(), ".emdee", "config.json");

    if (!action || action === "stats") {
      try {
        const files = await import("node:fs/promises").then((m) => m.readdir(cacheDir));
        const jsonFiles = files.filter((f) => f.endsWith(".json"));
        console.log(`cache: ${cacheDir}`);
        console.log(`entries: ${jsonFiles.length}`);
        console.log(`ttl_seconds: ${userConfig.cache_ttl_seconds ?? 300}`);
      } catch {
        console.log(`cache: ${cacheDir} (not yet populated)`);
        console.log(`entries: 0`);
        console.log(`ttl_seconds: ${userConfig.cache_ttl_seconds ?? 300}`);
      }
      return;
    }

    if (action === "clear") {
      try {
        await import("node:fs/promises").then((m) => m.rm(cacheDir, { recursive: true, force: true }));
        console.log(`cleared ${cacheDir}`);
      } catch (e) {
        console.error(`clear failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      return;
    }

    if (action === "ttl") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        console.error("usage: emdee cache ttl <positive-seconds>");
        process.exit(1);
      }
      await mkdir(path.dirname(cfgPath), { recursive: true });
      const next = { ...userConfig, cache_ttl_seconds: n };
      await writeFile(cfgPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      console.log(`set cache_ttl_seconds=${n} in ${cfgPath}`);
      return;
    }

    console.error(`unknown action: ${action}. Use stats | clear | ttl`);
    process.exit(1);
  });

program.parseAsync();

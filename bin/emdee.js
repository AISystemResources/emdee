#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const program = new Command();
program.name("emdee").description("Emdee — local docs + knowledge graph + MCP").version("0.0.1");

program
  .command("init")
  .description("Create a docs/ folder seeded with SILENTMANE.md, TEMPLATE.md, and a SAMPLE_* example set")
  .action(async () => {
    const cwd = process.cwd();
    const docsDir = path.join(cwd, "docs");
    await mkdir(docsDir, { recursive: true });
    const seeds = [
      "MANE.md",
      "VAULT.md",
      "INFO.md",
      "INSTRUCTIONS.md",
      "BRAIN.md",
      "WORKFLOWS.md",
      "SAMPLE.md",
      "EDUCATION.md",
      "CAREER.md",
      "sample/TEMPLATE.md",
      "sample/ACME-WORKSPACE.md",
      "sample/ATLAS-SEARCH.md",
      "sample/QUERY-ROUTER.md",
      "sample/MAYA-CHEN.md",
    ];
    for (const name of seeds) {
      const target = path.join(docsDir, name);
      try {
        await access(target);
        console.log(`docs/${name} already exists — leaving it alone.`);
      } catch {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(pkgRoot, "templates", name), target);
        console.log(`Created docs/${name}`);
      }
    }
    console.log(
      `\nDelete the sample branch once you've read it: rm -rf docs/sample/`
    );
  });

program
  .command("start")
  .description("Start the Emdee viewer against ./docs")
  .option("-p, --port <port>", "port", "5173")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .action((opts) => {
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
  .description("Start the Emdee viewer using Next.js (App Router)")
  .option("-p, --port <port>", "port", "3000")
  .option("-d, --docs <dir>", "docs directory", "docs")
  .action((opts) => {
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

program.parseAsync();

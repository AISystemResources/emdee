import type { Plugin } from "vite";
import path from "node:path";
import { watch } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { buildIndex } from "../core/indexer.js";

function safeJoin(base: string, rel: string): string | null {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  if (!resolved.endsWith(".md")) return null;
  return resolved;
}

export function silentManePlugin(docsDir: string): Plugin {
  const resolved = path.resolve(docsDir);
  return {
    name: "emdee-dev",
    configureServer(server) {
      server.middlewares.use("/api/index", async (_req, res) => {
        const index = await buildIndex(resolved);
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(index));
      });

      server.middlewares.use("/api/doc", async (req, res) => {
        if (req.method !== "PUT") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const url = new URL(req.url ?? "", "http://localhost");
        const rel = url.searchParams.get("path");
        if (!rel) {
          res.statusCode = 400;
          res.end("missing path");
          return;
        }
        const file = safeJoin(resolved, rel);
        if (!file) {
          res.statusCode = 400;
          res.end("invalid path");
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks).toString("utf8");
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, body, "utf8");
          res.statusCode = 204;
          res.end();
        } catch (err) {
          res.statusCode = 500;
          res.end(`save failed: ${(err as Error).message}`);
        }
      });

      let timer: NodeJS.Timeout | null = null;
      const notify = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          server.ws.send({ type: "custom", event: "emdee:docs-changed" });
        }, 100);
      };

      try {
        const watcher = watch(resolved, { recursive: true }, (_event, filename) => {
          if (!filename) return notify();
          if (filename.endsWith(".md")) notify();
        });
        server.httpServer?.once("close", () => watcher.close());
      } catch (err) {
        server.config.logger.warn(`[emdee] could not watch ${resolved}: ${(err as Error).message}`);
      }
    },
  };
}

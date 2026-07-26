import path from "node:path";

export const dynamic = "force-dynamic";

// SPRINT-150d: switched the Claude Code onboarding command from
// `claude mcp add emdee --transport http ...` to the npm install +
// stdio-MCP pattern. Cleaner distribution story: users install our
// package once and can then use it locally OR wire it into Claude Code.
// No account required for local use; the HTTP endpoint is documented
// separately for cloud-vault users.
export async function GET(request: Request) {
  const docsDir = process.env.EMDEE_DOCS;

  if (docsDir) {
    const resolved = path.resolve(docsDir);
    const command = `npm i -g @aisystemresources/emdee && emdee mcp --docs "${resolved}"`;
    return Response.json({ mode: "local", command });
  }

  // Cloud-vault users: install the CLI globally, then have Claude Code
  // launch it as a local stdio MCP server. The CLI handles OAuth to
  // the cloud MCP on first use.
  void request; // origin retained in the signature for future cloud-http path.
  const command = `npm i -g @aisystemresources/emdee && emdee mcp`;
  return Response.json({ mode: "cloud", command });
}

# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in `@aisystemresources/emdee` — either the npm CLI package, the MCP server, the Next.js renderer at `emdee.tech`, or the Supabase-backed storage layer — please report it privately to Edmund at **elz.work22@gmail.com**.

Do not open a public GitHub issue for suspected vulnerabilities.

We aim to acknowledge reports within 3 business days and to ship a fix (or a documented mitigation) within 14 days for high-severity issues.

## Scope

In-scope:
- Runtime code in this repository (`src/`, `app/`, `bin/`)
- Published npm package tarball contents
- Supabase RLS policies affecting `vault_files`, `doc_edges`, `doc_shares`, `publications`, and OAuth tables
- MCP endpoint (`/api/mcp`) authentication and authorization
- Client-side content sanitization (markdown rendering, share pages)

Out-of-scope:
- Vulnerabilities in dev-only dependencies (linters, test frameworks) that cannot affect production runtime
- Reports requiring physical access to the user's machine
- Social engineering of authorized users
- DoS via load exceeding stated tier limits

## Supported versions

Only the latest published version on npm receives security updates. Please upgrade to the current version before reporting to confirm the issue reproduces.

## Coordinated disclosure

We prefer coordinated disclosure. If you have a fix in mind, please describe it in your report — we may be able to ship attribution and a public advisory in the same window.

## Bug bounty

There is no formal bounty program. Contributors who report valid vulnerabilities will be credited in the release notes if they wish.

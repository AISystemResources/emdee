# AGENTS

> Catalog of C-suite role templates for your Claude-Schedules-driven agent constellation. Copy a template into your own vault subtree, customise with project context, then wire up a Claude Schedule to fire it hourly. Prompts live here; runtime is Claude Schedules — no Anthropic API keys, ever.

## Child of

* [[VAULT]]

## Parent of

* [[CMO]]

* [[CPO]]

* [[CEO]]

* [[COO]]

* [[AGENT-LOOP]]

## Associated with

## How this works

Each agent = one vault doc + one Claude Schedule.

The **doc** holds the prompt: role, project context, dispatch targets, tools. The **schedule** contains one instruction: *"Read [[my-agent]] via EMDEE MCP and follow its instructions."* Every agent doc opens with `Follow [[AGENT-LOOP]] first.` — the six-step loop below.

The tickets table (SPRINT-173, extended in SPRINT-185) is the queue between agents. `assigned_agent_id` = who the ticket is for. `sender_agent_id` = who filed it. Convention for slugs: `project:role` (`whatelz:cmo`, `emdee:cpo`).

## Vault-graph conventions

- `## Child of` on an agent doc = the CEO / parent agent it reports to
- `## Associated with` = peer agents it dispatches to (labelled: "dispatches to")

This reuses the existing bidirectional-edge machinery — no new relationship schema.

## Templates (below)

Copy the body of a template into your own project's `AGENTS/` folder as a new doc. Customise the "PROJECT CONTEXT" section with your specifics. Reference `[[AGENT-LOOP]]` at the top of every agent doc so mechanics stay consistent.

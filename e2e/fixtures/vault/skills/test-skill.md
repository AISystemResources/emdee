# EMDEE_TEST_VAULT — TEST-SKILL

> Fixture skill-reference doc for the EMDEE e2e suite. Demonstrates how a skill or playbook lives in the vault as a referenceable doc. Seeded by `e2e/global-setup.ts`; never edit by hand.

## Child of

* [[EMDEE_TEST_VAULT — INFO]]

## Parent of

## Associated with

## Notes

Skills in EMDEE are reusable playbooks (e.g., "how to write a sprint", "how to triage INBOX"). They live as docs in the vault so they can be linked, edited, and surfaced via MCP tools. This fixture exists so a future spec can assert "the MCP `search` tool finds this skill by keyword" or "the renderer surfaces skill docs in a dedicated section."

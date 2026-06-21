# EMDEE_TEST_VAULT — TEST-HUB

> Fixture hub node for the EMDEE e2e suite. Demonstrates the hub shape (one parent, multiple children, a `## Notes` section explaining intent). Seeded by `e2e/global-setup.ts`; never edit by hand.

## Child of

* [[EMDEE_TEST_VAULT — INFO]]

## Parent of

## Associated with

## Notes

A hub in EMDEE is a node whose role is to gather related children under one umbrella. It typically has a richer `## Notes` body and may carry typed edges in `## Associated with`. This fixture exists so future specs can assert "the graph view renders a hub with the expected fan-out shape" without depending on any user's production vault.

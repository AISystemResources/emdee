# EMDEE_TEST_VAULT — INFO

> Canonical entrypoint for the EMDEE e2e fixture vault. This vault is seeded into the **EMDEE-test** Supabase project at the start of every Playwright run by `e2e/global-setup.ts` and exists solely to give the test suite deterministic content to assert against. Any human inspecting EMDEE-test should treat these docs as disposable test scaffolding — never edit by hand.

## Child of

## Parent of

* [[EMDEE_TEST_VAULT — TEST-HUB]]
* [[EMDEE_TEST_VAULT — PERSON]]
* [[EMDEE_TEST_VAULT — TEST-SKILL]]

## Associated with

## Notes

The fixture vault mirrors the canonical node-type taxonomy of a real EMDEE vault — hubs, templates, skills — so future test cases can extend coverage by dropping new `.md` files into `e2e/fixtures/vault/` without touching the seed code.

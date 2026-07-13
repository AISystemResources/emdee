# SUMMARISER

> The nightly-ish workflow that scans the vault for docs whose body has drifted from their summary, proposes updated summaries into a review report, and lets the owner approve or edit before anything touches the source docs. Read-only w.r.t. the summaries themselves — this workflow only proposes; approval + application is a separate step (future sprint).

## Child of

* [[AUTOMATION]]

## When to run

- Manually: `/loop run-summariser` from Claude Code (or Claude Chat via the MCP).
- Scheduled (SPRINT-082+): nightly routine that fires while the owner sleeps.

## What Claude does when this workflow runs

1. **Fetch a batch of drift candidates** — call `list_summary_drift({ format: "text", limit: 20, offset: <last_offset> })`. If empty, report "no drift" and exit.

2. **Load the state doc** — read `SUMMARISER-STATE.md` under the same folder (create it if missing). It carries: last processed offset, last run timestamp, running counts.

3. **For each returned path**:
   - `get_doc({ path, full: true, format: "text" })` to read the doc.
   - Check the current blockquote summary (the `>` line under the H1).
   - Compare against the body's actual content. Ask: does the summary still describe what the doc is about? If yes → verdict `keep`. If no → verdict `replace` and draft a new one-line summary matching vault convention (see [[SUMMARY CONVENTION]] below).

4. **Append verdicts to today's report** at `automation/reports/YYYY-MM-DD.md` (create if missing). Format per doc:

   ```
   --- <path>
   Current: <current summary>
   Proposed: <new summary, or "(unchanged)">
   Verdict: keep | replace
   Rationale: <one line — what shifted, or why the current still fits>
   ```

5. **Update `SUMMARISER-STATE.md`** with the new offset and run timestamp.

6. **Never patch the source doc's blockquote in this workflow.** The report is the only artifact. Human review + a separate `apply-summariser-report` workflow (future sprint) handles application.

## Summary convention

One line, action-oriented, describes what the doc *is* and its current state. Examples from the live vault:

- *"Distilled wisdom from working on [[EMDEE_OS]] — what works, what doesn't, anti-patterns. Dated entries, supersede explicitly."*
- *"Casing enforcement in MCP write tools: create_child, move_doc, and rename_doc enforce the vault convention (lowercase folder names, UPPERCASE file names) at the tool layer — so violations are impossible, not just linted."*
- *"Personal operating principles distilled from cross-domain experience. The always-loaded prior for how to operate, independent of which project is at hand."*

Tone: dense, informative, no fluff. Length: usually 1–3 sentences. If the doc has strong wiki-links, cite them by `[[TITLE]]` in the summary.

## Guardrails

- **Never propose a summary that removes existing wiki-links** without a clear reason in the rationale.
- **Never mark a doc `replace` if the body change is trivially cosmetic** (whitespace, punctuation) — the drift signal fires on any body change; the summary may still be accurate.
- **Never process more than 20 docs per run** to keep report review manageable.
- **Never modify source docs** — the report is the only output.

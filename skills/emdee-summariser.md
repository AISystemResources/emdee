---
name: emdee-summariser
description: |
  Use whenever the user asks for a summary refresh, or when `emdee
  list-summary-drift` returns ≥ 1 candidate, or when you notice a doc whose
  summary is stale relative to its content (drifted body, new sections added,
  scope change). Runs the SPRINT-081 batch summariser flow.
---

# emdee-summariser — refresh drifting doc summaries

Docs in EMDEE carry a one-line `> blockquote` summary right below the H1. That summary is what routing sees — `emdee search`, `emdee get-summary`, cheap enumeration all pivot on it. When the body drifts (new sections, refined framing, changed scope), the summary should catch up. This skill runs that refresh.

## Trigger patterns

- User asks: "refresh summaries", "which docs have drifted", "run the summariser"
- Output of `emdee list-summary-drift` or `emdee drift-batch` returns any candidates
- You notice: after making substantial edits to a doc's body, its blockquote no longer accurately previews what's inside

## Workflow

### 1. Enumerate drift

```
emdee list-summary-drift --limit 20 --remote --format text
```

Returns up to 20 paths, one per line. Each is a doc where:
- `content_hash_at_summary_write` is null (never baselined), OR
- `hash(current_content) != content_hash_at_summary_write` (body drifted since summary was written)

For a bigger batch, raise `--limit`. Don't run > 50 in one pass — token cost + human review burden compounds.

### 2. Per doc, propose a new summary

For each returned path:

```
emdee get-doc --path <PATH> --remote --full --format text
```

Read the full body. Compose a new one-line summary (15-40 words) that:
- **Answers "what is this and why does it exist"** — routing signal
- **Uses the doc's own vocabulary** — searchers will match on their terms
- **Mentions the load-bearing thing first** — a scan of the first 20 characters should telegraph the doc's purpose

### 3. Report proposals to the user

Do NOT patch yet. Present the full batch as a punch list:

```
<PATH>
  Current: <old blockquote>
  Proposed: <new blockquote>

<PATH>
  Current: ...
  Proposed: ...
```

The user approves per-doc or in bulk.

### 4. On approval, patch each

Get the fresh preamble hash:

```
emdee get-doc --path <PATH> --remote --json
```

Take `preamble.content_hash`. Then:

```
emdee patch-preamble --path <PATH> \
  --body "> <new summary>" \
  --expected-hash <hash> --remote
```

The patch REPLACES the entire preamble body (blockquote + any intro paragraphs). If the doc has intro paragraphs before the first H2, preserve them by including them in the new `--body`.

## Batching etiquette

- **Read all 20 first, then propose, then wait for approval, then patch.** Don't interleave read + patch — you'll bill the user for reads on docs they'll reject.
- **Sort proposals by importance** (parent hubs first, leaves last). If the user only has time to review 5, they see the highest-signal ones.
- **If two docs share a common subject** and both need re-summarising, note it: `SEE ALSO: <other-path>`. Helps the user spot when a broader restructure is warranted.

## When to say no

- If the drift is small (a typo fix, a minor addition), skip the summary refresh. Only touch docs where the body has shifted enough that the current blockquote actively misleads.
- If the doc's structure has changed (added new sections that fundamentally change scope), don't just refresh the summary — suggest a broader restructure via `emdee move-doc` or `emdee split-doc`. Escalate to the user.

## Reporting after the batch

```
Refreshed <N> summaries in <namespace>.
Skipped <M> where drift was cosmetic.
Flagged <K> for restructure (see notes).
```

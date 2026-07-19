---
name: summarise
description: Refresh drifting doc summaries. Optional path prefix argument narrows the batch.
argument-hint: [path-prefix]
---

Run the emdee-summariser skill's batch flow:

1. `emdee list-summary-drift --remote --limit 20 --format text` (append `--prefix $ARGUMENTS` if the user provided one) → get up to 20 candidate paths
2. For each path, `emdee get-doc --path <path> --remote --full --format text` → read the body
3. Compose a fresh summary (15-40 words) that answers "what is this and why does it exist"
4. Present all proposals as a punch list — do NOT patch yet:

```
<path>
  Current: <old blockquote>
  Proposed: <new blockquote>
```

5. Wait for the user's approval (per-doc or bulk). On approval:
   - `emdee get-doc --path <path> --remote --json` → fetch preamble.content_hash
   - `emdee patch-preamble --path <path> --body "> <new>" --expected-hash <hash> --remote`

Never batch-patch without human review — image content is high-signal but the model can misread ambiguous shots.

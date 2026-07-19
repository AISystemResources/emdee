---
name: vault-status
description: Show a mini dashboard of the user's EMDEE vault — total docs + top 3 drifting summaries.
---

Run these commands via the Bash tool and present the results as a compact dashboard:

1. `emdee list --remote | wc -l` → total doc count
2. `emdee list-summary-drift --remote --limit 3 --format text` → top 3 drifting paths

Format the output as:

```
Vault: <N> docs total, <M> with drifting summaries
Top drift candidates:
  - <path 1>
  - <path 2>
  - <path 3>
```

If `emdee list --remote` errors with "run login", tell the user to run `emdee login` first and stop.

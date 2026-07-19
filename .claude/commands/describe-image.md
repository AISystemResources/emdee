---
name: describe-image
description: Describe an EMDEE vault image doc and rename it from timestamp to semantic title.
argument-hint: <vault-path>
---

Take the vault doc path from `$ARGUMENTS`. Run the emdee-describe-image skill workflow:

1. `emdee get-image --doc-path $ARGUMENTS --remote --out /tmp/emdee-describe.jpg` — save the image locally
2. Read the image visually and compose:
   - A semantic title, 3-6 words, UPPERCASE-with-HYPHENS (e.g. `HANDSTAND-BALANCE-DRILL`)
   - A one-line summary, 15-30 words
3. `emdee rename-doc --old-path $ARGUMENTS --new-title <TITLE> --remote`
4. Get the fresh preamble hash: `emdee get-doc --path <new-path> --remote --json`
5. `emdee patch-preamble --path <new-path> --body "> <summary>" --expected-hash <hash> --remote`

Report the before/after path + title + summary as a punch list at the end.

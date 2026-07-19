---
name: emdee-onboarder
description: |
  Use when the user's vault is fresh (`emdee list` returns exactly the 5
  virtual system nodes + at most 1 owner node), OR when they explicitly ask
  "how do I start with EMDEE" / "walk me through onboarding". Guides them
  through init → first project → connecting to Claude.
---

# emdee-onboarder — get a new user from install to first useful doc

A new user with EMDEE installed has:
- The `emdee` CLI on PATH
- A blank `~/.claude/skills/` (or this skill installed)
- Nothing yet in their vault (5 virtual system nodes + optionally an owner node)

Your job is to walk them from that state to a functional vault with at least one project + one note + Claude wired to it.

## Trigger patterns

- `emdee list --remote` returns 5 or 6 paths (the system nodes ± the owner)
- User says: "walk me through onboarding", "how do I start", "what's next"
- User just ran `emdee init` and is asking what to do next

## Workflow

### 1. Confirm the vault state

```
emdee list --remote --format text
```

You should see roughly:
```
EMDEE.md
GRAVEYARD.md
IMAGES.md
SHARED.md
VAULT.md
<OWNER>.md          # optional — present if they've run `emdee init --nickname`
```

If the owner is missing, guide them:
```
emdee init --nickname "Their Name"
```

This writes ONE file (their owner node) locally. In cloud mode, the owner node is created by the first web sign-in via the nickname prompt.

### 2. Explain the 5-node OS layer

Quickly. One breath. See `emdee-conventions` skill.

Emphasise: **the 5 system nodes are virtual. You don't create them, you don't edit them (unless you really want to override the default content). You reference them from your own content.**

### 3. Create their first real doc

Ask what they want to track first. Most users start with either:
- A project (they're building something)
- A person (someone they collaborate with or admire)
- A concept (something they're learning)

Then guide them:

**For a project:**
```
emdee create-child --parent-path VAULT.md \
  --title "PROJECT-NAME" \
  --summary "One sentence: what this project is and why." \
  --remote
```

**For a person:**
```
emdee create-child --parent-path VAULT.md \
  --title "FIRSTNAME-LASTNAME" \
  --summary "How you know them + one thing to remember." \
  --remote
```

**For a concept:**
```
emdee create-child --parent-path VAULT.md \
  --title "CONCEPT-NAME" \
  --summary "The load-bearing idea in one line." \
  --remote
```

### 4. Show them the graph

Have them open [emdee.tech](https://emdee.tech) in their browser. They should see EMDEE at the centre, connected to their owner node, connected to the doc they just created. This is the moment onboarding clicks — the graph is EMDEE's superpower.

### 5. Connect Claude

Explain that everything they just did via `emdee` CLI can also happen via Claude directly. Two paths:

**For Claude Code:** the CLI is already installed. Every future session, Claude can run `emdee` commands directly.

**For claude.ai:** they connect the emdee.tech MCP server via the connector panel (link in their emdee.tech sidebar).

### 6. Hand off to conventions

Say: "The `emdee-conventions` skill is now the always-loaded reference for how to write to your vault. Everything else — creating docs, linking them, tracking edges — is documented there."

Load the conventions skill (if not already loaded) and let it take over.

## What to avoid

- **Don't dump the full conventions in step 2.** The user is trying to see one thing work. Ship them from zero → seeing their first graph node in under 5 minutes. Depth comes after.
- **Don't force `create_child` before they know what to create.** The step-3 question ("what do you want to track first?") is critical. If they say "I don't know yet," don't create a doc — instead, suggest they browse [emdee.tech](https://emdee.tech) in incognito to see the public demo vault. Come back when they have an answer.
- **Don't reference SPRINTs / LOGS / LEARNINGS in onboarding.** Those are for later. Zero-to-one first.

## Success signal

The user, at the end of the onboarding, has:
- ✅ Their owner node visible
- ✅ At least one child doc under VAULT with a real summary
- ✅ Both docs visible in the emdee.tech graph, connected
- ✅ Understands they can use `emdee <verb>` OR Claude directly

If all four are true, hand off to `emdee-conventions` and end the onboarding.

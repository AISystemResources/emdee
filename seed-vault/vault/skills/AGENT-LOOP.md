# AGENT-LOOP

> The mechanical six-step lifecycle every scheduled agent runs. Referenced from every agent doc so the loop mechanics stay identical across all agents — only role-specific behaviour lives in the individual agent docs.

## Child of

* [[VAULT]]

## Parent of

## Associated with

## The loop

Every agent, when its Claude Schedule fires, runs these six steps in order:

1. **Read own doc.** `get_doc(path = my_vault_path, full = true)`. Refreshes the prompt from vault truth in case you edited it since last run.

2. **Poll inbox.** `list_tickets(assigned_agent_id = "<my slug>", status = "open")`.

3. **Early-exit on idle.** If step 2 returned zero AND the last N runs also returned zero (check via `list_tickets(sender_agent_id = "<my slug>" OR assigned_agent_id = "<my slug>", limit = 10)` and inspecting `created_at`), log a heartbeat via `create_ticket(pillar = "<my pillar>", type = "heartbeat", assigned_agent_id = "<my slug>", sender_agent_id = "<my slug>", payload = {idle: true})` and exit. Default N = 3.

4. **Do the work.** For each open ticket returned in step 2, execute what the ticket describes. Read any referenced vault docs, do the analysis / writing / decision-making the role requires.

5. **Dispatch.** For each downstream action, `create_ticket(pillar, type, assigned_agent_id = "<target>", sender_agent_id = "<my slug>", payload)`. Cap dispatches per run — recommended max = 5. If more work exists, file a "backlog" ticket to yourself for next hour.

6. **Close done.** For each ticket you completed in step 4, `update_ticket(id, status = "done", payload = {result: ...})`. This stamps `resolved_at` and (via trigger) `first_resolved_at`.

Then exit.

## Guardrails

- **Never touch tickets outside your own inbox.** Only read tickets addressed to you; only close tickets you're processing.
- **Never bypass the queue for peer-to-peer chat.** If you need CPO to see something, file a ticket — don't try to edit CPO's vault doc directly.
- **Cap sessions.** Aim to finish under 5 minutes of Claude time per hour. If the inbox is deep, close the priority items and defer the rest.
- **Idempotency on retry.** If your schedule fires twice or you're re-invoked mid-work, `update_ticket(status = "done")` is safe to call again.
- **Never dispatch to yourself without a clear reason.** Self-dispatch is legit for "resume tomorrow" backlog notes but not for anything the current session could handle.

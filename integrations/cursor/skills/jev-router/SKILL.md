---
name: jev-router
description: Route a coding task through TypeSafe JEV before doing the work, using only the models on the current Cursor plan. Use at the start of a user task in this repo.
---

# JEV Router (Cursor)

Never pick a model yourself, and never call the TypeSafe JEV API directly. Run `node src/cli.mjs` from this repo and follow what it returns.

Cursor cannot change the model of the open chat. `decide` chooses among the models `discover` found on this account's plan. Those profiles live in `~/.jev-router/cursor/profiles.json` and differ per plan. Do not hardcode a model list.

## One-time setup

Run once after cloning this repo:

```bash
node src/cli.mjs init --harness cursor
```

That creates `.env` from `.env.example` if needed, links `.cursor/skills` to the bundled router skill, and — when `~/.jev-router/cursor/profiles.json` is missing — discovers models from your plan's picker cache and writes `profiles.json` with auto-generated descriptions. You still set the API key in `.env` yourself.

**Fallback** (only if `init` could not write `profiles.json`, e.g. Cursor has never been opened while logged in so the plan catalog is empty):

1. `node src/cli.mjs discover --harness cursor` — writes `profiles.draft.json` (one entry per enabled variant).
2. Fill each `description` if any are still null, then `node src/cli.mjs finalize --harness cursor`.

Re-run discover/finalize when the user says their plan's model list changed and you need to refresh profiles.

## Every task, after setup exists

1. Run: `node src/cli.mjs decide --harness cursor --task "<the user's exact task>"`
   This prints JSON including `{ profileId, model, effort, displayName, subagentModel, confidence, source, warning?, reason? }`.
   `displayName` is the picker label. `subagentModel` is the id for a Task sub-agent. Both come from that account's plan profile, not from a fixed table.
2. If `source` is `"fallback"`, say which profile was used and why (`reason`). If `warning` is `"medium_confidence"`, say that JEV's confidence was moderate.
3. If this chat is already on `displayName`, continue the task here.
4. If it is not, do not answer on the current model. Launch a Task sub-agent:
   - `subagent_type`: `generalPurpose`
   - `model`: `subagentModel` from the JSON, exactly
   - `prompt`: the user's question plus any context the sub-agent needs. It cannot see this chat.
5. When the sub-agent finishes, reply in this chat with its answer, and name the `displayName` that produced it.
6. If the Task call rejects that model slug, say so and stop. Do not answer the task on the current model, and do not substitute a different model.

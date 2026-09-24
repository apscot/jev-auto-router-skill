---
name: jev-router
description: Route this coding task through TypeSafe JEV before doing any other work, to pick the right model and effort level. Invoke at the start of every user task.
---

# JEV Router

Never pick a model or effort level yourself, and never call the TypeSafe JEV API
directly. This skill's only job is to run the deterministic CLI (`jev-router`,
in this repo's `src/cli.mjs`) and follow exactly what it returns.

## One-time setup (only if `~/.jev-router/claude-code/profiles.json` does not exist yet)

1. Run: `node <repo>/src/cli.mjs discover --harness claude-code`
   This writes `~/.jev-router/claude-code/profiles.draft.json`: every
   model x effort combination, each with `"description": null`.
2. Read that draft file. For each entry, write a one-sentence description of
   what that specific model+effort combination is best suited for (e.g.
   "claude-haiku-4-5-20251001 at low effort: trivial edits, renames,
   formatting, single-file mechanical changes"). Use your own knowledge —
   this step needs no external API call. Save the file with every
   description filled in, in place.
3. Run: `node <repo>/src/cli.mjs finalize --harness claude-code`
   This validates every entry has a description, writes the final
   `profiles.json`, and generates one `jev-route-<id>` sub-skill per profile
   under `integrations/claude-code/skills/`. Do this once; it does not need
   to be repeated on later invocations unless you want to regenerate the
   profile set.

## Every task, after setup exists

1. Run: `node <repo>/src/cli.mjs decide --harness claude-code --task "<the user's exact task>"`
   This prints JSON: `{ profileId, model, effort, confidence, source, warning?, reason? }`.
2. Invoke the Skill tool for `jev-route-<profileId>` using exactly the
   `profileId` returned — never substitute a different one and never invent
   an id that `decide` did not return.
3. If `source` is `"fallback"`, briefly note which profile was used as
   fallback and why (`reason` field) before continuing.
4. If `warning` is `"medium_confidence"`, proceed but mention JEV's
   confidence was moderate.

The chosen sub-skill pins the model for that turn and carries the effort
guidance; once invoked, continue the task exactly as normal.

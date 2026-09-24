# JEV Auto Router

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Status](https://img.shields.io/badge/status-Claude%20Code%20only-orange)

**Stop choosing which model to use for every coding task.**
JEV Auto Router asks [TypeSafe's Jev](https://openrouter.ai/docs/guides/community/jev) which model + effort level fits your task, *before* your agent starts work — then routes to it automatically, on every message.

You bring **one key**. Nothing else. Models are used through whatever coding agent you're already running — this project never holds or proxies provider API access.

```
 your message
      │
      ▼
 ┌─────────────┐        state + candidate profiles
 │ jev-router  │ ─────────────────────────────────▶  Jev (OpenRouter or direct)
 │   (skill)   │ ◀─────────────────────────────────  { choice, confidence }
 └──────┬──────┘
        │ invokes the matching pinned-model skill
        ▼
 ┌─────────────┐
 │ jev-route-*  │  pins the model for this turn, then the task runs normally
 └─────────────┘
```

---

## Table of contents

- [Status](#status)
- [Requirements](#requirements)
- [Install](#install)
- [Choosing a Jev provider](#choosing-a-jev-provider)
- [How it works](#how-it-works)
- [Useful commands](#useful-commands)
- [Known limitations](#known-limitations--open-items)
- [Roadmap](#roadmap-beyond-claude-code)
- [Privacy](#privacy)

---

## Status

| Harness | Support |
|---|---|
| **Claude Code** | ✅ Working end-to-end — discovery, real Jev routing, per-turn model switching. Verified live. |
| Cursor | ❌ Not implemented — model discovery/switching mechanism unresearched. |
| Codex | ❌ Not implemented — model discovery/switching mechanism unresearched. |

Only Claude Code works today. See [Roadmap](#roadmap-beyond-claude-code) for what "supporting a new agent" actually requires.

## Requirements

- Node.js 18+
- Claude Code
- **One** API key: an [OpenRouter](https://openrouter.ai/keys) key (no waitlist, works today), *or* a [TypeSafe console](https://console.typesafe.ai/settings/keys) key (early access, waitlisted) — see [Choosing a Jev provider](#choosing-a-jev-provider).

## Install

```bash
git clone <this-repo-url>
cd jev-auto-router
node src/cli.mjs init
```

`init` is idempotent — safe to re-run — and sets up everything below in one shot:

- creates `.env` from `.env.example` if missing
- creates the `.claude/skills` symlink Claude Code actually reads skills from
- makes the routing hook executable
- installs the **bundled default profile set** (16 pre-written model × effort profiles, ships in the repo) so you don't have to hand-write descriptions yourself

Then:

```bash
# edit .env: set OPENROUTER_API_KEY (get one free at https://openrouter.ai/keys)
claude
```

That's it. Skills and hooks load at session start, so make sure `claude` is a **fresh** session after `init`. Send a real task **without naming any skill** and it should route on its own.

**Verify it worked:**
```
/hooks    → jev-nudge.sh should be listed under UserPromptSubmit
/skills   → jev-router plus one jev-route-<id> skill per profile should be listed
```
```bash
node src/cli.mjs doctor   # confirms key + profile status from the command line
```

<details>
<summary><strong>What <code>init</code> is doing, and how to do it by hand</strong></summary>

**The skill symlink.** Claude Code only loads skills from `.claude/skills/`. This repo generates skills under `integrations/claude-code/skills/` (so they can also be packaged/distributed independently of Claude Code), so `.claude/skills` is a symlink to that folder:
```bash
mkdir -p .claude && ln -s ../integrations/claude-code/skills .claude/skills
```

**The auto-routing hook.** Skill invocation isn't automatic by itself — Claude only invokes a skill when it judges your message matches that skill's description, which isn't reliable on its own. A `UserPromptSubmit` hook forces the routing skill to run on **every** message instead. This ships as `.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/jev-nudge.sh", "args": [] }
        ]
      }
    ]
  }
}
```
Watch the nesting — each event maps to a list of `{ matcher, hooks }` groups, not directly to a list of `{ type, command }` entries. A flat `"UserPromptSubmit": [{ "type": "command", ... }]` looks reasonable but is silently invalid and just won't fire, no error, no warning. The script itself needs `chmod +x .claude/hooks/jev-nudge.sh`.

**Custom profiles instead of the bundled default.** If you want to regenerate profiles yourself (e.g. you edited `DEFAULT_MODELS` in an adapter):
```bash
node src/cli.mjs discover --harness claude-code   # writes profiles.draft.json, every entry description: null
# open the draft, write a one-sentence description per entry
node src/cli.mjs finalize --harness claude-code   # validates + writes profiles.json + generates route skills
```
</details>

## Choosing a Jev provider

This project supports **two ways to call Jev**, switchable via `JEV_PROVIDER` in `.env`:

| | `openrouter` (default) | `direct` |
|---|---|---|
| Endpoint | OpenRouter's alpha Decisions API | TypeSafe's own console API |
| Key | `OPENROUTER_API_KEY` | `TYPESAFE_API_KEY` |
| Access | Open — get a key instantly at [openrouter.ai/keys](https://openrouter.ai/keys) | Early access — [waitlist via console.typesafe.ai](https://console.typesafe.ai) |
| Verified against | First-party OpenRouter docs ✅ | Third-party docs only — **not confirmed against an official TypeSafe source** ⚠️ |

```bash
# .env — pick one:
JEV_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...

# or:
JEV_PROVIDER=direct
TYPESAFE_API_KEY=...
```

Both providers are called with the identical request/response shape (`state` + typed `questions` → `answers`); only the base URL, auth header, and default model id differ. See `src/jev-client.mjs` for the exact contract of each. **Default to `openrouter`** unless you specifically have TypeSafe console access — it's the only one verified against first-party documentation.

## How it works

1. **Discovery (once).** Builds every model × effort combination for the harness, gets one-sentence descriptions written by the agent itself (no extra API call), and generates one thin skill per profile — each pins a single model via `model:` frontmatter.
2. **Every message.** The `UserPromptSubmit` hook injects a reminder that forces the `jev-router` skill to run first. That skill calls `jev-router decide --task "..."`, which sends the task and the cached profile list to Jev, validates the response against the known profile list, applies a confidence/fallback policy, and returns one validated profile. The skill then invokes the matching `jev-route-<id>` skill — it never picks a model itself.

See `integrations/claude-code/skills/jev-router/SKILL.md` for the exact step-by-step the agent follows.

## Useful commands

```bash
node src/cli.mjs init                                                 # one-shot setup (idempotent, safe to re-run)
node src/cli.mjs doctor                                              # check key + profile status
node src/cli.mjs decide --harness claude-code --task "..."           # test routing directly, no Claude Code needed
node src/cli.mjs discover --harness claude-code                      # rebuild the draft profile list
node src/cli.mjs finalize --harness claude-code                      # validate + generate route skills
```

## Known limitations / open items

- **The hook fires on every message, task or not.** It doesn't distinguish a real coding task from a one-word reply — left unfiltered, casual messages also trigger a small (~$0.00003) Jev call. Not yet addressed.
- **The `direct` provider is unverified.** Sourced from third-party docs only; confirm the contract yourself against `console.typesafe.ai` before relying on it.
- **Effort is advisory, not enforced**, for Claude Code. Only `model:` skill frontmatter is a confirmed override mechanism; effort level is passed to the model as an instruction inside the generated route-skill, not as a harness-level control.
- **Confidence thresholds are a rough calibration**, not a tuned one — defaults assume ~16 profiles; adjust `JEV_CONFIDENCE_MEDIUM` / `JEV_CONFIDENCE_HIGH` in `.env` if your profile count differs a lot.
- **Default model/effort lists may drift.** `src/adapters/claude-code.mjs` hardcodes a model list valid as of when it was written — re-verify before relying on it.

## Roadmap: beyond Claude Code

The core (`jev-client.mjs`, profile schema, CLI, confidence/fallback policy) is already harness-agnostic — it doesn't change to support a new agent. What's missing per harness is exactly two things, packaged as an adapter (`src/adapters/<harness>.mjs`):

1. **Discovery** — how does this harness expose its available models and effort/reasoning levels?
2. **Switching** — how does this harness let something *other than the model itself* pin a specific model for a single turn, the way Claude Code's skill `model:` frontmatter does?

Both are currently unresearched for Cursor and Codex (`src/adapters/cursor.mjs`, `codex.mjs` are stubs that throw `"not implemented"` — deliberately, rather than guessing). Contributions researching either of these, for any harness, are the highest-leverage way to extend this project.

## Privacy

Only the task text and the cached profile list (ids + one-sentence descriptions) are sent to Jev — never repository contents, file contents, or credentials.

## License

MIT

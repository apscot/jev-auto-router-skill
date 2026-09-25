# JEV Auto Router

JEV picks a model profile before your coding task starts. You configure **one** API key for JEV. The host agent (Claude Code or Cursor) uses its own access for the actual coding model. Two harnesses are supported: **Claude Code** (in-session routing) and **Cursor** (skill in the editor, optional CLI launcher).

## Table of contents

- [Requirements](#requirements)
- [Claude Code installation](#claude-code-installation)
- [Cursor installation](#cursor-installation)
- [Cursor CLI (optional)](#cursor-cli-optional)
- [Uninstall](#uninstall)
- [Commands](#commands)
- [Jev provider](#jev-provider)
- [Privacy](#privacy)
- [License](#license)

## Requirements

- Node.js 18+
- **Claude Code** and/or **Cursor** (follow the install section for the harness you use)
- One API key: [OpenRouter](https://openrouter.ai/keys) or [TypeSafe console](https://console.typesafe.ai/settings/keys) — see [Jev provider](#jev-provider)

## Claude Code installation

```bash
git clone <this-repo-url>
cd <repo-directory>
node src/cli.mjs init
```

Edit `.env` and set your key, then start a **new** Claude Code session so skills and hooks load:

```bash
claude
```

`init` is idempotent. It creates `.env` from `.env.example` if missing, symlinks `.claude/skills` to `integrations/claude-code/skills`, ensures the routing hook script is executable and wired in `.claude/settings.json`, and installs the bundled default profile set (16 profiles) with generated route skills when `~/.jev-router/claude-code/profiles.json` is not already present.

Optional: `node src/cli.mjs doctor` reports whether the active provider key is set and whether each harness has `profiles.json`.

## Cursor installation

Open Cursor while logged in once, so your plan’s model list is cached. Then:

```bash
git clone <this-repo-url>
cd <repo-directory>
node src/cli.mjs init --harness cursor
```

Edit `.env` and set your key. Open this repo in Cursor.

`init` for Cursor:

- Creates `.env` from `.env.example` if missing
- Symlinks `.cursor/skills` → `integrations/cursor/skills` (if `.cursor/skills` is already a real directory, it is removed and replaced with the symlink — move other skills out first)
- Writes `~/.jev-router/cursor/profiles.json` from the plan picker **only if that file is missing**, with auto-generated descriptions

The `jev-router` skill runs at the start of a task: it calls `decide`. If the chat model already matches the chosen profile’s `displayName`, continue on that model. Otherwise it launches a sub-agent on `subagentModel` and brings the answer back into the chat.

Optional: `node src/cli.mjs doctor`.

## Cursor CLI (optional)

This path is separate from in-chat routing:

```bash
node src/cli.mjs run --harness cursor --task "Your task here"
```

Requires the Cursor `agent` CLI installed, logged in (`agent login`), and the workspace trusted once for non-interactive runs. The command runs JEV, then starts a **new** `agent` process pinned to the chosen model.

## Uninstall

There is no uninstall command. Remove artifacts by hand.

**Claude Code:** Remove the `.claude/skills` symlink if it points at this integration; remove the `UserPromptSubmit` hook for `.claude/hooks/jev-nudge.sh` from `.claude/settings.json` and delete that script; remove `~/.jev-router/claude-code`. Optionally delete `.env`.

**Cursor:** Remove the `.cursor/skills` symlink if it points at `integrations/cursor/skills`; remove `~/.jev-router/cursor`. Optionally delete `.env`.

Restart or reopen the harness so it stops loading removed skills and hooks.

## Commands

| Command | Purpose |
|--------|---------|
| `node src/cli.mjs init` | Set up Claude Code (default harness) |
| `node src/cli.mjs init --harness cursor` | Set up Cursor skills symlink and plan profiles |
| `node src/cli.mjs doctor` | Check API key and `profiles.json` per harness |
| `node src/cli.mjs decide --harness claude-code --task "..."` | Route only (Claude Code profiles) |
| `node src/cli.mjs decide --harness cursor --task "..."` | Route plus `displayName` and `subagentModel` |
| `node src/cli.mjs discover --harness <harness>` | Write `profiles.draft.json` (descriptions null) |
| `node src/cli.mjs finalize --harness <harness>` | Validate draft, write `profiles.json`; generates route skills for Claude Code only |
| `node src/cli.mjs run --harness cursor --task "..."` | Route, then launch `agent` (Cursor only) |

Harness flag: `claude-code` (default) or `cursor`.

## Jev provider

Default is OpenRouter (`OPENROUTER_API_KEY`). For TypeSafe’s API directly, set `JEV_PROVIDER=direct` and `TYPESAFE_API_KEY`. See `.env.example` for variables and optional overrides.

## Privacy

Only the task text and cached profile ids with one-sentence descriptions are sent to JEV — not repository or file contents, and not credentials.

## License

MIT

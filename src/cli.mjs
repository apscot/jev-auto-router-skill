#!/usr/bin/env node
import "./load-env.mjs";
import { existsSync } from "node:fs";
import { symlink, chmod, copyFile, mkdir, lstat, readlink, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cartesianProduct,
  draftPath,
  profilesPath,
  saveJson,
  loadJson,
} from "./profile-store.mjs";
import { decide } from "./jev-client.mjs";
import * as claudeCode from "./adapters/claude-code.mjs";
import * as cursor from "./adapters/cursor.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADAPTERS = {
  "claude-code": claudeCode,
  cursor,
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
      opts[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { command, opts, positional };
}

function requireAdapter(harness) {
  const adapter = ADAPTERS[harness];
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(", ");
    if (harness === "codex") {
      console.error(`"${harness}" adapter is not implemented yet (discovery/switch mechanisms unverified).`);
    } else {
      console.error(`Unknown harness "${harness}". Known: ${known}`);
    }
    process.exit(1);
  }
  return adapter;
}

async function cmdDiscover(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  // Claude Code keeps the shared model × effort product (DEFAULT_MODELS ×
  // DEFAULT_EFFORTS). Cursor exports discoverProfiles() instead: its plan
  // catalog is per-account, and effort is already a parameter of each
  // enabled variant, not a dimension this tool should expand.
  let profiles;
  if (adapter.discoverProfiles) {
    profiles = await adapter.discoverProfiles();
  } else {
    const models = adapter.getModels ? await adapter.getModels() : adapter.DEFAULT_MODELS;
    profiles = cartesianProduct(models, adapter.DEFAULT_EFFORTS);
  }
  const path = draftPath(harness);
  await saveJson(path, profiles);
  console.log(
    JSON.stringify(
      {
        wrote: path,
        count: profiles.length,
        next: `Fill in each entry's "description" with a one-sentence note on what that model+effort combination is best suited for, then run: jev-router finalize --harness ${harness}`,
      },
      null,
      2
    )
  );
}

async function cmdFinalize(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  const draft = await loadJson(draftPath(harness));
  if (!draft) {
    console.error(`No draft found at ${draftPath(harness)}. Run "jev-router discover" first.`);
    process.exit(1);
  }
  const missing = draft.filter((p) => !p.description);
  if (missing.length > 0) {
    console.error(
      `${missing.length} profile(s) still missing a description: ${missing.map((p) => p.id).join(", ")}`
    );
    process.exit(1);
  }
  const finalized = draft.map(({ _discovery, ...profile }) => profile);
  await saveJson(profilesPath(harness), finalized);
  const skillsGenerated = Boolean(adapter.generateRouteSkills);
  if (skillsGenerated) {
    await adapter.generateRouteSkills(REPO_ROOT, draft);
  }
  console.log(
    JSON.stringify(
      {
        wrote: profilesPath(harness),
        profiles: draft.length,
        generatedSkills: skillsGenerated ? draft.length : 0,
      },
      null,
      2
    )
  );
}

async function cmdDecide(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  const task = opts.task;
  if (!task) {
    console.error('Missing --task "<description>"');
    process.exit(1);
  }
  const profiles = await loadJson(profilesPath(harness));
  if (!profiles) {
    console.error(
      `No profiles.json for harness "${harness}". Run "jev-router discover" then "jev-router finalize" first.`
    );
    process.exit(1);
  }
  let decision = await decide(task, profiles);
  if (adapter.annotateDecision) decision = adapter.annotateDecision(decision, profiles);
  console.log(JSON.stringify(decision, null, 2));
}

// Checks more than existsSync would: a Windows git checkout with
// core.symlinks=false writes a committed symlink as a plain text file
// containing the target path, not a real symlink — existsSync alone would
// see "something's there" and silently leave it broken. This verifies the
// path is an actual symlink pointing at the right target, and repairs it
// if not. A real directory at this path is left untouched rather than
// deleted, since that could be user content rather than a broken checkout.
async function ensureSkillsSymlink(harness) {
  const skillsLink = join(REPO_ROOT, ".claude", "skills");
  const expectedTarget = join("..", "integrations", harness, "skills");

  // existsSync follows symlinks to their target, so a *broken* symlink
  // (entry present, target missing) reports false — indistinguishable from
  // "nothing here" — and a plain symlink() call then fails with EEXIST
  // against the entry existsSync claimed wasn't there. lstat + catching
  // ENOENT reports the entry itself, not what it resolves to.
  let stat;
  try {
    stat = await lstat(skillsLink);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    stat = null;
  }

  if (!stat) {
    await mkdir(join(REPO_ROOT, ".claude"), { recursive: true });
    await symlink(expectedTarget, skillsLink);
    return `created .claude/skills -> integrations/${harness}/skills`;
  }

  if (stat.isSymbolicLink()) {
    const actualTarget = await readlink(skillsLink);
    if (actualTarget === expectedTarget) {
      return ".claude/skills already present and correct, left as-is";
    }
    await unlink(skillsLink);
    await symlink(expectedTarget, skillsLink);
    return `.claude/skills pointed at the wrong target (${actualTarget}) — recreated`;
  }

  if (stat.isDirectory()) {
    return ".claude/skills exists as a real directory, not a symlink — left alone to avoid deleting content; move it aside and re-run init to fix";
  }

  await unlink(skillsLink);
  await symlink(expectedTarget, skillsLink);
  return ".claude/skills existed as a broken file stub (likely a Windows checkout without symlink support) — recreated as a real symlink";
}

async function cmdInit(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  const steps = [];
  let next;

  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    await copyFile(join(REPO_ROOT, ".env.example"), envPath);
    steps.push("created .env from .env.example — edit it and set your API key");
  } else {
    steps.push(".env already exists, left as-is");
  }

  if (adapter.generateRouteSkills) {
    // Skill-based harness (Claude Code): something in-editor to wire up —
    // symlink, hook, and a bundled profile set safe to hardcode because the
    // model list is small, fixed, and public.
    steps.push(await ensureSkillsSymlink(harness));

    const hookScript = join(REPO_ROOT, ".claude", "hooks", "jev-nudge.sh");
    if (existsSync(hookScript)) {
      await chmod(hookScript, 0o755);
      steps.push("ensured .claude/hooks/jev-nudge.sh is executable");
    }

    const finalPath = profilesPath(harness);
    if (!existsSync(finalPath)) {
      const bundled = join(REPO_ROOT, "integrations", harness, "profiles.default.json");
      if (existsSync(bundled)) {
        await saveJson(finalPath, await loadJson(bundled));
        const profiles = await loadJson(finalPath);
        await adapter.generateRouteSkills(REPO_ROOT, profiles);
        steps.push(`installed bundled default profiles (${profiles.length}) and generated route skills`);
      } else {
        steps.push(
          `no profiles for "${harness}" and no bundled default found — run "discover" then "finalize"`
        );
      }
    } else {
      steps.push(`profiles.json for "${harness}" already exists, left as-is`);
    }
    next = "Set your API key in .env, then run: claude";
  } else if (adapter.launch) {
    // Cursor cannot pin the open chat's model. The shipped skill under
    // integrations/cursor/skills tells the agent to delegate to a sub-agent
    // on the plan profile JEV picked. The model list is per-account, so
    // there is no bundled profile set.
    if (adapter.install) steps.push(await adapter.install(REPO_ROOT));
    const finalPath = profilesPath(harness);
    if (!existsSync(finalPath)) {
      try {
        let profiles = await adapter.discoverProfiles();
        if (adapter.autoDescribeProfiles) {
          profiles = adapter.autoDescribeProfiles(profiles);
        }
        const missing = profiles.filter((p) => !p.description);
        if (missing.length > 0) {
          throw new Error(`${missing.length} profile(s) still lack a description after auto-describe`);
        }
        await saveJson(finalPath, profiles);
        steps.push(
          `discovered ${profiles.length} plan profile(s), auto-filled descriptions, and wrote ${finalPath}`
        );
      } catch (err) {
        steps.push(`could not write profiles.json: ${err.message}`);
        steps.push(
          `fallback: node src/cli.mjs discover --harness ${harness}, fill descriptions in the draft, then node src/cli.mjs finalize --harness ${harness}`
        );
      }
    } else {
      steps.push(`profiles.json for "${harness}" already exists, left as-is`);
    }
    next =
      "Set OPENROUTER_API_KEY in .env (or TYPESAFE_API_KEY with JEV_PROVIDER=direct), then open this repo in Cursor. Optional: node src/cli.mjs doctor";
  }

  console.log(JSON.stringify({ steps, next }, null, 2));
}

// For launcher-based harnesses only (Cursor). Skill-based harnesses
// (Claude Code) route from inside the agent's own already-running session
// via the jev-router skill — there's no separate "run" for those; running
// jev-router's decide+skill-invoke *is* how a Claude Code task gets routed.
async function cmdRun(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  if (!adapter.launch) {
    console.error(
      `"${harness}" has no launcher mechanism — it routes from inside the agent's own session instead (see its adapter).`
    );
    process.exit(1);
  }
  const task = opts.task;
  if (!task) {
    console.error('Missing --task "<description>"');
    process.exit(1);
  }
  const profiles = await loadJson(profilesPath(harness));
  if (!profiles) {
    console.error(
      `No profiles.json for harness "${harness}". Run "discover" then "finalize" first.`
    );
    process.exit(1);
  }
  const decision = await decide(task, profiles);
  console.error(
    `[jev-router] routed to ${decision.model} (${decision.source}${decision.reason ? ", " + decision.reason : ""})`
  );
  const result = await adapter.launch(decision, task);
  process.exit(result.exitCode ?? 0);
}

async function cmdDoctor() {
  const jevProvider = process.env.JEV_PROVIDER || "openrouter";
  const report = {
    JEV_PROVIDER: jevProvider,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? "set" : "missing",
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ? "set" : "missing",
    harnesses: {},
  };
  for (const harness of Object.keys(ADAPTERS)) {
    report.harnesses[harness] = {
      profiles: existsSync(profilesPath(harness)) ? "ready" : "not discovered",
    };
  }
  const activeKeyMissing =
    (jevProvider === "openrouter" && report.OPENROUTER_API_KEY === "missing") ||
    (jevProvider === "direct" && report.TYPESAFE_API_KEY === "missing");
  if (activeKeyMissing) {
    report.note = `JEV_PROVIDER is "${jevProvider}" but its key is missing; decide() will always use the local fallback policy until it's set.`;
  }
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "init":
      return cmdInit(opts);
    case "discover":
      return cmdDiscover(opts);
    case "finalize":
      return cmdFinalize(opts);
    case "decide":
      return cmdDecide(opts);
    case "run":
      return cmdRun(opts);
    case "doctor":
      return cmdDoctor(opts);
    default:
      console.error(
        "Usage: jev-router <init|discover|finalize|decide|run|doctor> [--harness claude-code|cursor] [--task \"...\"]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});

#!/usr/bin/env node
import "./load-env.mjs";
import { existsSync } from "node:fs";
import { symlink, chmod, copyFile, mkdir } from "node:fs/promises";
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADAPTERS = {
  "claude-code": claudeCode,
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
    if (harness === "cursor" || harness === "codex") {
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
  const models = adapter.DEFAULT_MODELS;
  const efforts = adapter.DEFAULT_EFFORTS;
  const profiles = cartesianProduct(models, efforts);
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
  await saveJson(profilesPath(harness), draft);
  if (adapter.generateRouteSkills) {
    await adapter.generateRouteSkills(REPO_ROOT, draft);
  }
  console.log(
    JSON.stringify({ wrote: profilesPath(harness), generatedSkills: draft.length }, null, 2)
  );
}

async function cmdDecide(opts) {
  const harness = opts.harness || "claude-code";
  requireAdapter(harness);
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
  const decision = await decide(task, profiles);
  console.log(JSON.stringify(decision, null, 2));
}

async function cmdInit(opts) {
  const harness = opts.harness || "claude-code";
  const adapter = requireAdapter(harness);
  const steps = [];

  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    await copyFile(join(REPO_ROOT, ".env.example"), envPath);
    steps.push("created .env from .env.example — edit it and set your API key");
  } else {
    steps.push(".env already exists, left as-is");
  }

  const skillsLink = join(REPO_ROOT, ".claude", "skills");
  if (!existsSync(skillsLink)) {
    await mkdir(join(REPO_ROOT, ".claude"), { recursive: true });
    await symlink(join("..", "integrations", harness, "skills"), skillsLink);
    steps.push(`created .claude/skills -> integrations/${harness}/skills`);
  } else {
    steps.push(".claude/skills already present, left as-is");
  }

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
      if (adapter.generateRouteSkills) {
        await adapter.generateRouteSkills(REPO_ROOT, profiles);
      }
      steps.push(`installed bundled default profiles (${profiles.length}) and generated route skills`);
    } else {
      steps.push(
        `no profiles for "${harness}" and no bundled default found — run "discover" then "finalize"`
      );
    }
  } else {
    steps.push(`profiles.json for "${harness}" already exists, left as-is`);
  }

  console.log(JSON.stringify({ steps, next: "Set your API key in .env, then run: claude" }, null, 2));
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
    case "doctor":
      return cmdDoctor(opts);
    default:
      console.error(
        "Usage: jev-router <init|discover|finalize|decide|doctor> [--harness claude-code] [--task \"...\"]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});

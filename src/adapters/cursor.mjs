// Cursor adapter. Fundamentally different shape from claude-code.mjs —
// confirmed via https://cursor.com/docs/rules and https://cursor.com/docs/hooks
// (2026-09): Cursor's rules (.cursor/rules/*.mdc) and hooks (.cursor/hooks.json,
// including the closest analog to UserPromptSubmit, `beforeSubmitPrompt`)
// have NO ability to select or influence which model handles a turn — that
// is UI-dropdown-only inside the editor. This is a real product limitation,
// not a research gap. There is no equivalent of Claude Code's
// skill-model-frontmatter + hook combo, and there cannot be one until
// Cursor exposes one.
//
// The one confirmed, real, programmatic model-switching mechanism is the
// CLI's `--model` flag for non-interactive runs — confirmed against the
// official reference: https://cursor.com/docs/cli/reference/parameters
// (verbatim quotes fetched live), https://cursor.com/docs/cli/installation.
// The binary is `agent`, NOT `cursor-agent` — an earlier research pass on
// this project got that wrong (a plausible-sounding guess based on the
// product name "Cursor Agent CLI"), caught only by fetching the official
// install/reference pages directly and finding every real code example
// uses `agent`. This is a process launch, not a live in-editor turn, so
// this adapter supports the "launcher" pattern only (see architecture
// doc's Strategy A): route, then start a new `agent -p "<task>" --model
// <chosen>` process. It does NOT make Cursor's own in-IDE chat panel
// auto-route every message the way Claude Code does.
//
// Discovery reads the plan catalog the model picker uses, not `agent models`.
// On a plan that shows four models, `agent models` still printed every
// effort and fast id (eleven lines). Those extra ids are not selectable.
// launch() still passes the variant's legacy slug to `--model`, which is
// the id the CLI accepts for that enabled variant.
//
// Also confirmed live: non-interactive runs are gated behind a workspace
// trust check ("Workspace Trust Required" unless the directory was already
// trusted, e.g. via one interactive `agent` run or `agent --trust` once —
// trust then persists). launch() deliberately does NOT pass
// `--trust`/`--yolo`/`-f` itself, since that would mean silently
// auto-approving arbitrary code execution on the user's behalf.

import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const harness = "cursor";
const BIN = "agent";

// Cursor's model picker is the plan catalog cached in the editor's state
// DB (availableDefaultModels2). `agent models` is a different list: it
// expands every effort and fast variant the CLI knows about, including
// ones the current plan does not offer. Discovery uses the plan catalog
// only, and emits one profile per enabled variant — it does not cross
// those models with a fixed effort list.

function notFoundError() {
  return new Error(
    `"${BIN}" CLI not found. Install it: curl https://cursor.com/install -fsS | bash — then verify with "${BIN} --version". See https://cursor.com/docs/cli/installation`
  );
}

// Editor state key that holds availableDefaultModels2 — the same list the
// model picker shows for the signed-in plan. Internal storage, not a public
// API; if Cursor renames it, discovery fails loudly rather than falling
// back to `agent models` (that list includes variants the plan does not offer).
const PLAN_STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

function cursorStateDbPath() {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return join(config, "Cursor", "User", "globalStorage", "state.vscdb");
}

function loadPlanModels() {
  const dbPath = cursorStateDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Cursor plan catalog not found at ${dbPath}. Open Cursor once while logged in so it caches the models on your plan, then run discover again.`
    );
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(`Could not read Cursor plan catalog at ${dbPath}: ${err.message}`);
  }

  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(PLAN_STORAGE_KEY);
    if (!row?.value) {
      throw new Error(
        "Cursor's state database has no plan model list yet. Open Cursor while logged in, then run discover again."
      );
    }
    const data = JSON.parse(row.value);
    const models = data.availableDefaultModels2;
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("Cursor plan catalog is empty (availableDefaultModels2).");
    }
    return models;
  } finally {
    db.close();
  }
}

function slug(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tooltipMarkdownSource(model, variant) {
  return (
    variant?.tooltipData?.markdownContent ||
    model?.tooltipData?.markdownContent ||
    variant?.tooltipData?.primaryText ||
    model?.tooltipData?.primaryText ||
    null
  );
}

// First substantive line from the picker tooltip (skips title echo and context-size boilerplate).
function blurbFromTooltipMarkdown(markdown) {
  if (!markdown) return null;
  const lines = String(markdown)
    .replace(/<br\s*\/?>/gi, "\n")
    .split(/\n+/)
    .map((line) => stripHtml(line).replace(/\*\*/g, "").trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^\d+k context/i.test(line)) continue;
    if (/^version:/i.test(line) || /^\*version:/i.test(line)) continue;
    if (/^[\w][\w.\s]*\d[\w.]*$/.test(line) && line.length < 20) continue;
    if (line.length >= 12) return line;
  }
  return lines[0] || null;
}

function paramMarkdownTooltip(model, paramId) {
  const def = (model?.parameterDefinitions || []).find((p) => p.id === paramId);
  return def?.markdownTooltip ? stripHtml(def.markdownTooltip) : null;
}

// One sentence for JEV routing from displayName plus plan tooltip/metadata captured at discovery.
export function autoDescribeProfiles(profiles) {
  return profiles.map((profile) => {
    const { _discovery, ...rest } = profile;
    const name = rest.displayName || rest.id;
    const parts = [];

    const blurb = _discovery?.tooltipBlurb;
    if (blurb) {
      const lowerName = name.toLowerCase();
      const lowerBlurb = blurb.toLowerCase();
      const sentence =
        lowerBlurb.startsWith(lowerName) || lowerBlurb.startsWith(`${lowerName} `)
          ? blurb
          : `${name}: ${blurb}`;
      parts.push(sentence.endsWith(".") ? sentence : `${sentence}.`);
    } else {
      parts.push(`Route tasks to the ${name} entry from this plan's model picker.`);
    }

    const metaBits = [];
    if (rest.effort && rest.effort !== "default") metaBits.push(`${rest.effort} effort`);
    if (_discovery?.fast) {
      const fastHint = _discovery.fastTooltip || "fast mode";
      metaBits.push(fastHint.toLowerCase().includes("fast") ? fastHint : `fast (${fastHint})`);
    }
    if (metaBits.length > 0 && blurb) {
      const base = parts.pop().replace(/\.$/, "");
      parts.push(`${base} (${metaBits.join("; ")}).`);
    }

    return { ...rest, description: parts.join(" ") };
  });
}

function paramValue(variant, ids) {
  const params = variant?.parameterValues || [];
  const found = params.find((p) => ids.includes(p.id));
  return found?.value ?? null;
}

function variantEffort(variant) {
  const value = paramValue(variant, ["reasoning_effort", "effort"]);
  return typeof value === "string" && value ? value : null;
}

function variantIsFast(variant) {
  const value = paramValue(variant, ["fast"]);
  return value === "true" || value === true;
}

// Strongest Grok first, then everything else (Composer and similar everyday
// models) last, so jev-client's fallback — the last profile — stays on the
// cheaper model when JEV itself is unavailable.
function modelRank(model) {
  const name = String(model.serverModelName || model.name || "");
  const grok = name.match(/grok-(\d+(?:\.\d+)?)/);
  if (grok) return -Number(grok[1]);
  return 1;
}

function effortRank(variant) {
  const index = EFFORT_ORDER.indexOf(variantEffort(variant));
  return index === -1 ? EFFORT_ORDER.length : index;
}

// One profile per variant the plan actually enables. A model whose picker
// entry only allows medium effort becomes one profile, not low/medium/high/max.
export async function discoverProfiles() {
  const models = loadPlanModels().slice().sort((a, b) => modelRank(a) - modelRank(b));
  const profiles = [];

  for (const model of models) {
    const serverName = model.serverModelName || model.name;
    if (!serverName) continue;

    const variants = Array.isArray(model.variants) && model.variants.length > 0 ? model.variants.slice() : [null];
    variants.sort((a, b) => {
      if (!a || !b) return 0;
      return effortRank(a) - effortRank(b) || Number(variantIsFast(a)) - Number(variantIsFast(b));
    });

    const multiple = variants.length > 1;
    for (const variant of variants) {
      const effort = variant ? variantEffort(variant) : null;
      const fast = variant ? variantIsFast(variant) : false;
      let id = slug(serverName);
      if (multiple) {
        id = [id, effort || "default", fast ? "fast" : null].filter(Boolean).join("-");
      }

      const tooltipMarkdown = tooltipMarkdownSource(model, variant);
      profiles.push({
        id,
        model: variant?.legacySlug || variant?.variantStringRepresentation || serverName,
        effort: effort || "default",
        displayName: multiple
          ? stripHtml(variant?.displayName) || model.clientDisplayName || serverName
          : model.clientDisplayName || stripHtml(variant?.displayName) || serverName,
        description: null,
        _discovery: {
          tooltipBlurb: blurbFromTooltipMarkdown(tooltipMarkdown),
          fast: fast || false,
          fastTooltip: fast ? paramMarkdownTooltip(model, "fast") : null,
        },
      });
    }
  }

  if (profiles.length === 0) {
    throw new Error("Cursor plan catalog contained no usable models.");
  }

  return profiles;
}

// Adds the plan profile's picker label and the id a Cursor Task sub-agent
// must be launched with. Claude Code does not use this; its decide JSON
// stays as jev-client returns it.
export function annotateDecision(decision, profiles) {
  const profile = profiles.find((p) => p.id === decision.profileId);
  return {
    ...decision,
    displayName: profile?.displayName ?? null,
    subagentModel: profile?.model ?? decision.model,
  };
}

// Cursor loads skills from .cursor/skills. The file people edit and commit
// is integrations/cursor/skills; this symlink is what the editor reads,
// same shape as .claude/skills -> integrations/claude-code/skills.
export async function install(repoRoot) {
  const skillsLink = join(repoRoot, ".cursor", "skills");
  const expectedTarget = join("..", "integrations", "cursor", "skills");

  let stat;
  try {
    stat = await lstat(skillsLink);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    stat = null;
  }

  if (!stat) {
    await mkdir(join(repoRoot, ".cursor"), { recursive: true });
    await symlink(expectedTarget, skillsLink);
    return "created .cursor/skills -> integrations/cursor/skills";
  }

  if (stat.isSymbolicLink()) {
    const actualTarget = await readlink(skillsLink);
    if (actualTarget === expectedTarget) return ".cursor/skills already present and correct, left as-is";
    await rm(skillsLink);
    await symlink(expectedTarget, skillsLink);
    return `.cursor/skills pointed at the wrong target (${actualTarget}) — recreated`;
  }

  // A real directory here is the hand-written copy. Replace it so the
  // committed integration skill is what Cursor loads.
  await rm(skillsLink, { recursive: true });
  await symlink(expectedTarget, skillsLink);
  return ".cursor/skills was a real directory — replaced with a symlink to integrations/cursor/skills";
}

// Launches a single non-interactive run pinned to the given profile's
// model. Used by cli.mjs's `run` command, the Cursor equivalent of Claude
// Code's "invoke the matching jev-route-<id> skill" step — except here
// it's a brand new process, not a continuation of an existing session.
export function launch(profile, task) {
  return new Promise((resolve, reject) => {
    const args = ["-p", task, "--model", profile.model, "--output-format", "text"];
    const child = spawn(BIN, args, { stdio: "inherit" });
    child.on("error", (err) => {
      reject(err.code === "ENOENT" ? notFoundError() : err);
    });
    child.on("close", (code) => resolve({ exitCode: code }));
  });
}

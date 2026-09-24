import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const harness = "claude-code";

// Verified against this session's own environment info at the time this was
// written. Model IDs change over time — re-check before trusting this list.
// Order matters, not just cosmetically: the fallback policy in jev-client.mjs
// assumes the first entry is strongest and the last is weakest.
export const DEFAULT_MODELS = [
  { id: "fable", model: "claude-fable-5-1" }, // frontier tier: ambitious/long-horizon coding, above opus
  { id: "opus", model: "claude-opus-5-5" },
  { id: "sonnet", model: "claude-sonnet-5" },
  { id: "haiku", model: "claude-haiku-4-5-20251001" },
];

// NOT verified against Claude Code's actual supported effort tokens — this
// is the commonly referenced set (low/medium/high/max). Confirm with
// `/effort` in a live session and edit if it differs.
export const DEFAULT_EFFORTS = ["low", "medium", "high", "max"];

export function skillsDir(repoRoot) {
  return join(repoRoot, "integrations", "claude-code", "skills");
}

// Only `model:` frontmatter is confirmed to override the model for a skill's
// invocation (per-turn only). There is no confirmed mechanism to set effort
// via frontmatter, so effort is applied as an instruction to the model
// itself inside the generated skill body — advisory, not enforced by the
// harness.
export async function generateRouteSkills(repoRoot, profiles) {
  const dir = skillsDir(repoRoot);
  await mkdir(dir, { recursive: true });

  // Clear previously generated jev-route-* skills so stale profiles (from
  // an older discover run) don't linger.
  if (existsSync(dir)) {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith("jev-route-")) {
        await rm(join(dir, entry), { recursive: true, force: true });
      }
    }
  }

  for (const profile of profiles) {
    const name = `jev-route-${profile.id}`;
    const skillDir = join(dir, name);
    await mkdir(skillDir, { recursive: true });
    const content = `---
name: ${name}
description: Internal routing target chosen by jev-router via JEV's decision. Do not invoke directly and do not invoke based on your own judgment of the task — only jev-router should invoke this, using the profile id JEV returned.
model: ${profile.model}
---

# JEV route: ${profile.id}

This skill exists only to pin the model for this turn (model: ${profile.model}).

Reason and respond at a "${profile.effort}" effort level: ${effortGuidance(profile.effort)}

Then continue exactly as you normally would to complete the user's original task, using whatever tools are needed. Do not mention this routing skill to the user unless they ask how the task was routed.
`;
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
  }
}

function effortGuidance(effort) {
  switch (effort) {
    case "low":
      return "keep reasoning brief, prefer the fastest correct path, avoid over-exploring alternatives.";
    case "medium":
      return "reason normally, verify assumptions before large edits.";
    case "high":
      return "reason thoroughly, consider edge cases and alternative approaches before acting.";
    case "max":
      return "reason exhaustively — this task was routed here because it's expected to be hard.";
    default:
      return "use your judgment on how much reasoning this task needs.";
  }
}

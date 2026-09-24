import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function storeDir(harness) {
  return join(homedir(), ".jev-router", harness);
}

export function draftPath(harness) {
  return join(storeDir(harness), "profiles.draft.json");
}

export function profilesPath(harness) {
  return join(storeDir(harness), "profiles.json");
}

export function cartesianProduct(models, efforts) {
  const profiles = [];
  for (const m of models) {
    for (const effort of efforts) {
      profiles.push({
        id: `${m.id}-${effort}`,
        model: m.model,
        effort,
        description: null,
      });
    }
  }
  return profiles;
}

export async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function loadJson(path) {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

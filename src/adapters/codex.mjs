// Not implemented. Codex's model discovery and per-task model switching
// mechanisms have not been researched/verified yet. Do not fabricate a
// mechanism here — find out what Codex actually exposes before writing
// this adapter.

export const harness = "codex";

export function notImplemented() {
  throw new Error(
    "codex adapter is not implemented yet: model discovery and per-task switching mechanisms are unverified for Codex."
  );
}

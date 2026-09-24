// Not implemented. Cursor's model discovery and per-task model switching
// mechanisms have not been researched/verified yet. Do not fabricate a
// mechanism here — find out what Cursor actually exposes (rules files,
// extension API, config format) before writing this adapter.

export const harness = "cursor";

export function notImplemented() {
  throw new Error(
    "cursor adapter is not implemented yet: model discovery and per-task switching mechanisms are unverified for Cursor."
  );
}

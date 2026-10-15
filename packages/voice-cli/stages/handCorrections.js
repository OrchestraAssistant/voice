import path from "node:path";
import { OVERLAY_FILE, applyOverlay } from "../core/overlay.js";

/**
 * Corrections a person wrote, and the list of what should ship.
 *
 * A policy: it changes what the manifest says rather than discovering
 * anything. Runs before exclusions, because naming something in the overlay is
 * a deliberate act that outranks a default.
 *
 * The generated manifest used to carry a field asking people not to run the
 * generator again, because doing so destroyed their corrections. This is that
 * file, read instead of overwritten.
 */
export const handCorrections = {
  name: "hand-corrections",
  role: "policy",
  describe: `${OVERLAY_FILE}: descriptions, fixes, and an include list`,

  run({ outDir, manifest }) {
    // What every stage produced, so an overlay entry that REPLACES a value
    // rather than filling a gap can be reported. Silently overwriting is how
    // a stale hand correction outlives the thing it was correcting.
    const before = new Map();
    for (const kind of ["routes", "queries", "actions"]) {
      for (const item of manifest[kind] ?? []) before.set(`${kind}:${item.path ?? item.name}`, { ...item });
    }

    const result = applyOverlay(manifest, path.join(outDir, OVERLAY_FILE));
    const notes = [];
    if (result.applied.length) notes.push(`${result.applied.length} correction(s) from ${OVERLAY_FILE}`);

    const overridden = [];
    for (const kind of ["routes", "queries", "actions"]) {
      for (const item of manifest[kind] ?? []) {
        const was = before.get(`${kind}:${item.path ?? item.name}`);
        if (!was) continue;
        for (const [field, value] of Object.entries(item)) {
          if (was[field] === undefined || field.startsWith("_")) continue;
          if (JSON.stringify(was[field]) !== JSON.stringify(value)) {
            overridden.push(`${item.path ?? item.name}.${field}`);
          }
        }
      }
    }
    if (overridden.length) {
      notes.push(`overrides what a stage found: ${overridden.slice(0, 6).join(", ")}${overridden.length > 6 ? ", ..." : ""}`);
    }
    for (const miss of result.unmatched) notes.push(`${OVERLAY_FILE} describes ${miss}, which no detector found`);
    // Only forward `description` when the overlay actually set one, so a missing
    // overlay description does not clobber the seed app-meta read from source.
    return { notes, named: result.named, include: result.include, ...(result.description ? { description: result.description } : {}) };
  },
};

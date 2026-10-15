/**
 * What a detector is.
 *
 * The whole extensibility story lives here: adding coverage for a framework
 * means writing one of these and adding it to the registry. Nothing else in
 * the pipeline changes, and nothing else needs to know the framework exists.
 *
 *   name      stable id, used in reports and conflict messages
 *   describe  what it looks for, shown when it finds nothing -- so a user
 *             whose app it does not fit learns why rather than concluding
 *             the product is broken
 *   role      "producer" finds operations; "enricher" fills in details of
 *             what producers already found
 *   applies   optional. False means "does not apply to this app", which is a
 *             DIFFERENT answer from "found nothing" and is reported as such.
 *             Conflating them hid a detector firing on a coincidence.
 *   excludes  optional. Endpoint patterns this framework knows are
 *             infrastructure. They live with the detector that produces them
 *             rather than in a global list, so a framework's knowledge about
 *             itself arrives and leaves in one piece.
 *   run(ctx)  returns { routes?, queries?, actions?, notes? }
 *
 * Role is not decoration. Enrichers read what producers found, so the runner
 * orders by role rather than by position in an array -- reordering the
 * registry used to be enough to make every enricher silently do nothing.
 */
/**
 * Every stage of the pipeline is one of these, and the runner orders by role
 * rather than by position in a list.
 *
 *   producer  finds entries        (a framework's routes, a data layer's operations)
 *   enricher  annotates them       (body shapes from a schema, call-site counts)
 *   policy    reshapes the result  (hand corrections, exclusions, an include list)
 *   probe     asks the running app (reachability, response shapes, page copy)
 *
 * Detection was modular from the start; everything after it was a fixed
 * sequence in generate.js and probe.js. Naming the later steps the same way
 * makes them removable, reorderable and, most usefully, switchable off one at
 * a time -- which is how you find out what a step is actually worth.
 */
export const ROLES = ["producer", "enricher", "policy", "probe"];

/** The order the runner applies them in. Probes are run by the probe command. */
export const STATIC_ROLES = ["producer", "enricher", "policy"];

/** Fails loudly on a malformed detector, at load time rather than mid-run. */
export function validateDetector(detector) {
  const problems = [];
  if (!detector || typeof detector !== "object") return ["not an object"];
  if (typeof detector.name !== "string" || !detector.name) problems.push("needs a name");
  if (typeof detector.describe !== "string" || !detector.describe) {
    problems.push("needs a `describe`: it is what a user reads when this finds nothing");
  }
  if (!ROLES.includes(detector.role)) problems.push(`role must be one of ${ROLES.join(" | ")}`);
  if (typeof detector.run !== "function") problems.push("needs a run(context)");
  if (detector.applies !== undefined && typeof detector.applies !== "function") problems.push("`applies` must be a function");
  for (const rule of detector.excludes ?? []) {
    if (!(rule.pattern instanceof RegExp) || typeof rule.why !== "string") {
      problems.push("each exclude needs { pattern: RegExp, why: string }");
    }
  }
  return problems;
}

export function validateRegistry(detectors) {
  const errors = [];
  const seen = new Set();
  for (const detector of detectors) {
    const problems = validateDetector(detector);
    if (problems.length) errors.push(`${detector?.name ?? "(unnamed)"}: ${problems.join("; ")}`);
    if (seen.has(detector?.name)) errors.push(`${detector.name}: duplicate name`);
    seen.add(detector?.name);
  }
  return errors;
}

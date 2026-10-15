import { STATIC_ROLES, validateRegistry } from "./contract.js";

/**
 * Runs the registry and collects what each detector found.
 *
 * Producers first, then enrichers, by ROLE rather than by array order. The
 * context accumulates as it goes, which is how an enricher sees the actions a
 * producer discovered -- stated here because it used to be an undocumented
 * side effect of a loop.
 *
 * A detector that throws is reported and skipped. One framework's bad day
 * should not cost a user every other framework's results.
 */
export function runDetectors(detectors, base, roles = STATIC_ROLES) {
  const errors = validateRegistry(detectors);
  if (errors.length) throw new Error(`Detector registry is invalid:\n  ${errors.join("\n  ")}`);

  const context = { ...base, routes: [], queries: [], actions: [] };
  const results = [];

  for (const role of roles) {
    // Policies reshape the finished thing, so they need the merged manifest
    // rather than the running pile that producers and enrichers add to. The
    // caller supplies it via `onPhase`, since merging is not this file's job.
    if (base.onPhase) Object.assign(context, base.onPhase(role, context, results) ?? {});

    for (const detector of detectors.filter((d) => d.role === role)) {
      if (detector.applies && !detector.applies(context)) {
        results.push({ detector: detector.name, role: detector.role, found: {}, skipped: true });
        continue;
      }
      let found;
      try {
        found = detector.run(context) ?? {};
      } catch (err) {
        results.push({ detector: detector.name, role: detector.role, found: {}, failed: err.message });
        continue;
      }
      results.push({ detector: detector.name, role: detector.role, found });
      for (const kind of ["routes", "queries", "actions"]) context[kind].push(...(found[kind] ?? []));
      // A stage can hand something to the ones after it -- the overlay names
      // what the exclusion policy must keep, for instance.
      for (const key of ["named", "include", "uncalled", "excluded", "description"]) {
        if (found[key] !== undefined) context[key] = found[key];
      }
    }
  }
  return { results, context };
}

/**
 * Narrows a registry to what the caller asked for.
 *
 * `--only` and `--without` exist so a configuration can be tested by running
 * it, rather than by checking out an old commit. Comparing nine versions of
 * this tool meant nine git worktrees; comparing nine configurations should
 * mean nine flags.
 */
export function selectStages(stages, { only = [], without = [] } = {}) {
  let chosen = stages;
  if (only.length) chosen = chosen.filter((s) => only.includes(s.name));
  if (without.length) chosen = chosen.filter((s) => !without.includes(s.name));
  const unknown = [...only, ...without].filter((name) => !stages.some((s) => s.name === name));
  return { stages: chosen, unknown };
}

/** Exclusion rules contributed by the detectors that actually applied. */
export function activeExcludes(detectors, results) {
  const ran = new Set(results.filter((r) => !r.skipped).map((r) => r.detector));
  return detectors.filter((d) => ran.has(d.name)).flatMap((d) => d.excludes ?? []);
}

/**
 * Runs the probe stages, which are async because they talk to a running app.
 *
 * Separate from runDetectors rather than a role inside it: a probe needs a
 * live application and a session, so it cannot run at generate time, and
 * pretending both pipelines are one would mean every generate carried the
 * machinery for a network it never touches.
 *
 * Corrections come back rather than being applied. What a probe learns is a
 * suggestion for the overlay, which a person reads in a diff before it becomes
 * prompt content for every future session.
 */
export async function runProbes(stages, context) {
  const results = [];
  const problems = [];
  const corrections = { routes: [], queries: [], actions: [] };

  for (const stage of stages.filter((s) => s.role === "probe")) {
    if (stage.needsWrites && !context.allowWrites) {
      results.push({ detector: stage.name, role: "probe", found: {}, skipped: true, why: "needs --writes" });
      continue;
    }
    let found;
    try {
      found = (await stage.run(context)) ?? {};
    } catch (err) {
      results.push({ detector: stage.name, role: "probe", found: {}, failed: err.message });
      continue;
    }
    results.push({ detector: stage.name, role: "probe", found });
    for (const problem of found.problems ?? []) problems.push(`${stage.name}: ${problem}`);
    for (const kind of ["routes", "queries", "actions"]) {
      corrections[kind].push(...(found.corrections?.[kind] ?? []));
    }
  }
  return { results, problems, corrections };
}

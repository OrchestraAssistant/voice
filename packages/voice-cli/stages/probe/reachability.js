import { readOnlyPlan, readRoute } from "../../core/probe.js";

/**
 * Whether the pages and queries the manifest promises are actually there.
 *
 * A route that 404s is one the agent has been told exists. It will send
 * someone there, confidently, and be wrong -- which is a worse failure than
 * not knowing about the page at all.
 *
 * A redirect or a 401 is not a failure. Plenty of real routes bounce to a
 * canonical path or a login page, and following that would only prove the app
 * has authentication.
 */
export const reachability = {
  name: "reachability",
  role: "probe",
  describe: "whether each route and query is actually there",

  async run({ manifest, ask }) {
    const problems = [];
    let reachable = 0;
    let skipped = 0;

    for (const probe of readOnlyPlan(manifest)) {
      if (probe.skipped) {
        skipped++;
        continue;
      }
      const { status, error } = await ask(probe.method, probe.url);
      if (error) {
        problems.push(`${probe.kind} ${probe.name}: could not reach the app (${error})`);
        continue;
      }
      const verdict = readRoute(status);
      if (verdict.ok) reachable++;
      else problems.push(`${probe.kind} ${probe.name} (${probe.url}): ${verdict.why}`);
    }

    return {
      problems,
      notes: [`${reachable} reachable, ${skipped} not probeable without a value`],
    };
  },
};

import { countCallSites } from "../core/callsites.js";

/**
 * How often the app's own code calls each operation.
 *
 * An enricher rather than a policy: it records a number and decides nothing.
 * 52 of cal.diy's 177 operations are called by nothing at all -- schedulers,
 * webhooks, endpoints published for third parties, dead code -- but zero is a
 * signal and not a verdict, since an endpoint added last week for a page
 * shipping next week counts zero and is perfectly real.
 */
export const callSites = {
  name: "call-sites",
  role: "enricher",
  describe: "how often the app's own source references each operation",

  run({ srcDir, root, queries = [], actions = [] }) {
    const operations = [...queries, ...actions];
    if (!operations.length) return {};

    const counts = countCallSites(operations, [srcDir, root]);
    const uncalled = [];
    for (const operation of operations) {
      const count = counts.get(operation.name);
      // null means no question was asked, which is not the same as zero.
      if (count === null || count === undefined) continue;
      operation.callSites = count;
      if (count === 0) uncalled.push(operation.name);
    }

    if (!uncalled.length) return {};
    return {
      notes: [`${uncalled.length} operation(s) the app never calls: ${uncalled.slice(0, 8).join(", ")}${uncalled.length > 8 ? ", ..." : ""}`],
      uncalled,
    };
  },
};

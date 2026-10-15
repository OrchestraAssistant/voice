import { describeShape, readOnlyPlan, readRoute } from "../../core/probe.js";

/**
 * What each query returns.
 *
 * The manifest has no way to say this, so the model infers the shape from the
 * tool's name and whatever arrives at runtime. One call answers it, and it
 * reaches the model as a sentence in the tool description for about a dozen
 * tokens.
 *
 * Deliberately shallow: a full JSON Schema of a booking would cost more than
 * every other entry in the manifest combined.
 */
export const queryShapes = {
  name: "query-shapes",
  role: "probe",
  describe: "what each query returns, which the manifest cannot express",

  async run({ manifest, ask }) {
    const queries = [];
    for (const probe of readOnlyPlan(manifest)) {
      if (probe.skipped || probe.kind !== "query") continue;
      const { status, body, error } = await ask(probe.method, probe.url);
      if (error || !readRoute(status).ok || !body) continue;
      const returns = describeShape(body);
      if (returns?.fields?.length || returns?.of?.length) queries.push({ name: probe.name, returns });
    }
    return {
      corrections: { queries },
      notes: queries.length ? [`${queries.length} query shape(s) recorded`] : [],
    };
  },
};

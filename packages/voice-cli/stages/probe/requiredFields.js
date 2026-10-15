import { omissionProbes, readOmission } from "../../core/probe.js";

/**
 * Which fields the server actually requires.
 *
 * The declaration is a guess. Zod's `.optional()` and TypeScript's `?:` say
 * what the CLIENT believes; the server decides. The demo app's
 * `updateSettings` declares name, email and theme all required, and the server
 * accepts `{"theme":"dark"}` alone -- so the manifest was telling the model it
 * must supply all three to change one, which makes it invent a name and an
 * email and overwrite two fields nobody asked it to touch.
 *
 * Needs `--writes`, because probing a write means performing one. A request
 * missing a genuinely required field is rejected before anything is written,
 * which is what makes the question safe to ask at all -- but "before anything
 * is written" is a property of the app, not a promise we can make.
 */
export const requiredFields = {
  name: "required-fields",
  role: "probe",
  describe: "which declared-required fields the server truly requires",
  needsWrites: true,

  async run({ manifest, ask }) {
    const actions = [];
    const notes = [];

    for (const action of manifest.actions ?? []) {
      // A flow runs in the page; there is no endpoint to send a body to.
      if (action.transport === "dom") continue;
      const probes = omissionProbes(action);
      if (!probes.length) continue;

      const notRequired = [];
      for (const { omitted, body } of probes) {
        const { status, error } = await ask(action.method, action.endpoint, body);
        if (error) continue;
        if (readOmission(omitted, status).required === false) notRequired.push(omitted);
      }
      if (!notRequired.length) continue;

      actions.push({
        name: action.name,
        bodyFields: (action.bodyFields ?? []).map((f) =>
          notRequired.includes(f.name) ? { ...f, required: false } : f,
        ),
      });
      notes.push(`${action.name}: ${notRequired.join(", ")} accepted without it, though the manifest says required`);
    }
    return { corrections: { actions }, notes };
  },
};

/**
 * The last word on a write's body: after EVERY schema and type enricher has had
 * its turn, which writes still carry nothing?
 *
 * This used to live at the end of `zod-bodies`, and that was a bug. Zod runs
 * first (a schema is stronger evidence than a bare type), so a write it leaves
 * empty is routinely filled a moment later by the TypeScript, Valibot, Yup or
 * ArkType enricher. A flag raised inside zod therefore stamped "no input parser"
 * onto actions that DID end up typed -- most visibly every axios-service action
 * typed from a shared `@plane/types` interface -- and the confidence policy then
 * read that stale flag and steered a perfectly good API call to the screen.
 *
 * Run last instead, over the finished bodies, so the flag means what it says: a
 * write whose shape nobody could recover. It is a triage note for the
 * human/LLM pass and a hint the dispatcher reads to prefer the DOM path; it
 * stays in the manifest but never reaches the model (expand strips it).
 *
 * The reason points somewhere different per case, so a reviewer knows where to
 * start: a declared schema that would not resolve is a symbol to chase; a named
 * TS type that would not resolve is a type to find; a hook with no schema beside
 * it is a form to read; nothing declared at all is the handler itself.
 */
export const unresolvedBodies = {
  name: "unresolved-bodies",
  role: "enricher",
  describe: "writes still missing a body after every schema/type enricher -- flagged for the judgement pass",

  run({ actions = [] }) {
    const flagged = [];
    for (const action of actions) {
      const writes = ["POST", "PUT", "PATCH"].includes((action.method ?? "").toUpperCase());
      if (!writes || (action.bodyFields ?? []).length) continue;
      // GraphQL declares its variables exhaustively in the operation document,
      // so an empty variable list means "takes nothing", not "we could not read
      // the body". Flagging it would steer a fully-specified mutation to the
      // screen for no reason.
      if (action.transport === "graphql") continue;

      const reason = action._inputSchema
        ? `input schema \`${action._inputSchema}\` did not resolve to a z.object({...}) -- look where it is defined (it may be a union, a runtime schema, or re-exported)`
        : action._inputType
          ? `input type \`${action._inputType}\` was named but did not resolve to a readable type/interface -- find where it is defined (it may be a generic, a mapped type, or in an untyped package)`
          : action._hookName
            ? `no schema found beside the write hook \`${action._hookName}\` -- read the form that calls it`
            : "no input parser is declared -- the shape lives only in the handler";

      action.review = [...(action.review ?? []), { field: null, kind: "unknown", reason }];
      flagged.push(action.name);
    }
    return {
      notes: flagged.length
        ? [`writes with no readable body, flagged off-prompt: ${flagged.length} (${flagged.slice(0, 8).join(", ")}${flagged.length > 8 ? ", ..." : ""})`]
        : [],
    };
  },
};

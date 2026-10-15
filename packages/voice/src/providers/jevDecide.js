/**
 * The JEV decision engine: turn a transcript + the neutral tool catalog into a
 * decision the core can run, using JEV's closed-set primitives (choice / noul).
 *
 * JEV "gives up string generation" -- it only answers typed questions, never
 * writes free text. So this engine does everything JEV CAN do (route the turn,
 * pick the operation, fill enum/boolean args) and, for a required
 * free-text/number/date argument, returns `needsText` so the provider fills it
 * with a generative model instead. That gate is derived from the chosen op's
 * MANIFEST params, not from asking JEV to self-assess -- which closes the
 * "free text -> default silently stands" footgun.
 *
 * `evaluate(state, questions) -> answers` is injected (JEV via the dev's broker,
 * e.g. the AI SDK's experimental_evaluate). `answers` is keyed by question name;
 * a choice answer carries `.choice`, a noul/boolean answer `.probability`.
 */

/** JEV can fill a param iff it is a closed set: an enum, or a boolean. */
const isClosed = (p) => p.type === "boolean" || (p.type === "enum" && (p.enumValues?.length ?? 0) > 0);

/** Split an op's params into what JEV answers vs what a text model must write. */
export function splitArgs(op) {
  const all = [...(op.params ?? []), ...(op.bodyFields ?? [])];
  const closed = all.filter(isClosed);
  const free = all.filter((p) => !isClosed(p));
  return { closed, free, requiredFree: free.filter((p) => p.required) };
}

/** Top-level routing: a command to run, a question to answer, or a dismissal. */
export function intentQuestion() {
  return {
    type: "choice",
    instructions: "What does the user want?",
    criteria: {
      command: "do something in the app -- run an action or a lookup",
      question: "ask a question to be answered out loud",
      dismiss: "end the conversation (\"that's all\", \"goodbye\", \"stop\")",
    },
  };
}

/** Which catalog operation the user means (or none). */
export function opQuestion(catalog) {
  return {
    type: "choice",
    instructions: "Which operation does the user mean?",
    criteria: {
      ...Object.fromEntries(catalog.map((o) => [o.name, o.description || o.name])),
      none: "none of these",
    },
  };
}

/** Closed-set argument questions for a chosen op: a choice per enum, a noul per boolean. */
export function argQuestions(op) {
  const qs = {};
  for (const p of splitArgs(op).closed) {
    if (p.type === "boolean") {
      qs[`arg_${p.name}`] = { type: "boolean", instructions: `Should "${p.name}" be on?` };
    } else {
      qs[`arg_${p.name}`] = {
        type: "choice",
        instructions: `Which "${p.name}"?`,
        criteria: Object.fromEntries(p.enumValues.map((v) => [String(v), String(v)])),
      };
    }
  }
  return qs;
}

/** Read a JEV answer back into a plain value. */
function valueOf(answer) {
  if (!answer) return undefined;
  if (answer.type === "boolean" || typeof answer.probability === "number") return (answer.probability ?? 0) >= 0.5;
  return answer.choice;
}

/**
 * Decide a turn. Two cheap closed-set evaluate() calls (JEV output is free):
 * route+op together, then closed args once the op is known. Returns one of:
 *   { kind: "dismiss" }
 *   { kind: "answer" }                       -- a spoken reply the provider generates
 *   { kind: "none" }                         -- nothing matched
 *   { kind: "command", name, args, needsText?, missing? }
 */
export async function decide({ transcript, catalog, evaluate }) {
  const routed = await evaluate(transcript, { intent: intentQuestion(), op: opQuestion(catalog) });
  const intent = routed.intent?.choice;
  if (intent === "dismiss") return { kind: "dismiss" };

  const opName = routed.op?.choice;
  if (intent === "question") return { kind: "answer" };
  if (!opName || opName === "none") return { kind: "none" };

  const op = catalog.find((o) => o.name === opName);
  if (!op) return { kind: "none" };

  const argQs = argQuestions(op);
  const args = {};
  if (Object.keys(argQs).length) {
    const answered = await evaluate(transcript, argQs);
    for (const [key, answer] of Object.entries(answered)) {
      const v = valueOf(answer);
      if (v !== undefined) args[key.replace(/^arg_/, "")] = v;
    }
  }

  const { requiredFree } = splitArgs(op);
  return {
    kind: "command",
    name: op.name,
    args,
    ...(requiredFree.length ? { needsText: true, missing: requiredFree.map((p) => p.name) } : {}),
  };
}

/**
 * What an operation's confidence means for how the dispatcher runs it.
 *
 * The manifest stamps `confidence` on the operations whose API path we do not
 * fully trust (see the CLI's confidence stage): `review` when the shape is
 * known but a convention or a hidden depth rides on it, `unknown` when the
 * shape itself is a guess. Absent means `known` -- the default, fully trusted.
 *
 * Two runtime consequences, both keyed off that one word:
 *  - how many times a failing call is worth retrying before we stop, and
 *  - what to tell the model when we do stop: for a low-confidence operation,
 *    steer it to the screen instead of leaving it to remember the screen exists.
 *
 * Pure, so both are testable without a session. The prompt carries the matching
 * guidance up front (API first / screen first / screen only); this is the
 * backstop for when the model tries the API anyway and it fails.
 */
export const confidenceOf = (op) => op?.confidence ?? "known";

/**
 * How many identical failures to allow before stopping.
 *
 * `unknown` gets one try: the body was a guess, so a retry re-sends the same
 * guess and only pushes the rate limit deeper. `review` gets a little more only
 * if the error is transient. `known` keeps today's behaviour. A non-retryable
 * (validation/fatal) error is always one strike -- the identical call cannot
 * start passing.
 */
export function retryBudget(op, { retryable }) {
  const c = confidenceOf(op);
  if (c === "unknown") return 1;
  if (c === "review") return retryable ? 2 : 1;
  return retryable ? 3 : 1;
}

/**
 * The steer to the screen for a low-confidence operation that has stopped
 * failing over. Null for a `known` one -- the API is its right path.
 *
 * Deliberately soft: "try", plus an explicit way out ("if it still cannot be
 * done, stop and say so"), because a hard "do it on the screen" reads as an
 * order the model will obey until it loops. A recorded DOM flow, when one
 * exists, is a tool of its own the model can reach; with none -- cal.diy has
 * none -- the fallback is agentic: navigate, snapshot, and drive the controls.
 */
export function screenSteer(op) {
  const c = confidenceOf(op);
  if (c === "known") return null;
  const where = op?.page ? ` It is on the ${op.page} screen.` : "";
  const why = c === "unknown"
    ? "its exact inputs could not be read from the code"
    : "it may need details that could not be read from the code";
  return (
    `The direct call did not work, and ${why}, so try doing it on the screen instead: ` +
    `navigate to the right page, then dom_snapshot and dom_click / dom_type to do it by hand.${where} ` +
    `If it still cannot be done that way, stop and tell the user what failed -- do not keep retrying.`
  );
}

/**
 * Is an error worth retrying, or is it settled the moment it happens?
 *
 * The distinction the session made expensive: a rate limit says "try again in
 * 8s" and retrying is the whole fix; a validation error ("schedule: Expected
 * array") will reject the identical call forever. Treating them the same made
 * the agent burn four attempts -- and the tokens of each retry -- on a call
 * that could never succeed, which pushed the rate limit deeper and slowed
 * every step after.
 *
 * So errors are split by whether a RETRY of the same request could plausibly
 * succeed:
 *
 *   transient   rate limit, 5xx, a network blip -- wait and retry.
 *   validation  a 400 / bad input -- the SHAPE is wrong; the same call will
 *               keep failing, so change it substantially or use another route
 *               (the DOM tools), never repeat it.
 *   fatal       auth (401/403) and not-found (404) -- retrying changes nothing
 *               and there is nothing to fix in the arguments either.
 *
 * Pattern-matched on the message because that is all a tool result carries by
 * the time it reaches here. Conservative: anything unrecognised is treated as
 * possibly-transient, so a real transient failure is never wrongly abandoned.
 */
export function classifyError(message = "") {
  const m = String(message).toLowerCase();
  if (/rate.?limit|too many requests|429|try again in|temporarily|timeout|network|econn|5\d\d\b/.test(m)) {
    return { kind: "transient", retryable: true };
  }
  if (/invalid input|expected .* received|required|must be|validation|bad request|400\b/.test(m)) {
    return { kind: "validation", retryable: false };
  }
  if (/unauthor|forbidden|401|403|not found|404|no such/.test(m)) {
    return { kind: "fatal", retryable: false };
  }
  return { kind: "unknown", retryable: true };
}

/**
 * Whether an operation should stage-and-confirm before it runs -- the default
 * value of `requiresConfirmation`. A hint, not a verdict: an app tunes it with a
 * hand-correction in manifest.overlay.json.
 *
 * Method OR name, because neither alone is enough. A DELETE is destructive; so is
 * a POST/PUT/PATCH whose name says it undoes, removes, disables, or moves money.
 * The NAME carries most of the signal: tRPC and GraphQL mutations are always
 * POST, so a classifier that trusted only the HTTP method flagged nothing at all
 * for those stacks, and `deactivateAccount` / `cancelSubscription` /
 * `transferOwnership` / `resetPassword` sailed through unconfirmed.
 *
 * The name is split on camelCase and separators and matched WORD by word, so the
 * verb is caught wherever it sits (`deleteTask` and `availabilityScheduleDelete`
 * both) without firing on a substring (`undeletedItems` does not match).
 *
 * Deliberately errs toward flagging: a spurious confirmation costs a moment, a
 * missed one runs a destructive write unasked -- the asymmetry this gate is for.
 */
const DESTRUCTIVE_VERBS = new Set([
  "delete", "remove", "destroy", "deactivate", "disable", "cancel", "archive",
  "unpublish", "deprecate", "revoke", "reset", "wipe", "purge", "discard",
  "terminate", "suspend", "withdraw", "transfer", "refund", "payout", "chargeback",
]);

/** camelCase / dotted / dashed name -> its lower-cased words. */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

export function isDestructive({ method, name } = {}) {
  if (typeof method === "string" && method.toUpperCase() === "DELETE") return true;
  if (typeof name !== "string") return false;
  return words(name).some((w) => DESTRUCTIVE_VERBS.has(w));
}

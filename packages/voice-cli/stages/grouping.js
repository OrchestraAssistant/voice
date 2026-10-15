/**
 * The classifier pass the catalog was built for: on a LARGE app, move the long
 * tail of operations under topics so the base prompt stays a handful of lines.
 *
 * The catalog ships every ROOT operation in the session
 * prompt, fully described and immediately callable, and lists only the NAMES of
 * top-level topics -- their operations are one `expand({ topic })` away. A
 * freshly generated manifest has no groups, so everything is root: exactly right
 * for a small or mid app, where shipping the whole surface costs little and
 * every tool is callable on the first turn. But a 300-operation app that way is
 * ~20k tokens of prefix paid on every response -- the size that walked a live
 * session into a per-minute rate limit.
 *
 * So above a budget, operations are clustered by their ENTITY -- the thing the
 * name acts on, read from the name itself (createIssueLink -> issue,
 * findManyApplicationRegistrations -> application, availabilityScheduleUpdate ->
 * availability). Two things keep it from fighting a well-shaped app:
 *
 * - It groups only the LONG TAIL, and only as much as the budget needs --
 *   SMALLEST clusters first, stopping the moment root is back under budget. So
 *   the dominant entity (the one a user speaks to most -- "work items" in a
 *   tracker) is grouped LAST, i.e. stays at root unless the app is so large even
 *   it must move. An earlier version grouped every multi-member cluster at once,
 *   which buried the common operations behind an expand() the instant the app
 *   crept one op over budget.
 * - A lone operation stays at root (a topic for one tool is just a round trip),
 *   and anything already carrying a group -- a hand/overlay decision, or a
 *   producer that knows the real structure -- is the floor, left untouched.
 *
 * Name-based on purpose: the accurate signal (a service class, a gql module
 * directory, a tRPC router path) lives in the producer, but reading it uniformly
 * across every stack is a bigger change, and the name already clusters well --
 * a leading verb strips to the entity, and a namespaced name keeps its
 * namespace, which is the grouping you want in both cases.
 */

// At or below this many operations, ship everything at root (the deliberate
// default). Grouping exists for the genuinely large app (the ~300-op surface that
// is ~20k tokens of prefix); a mid-size app's full surface is a cheap prefix and
// every tool callable on the first turn is worth more than the tokens saved. Set
// high enough that an ordinary app is never grouped against the author's intent.
const ROOT_BUDGET = 80;
// A cluster is only worth a topic -- and the expand() it costs -- above one tool.
const MIN_CLUSTER = 2;

// Words that LEAD a name as a verb or qualifier rather than name the thing acted
// on. Stripped from the front so the key is the entity. A name that does not
// start with one of these keeps its first word (for `availabilityScheduleUpdate`
// that is `availability` -- the namespace, which is the grouping you want).
const LEAD = new Set([
  "get", "list", "find", "fetch", "read", "load", "show", "view", "search", "count",
  "create", "add", "new", "insert", "upsert", "make", "generate", "import",
  "update", "patch", "edit", "set", "change", "modify", "save", "rename",
  "delete", "remove", "destroy", "clear", "drop", "discard", "purge", "wipe",
  "archive", "unarchive", "restore", "deactivate", "activate", "disable", "enable",
  "cancel", "revoke", "reset", "toggle", "assign", "unassign", "approve", "reject",
  "submit", "send", "mark", "move", "reorder", "duplicate", "copy", "bulk", "batch",
  "one", "many", "all", "current", "my",
]);

/** camelCase / dotted / dashed name -> its words. */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** The topic key for an operation: its entity, after stripping leading verbs. */
export function groupKeyOf(name) {
  const ws = words(name);
  if (!ws.length) return "";
  let i = 0;
  // Skip leading verbs AND single-character fragments (`oAuthCreateClient` splits
  // to o/Auth/... -> "auth", not "o"). Never strip the last word, so an all-verb
  // name still yields a key.
  while (i < ws.length - 1 && (ws[i].length === 1 || LEAD.has(ws[i].toLowerCase()))) i++;
  return ws[i].toLowerCase();
}

export const grouping = {
  name: "grouping",
  role: "policy",
  describe: "on a large app, cluster operations into topics by entity so the base prompt stays small",

  // A policy: reads the MERGED manifest, after producers/enrichers and after
  // infrastructure has dropped what it drops, so it only groups surviving ops.
  run({ manifest }) {
    const ops = [...(manifest?.queries ?? []), ...(manifest?.actions ?? [])];
    if (ops.length <= ROOT_BUDGET) return { notes: [] };

    // Cluster the ungrouped operations by entity. Ones already carrying a group
    // are the floor -- skipped, and already off root. `rootCount` is what remains
    // shippable at root; we group down toward the budget from there.
    const clusters = new Map();
    let rootCount = 0;
    for (const op of ops) {
      if (op.group?.length) continue;
      rootCount += 1;
      const key = groupKeyOf(op.name);
      if (!key) continue;
      const members = clusters.get(key) ?? clusters.set(key, []).get(key);
      members.push(op);
    }

    // Smallest eligible cluster first, stopping once root is back under budget --
    // so the long tail moves and the dominant (usually most-spoken-to) entity
    // stays at root whenever the budget can be met without it.
    const eligible = [...clusters.entries()]
      .filter(([, m]) => m.length >= MIN_CLUSTER)
      .sort((a, b) => a[1].length - b[1].length);

    const topics = new Set();
    let grouped = 0;
    for (const [key, members] of eligible) {
      if (rootCount <= ROOT_BUDGET) break;
      for (const op of members) op.group = [key];
      topics.add(key);
      grouped += members.length;
      rootCount -= members.length;
    }

    if (!grouped) return { notes: [] };
    const shown = [...topics].sort((a, b) => clusters.get(b).length - clusters.get(a).length).slice(0, 8);
    return {
      notes: [
        `grouping: ${ops.length} operations -> ${rootCount} at root + ` +
          `${grouped} under ${topics.size} topic(s) (${shown.join(", ")}${topics.size > 8 ? ", ..." : ""})`,
      ],
    };
  },
};

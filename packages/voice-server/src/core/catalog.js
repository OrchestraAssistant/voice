/**
 * The operation catalog as a TREE, so a big app's tools do not all ride in the
 * session prompt at once.
 *
 * Every query and action has an optional `group`: a path like
 * ["availability","schedule"]. No group -- undefined or [] -- means the ROOT,
 * and root operations ship in the base prompt, fully described and immediately
 * callable. That is the deliberate default: a freshly generated manifest has no
 * groups, so everything is root, so everything ships and the app works on the
 * first try. Lightening it is what the classifier pass does afterwards, by
 * moving operations down into groups.
 *
 * Below the root are TOPICS. A topic is a node in the tree; the base prompt
 * lists the top-level ones by name and description, not their operations, and
 * the model reaches an operation by calling `expand` on the topic that holds
 * it. A deep app is a deep tree, so the very niche things take a few expands to
 * reach -- which is the point: context fills with one topic's tools when asked,
 * not with everything.
 *
 * `manifest.groups` is an optional list of { path, description } giving each
 * topic node its one-line summary. A topic with no entry still works; it just
 * shows its own name and nothing more.
 */

const asPath = (group) => (Array.isArray(group) ? group : group ? [group] : []);
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const pathKey = (p) => p.join("/");

/**
 * A body field as the MODEL should see it. `dates` is encoding metadata the
 * transport reads, and `review` is a build-time triage flag for a human/LLM --
 * neither belongs in the prompt: one is noise, the other is our own uncertainty,
 * which would only sap the model's confidence. The model gets name, type,
 * whether it is required, its values, and its shape, and nothing else.
 */
const forSession = ({ dates, review, ...field }) => field;

/** Every query and action, tagged with its kind and normalised path. */
function operations(manifest) {
  return [
    ...(manifest.queries ?? []).map((o) => ({ ...o, kind: "query" })),
    ...(manifest.actions ?? []).map((o) => ({ ...o, kind: "action" })),
  ].map((o) => ({ ...o, path: asPath(o.group) }));
}

const describeOf = (manifest, path) =>
  (manifest.groups ?? []).find((g) => samePath(asPath(g.path), path))?.description ?? "";

/**
 * What sits directly at a node, and which topics branch off it.
 *
 * `at` is the path of the node ([] for root). Direct operations are those whose
 * group is exactly `at`. Child topics are the distinct next segments of every
 * operation that lives deeper, each carrying a count of everything beneath it
 * so the model can tell a big branch from a small one before spending a call.
 */
export function nodeAt(manifest, at = []) {
  const ops = operations(manifest);
  const direct = ops.filter((o) => samePath(o.path, at));

  const children = new Map(); // next segment -> count beneath it
  for (const o of ops) {
    if (o.path.length <= at.length) continue;
    if (!at.every((s, i) => s === o.path[i])) continue;
    const seg = o.path[at.length];
    children.set(seg, (children.get(seg) ?? 0) + 1);
  }

  const topics = [...children.entries()].map(([seg, count]) => {
    const path = [...at, seg];
    return { path, name: seg, description: describeOf(manifest, path), count };
  });

  return { direct, topics };
}

/**
 * What a query returns, when probing has been able to find out. The model was
 * otherwise inferring the shape from the tool name and whatever arrived at
 * runtime; a dozen tokens removes the guess. Nothing when unprobed, so an
 * un-probed manifest reads exactly as before.
 */
export function describeReturns(returns) {
  if (!returns) return "";
  if (returns.kind === "array") {
    const fields = Array.isArray(returns.of) ? returns.of : null;
    return fields?.length ? ` Returns a list; each item has: ${fields.join(", ")}.` : " Returns a list.";
  }
  if (returns.kind === "object" && returns.fields?.length) return ` Returns an object with: ${returns.fields.join(", ")}.`;
  return "";
}

/**
 * One catalog entry: a NAME and what it takes, deliberately NOT shaped like a
 * function signature.
 *
 * The first version read `query availabilityScheduleGet(scheduleId?)`, which
 * the model saw as a tool and called directly -- there is no such tool, only
 * run_query. So the kind is dropped (the section header carries it), the params
 * become "takes:" rather than parentheses, and the name stands alone as the
 * string you pass. Measured: with the signature form the model invented
 * `availabilityScheduleGet(...)` and `query(...)` calls and never reached the
 * dispatcher.
 */
export function opLine(op) {
  const args = [...(op.params ?? []), ...(op.bodyFields ?? [])]
    // A nested shape rides with the name -- `schedule: Array<Array<{start, end}>>`
    // -- because the shape is exactly what a bare name could not convey and a
    // model kept guessing wrong. A scalar carries no shape and stays a bare name.
    .map((p) => `${p.name}${p.required ? "" : "?"}${p.shape ? `: ${p.shape}` : ""}`)
    .join(", ");
  const desc = (op.description ?? "").replace(/\s+/g, " ").trim();
  const returns = op.kind === "query" ? describeReturns(op.returns) : "";
  const destructive = op.requiresConfirmation ? " [destructive]" : "";
  // A flow runs in the page and can stop partway; the STEPS are never shown.
  const onScreen = op.transport === "dom" ? " [on screen, can stop partway]" : "";
  // The path directive, from confidence -- but never on an operation that is
  // ALREADY a screen flow (it is the screen). "screen first": the API call may
  // be subtly wrong. "screen only": we could not read its inputs at all.
  const path =
    op.transport === "dom" ? "" : op.confidence === "unknown" ? " [screen only]" : op.confidence === "review" ? " [screen first]" : "";
  return `${op.name}${destructive}${onScreen}${path}${args ? ` -- takes: ${args}` : ""}${desc ? ` -- ${desc}` : ""}${returns}`;
}

/**
 * The catalog text for the base prompt: the root operations by kind, then the
 * top-level topics as expandable names. This is the whole of what a session
 * starts knowing about; everything else is an `expand` away.
 */
export function rootCatalog(manifest) {
  const { direct, topics } = nodeAt(manifest, []);
  const queries = direct.filter((o) => o.kind === "query");
  const actions = direct.filter((o) => o.kind === "action");
  const lines = [];

  if (queries.length) {
    lines.push("To READ, pass one of these names to run_query as { name, args }:");
    for (const op of queries) lines.push(`  ${opLine(op)}`);
  }
  if (actions.length) {
    lines.push(`${lines.length ? "\n" : ""}To CHANGE something, pass one of these names to run_action as { name, items }:`);
    for (const op of actions) lines.push(`  ${opLine(op)}`);
  }
  if (topics.length) {
    lines.push(`${lines.length ? "\n" : ""}More tools are grouped by topic. Call expand({ topic }) with a topic name to reveal its tools:`);
    for (const t of topics) {
      lines.push(`  ${pathKey(t.path)}${t.description ? ` -- ${t.description}` : ""} (${t.count} tool${t.count === 1 ? "" : "s"})`);
    }
  }
  return lines.join("\n");
}

/**
 * The answer to expand({topic}). Returns the operations directly under that
 * topic and any sub-topics beneath it, or null when the path names no node.
 *
 * Answered from the manifest, so whoever holds it -- the widget, at runtime --
 * can serve an expand without a round trip. The relay only ever renders the
 * root; the tree lives in the data both sides already share.
 */
export function expand(manifest, topic) {
  // A string topic always splits on "/"; an array is taken as-is.
  const at = Array.isArray(topic) ? topic : String(topic ?? "").split("/").filter(Boolean);
  const { direct, topics } = nodeAt(manifest, at);
  if (!direct.length && !topics.length) return null;
  return {
    topic: pathKey(at),
    tools: direct.map((op) => ({
      kind: op.kind,
      name: op.name,
      description: op.description ?? "",
      params: op.params ?? [],
      ...(op.bodyFields ? { bodyFields: op.bodyFields.map(forSession) } : {}),
      ...(op.requiresConfirmation ? { requiresConfirmation: true } : {}),
      // The path directive travels with an expanded tool too, so a deep
      // operation carries the same steer as a root one. A model-facing verdict,
      // unlike the review flags forSession strips.
      ...(op.confidence ? { confidence: op.confidence } : {}),
    })),
    subtopics: topics.map((t) => ({ topic: pathKey(t.path), description: t.description, count: t.count })),
  };
}

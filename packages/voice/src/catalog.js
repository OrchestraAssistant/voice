/**
 * Answering expand() from the manifest, at runtime, in the widget.
 *
 * The relay renders the ROOT of the tool tree into the session prompt (see the
 * relay's catalog.js); the widget answers every expand() into the deeper
 * branches, because it already holds the whole manifest and the model's call
 * lands here as a tool call. Same data model on both sides, two views of it.
 *
 * A `group` is a path -- ["availability","schedule"] -- and no group means the
 * root. expand("availability") returns the operations directly under that node
 * and the sub-topics beneath it.
 */
const asPath = (group) => (Array.isArray(group) ? group : group ? [group] : []);
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

// A body field as the MODEL should see it: `dates` (transport encoding) and
// `review` (a build-time triage flag for a human/LLM) are stripped -- one is
// noise in the prompt, the other is our uncertainty, which would only sap the
// model's confidence. Same projection the relay applies to the root catalog.
const forSession = ({ dates, review, ...field }) => field;

function operations(manifest) {
  return [
    ...(manifest.queries ?? []).map((o) => ({ ...o, kind: "query" })),
    ...(manifest.actions ?? []).map((o) => ({ ...o, kind: "action" })),
  ].map((o) => ({ ...o, path: asPath(o.group) }));
}

export function expandTopic(manifest, topic) {
  // A string topic always splits on "/"; an array is taken as-is.
  const at = Array.isArray(topic) ? topic : String(topic ?? "").split("/").filter(Boolean);
  const ops = operations(manifest);
  const direct = ops.filter((o) => samePath(o.path, at));

  const children = new Map();
  for (const o of ops) {
    if (o.path.length <= at.length || !at.every((s, i) => s === o.path[i])) continue;
    const seg = o.path[at.length];
    children.set(seg, (children.get(seg) ?? 0) + 1);
  }
  if (!direct.length && !children.size) return null;

  const groups = manifest.groups ?? [];
  const describe = (path) => groups.find((g) => samePath(asPath(g.path), path))?.description ?? "";

  return {
    topic: at.join("/"),
    tools: direct.map((op) => ({
      kind: op.kind,
      name: op.name,
      description: op.description ?? "",
      params: op.params ?? [],
      ...(op.bodyFields ? { bodyFields: op.bodyFields.map(forSession) } : {}),
      ...(op.requiresConfirmation ? { requiresConfirmation: true } : {}),
      // The path directive (known omitted): a model-facing steer, kept when the
      // hidden tags are stripped.
      ...(op.confidence ? { confidence: op.confidence } : {}),
    })),
    subtopics: [...children.entries()].map(([seg, count]) => ({
      topic: [...at, seg].join("/"),
      description: describe([...at, seg]),
      count,
    })),
  };
}

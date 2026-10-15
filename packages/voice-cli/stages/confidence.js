/**
 * One verdict per operation: how much we trust its API path.
 *
 *   known    -- nothing flagged it; the API call is fully specified.
 *   review   -- the shape is known but something rides on it we could not read
 *               (an opaque convention, a truncated depth), so a call may be
 *               subtly wrong.
 *   unknown  -- the shape itself is undetermined; a call is a guess.
 *
 * This is the single number the runtime and the prompt read to choose a path:
 * known -> API first, review -> the screen first, unknown -> the screen only.
 * It collapses the review flags (and, when present, the read-back probe's
 * verdict) into that one word, so neither consumer has to re-derive it and the
 * three stages of judgement -- static flags, probe, and later the human/LLM
 * note -- all arrive as one field.
 *
 * `known` is the default and is left OFF the operation, so only the minority
 * that need a different path carry the mark, in the manifest and the prompt.
 */
export function confidenceOf(op) {
  // The read-back probe outranks the static guess: a fixture that actually
  // changed state proves the API path works, and a silent no-op condemns it,
  // whatever the shape looked like. Set by the write-effects probe (overlay).
  if (op.verified === true) return "known";
  if (op.verified === false) return "review";

  const kinds = new Set((op.review ?? []).map((r) => r.kind));
  if (kinds.has("unknown")) return "unknown";
  if (kinds.has("opaque") || kinds.has("truncated")) return "review";
  return "known";
}

export const confidence = {
  name: "confidence",
  role: "policy",
  describe: "a per-operation verdict (known/review/unknown) that picks the API-vs-screen path",

  // A policy stage, so it reads the MERGED manifest, not the pre-merge arrays
  // still sitting in the context -- those carry a framework's duplicate
  // operations (cal.diy's viewer/loggedInViewerRouter aliases), which merge
  // drops. Counting them there over-reported by 17.
  run({ manifest }) {
    const queries = manifest?.queries ?? [];
    const actions = manifest?.actions ?? [];
    const counts = { review: 0, unknown: 0 };
    for (const op of [...queries, ...actions]) {
      const c = confidenceOf(op);
      if (c === "known") {
        delete op.confidence; // the default; kept off the operation to save bytes
      } else {
        op.confidence = c;
        counts[c] += 1;
      }
    }
    const notes = [];
    if (counts.review || counts.unknown) {
      notes.push(`confidence: ${counts.review} to review, ${counts.unknown} unknown (API path not trusted; prompt steers these to the screen)`);
    }
    return { notes };
  },
};

import { walk } from "./parse.js";
import fs from "node:fs";

/**
 * How often the app's own code calls each operation.
 *
 * An endpoint nothing calls is almost certainly not something a person would
 * ask for. Measured against cal.diy: 52 of 177 discovered operations appear
 * nowhere in the client or shared source. They are schedulers calling
 * themselves, webhooks arriving from other services, endpoints published for
 * third-party API consumers, operational probes, and dead code.
 *
 * Pattern rules already catch cron jobs and webhooks by their paths. Nothing
 * in a pattern catches `/api/version` or `/api/me`, and this does.
 *
 * A count rather than a verdict. Zero is a strong signal and still only a
 * signal: an endpoint added last week for a page shipping next week counts
 * zero and is perfectly real.
 */
export function countCallSites(operations, roots) {
  const sources = [];
  for (const root of roots) {
    for (const file of walk(root, (n) => /\.(t|j)sx?$/.test(n))) {
      try {
        sources.push(fs.readFileSync(file, "utf-8"));
      } catch {
        // Unreadable is not a reason to abandon the rest.
      }
    }
    if (sources.length) break;
  }
  if (!sources.length) return new Map();

  const counts = new Map();
  for (const operation of operations) {
    const needles = searchTermsFor(operation);
    if (!needles.length) {
      counts.set(operation.name, null);
      continue;
    }
    // The first needle that finds anything wins. A URL assembled from a
    // constant prefix -- `${BASE}/tasks` -- contains the literal "/api/tasks"
    // nowhere in the source, so searching only for the resolved endpoint
    // reported every operation in such an app as called by nothing.
    let count = 0;
    for (const needle of needles) {
      count = sources.filter((s) => s.includes(needle)).length;
      if (count) break;
    }
    counts.set(operation.name, count);
  }
  return counts;
}

/**
 * What to look for.
 *
 * A tRPC procedure never appears as a URL in client code -- it is called as
 * `trpc.availability.list.useQuery()` -- so the dotted path is the only thing
 * that will match. A REST endpoint is searched by its literal path with any
 * parameter placeholder cut off, since the text after it is interpolated.
 */
/**
 * What to look for, most specific first.
 *
 * The resolved endpoint is the best needle when it appears literally. When the
 * app builds it from a prefix constant, which is the common case, the path
 * without its first segment is what is actually written down.
 */
export function searchTermsFor(operation) {
  const exact = searchTermFor(operation);
  if (!exact) return [];
  if (!exact.startsWith("/")) return [exact];

  const terms = [exact];
  const segments = exact.split("/").filter(Boolean);
  if (segments.length > 1) {
    const withoutPrefix = `/${segments.slice(1).join("/")}`;
    // Short enough to match anything is worse than not looking.
    if (withoutPrefix.length >= 5) terms.push(withoutPrefix);
  }
  return terms;
}

export function searchTermFor(operation) {
  const endpoint = operation.endpoint ?? "";
  if (operation.transport === "trpc" || endpoint.includes("/api/trpc/")) {
    const tail = endpoint.split("/api/trpc/")[1] ?? "";
    // "availability/schedule.update" is addressed as availability.schedule.update
    const dotted = tail.replace(/\//g, ".");
    return dotted.length >= 4 ? dotted : null;
  }
  const literal = endpoint.split("{")[0].replace(/\/$/, "");
  // Too short a needle matches everything; "/api" would count every file.
  return literal.length >= 6 ? literal : null;
}

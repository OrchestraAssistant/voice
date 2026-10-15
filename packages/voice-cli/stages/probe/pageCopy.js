import { describePages, harvestPage, readOnlyPlan, readRoute } from "../../core/probe.js";

/**
 * What each page says about itself, taken from the HTML it serves.
 *
 * Largely superseded by reading the source, which sees pages that never render
 * on the server -- cal.diy serves a shell for 61 of its 81 routes, so this
 * described 20 where the source described 53. Kept because it is the only
 * thing that can read a page whose heading is assembled at request time, and
 * because the two disagreeing is worth knowing about.
 *
 * Deciding what counts as a description takes all the pages at once: the
 * product name is whichever title segment repeats everywhere, and no single
 * page can tell which half of "Availability | Cal.diy" that is.
 */
export const pageCopy = {
  name: "page-copy",
  role: "probe",
  describe: "the heading and subtitle each page actually renders",

  async run({ manifest, ask }) {
    const harvested = [];
    for (const probe of readOnlyPlan(manifest)) {
      if (probe.skipped || probe.kind !== "route") continue;
      const { status, text, error } = await ask(probe.method, probe.url);
      if (error || !readRoute(status).ok || !text) continue;
      const page = harvestPage(text);
      if (page) harvested.push({ path: probe.name, ...page });
    }

    const routes = describePages(harvested);
    return {
      corrections: { routes },
      notes: routes.length ? [`${routes.length} page(s) describe themselves`] : [],
    };
  },
};

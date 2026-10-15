import { excludeInfrastructure } from "../core/exclude.js";
import { activeExcludes } from "../core/run.js";

/**
 * Leaves out what nobody would ask for out loud.
 *
 * Reading cal.diy's route handlers turned up 84 endpoints including
 * createCronBookingReminder, createAuthOauthToken and
 * createWebhookAppCredential. It is measurably expensive too: the tool list
 * rides in the session prompt, and those 84 took the prefix from ~2,500 tokens
 * to ~10,900, paid on the first response of every session.
 *
 * The rules belong to the frameworks that produce those endpoints, and only
 * frameworks that actually applied get a say -- a plain React app is never
 * filtered by Next.js conventions.
 */
export const infrastructure = {
  name: "infrastructure",
  role: "policy",
  describe: "endpoints a framework calls itself: cron, webhooks, OAuth callbacks",

  run({ manifest, stages, results, named = [] }) {
    const excluded = excludeInfrastructure(manifest, activeExcludes(stages, results), named);
    if (!excluded.length) return {};

    const byReason = new Map();
    for (const item of excluded) byReason.set(item.why, (byReason.get(item.why) ?? 0) + 1);
    return {
      notes: [`${excluded.length} endpoint(s) left out: ${[...byReason].map(([why, n]) => `${n} ${why}`).join("; ")}`],
      excluded,
    };
  },
};

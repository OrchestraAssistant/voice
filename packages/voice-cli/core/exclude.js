/**
 * Not everything an app exposes is something a person would ask for.
 *
 * Reading Next.js route handlers turned up 84 endpoints in cal.diy, including
 * createCronBookingReminder, createAuthOauthToken and createWebhookAppCredential.
 * Those are machinery: schedulers calling themselves, OAuth handshakes,
 * provider callbacks. Nobody says them out loud.
 *
 * It is measurably expensive too, because the tool list rides in the session
 * prompt: those 84 endpoints took the prefix from ~2,500 tokens to ~10,900,
 * paid in full on the first response of every session.
 *
 * This file is only the ENGINE. The rules live with the detector whose
 * framework produces those endpoints, so a framework's knowledge about itself
 * arrives and leaves in one piece instead of accumulating in a global list
 * that nobody owns.
 */
export function excludeInfrastructure(manifest, rules, keep = []) {
  const excluded = [];
  for (const kind of ["queries", "actions"]) {
    manifest[kind] = (manifest[kind] ?? []).filter((item) => {
      // Naming something in the overlay is a deliberate act and outranks a
      // default. The policy is a default, not a verdict.
      if (keep.includes(item.name)) return true;
      const hit = rules.find((rule) => rule.pattern.test(item.endpoint ?? ""));
      if (!hit) return true;
      excluded.push({ name: item.name, endpoint: item.endpoint, why: hit.why });
      return false;
    });
  }
  return excluded;
}

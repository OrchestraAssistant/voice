import fs from "node:fs";
import path from "node:path";

/**
 * Is this actually a Next.js app?
 *
 * Without this the Pages Router detector claimed four routes from a plain
 * React app that kept its components in `src/pages/` -- a directory name with
 * no framework meaning at all. A detector firing on a coincidence is worse
 * than one finding nothing, because what it produces looks exactly like a
 * real result.
 *
 * Lives here rather than in one of the detector files, because it is the Next
 * FAMILY's knowledge and both of them need it. The API detector used to import
 * it out of the routes detector, which made one an arbitrary owner of the
 * other's predicate.
 */
export function isNextApp(root) {
  if (["next.config.js", "next.config.ts", "next.config.mjs"].some((f) => fs.existsSync(path.join(root, f)))) return true;
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

/**
 * Endpoints a Next.js app exposes that a voice agent should not be handed.
 *
 * Owned by this module because these paths are Next.js conventions: NextAuth
 * mounts at /api/auth, tRPC at /api/trpc, and Vercel's cron calls /api/cron.
 * A framework we do not support contributes none of these, and one we add
 * later brings its own.
 */
export const NEXT_INFRASTRUCTURE = [
  { pattern: /^\/api\/auth\//, why: "authentication handshakes" },
  { pattern: /^\/api\/cron\//, why: "scheduled jobs the app calls itself" },
  { pattern: /^\/api\/webhooks?\b/, why: "inbound webhooks from other services" },
  // The catch-all HANDLER, not the procedures behind it. Written to match a
  // path parameter, because once the tRPC detector can read the router the
  // individual procedures ARE real endpoints -- and a blanket rule here
  // filtered all 172 of them away.
  { pattern: /^\/api\/trpc\/(.*\/)?\{[^}]*\}/, why: "the tRPC transport handler; its procedures are read separately" },
  { pattern: /^\/api\/integrations\//, why: "third-party integration callbacks" },
  { pattern: /\/callback\b/, why: "an OAuth or provider callback" },
  { pattern: /^\/api\/_/, why: "private by naming convention" },
  { pattern: /^\/api\/(health|status|ping|metrics)\b/, why: "operational probes" },
];

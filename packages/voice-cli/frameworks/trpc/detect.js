import fs from "node:fs";
import path from "node:path";

/** Does this app use tRPC at all? */
export function usesTrpc(root) {
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (Object.keys(deps).some((d) => d.startsWith("@trpc/"))) return true;
    } catch {
      /* fall through to the filesystem check */
    }
  }
  // A monorepo hides tRPC in a workspace package, so the app's own manifest
  // may not mention it. cal.diy is exactly this: @calcom/trpc, no @trpc/* in
  // apps/web's dependencies at all.
  return ["pages/api/trpc", "src/pages/api/trpc", "app/api/trpc", "src/app/api/trpc"].some((p) =>
    fs.existsSync(path.join(root, p)),
  );
}

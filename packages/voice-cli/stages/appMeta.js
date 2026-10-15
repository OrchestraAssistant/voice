import fs from "node:fs";
import path from "node:path";

/**
 * What the app IS, in one line -- the manifest's own answer to "what kind of
 * app is this", so the session prompt never has to assume.
 *
 * The relay used to open every prompt with a hardcoded "a task-management web
 * app", which was true for the app it was built against and wrong for every
 * other -- a store, a CRM, a newspaper the extension lands on. Identity is DATA,
 * not a constant in the relay: it belongs in the manifest.
 *
 * Seeded here from the app's own `package.json` description, which is the one
 * place a project already states what it is. It is only a seed -- the judgement
 * pass refines it into a line written for the model (`Plane: an issue and
 * project tracker`), the same way it refines a page's description. Absent, the
 * relay falls back to a neutral "a web app" rather than a wrong guess.
 */
export const appMeta = {
  name: "app-meta",
  role: "enricher",
  describe: "the app's own one-line identity (package.json description) for the prompt's opening",

  run({ root }) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    } catch {
      return {};
    }
    const description = typeof pkg.description === "string" && pkg.description.trim() ? pkg.description.trim() : null;
    if (!description) return {};
    return { description, notes: [`app identity seeded from package.json: "${description}"`] };
  },
};

import traverse from "@babel/traverse";
import { parseFile, walk } from "../../core/parse.js";

/**
 * React Router's declarative form: <Route path="/tasks/:id" element={<X/>} />.
 *
 * Scans every source file rather than only App.jsx. Routes are commonly split
 * across a routes/ directory or per-feature files, and reading one hardcoded
 * filename is how this found nothing in the first real app it met.
 */
export const reactRouter = {
  name: "react-router",
  role: "producer",
  describe: "<Route path=... element={<X/>} /> elements",

  run({ srcDir }) {
    const routes = [];
    for (const file of walk(srcDir, (n) => /\.(jsx|tsx|js|ts)$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue; // a file we cannot parse is not a reason to abandon the rest
      }
      // Babel 8 ships traverse as both a default and a namespace depending on
      // how it is imported; take whichever is callable.
      const visit = traverse.default ?? traverse;
      visit(ast, {
        JSXElement(nodePath) {
          const opening = nodePath.node.openingElement;
          if (opening.name.name !== "Route") return;
          let routePath;
          let component;
          for (const attr of opening.attributes) {
            if (attr.type !== "JSXAttribute") continue;
            if (attr.name.name === "path" && attr.value?.type === "StringLiteral") routePath = attr.value.value;
            if (attr.name.name === "element" && attr.value?.expression?.type === "JSXElement") {
              component = attr.value.expression.openingElement.name.name;
            }
          }
          if (routePath) routes.push({ path: routePath, component, _file: file });
        },
      });
    }
    return { routes };
  },
};

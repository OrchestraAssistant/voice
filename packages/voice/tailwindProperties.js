/**
 * Makes Tailwind's `--tw-*` variables work inside a shadow root.
 *
 * Tailwind v4 declares every internal variable with `@property`, and leans on
 * that registration for the variable's INITIAL value. `box-shadow` is then
 * written as a five-var chain:
 *
 *   box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow),
 *               var(--tw-ring-offset-shadow), var(--tw-ring-shadow),
 *               var(--tw-shadow);
 *
 * and `shadow-lg` only sets the last one. The other four come from the
 * registration.
 *
 * `@property` is registered per DOCUMENT. A stylesheet inside a shadow root is
 * ignored for it -- the rules parse, nothing registers. So the four unset vars
 * stay guaranteed-invalid, the whole declaration is invalid at computed-value
 * time, and `box-shadow` computes to `none` with `--tw-shadow` sitting right
 * there holding the correct value.
 *
 * Tailwind already emits the answer: a `@layer properties` block that assigns
 * every initial value on `*`. It gates it behind an `@supports` that matches
 * only the engines without `@property` (old Safari, Firefox), because on
 * Chromium the registration is assumed to work. In a shadow root it does not,
 * on any engine. So we remove the gate and let the block always apply.
 *
 * Measured before this existed, on our own widget in Chromium: `shadow-*` and
 * `ring-*` produced no shadow, `border` produced `border-style: none` and so
 * `0px` width, and `scale-*`/`blur-*` were dropped. The panel rendered as
 * white text boxes on a white page with no card edge -- which reads as "the
 * stylesheet never loaded", and sends you looking in the wrong place.
 *
 * Applied to BOTH copies we ship: the `?inline` string the bubble injects into
 * the shadow root, and dist/voice.css for hosts that mount inline. The
 * declarations land on `*` at specificity 0 inside our own layer, so a host's
 * own Tailwind utilities still outrank them.
 */
import postcss from "postcss";

const OPENER = "@layer properties{@supports ";

/**
 * Scope every class selector under `.iv-scope`, so the EXPORTED sheet
 * (`@expert/voice/inline.css`, for mount="inline") can never touch a host's own
 * elements. Its bare Tailwind utilities -- `.hidden`, `.md:flex` -- once collided
 * with a host app's identical classes in the global namespace and collapsed its
 * desktop sidebar to a mobile layout. A shadow root would isolate them, but
 * inline mount has no shadow, so the isolation has to be in the selectors: every
 * rule becomes `.iv-scope <sel>`, and the widget renders under a `.iv-scope`
 * element. A host has no `.iv-scope`, so nothing of ours reaches it.
 *
 * The shadow-mount copy (the `?inline` string) is NOT scoped -- the shadow root
 * already isolates it, and this only runs over the extracted dist/voice.css.
 *
 * `:root` variables (`--iv-*`, namespaced, non-colliding) and the global at-rules
 * (`@property`, `@keyframes`) are left alone: they define, not select, and
 * scoping them would only hide the widget's own tokens from itself.
 */
function scopeClasses(css, scope = ".iv-scope") {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return css; // never corrupt the sheet; unscoped-but-valid beats broken
  }
  root.walkRules((rule) => {
    const parent = rule.parent;
    // Keyframe steps (`0%`, `from`) are rules but not selectors to scope.
    if (parent?.type === "atrule" && /(^|-)keyframes$/i.test(parent.name)) return;
    rule.selectors = rule.selectors.map((sel) => {
      const s = sel.trim();
      if (!s || s === ":root" || s.startsWith(":root")) return s;
      return `${scope} ${s}`;
    });
  });
  return root.toString();
}

function ungate(css) {
  const start = css.indexOf(OPENER);
  if (start === -1) return css;

  // Find the `{` that opens the @supports body, then brace-match to its end.
  // Byte offsets rather than a regex: the condition itself is full of
  // parens and the body is thousands of characters of declarations.
  const bodyStart = css.indexOf("{", start + OPENER.length);
  if (bodyStart === -1) return css;
  let depth = 1;
  let i = bodyStart;
  while (++i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  if (depth !== 0) return css; // Unbalanced; leave it alone rather than corrupt it.
  const bodyEnd = i - 1; // The `}` that closes @supports.

  return css.slice(0, start) + "@layer properties{" + css.slice(bodyStart + 1, bodyEnd) + css.slice(bodyEnd + 1);
}

export function tailwindShadowDomProperties() {
  return {
    name: "tailwind-shadow-dom-properties",
    enforce: "post",
    transform(code, id) {
      // The `?inline` copy, while it is still CSS. Runs after Tailwind has
      // generated the sheet and before Vite stringifies it.
      if (!/\.css(\?|$)/.test(id) || !code.includes(OPENER)) return null;
      return { code: ungate(code), map: null };
    },
    generateBundle(_options, bundle) {
      // The extracted dist/voice.css, in case the transform above ran too
      // early in the pipeline to see the final sheet.
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        // This is dist/voice.css -- the sheet a host imports for mount="inline".
        // Ungate the properties block, then scope every class so it cannot reach
        // the host. The shadow copy (?inline, inlined into the JS) never lands
        // here, so it stays unscoped and fully isolated by its shadow root.
        file.source = scopeClasses(ungate(String(file.source)));
      }
    },
  };
}

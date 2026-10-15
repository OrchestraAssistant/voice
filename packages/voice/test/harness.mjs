import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The bundled Chromium needs shared libraries and fonts this container's
 * read-only root doesn't have, so they live in a micromamba env instead (see
 * the README). Setting these here rather than in a wrapper script means
 * `npm test` just works: Playwright spawns the browser as a child process, so
 * it inherits whatever we put in process.env before launching.
 *
 * Fonts are not cosmetic here. With none installed, `ch` units compute to zero
 * and any element sized in them collapses to a zero box -- which reads exactly
 * like a layout bug, in a suite whose whole job is telling real layout bugs
 * from imaginary ones.
 */
const BROWSER_ENV = process.env.CHROMIUM_ENV ?? "/workspace/.micromamba/envs/browser";

function withBrowserLibs() {
  const libs = `${BROWSER_ENV}/lib`;
  if (!process.env.LD_LIBRARY_PATH?.includes(libs)) {
    process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  process.env.FONTCONFIG_PATH ??= `${BROWSER_ENV}/etc/fonts`;
}

export async function launchBrowser() {
  withBrowserLibs();
  try {
    return await chromium.launch({ args: ["--no-sandbox"] });
  } catch (cause) {
    throw new Error(
      "Could not launch Chromium. It needs system libraries and fonts this image " +
        "lacks; install them into a micromamba env and point CHROMIUM_ENV at it " +
        "(see README, 'Testing'). Skipping these silently is not an option here -- " +
        "every bug they cover was invisible without a browser.",
      { cause },
    );
  }
}

/** The dev harness, on an ephemeral port so it never collides with a running server. */
export async function startHarness() {
  const server = await createServer({
    configFile: resolve(packageRoot, "vite.dev.config.js"),
    root: resolve(packageRoot, "dev"),
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const { port } = server.httpServer.address();
  return { server, url: (query = "") => `http://127.0.0.1:${port}/bubble.html${query}` };
}

/**
 * Reaches into the widget wherever it is mounted: the host tree at
 * mount="inline", or the overlay's shadow root. The root being open is what
 * makes this possible -- a plain querySelector does not descend into either,
 * so you have to ask for .shadowRoot deliberately.
 */
export async function preparePage(page) {
  await page.addInitScript(() => {
    window.__find = (selector) => {
      const roots = [document, ...[...document.querySelectorAll("[data-interpreter-overlay]")].map((h) => h.shadowRoot)];
      for (const root of roots) {
        const el = root?.querySelector(selector);
        if (el) return el;
      }
      return null;
    };
    // Top-layer churn. Two things re-raising each other show up as thousands.
    window.__toggles = 0;
    document.addEventListener("toggle", () => window.__toggles++, true);
  });
}

export const clickTab = (page, label) =>
  page.evaluate((l) => window.__find(`.interpreter-widget button[aria-label="${l}"]`).click(), label);

export const panelHeight = (page) =>
  page.evaluate(() => window.__find(".interpreter-widget > div")?.offsetHeight ?? null);

/**
 * Samples the animated container and the measured wrapper every frame across a
 * transition. The whole point is that these are questions a screenshot cannot
 * answer: a 350ms overshoot is invisible in a still, and every bug this suite
 * covers looked fine in one.
 */
export async function recordTransition(page, trigger, ms = 1000) {
  await page.evaluate(() => {
    window.__samples = [];
    window.__sampling = true;
    const tick = () => {
      const outer = window.__find(".interpreter-widget > div");
      const inner = outer?.firstElementChild;
      if (outer && inner) {
        window.__samples.push({
          outer: outer.offsetHeight,
          inner: inner.offsetHeight,
          innerWidth: inner.offsetWidth,
          // The tab strip is absolute and contributes no height. Two entries
          // mean a transition is in flight: outgoing pane and incoming one.
          panes: [...inner.children].filter((c) => !c.className.includes("absolute")).map((p) => p.offsetHeight),
        });
      }
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await trigger();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });
}

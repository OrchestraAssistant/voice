/**
 * A Chrome-shaped browser the developer already has, driven over CDP -- either
 * one already RUNNING that exposes CDP (connect to it), or a binary on disk
 * (launch it). Connecting is preferred: it needs no local binary and no system
 * libraries, because owning a browser process is not the probe's job -- using
 * one that exists is.
 *
 * puppeteer-core rather than puppeteer or playwright because it bundles no
 * browser: 12MB against 262MB for a downloaded Chromium. See find.js for why
 * borrowing beats shipping.
 *
 * An OPTIONAL dependency, imported only when this driver is actually used, so
 * `npx @expert/voice-cli` costs nothing for anyone who never runs a browser
 * stage. `available()` is what a caller asks first, and it answers with a
 * reason rather than throwing -- a machine without a browser is a normal
 * machine, and CI is usually one.
 */
import { INVENTORY_SCRIPT } from "./contract.js";
import { findBrowser } from "./find.js";

async function loadPuppeteer() {
  try {
    return (await import("puppeteer-core")).default;
  } catch {
    return null;
  }
}

export function chromeDriver({ headless = true, viewport = { width: 1280, height: 900 } } = {}) {
  let browser = null;
  let connected = false; // to an existing browser, so we detach rather than kill it

  // A browser the environment ALREADY runs, reachable over CDP -- Chrome's
  // normal automation API. `VOICE_BROWSER_ENDPOINT` is either an http(s) URL of
  // a browser started with --remote-debugging-port (puppeteer discovers the ws
  // from it) or a ws:// endpoint directly. Preferred over launching one:
  // connecting needs no local binary, no system libraries, no process to own.
  const endpoint = process.env.VOICE_BROWSER_ENDPOINT || null;
  const connectOpts = endpoint
    ? endpoint.startsWith("ws") ? { browserWSEndpoint: endpoint } : { browserURL: endpoint }
    : null;

  return {
    name: "chrome",

    async available() {
      if (!(await loadPuppeteer())) {
        return { ok: false, why: "puppeteer-core is not installed (npm i -D puppeteer-core)" };
      }
      // Connect mode: an endpoint is enough; no binary needs to be present.
      if (connectOpts) return { ok: true, using: endpoint, how: "connected to an existing browser over CDP" };
      const found = findBrowser();
      if (!found) {
        return {
          ok: false,
          why: "no browser available; point VOICE_BROWSER_ENDPOINT at a running Chrome (--remote-debugging-port) or VOICE_BROWSER at a binary to launch",
        };
      }
      return { ok: true, using: found.path, how: found.how };
    },

    async open(url, { cookies = [], headers = {}, settleMs = 0 } = {}) {
      const puppeteer = await loadPuppeteer();
      if (!browser) {
        if (connectOpts) {
          // Attach to what is already there; do not launch or own it.
          browser = await puppeteer.connect(connectOpts);
          connected = true;
        } else {
          const found = findBrowser();
          browser = await puppeteer.launch({
            executablePath: found.path,
            headless,
            // A clean profile, never the developer's. Their cookies and sessions
            // are not ours to borrow; the probe has --login for auth.
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          });
        }
      }
      const page = await browser.newPage();
      await page.setViewport(viewport);
      // The same headers the HTTP probe sent, so an app fronted by a reverse
      // proxy (x-forwarded-proto / x-forwarded-host) sees the browser the way
      // it sees every other request and does not bounce it to a login page for
      // arriving "insecure".
      if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
      if (cookies.length) await page.setCookie(...cookies);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (settleMs) await new Promise((r) => setTimeout(r, settleMs));

      return {
        async inventory() {
          try {
            return await page.evaluate(INVENTORY_SCRIPT);
          } catch (err) {
            // "Execution context was destroyed" means the page navigated out
            // from under us, which is a thing pages do: cal.diy bounces an
            // unauthenticated visitor to its login page part-way through a
            // sample. A sample that lands mid-navigation has nothing to
            // report, and that is different from the browser having broken.
            if (/context was destroyed|Target closed|detached/i.test(err.message)) return [];
            throw err;
          }
        },
        url() {
          return page.url();
        },
        async close() {
          await page.close();
        },
      };
    },

    async close() {
      // A browser we connected to is not ours to close -- detach and leave it
      // running. One we launched, we shut down.
      if (browser) await (connected ? browser.disconnect() : browser.close());
      browser = null;
      connected = false;
    },
  };
}

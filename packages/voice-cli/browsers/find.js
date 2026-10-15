/**
 * The browser the developer already has.
 *
 * Chrome-specific by nature, so it lives beside the Chrome driver rather than
 * in core: another engine would find itself its own way.
 *
 * Shipping a browser was the alternative and it is a bad trade. Playwright's
 * Chromium is 262MB and Lightpanda's binary is 162MB, against 12MB for
 * puppeteer-core, which bundles nothing and drives whatever it is pointed at.
 * A web developer with no Chrome-shaped browser anywhere on the machine is a
 * rare animal, and the ones who have Playwright or Puppeteer already have a
 * browser in a cache we can simply look in.
 *
 * Order is preference: an explicit choice, then a real installed browser,
 * then whatever a testing tool downloaded earlier.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const INSTALLED = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

const ON_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave"];

/** Caches a testing tool fills, which is where a web developer's browser usually is. */
const CACHES = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  // XDG_CACHE_HOME before ~/.cache: on Linux the two are often different, and
  // this one is what actually holds the browser when it is set. Missing it
  // meant reporting "no browser" on a machine with one three directories away.
  process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, "ms-playwright"),
  process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, "puppeteer"),
  process.env.HOME && join(process.env.HOME, ".cache", "ms-playwright"),
  process.env.HOME && join(process.env.HOME, "Library", "Caches", "ms-playwright"),
  process.env.HOME && join(process.env.HOME, ".cache", "puppeteer"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
].filter(Boolean);

const EXECUTABLES = new Set(["chrome", "chrome-headless-shell", "headless_shell", "chrome.exe"]);

/** A bounded walk: these caches are a handful of directories, not a filesystem. */
function search(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // unreadable is the same as absent here
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && EXECUTABLES.has(entry.name)) return full;
    if (entry.isDirectory()) {
      const found = search(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function findBrowser({ env = process.env, platform = process.platform } = {}) {
  if (env.VOICE_BROWSER) {
    // An explicit choice is honoured even if it does not exist, so a typo
    // reports the path the person typed rather than silently finding
    // something else and probing with it.
    return { path: env.VOICE_BROWSER, how: "VOICE_BROWSER" };
  }
  for (const path of INSTALLED[platform] ?? []) {
    if (existsSync(path)) return { path, how: "installed" };
  }
  for (const name of ON_PATH) {
    try {
      const path = execFileSync("command", ["-v", name], { stdio: ["ignore", "pipe", "ignore"], shell: true })
        .toString()
        .trim();
      if (path && existsSync(path)) return { path, how: "on PATH" };
    } catch {
      // not installed; try the next
    }
  }
  for (const cache of CACHES) {
    const found = search(cache);
    if (found) {
      try {
        statSync(found);
        return { path: found, how: "a browser your test tooling already downloaded" };
      } catch {
        // raced with a cleanup
      }
    }
  }
  return null;
}

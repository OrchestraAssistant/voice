#!/usr/bin/env node
/**
 * Asks the running app whether the manifest is true.
 *
 *   node probe.js .voice/manifest.json http://localhost:3000 [options]
 *
 *   --login <spec.json>   sign in first, so authenticated pages answer. In a
 *                         file, not an argument: credentials in a command end
 *                         up in shell history.
 *   --cookie "<header>"   send a session cookie you already have
 *   --header "K: V"       any other header, repeatable
 *   --writes              also probe write actions by omitting required fields
 *   --effects <file.json> verify writes truly change state, read back after the
 *                         fact. A fixture: per action, the natural call to make
 *                         and where to watch its result. Needs --writes.
 *   --browser [name]      use a real browser for stages that need one (default:
 *                         chrome, borrowed from whatever you already have)
 *   --fix                 write what was learned into manifest.overlay.json
 *   --only / --without    run a subset of the probe stages, comma-separated
 *
 * Not part of `npm test`: it needs a live app, it makes real requests, and
 * with --writes it makes real writes. Run it deliberately, against an instance
 * you can throw away.
 */
import fs from "node:fs";
import path from "node:path";

import { STAGES } from "./registry.js";
import { runProbes, selectStages } from "./core/run.js";
import { OVERLAY_FILE } from "./core/overlay.js";
import { cookieJar, pick, signedIn } from "./core/session.js";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
// Flags that take a value, so their value is not mistaken for a positional.
const VALUED = new Set(["--cookie", "--header", "--login", "--only", "--without", "--src", "--effects"]);
// --browser optionally takes a driver name. Optional-valued flags are a
// parsing trap: `--browser --fix` must not read `--fix` as the driver. So its
// value counts only when the next token is not itself a flag.
const KNOWN_DRIVERS = new Set(["chrome"]);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
/** Repeatable and comma-separated: --without page-copy,query-shapes */
const valued = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) out.push(...(argv[++i] ?? "").split(",").filter(Boolean));
  }
  return out;
};

const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++;
  else if (argv[i] === "--browser" && KNOWN_DRIVERS.has(argv[i + 1])) i++;
  else if (!argv[i].startsWith("--")) positional.push(argv[i]);
}
const [manifestPath, baseUrl] = positional;
if (!manifestPath || !baseUrl) {
  console.error("usage: probe.js <manifest.json> <baseUrl> [--login spec.json] [--cookie ...] [--header 'K: V'] [--writes] [--fix]");
  process.exit(1);
}

const headers = {};
if (flag("--cookie")) headers.Cookie = flag("--cookie");
// Repeatable, so each occurrence is read rather than only the first.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--header" || !argv[i + 1]) continue;
  const [key, ...rest] = argv[++i].split(":");
  headers[key.trim()] = rest.join(":").trim();
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const jar = cookieJar();
if (headers.Cookie) jar.absorb([headers.Cookie]);

const ask = async (method, url, body, form) => {
  try {
    const cookie = jar.header();
    const res = await fetch(new URL(url, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
    });
    // Every response can extend the session, not just the login one.
    jar.absorb(res.headers.getSetCookie?.() ?? []);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null; // an HTML page, which is normal for a route
    }
    return { status: res.status, body: parsed, text };
  } catch (err) {
    return { status: 0, error: err.message };
  }
};

/**
 * Requests are remembered for the length of a run.
 *
 * Reachability, page copy and query shapes all walk the same routes, and on a
 * development server every one of those is a route compile. Without this the
 * probe would ask for each page three times and pay for it three times.
 */
const seen = new Map();
const askOnce = (method, url, body) => {
  if (body || method !== "GET") return ask(method, url, body);
  const key = `${method} ${url}`;
  if (!seen.has(key)) seen.set(key, ask(method, url));
  return seen.get(key);
};

/**
 * Signs in before probing, if asked. Without a session most routes answer
 * with a redirect to a login page, which says only that the app has
 * authentication.
 */
async function signIn(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
  const before = jar.size();
  const fields = { ...(spec.post?.form ?? spec.post?.json ?? {}) };

  if (spec.csrf) {
    const { body } = await ask("GET", spec.csrf.url);
    const token = pick(body, spec.csrf.pick);
    if (!token) throw new Error(`no ${spec.csrf.pick} at ${spec.csrf.url}`);
    fields[spec.csrf.as ?? spec.csrf.pick] = token;
  }

  const { status } = spec.post.json
    ? await ask("POST", spec.post.url, fields)
    : await ask("POST", spec.post.url, undefined, fields);

  // A login endpoint answering 200 with an error in the body is the normal
  // way to fail, so the status proves nothing. A cookie that was not there
  // before proves it: a session IS a cookie.
  if (!signedIn(before, jar.size())) {
    throw new Error(`no session cookie came back (status ${status}). Credentials wrong, or the sequence does not match this app.`);
  }
}

async function main() {
  if (flag("--login")) {
    try {
      await signIn(flag("--login"));
      console.log(`Signed in; probing as a real user.\n`);
    } catch (err) {
      console.error(`Could not sign in: ${err.message}`);
      console.error(`Probing anonymously instead, which mostly measures the login page.\n`);
    }
  }
  const { stages, unknown } = selectStages(STAGES, {
    only: valued("--only"),
    without: valued("--without"),
  });
  for (const name of unknown) console.warn(`  no stage called "${name}"`);

  console.log(`Probing ${manifest.routes?.length ?? 0} routes and ${manifest.queries?.length ?? 0} queries against ${baseUrl}\n`);

  /**
   * A browser, only if asked for.
   *
   * Behind the driver contract rather than reached for directly, so the engine
   * stays swappable: `--browser chrome` today, something else later, and a
   * fake in the tests. The stage never learns which it got.
   *
   * Opt-in because starting a browser is not what someone expects from a
   * command that has, until now, made HTTP requests. And it is separate from
   * `available()`: a machine with no browser is a normal machine, and CI is
   * usually one, so the stage says so and carries on rather than failing.
   */
  const browserValue = (() => {
    const i = argv.indexOf("--browser");
    if (i === -1) return null;
    const next = argv[i + 1];
    return next && !next.startsWith("--") ? next : "chrome";
  })();
  const wanted = browserValue;
  let browser = null;
  if (wanted) {
    const { chromeDriver } = await import("./browsers/chrome.js");
    const drivers = { chrome: chromeDriver };
    if (!drivers[wanted]) {
      console.error(`No browser driver called "${wanted}". Known: ${Object.keys(drivers).join(", ")}`);
      process.exit(1);
    }
    browser = drivers[wanted]();
    const ready = await browser.available();
    console.log(ready.ok ? `Browser: ${ready.using} (${ready.how})\n` : `Browser unavailable: ${ready.why}\n`);
  }

  // The read-back fixture, if given. In a file for the same reason the login
  // spec is: it names real ids and payloads, which do not belong on a command line.
  let effects = null;
  if (flag("--effects")) {
    try {
      effects = JSON.parse(fs.readFileSync(flag("--effects"), "utf-8"));
    } catch (err) {
      console.error(`Could not read --effects fixture: ${err.message}`);
      process.exit(1);
    }
  }

  const { results, problems, corrections } = await runProbes(stages, {
    manifest,
    ask: askOnce,
    // The uncached fetcher, for a probe that must read the same URL twice and
    // see a real change between them (write-effects reads state before/after).
    askFresh: ask,
    allowWrites: has("--writes"),
    effects,
    browser,
    baseUrl,
    // Where the app's source lives, so the readiness stage can cross-check a
    // proposed marker against it: a testId written in one file is page
    // content, one written across many is shared chrome. Defaults to the
    // manifest's parent-of-.voice, which is the app root the CLI generated
    // from; --src overrides it.
    srcRoot: flag("--src") ?? path.dirname(path.dirname(path.resolve(manifestPath))),
    // The session the probe already established, so a browser stage sees the
    // app as a signed-in user rather than measuring the login page.
    // The base URL, but https, so a __Secure-/__Host- session cookie can be
    // set. Such a cookie may only be handed to CDP against an https origin --
    // yet its DOMAIN still has to match the host the browser navigates, which
    // is the base URL's. Swapping only the scheme keeps the host aligned
    // (localhost stays localhost) while satisfying the secure-context rule; a
    // proxy's external hostname would be secure but point at the wrong domain.
    cookies: jar.forBrowser(baseUrl.replace(/^http:/, "https:")),
    // The same forwarding headers the HTTP side used, so a proxied app treats
    // the browser like any other request rather than an insecure stranger.
    headers,
  });

  console.log("Stages:");
  for (const { detector, found, skipped, why, failed } of results) {
    const label = `  ${detector.padEnd(18)}`;
    if (failed) console.log(`${label} failed: ${failed}`);
    else if (skipped) console.log(`${label} skipped: ${why}`);
    else if ((found.notes ?? []).length) console.log(`${label} ${found.notes.join("; ")}`);
    else console.log(`${label} nothing found`);
  }

  if (problems.length) {
    console.log(`\n${problems.length} thing(s) the manifest is wrong about:`);
    for (const problem of problems) console.log(`  ${problem}`);
    console.log(`\n  Each of these is something the agent has been told exists. It will send`);
    console.log(`  someone there, confidently, and be wrong.`);
  }

  const learned = corrections;
  const found = learned.routes.length + learned.queries.length + learned.actions.length;
  if (found && has("--fix")) {
    const overlayPath = path.join(path.dirname(manifestPath), OVERLAY_FILE);
    const existing = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, "utf-8")) : {};
    const merged = { ...existing };

    // Every stage returns overlay-shaped patches, so the writer does not need
    // to know what any of them mean. Into the OVERLAY, never the generated
    // file: what a probe learned is a correction, it survives regeneration,
    // and a person reads the diff before it becomes prompt content.
    //
    // A probe never overwrites something the analyser already knows. The
    // overlay is applied last, so anything written here outranks every stage
    // -- which is right for a person's correction and wrong for a machine's.
    // Reading the source describes 53 of cal.diy's routes and reading the
    // served HTML describes 20, so letting the probe win by ordering would
    // have quietly replaced the better answer with the worse one.
    const deferred = [];
    for (const [kind, key] of [["routes", "path"], ["queries", "name"], ["actions", "name"]]) {
      for (const patch of learned[kind]) {
        const existing = (manifest[kind] ?? []).find((item) => item[key] === patch[key]);
        const clashes = Object.keys(patch).filter(
          (field) => field !== key && existing?.[field] !== undefined && existing[field] !== patch[field],
        );
        if (clashes.length) {
          deferred.push(`${kind} ${patch[key]}: ${clashes.join(", ")} already known, leaving it alone`);
          continue;
        }
        merged[kind] = upsertBy(merged[kind] ?? [], key, patch);
      }
    }
    if (deferred.length) {
      console.log(`\n${deferred.length} finding(s) the analyser already had:`);
      for (const line of deferred) console.log(`  ${line}`);
      console.log(`  Edit ${OVERLAY_FILE} by hand to override one deliberately.`);
    }

    fs.writeFileSync(overlayPath, JSON.stringify(merged, null, 2));
    console.log(`\nWrote ${found} correction(s) to ${overlayPath}`);
  } else if (found) {
    console.log(`\n${found} thing(s) learned. Re-run with --fix to write them into ${OVERLAY_FILE}.`);
  }

  process.exit(problems.length ? 1 : 0);
}

function upsertBy(list, key, patch) {
  const existing = list.find((i) => i[key] === patch[key]);
  if (existing) {
    Object.assign(existing, patch);
    return list;
  }
  return [...list, patch];
}

main();

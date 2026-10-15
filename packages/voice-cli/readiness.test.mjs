import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readiness } from "./stages/probe/readiness.js";
import { fakeBrowser } from "./browsers/fake.js";
import { validateDriver, validatePage } from "./browsers/contract.js";

const shellOf = (extra = []) => [
  { tag: "a", testId: "nav-event-types", label: "Event types" },
  { tag: "button", testId: "user-menu", label: "Pro Example" },
  ...extra,
];

const manifest = (paths) => ({ routes: paths.map((path) => ({ path })), queries: [], actions: [] });

describe("finding what to wait for", () => {
  test("the most page-specific stable element becomes the signal", async () => {
    // Whether it arrived late does not matter: a marker is a claim about a
    // page having its content, and content that renders at once satisfies it
    // at once. What picks Sunday-switch out of the shell is that it is on ONE
    // route, not that it was slow.
    const browser = fakeBrowser({
      pages: {
        "http://app/availability": { frames: [shellOf([{ tag: "button", testId: "Sunday-switch", label: "Sunday" }])] },
        "http://app/settings": { frames: [shellOf([{ tag: "button", testId: "save-profile", label: "Save" }])] },
      },
    });
    const out = await readiness.run({ manifest: manifest(["/availability", "/settings"]), browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0 });

    assert.deepEqual(
      out.corrections.routes.find((r) => r.path === "/availability"),
      { path: "/availability", readyWhen: { testId: "Sunday-switch" } },
    );
  });

  test("the shell is never the signal, because it is on every page", async () => {
    // Only visiting several routes can tell you which elements are furniture.
    // A sidebar link is present from the first frame everywhere, so it can
    // never mean "this page has finished".
    const late = [{ tag: "button", testId: "user-menu", label: "Pro Example" }];
    const browser = fakeBrowser({
      pages: {
        "http://app/a": { frames: [shellOf(), shellOf(), shellOf()] },
        "http://app/b": { frames: [shellOf(), shellOf(), shellOf(...[late])] },
      },
    });
    const out = await readiness.run({ manifest: manifest(["/a", "/b"]), browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0 });
    assert.deepEqual(out.corrections.routes, [], "it proposed a piece of the app's furniture");
  });

  test("a route with only shared chrome gets no signal", async () => {
    // The furniture appears everywhere and nothing else does, so there is
    // nothing page-specific to key on -- say so rather than pick a gear icon.
    const browser = fakeBrowser({
      pages: {
        "http://app/a": { frames: [shellOf([{ tag: "button", testId: "gear", label: "Settings" }])] },
        "http://app/b": { frames: [shellOf([{ tag: "button", testId: "gear", label: "Settings" }])] },
        "http://app/c": { frames: [shellOf([{ tag: "button", testId: "gear", label: "Settings" }])] },
      },
    });
    const out = await readiness.run({ manifest: manifest(["/a", "/b", "/c"]), browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0 });
    assert.equal(out.corrections.routes.length, 0);
    assert.ok(out.notes.some((n) => /page-specific/.test(n)));
  });

  test("a parameterised route is never probed with an invented id", async () => {
    // Nothing links to an instance here, so there is no real value to use and
    // guessing one only proves the app has a 404 page.
    const browser = fakeBrowser({ pages: { "*": { frames: [shellOf()] } } });
    const out = await readiness.run({
      manifest: manifest(["/availability/:schedule", "/event-types/[type]"]),
      browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0,
    });
    assert.deepEqual(browser.opened, [], "it made up an id and probed a 404");
    assert.ok(out.notes.some((n) => /nothing links to an instance/.test(n)));
  });

  test("a link on a list page is what makes its detail page measurable", async () => {
    // The app knows where its own instances are: cal.diy's availability list
    // renders /availability/${schedule.id} for each row. Following that beats
    // guessing which query holds the ids, and beats asking a person to write
    // sample values into the overlay for every parameterised route.
    const listing = [
      ...shellOf(),
      { tag: "a", testId: "schedule-row", label: "Weekend Warrior", href: "/availability/50" },
    ];
    const editor = [...shellOf(), { tag: "button", testId: "Sunday-switch", label: "Sunday" }];
    const browser = fakeBrowser({
      pages: {
        "http://app/availability": { frames: [listing] },
        "http://app/event-types": { frames: [shellOf()] },
        "http://app/availability/50": { frames: [shellOf(), shellOf(), editor] },
      },
    });
    const out = await readiness.run({
      manifest: manifest(["/availability", "/event-types", "/availability/:schedule"]),
      browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0,
    });

    assert.ok(browser.opened.includes("http://app/availability/50"), `never followed the link: ${browser.opened}`);
    assert.deepEqual(
      out.corrections.routes.find((r) => r.path === "/availability/:schedule"),
      { path: "/availability/:schedule", readyWhen: { testId: "Sunday-switch" } },
    );
  });

  test("a catch-all does not swallow a route the app really has", async () => {
    // cal.diy has a literal /event-types AND a catch-all /:user for public
    // booking pages. Without this the catch-all claimed the real route as one
    // of its instances and measured the wrong page under the wrong name.
    const listing = [
      ...shellOf(),
      { tag: "a", label: "Event types", href: "/event-types" },
      { tag: "a", label: "Someone", href: "/pro-example" },
    ];
    const browser = fakeBrowser({
      pages: {
        "http://app/event-types": { frames: [listing] },
        "http://app/availability": { frames: [shellOf()] },
        "*": { frames: [shellOf()] },
      },
    });
    await readiness.run({
      manifest: manifest(["/event-types", "/availability", "/:user"]),
      browser, baseUrl: "http://app", srcRoot: null, samples: 6, everyMs: 0,
    });
    assert.ok(!browser.opened.includes("http://app/event-types?"), "");
    assert.ok(
      browser.opened.includes("http://app/pro-example"),
      `the catch-all should have taken the only path that is not a route of its own: ${browser.opened}`,
    );
  });

  test("no browser is a normal machine, not a failure", async () => {
    // CI usually has none. The stage says so and the run carries on.
    const out = await readiness.run({ manifest: manifest(["/a"]), browser: null, baseUrl: "http://app", samples: 6, everyMs: 0 });
    assert.equal(out.problems, undefined);
    assert.match(out.notes[0], /no browser/);

    const unavailable = fakeBrowser({ availability: { ok: false, why: "no Chrome-shaped browser found" } });
    const skipped = await readiness.run({ manifest: manifest(["/a"]), browser: unavailable, baseUrl: "http://app", samples: 6, everyMs: 0 });
    assert.match(skipped.notes[0], /skipped: no Chrome-shaped browser/);
  });

  test("a driver that does not meet the contract is rejected, not used", async () => {
    const out = await readiness.run({ manifest: manifest(["/a"]), browser: { name: "broken" }, baseUrl: "http://app", samples: 6, everyMs: 0 });
    assert.match(out.problems[0], /needs available\(\)/);
  });

  test("the contract is what both drivers are checked against", async () => {
    const { chromeDriver } = await import("./browsers/chrome.js");
    assert.deepEqual(validateDriver(chromeDriver()), []);
    assert.deepEqual(validateDriver(fakeBrowser()), []);
    const page = await fakeBrowser({ pages: { "*": { frames: [[]] } } }).open("http://app/x");
    assert.deepEqual(validatePage(page), []);
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a templated marker is stored as its shape, not the measured value", async () => {
  // The probe can only see Sunday-switch; the source has ${weekday}-switch.
  // Storing the literal would break the day the app renders in another
  // language. With the template in source, the stored marker is *-switch.
  const dir = mkdtempSync(join(tmpdir(), "src-"));
  writeFileSync(join(dir, "Schedule.tsx"), "data-testid={`${weekday}-switch`}\n");
  const browser = fakeBrowser({
    pages: {
      "http://app/availability": { frames: [shellOf([{ tag: "button", testId: "Sunday-switch", label: "Sunday" }])] },
      "http://app/other": { frames: [shellOf([{ tag: "button", testId: "save", label: "Save" }])] },
    },
  });
  const out = await readiness.run({
    manifest: manifest(["/availability", "/other"]),
    browser, baseUrl: "http://app", srcRoot: dir, samples: 6, everyMs: 0,
  });
  rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(
    out.corrections.routes.find((r) => r.path === "/availability"),
    { path: "/availability", readyWhen: { testId: "*-switch" } },
    "stored the locale-bound literal instead of the shape",
  );
});

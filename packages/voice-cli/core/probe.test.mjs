import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describeShape, isProbeableRoute, omissionProbes, readOmission, readOnlyPlan, readRoute } from "./probe.js";

describe("what to ask", () => {
  test("a route with a parameter is skipped, with the reason", () => {
    // Visiting /tasks/:id means inventing an id, and an invented id gives a
    // 404 that says nothing about whether the manifest is right.
    assert.equal(isProbeableRoute({ path: "/settings" }), true);
    for (const path of ["/tasks/:id", "/api/x/{id}", "/docs/*"]) {
      assert.equal(isProbeableRoute({ path }), false, `${path} was treated as probeable`);
    }
    const plan = readOnlyPlan({ routes: [{ path: "/tasks/:id" }] });
    assert.match(plan[0].skipped, /parameter/);
  });

  test("writes are never probed by default", () => {
    // Probing a write means performing one. That is the caller's decision to
    // make explicitly, not something a verification tool does on its own.
    const plan = readOnlyPlan({ routes: [], queries: [], actions: [{ name: "deleteTask", method: "DELETE" }] });
    assert.deepEqual(plan, []);
  });

  test("a query needing a url parameter is skipped rather than guessed at", () => {
    const plan = readOnlyPlan({
      queries: [{ name: "task", endpoint: "/api/tasks/{id}", params: [{ name: "id", required: true, source: "url" }] }],
    });
    assert.match(plan[0].skipped, /needs id/);
  });

  test("an unfilled {param} in the endpoint is skipped even if its param is MISLABELLED", () => {
    // scratch-7f3's bug: a hand-written (or newly-produced) manifest tagged the
    // path param `source: "path"` instead of "url", so the source-only filter
    // missed it and the planner fetched "/api/tasks/{id}" literally -- a 404 on
    // the braces, reported as a missing endpoint. The endpoint is the authority:
    // a brace still in it can never be fetched, whatever the param was tagged.
    const plan = readOnlyPlan({
      queries: [{ name: "task", endpoint: "/api/tasks/{id}", params: [{ name: "id", required: true, source: "path" }] }],
    });
    assert.ok(plan[0].skipped, "a template with braces was planned as a real fetch");
    assert.match(plan[0].skipped, /needs id/);
  });

  test("a query with no params and a clean endpoint is fetched", () => {
    const plan = readOnlyPlan({ queries: [{ name: "me", endpoint: "/api/me", params: [] }] });
    assert.equal(plan[0].skipped, undefined);
    assert.equal(plan[0].url, "/api/me");
  });
});

describe("reading the answer", () => {
  test("a missing page is the finding that matters", () => {
    // The agent has been told this page exists. It will send someone there,
    // confidently, and be wrong.
    assert.equal(readRoute(404).ok, false);
    assert.match(readRoute(404).why, /not there/);
    assert.equal(readRoute(500).ok, false);
  });

  test("authentication and redirects are not failures", () => {
    // Plenty of real routes bounce to a canonical path or to a login page.
    // Following that would only prove the app has authentication.
    assert.equal(readRoute(302).ok, true);
    assert.equal(readRoute(401).ok, true);
    assert.match(readRoute(401).note, /behind authentication/);
  });
});

describe("what a query returns", () => {
  test("the manifest cannot say this, and one call can", () => {
    // Today the model infers the shape from the tool name. Naming the fields
    // costs a dozen tokens and removes the guess.
    const shape = describeShape([{ id: 1, title: "Yoga", done: false }]);
    assert.equal(shape.kind, "array");
    assert.deepEqual(shape.of, ["id", "title", "done"]);
  });

  test("one envelope is unwrapped, because every API has one", () => {
    assert.deepEqual(describeShape({ data: [{ id: 1, name: "x" }] }).of, ["id", "name"]);
    assert.deepEqual(describeShape({ results: { a: 1, b: 2 } }).fields, ["a", "b"]);
  });

  test("it stays shallow on purpose", () => {
    // A full JSON Schema of a booking would cost more than every other entry
    // in the manifest combined.
    const shape = describeShape({ id: 1, owner: { name: "x", email: "y" } });
    assert.deepEqual(shape.fields, ["id", "owner"]);
  });

  test("nothing at all is nothing, not an empty object", () => {
    assert.equal(describeShape(null), null);
    assert.equal(describeShape(undefined), null);
  });
});

describe("which fields the server actually requires", () => {
  const action = {
    name: "createTask",
    bodyFields: [
      { name: "title", required: true, type: "string" },
      { name: "priority", required: true, type: "enum", enumValues: ["low", "high"] },
      { name: "done", required: false, type: "boolean" },
    ],
  };

  test("one request per required field, each missing exactly that one", () => {
    const probes = omissionProbes(action);
    assert.deepEqual(probes.map((p) => p.omitted), ["title", "priority"]);
    assert.deepEqual(probes[0].body, { priority: "low", done: false });
  });

  test("the other fields carry values of the right type", () => {
    // So a rejection is about the missing field and not about a bad shape.
    const [first] = omissionProbes(action);
    assert.equal(typeof first.body.done, "boolean");
    assert.ok(action.bodyFields.find((f) => f.name === "priority").enumValues.includes(first.body.priority));
  });

  test("an action with nothing required is not probed at all", () => {
    assert.deepEqual(omissionProbes({ bodyFields: [{ name: "done", required: false }] }), []);
  });

  test("a rejection confirms the field, acceptance disproves it", () => {
    // The declaration is a guess: Zod's .optional() and TypeScript's `?:` say
    // what the CLIENT believes, and the server decides.
    assert.deepEqual(readOmission("title", 400), { field: "title", required: true });
    assert.equal(readOmission("title", 201).required, false);
    assert.match(readOmission("title", 201).note, /accepted without it/);
  });

  test("a server error teaches nothing, and says so", () => {
    // A 500 might be the missing field or might be the app having a bad day.
    // Recording it as "required" would write a guess into the manifest.
    assert.equal(readOmission("title", 500).required, null);
    assert.match(readOmission("title", 500).note, /nothing learned/);
  });
});

import { describePages, harvestPage } from "./probe.js";

describe("harvesting what a page says about itself", () => {
  const page = (html) => harvestPage(html);

  test("a heading and the line under it beat anything we could invent", () => {
    // cal.diy's own words, written by someone who knew what the page was for.
    const html = `<html><head><title>Event Types | Cal.diy</title></head>
      <body><h1>Event types</h1><p class="text-subtle">Configure different events for people to book on your calendar.</p></body></html>`;
    const [described] = describePages([{ path: "/event-types", ...page(html) }]);
    assert.equal(described.description, "Event types. Configure different events for people to book on your calendar.");
  });

  test("the product name is found by what repeats, not by length", () => {
    // "Error | Cal.diy": picking the longer half chose "Cal.diy" over "Error",
    // so every page was described as the product. Only counting across pages
    // can tell which half is the name of the app.
    const pages = [
      { path: "/apps", ...page("<title>App store | Cal.diy</title>") },
      { path: "/settings/profile", ...page("<title>Your account | Cal.diy</title>") },
      { path: "/teams", ...page("<title>Teams | Cal.diy</title>") },
    ];
    const described = describePages(pages);
    assert.equal(described.find((d) => d.path === "/apps").description, "App store");
    assert.equal(described.find((d) => d.path === "/settings/profile").description, "Your account");
    // And "Teams" for /teams is dropped, because it restates the path.
    assert.ok(!described.some((d) => d.path === "/teams"));
  });

  test("a description that restates the path is dropped", () => {
    // "/availability" described as "Availability" costs tokens and says
    // nothing the model could not read off the route.
    const described = describePages([
      { path: "/availability", ...page("<title>Availability | Cal.diy</title>") },
      { path: "/apps", ...page("<title>App store | Cal.diy</title>") },
      { path: "/x", ...page("<title>Something | Cal.diy</title>") },
    ]);
    assert.ok(!described.some((d) => d.path === "/availability"));
    assert.ok(described.some((d) => d.path === "/apps"));
  });

  test("a title that is only the product name is dropped", () => {
    const described = describePages([
      { path: "/a", ...page("<title>Cal.diy</title>") },
      { path: "/b", ...page("<title>Teams | Cal.diy</title>") },
      { path: "/c", ...page("<title>Apps | Cal.diy</title>") },
    ]);
    assert.ok(!described.some((d) => d.path === "/a"));
  });

  test("markup and entities do not reach the prompt", () => {
    const [described] = describePages([
      { path: "/x", ...page(`<h1><span>Bookings</span></h1><p>Your <b>upcoming</b> &amp; past meetings.</p>`) },
    ]);
    assert.equal(described.description, "Bookings. Your upcoming & past meetings.");
  });

  test("a page with nothing to say is left alone", () => {
    // A client-rendered page serves a shell: the heading exists only after
    // hydration. Inventing something would be worse than saying nothing.
    assert.deepEqual(describePages([{ path: "/x", ...page("<html><body><div id=root></div></body></html>") }]), []);
    assert.equal(harvestPage(null), null);
  });
});

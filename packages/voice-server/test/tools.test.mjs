import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTools, buildInstructions, resolveModel, resolveLanguage, validateManifest, MODELS, LANGUAGES } from "../src/core/tools.js";

const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

describe("session options", () => {
  test("an unknown model is rejected, not quietly substituted", () => {
    // A browser asking for a model the account did not choose is a cost
    // decision made in the wrong place. Silent fallback hides it.
    assert.match(resolveModel("gpt-5-ultra", "gpt-realtime").error, /Unsupported model/);
    assert.equal(resolveModel("gpt-5-ultra", "gpt-realtime").model, undefined);
  });

  test("an allowed model passes through, and absent means default", () => {
    assert.equal(resolveModel("gpt-realtime-mini", "gpt-realtime").model, "gpt-realtime-mini");
    assert.equal(resolveModel(undefined, "gpt-realtime").model, "gpt-realtime");
    for (const m of MODELS) assert.equal(resolveModel(m.id, "gpt-realtime").model, m.id);
  });

  test("auto-detect is null, unknown codes are rejected", () => {
    assert.equal(resolveLanguage("auto").language, null);
    assert.equal(resolveLanguage(undefined).language, null);
    assert.match(resolveLanguage("xx").error, /Unsupported language/);
  });

  test("a chosen language is pinned in the instructions", () => {
    // The transcription hint alone does not stop the model answering in
    // another language -- one measured run replied in Vietnamese to English
    // audio -- so the reply language has to be stated in the prompt too.
    const es = buildInstructions(manifest, resolveLanguage("es").language);
    assert.match(es, /Speak and write in Spanish, always/);
    assert.doesNotMatch(buildInstructions(manifest, null), /Speak and write in/);
  });

  test("every offered language has a name to put in the prompt", () => {
    for (const l of LANGUAGES.filter((x) => x.code !== "auto")) {
      assert.ok(l.name, `${l.code} has no name`);
      assert.match(buildInstructions(manifest, l), new RegExp(`Speak and write in ${l.name}`));
    }
  });
});

describe("answer_aloud", () => {
  const tools = buildTools(manifest);
  const aloud = tools.find((t) => t.name === "answer_aloud");

  test("is offered, and asks for a reason", () => {
    // The reason is not decoration. A no-op tool with no payload is an odd
    // thing for a model to call; making it state why improves the odds it is
    // called deliberately, and gives one log line per decision to tune on.
    assert.ok(aloud, "answer_aloud is missing from the tool list");
    assert.deepEqual(aloud.parameters.required, ["because"]);
    assert.equal(aloud.parameters.properties.because.type, "string");
  });

  test("its description says when NOT to call it", () => {
    // Left to "call this when speech is warranted", the model finds a
    // justification every time -- measured at 6 spoken turns out of 6.
    assert.match(aloud.description, /same turn/i);
    assert.match(aloud.description, /do not|don't/i);
  });

  test("the session keeps the server's detector but not its response", () => {
    const mint = readFileSync(new URL("../src/core/mintHandler.js", import.meta.url), "utf8");
    assert.match(mint, /turn_detection: \{ type: "server_vad", create_response: false \}/);
  });
});

describe("the dispatcher and its catalog", () => {
  const tools = buildTools(manifest);
  const names = tools.map((t) => t.name);
  const catalog = buildInstructions(manifest);

  test("operations are reached by name, not as one typed tool each", () => {
    // 177 typed tools was ~15k tokens of prefix on every turn and rate-limited
    // a live session. The surface is now a handful of dispatchers whatever the
    // app's size.
    assert.ok(names.includes("run_query"));
    assert.ok(names.includes("run_action"));
    assert.ok(names.includes("expand"));
    assert.equal(names.filter((n) => n.startsWith("query_") || n.startsWith("action_")).length, 0);
    assert.ok(tools.length < 15, `tool surface is ${tools.length}, not a handful`);
  });

  test("open_url is an extension-only tool, absent for the in-page widget", () => {
    // The widget cannot point the address bar at an arbitrary URL, so offering
    // it open_url is offering a tool that can only fail.
    assert.equal(names.includes("open_url"), false, "the widget must not get open_url");
    const ext = buildTools(manifest, { surface: "extension" }).map((t) => t.name);
    assert.ok(ext.includes("open_url"), "the extension must get open_url");
  });

  test("the extension prompt steers links to open_url; the widget prompt has no such tool", () => {
    // A bare page (no manifest) is the extension's common case on the open web.
    const empty = { routes: [], queries: [], actions: [] };
    const extPrompt = buildInstructions(empty, null, { surface: "extension" });
    assert.match(extPrompt, /open_url/);
    assert.match(extPrompt, /href/);
    assert.doesNotMatch(buildInstructions(empty), /open_url/);
  });

  test("run_action takes a list; run_query does not", () => {
    const run = tools.find((t) => t.name === "run_action");
    assert.deepEqual(run.parameters.required, ["name", "items"]);
    assert.equal(run.parameters.properties.items.minItems, 1);
    const q = tools.find((t) => t.name === "run_query");
    assert.equal(q.parameters.properties.items, undefined, "a query is not a batch");
  });

  test("the catalog lists an operation's name, params and description", () => {
    // What was a typed schema per tool is now one line per tool in the prompt.
    assert.match(catalog, /createTask -- takes: title/);
    assert.match(catalog, /tasks -- takes: search\?/);
  });

  test("a destructive action is marked in the catalog", () => {
    assert.match(catalog, /deleteTask \[destructive\]/);
  });

  test("the rules point at run_query/run_action and expand, not the old tools", () => {
    assert.match(catalog, /go through run_query or run_action/);
    assert.match(catalog, /run_action AND dom_click and dom_type take a LIST/);
    assert.doesNotMatch(catalog, /query_\* and action_\*/);
  });
});

describe("destructive ordering", () => {
  test("the rule states the order, and names the failure", () => {
    // Observed live: the model asked "would you like to confirm?", the user
    // said yes, THEN it staged -- which asks again. The user confirmed twice.
    const rules = buildInstructions(manifest);
    assert.match(rules, /CALL THE TOOL FIRST/);
    assert.match(rules, /Do not ask before calling it/);
    assert.match(rules, /say yes twice/);
  });
});

describe("staleness", () => {
  const rules = buildInstructions(manifest);

  test("a query result expires at the end of its turn", () => {
    // Observed live: it read settings once, then answered questions 130 and
    // 160 seconds later from that snapshot. Both answers were wrong -- the
    // name had changed to "Steve Branson Jr" in between.
    assert.match(rules, /only true for the turn it arrived in/i);
    assert.match(rules, /Never answer from what a query told you earlier/i);
  });

  test("being challenged means re-checking, not repeating", () => {
    // The worst moment in that session: asked "You sure?", it re-asserted the
    // wrong name with an added "Yes" and no tool call. A wrong answer that
    // survives being questioned teaches the user not to question.
    assert.match(rules, /are you sure\?", "double check"/i);
    assert.match(rules, /re-run the query/i);
  });

  test("the batching rule cannot be read as licence to reuse an old result", () => {
    // Rule 8 says call a query ONCE rather than once per item. Read across
    // turns instead of within one, that argues for exactly the wrong thing,
    // so the staleness rule comes first.
    const staleness = rules.indexOf("only true for the turn it arrived in");
    const batching = rules.indexOf("call the query ONCE with no filter");
    assert.ok(staleness > 0 && batching > 0);
    assert.ok(staleness < batching, "the staleness rule must come before the batching one");
  });
});

describe("the rule list", () => {
  test("numbers run 1..n once each, in every language", () => {
    // The language rule carries its own hardcoded number, so it silently
    // collided with a rule in the main list the moment one was inserted --
    // it shipped as a second "7" for as long as there were six rules.
    for (const language of [undefined, { code: "es", name: "Spanish" }]) {
      const numbers = [...buildInstructions(manifest, language).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      assert.deepEqual(numbers, numbers.map((_, i) => i + 1), `numbering broke for ${language?.name ?? "auto"}`);
    }
  });
});

describe("hanging up", () => {
  const rules = buildInstructions(manifest);
  const endSession = buildTools(manifest).find((t) => t.name === "end_session");

  test("the tool exists and asks why", () => {
    // `because` carries the user's own words. Without it a hang-up in the log
    // is indistinguishable from a dropped connection.
    assert.ok(endSession);
    assert.deepEqual(endSession.parameters.required, ["because"]);
  });

  test("only the user ends the conversation", () => {
    // The terseness rules already push it toward wrapping up. Left vaguer than
    // this, "act, don't narrate" plus "never offer further help" reads a lot
    // like permission to hang up the moment a task succeeds.
    assert.match(endSession.description, /ONLY when the user/);
    assert.match(endSession.description, /Do NOT call it because you think the task is complete/);
    assert.match(rules, /Completing a task is not a dismissal, and neither is an error/);
  });

  test("the goodbye is part of the same turn", () => {
    assert.match(rules, /call end_session and say one short goodbye/);
  });
});

describe("the manifest comes from the app", () => {
  test("a missing one is refused, not defaulted", () => {
    // The bug this replaces: MANIFEST_PATH fell back to the demo app's file,
    // so a relay restarted without it served a task manager's manifest to a
    // calendar app. The agent then correctly explained the app had no
    // bookings page. A wrong-but-plausible default is the worst outcome
    // available, so there is no default any more.
    for (const bad of [undefined, null, "", 0, [], "not-an-object"]) {
      assert.ok(validateManifest(bad).error, `${JSON.stringify(bad)} was accepted as a manifest`);
    }
  });

  test("the three sections are optional but must be arrays if present", () => {
    assert.ok(validateManifest({ routes: {} }).error);
    assert.ok(validateManifest({ queries: "none" }).error);
    assert.match(validateManifest({ actions: 3 }).error, /manifest\.actions must be an array/);
  });

  test("missing sections normalise to empty, so downstream has one case", () => {
    const checked = validateManifest({ routes: [{ path: "/" }] });
    assert.equal(checked.error, undefined);
    assert.deepEqual(checked.manifest.queries, []);
    assert.deepEqual(checked.manifest.actions, []);
  });

  test("an empty manifest is legal, and says so", () => {
    // Legitimate: an app whose analysis found nothing still gets the DOM
    // tools. Almost never intended, though, so it is worth seeing in a log.
    const checked = validateManifest({});
    assert.equal(checked.error, undefined);
    assert.equal(checked.empty, true);
    assert.equal(validateManifest({ routes: [{ path: "/" }] }).empty, false);
  });

  test("no size limit", () => {
    // Deliberate. On a relay you host, the tokens are your own; on one we
    // host, the gate belongs at the door rather than in the payload's shape.
    const huge = { routes: Array.from({ length: 5000 }, (_, i) => ({ path: `/r${i}` })), queries: [], actions: [] };
    assert.equal(validateManifest(huge).error, undefined);
  });

  test("tools are still built from whatever arrives", () => {
    const checked = validateManifest(JSON.parse(JSON.stringify(manifest)));
    const names = buildTools(checked.manifest).map((t) => t.name);
    assert.ok(names.includes("run_query"), "the dispatcher is always present");
    assert.ok(names.includes("navigate"), "the generic fallbacks do not depend on the manifest");
    // The operations themselves live in the catalog now, not as typed tools.
    assert.match(buildInstructions(checked.manifest), /\btasks\b/);
  });
});

describe("what a query returns", () => {
  test("reaches the model when something has found it out", () => {
    // Static analysis cannot say this at all, so the model was inferring the
    // shape from the tool's name and whatever arrived at runtime. Probing the
    // running app answers it in one call, and a dozen tokens removes a guess.
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "tasks").returns = { kind: "array", of: ["id", "title", "done"] };
    assert.match(buildInstructions(probed), /tasks .*Returns a list; each item has: id, title, done\./);
  });

  test("an object shape reads differently from a list", () => {
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "settings").returns = { kind: "object", fields: ["name", "theme"] };
    assert.match(buildInstructions(probed), /settings .*Returns an object with: name, theme\./);
  });

  test("a manifest that has never been probed reads exactly as before", () => {
    // Most manifests will not have this. It has to be additive. Built from a
    // copy with the field removed rather than from the demo's own manifest,
    // which has since been probed and legitimately carries one.
    const unprobed = JSON.parse(JSON.stringify(manifest));
    unprobed.queries.forEach((q) => delete q.returns);
    assert.doesNotMatch(buildInstructions(unprobed), /Returns/);
  });

  test("a shape with no fields adds nothing rather than an empty sentence", () => {
    const probed = JSON.parse(JSON.stringify(manifest));
    probed.queries.find((q) => q.name === "tasks").returns = { kind: "object", fields: [] };
    const line = buildInstructions(probed).split("\n").find((l) => /^\s*tasks /.test(l));
    assert.doesNotMatch(line, /Returns/);
  });
});

describe("a flow is an action, reached through the dispatcher", () => {
  const withFlow = () => {
    const m = JSON.parse(JSON.stringify(manifest));
    m.actions.push({
      name: "createEventType",
      description: "Create a new event type",
      transport: "dom",
      params: [],
      bodyFields: [{ name: "title", required: true, type: "string" }, { name: "duration", type: "number" }],
      requiresConfirmation: false,
      steps: [{ click: "New" }, { type: "Title", from: "title" }],
    });
    return m;
  };
  const lineFor = (m, name) => buildInstructions(m).split("\n").find((l) => new RegExp(`^\\s*${name}\\b`).test(l));

  test("it appears as an ordinary action with its named fields", () => {
    // The model calls run_action({name:"createEventType", items:[{title}]}) and
    // never learns a dialog is involved. Its fields are in the catalog line.
    const line = lineFor(withFlow(), "createEventType");
    assert.match(line, /createEventType.*takes: title, duration\?/);
  });

  test("but the line says it happens on screen", () => {
    assert.match(lineFor(withFlow(), "createEventType"), /on screen/);
    assert.match(lineFor(withFlow(), "createEventType"), /stop partway/);
  });

  test("an HTTP action says nothing of the kind", () => {
    assert.doesNotMatch(lineFor(manifest, "createTask"), /on screen/);
  });

  test("steps are never shown to the model", () => {
    // They are execution detail; exposing them invites reasoning about clicks.
    // The flow's own steps must not surface. dom_snapshot legitimately appears
    // in the rules (the pointing rule), so check for the STEP content, not the
    // primitive's name.
    assert.doesNotMatch(buildInstructions(withFlow()), /"steps"|"click":|from: *"title"/);
    assert.doesNotMatch(lineFor(withFlow(), "createEventType"), /click|New/);
  });
});

describe("what the model is told about routes", () => {
  test("a description is used when there is one", () => {
    // Built the harvest, then found it never reached the model: the prompt
    // said "- /:user/:type/embed (embed)" and nothing else, so 53 harvested
    // sentences were inert.
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/event-types", component: "[type]", description: "Event types. Configure different events." };
    assert.match(buildInstructions(m), /- \/event-types -- Event types\. Configure different events\./);
  });

  test("the component name is only a fallback", () => {
    // It is frequently noise -- cal.diy's routes are called "[type]" and
    // "embed" -- while a description is the app's own sentence.
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/x", component: "Thing", description: "What this page is for." };
    const line = buildInstructions(m).split("\n").find((l) => l.startsWith("- /x"));
    assert.equal(line, "- /x -- What this page is for.");
    assert.ok(!line.includes("Thing"));
  });

  test("a route with neither reads as just its path", () => {
    const m = JSON.parse(JSON.stringify(manifest));
    m.routes[0] = { path: "/bare" };
    assert.ok(buildInstructions(m).includes("\n- /bare\n"));
  });

  test("call-site counts never reach the model", () => {
    // Diagnostic, for whoever writes the include list. In the prompt it would
    // be tokens spent on a number the model cannot use.
    const m = JSON.parse(JSON.stringify(manifest));
    m.queries[0].callSites = 7;
    const payload = JSON.stringify({ i: buildInstructions(m), t: buildTools(m) });
    assert.ok(!payload.includes("callSites"));
  });
});

describe("a page with no manifest gets the generic, DOM-first prompt", () => {
  const empty = { routes: [], queries: [], actions: [] };

  test("it does not claim to be an app or a task manager, and points at the DOM", () => {
    const p = buildInstructions(empty, null);
    assert.doesNotMatch(p, /task-management/, "asserts a task app onto an unknown page");
    assert.match(p, /must not assume/, "should tell the model not to assume what the site is");
    assert.match(p, /dom_snapshot/, "the DOM is the only truth for an unknown page");
  });

  test("the language directive still applies", () => {
    assert.match(buildInstructions(empty, LANGUAGES.find((l) => l.code === "es")), /Speak and write in/);
    assert.doesNotMatch(buildInstructions(empty, null), /Speak and write in/);
  });

  test("a manifest with operations still gets the app prompt", () => {
    const app = { routes: [{ path: "/x" }], queries: [{ name: "q" }], actions: [] };
    assert.match(buildInstructions(app, null), /operations are listed below/);
  });
});

describe("the app's identity comes from the manifest, not a constant", () => {
  test("the opening line uses manifest.description when present", () => {
    const app = { description: "a bakery storefront", routes: [{ path: "/x" }], queries: [{ name: "q" }], actions: [] };
    assert.match(buildInstructions(app, null), /embedded in a bakery storefront/);
  });
  test("it falls back to a neutral 'a web app' when there is no description", () => {
    const app = { routes: [{ path: "/x" }], queries: [{ name: "q" }], actions: [] };
    assert.match(buildInstructions(app, null), /embedded in a web app/);
    assert.doesNotMatch(buildInstructions(app, null), /task-management/);
  });

  // The regression: the mint path is validateManifest -> buildInstructions, and
  // validateManifest used to rebuild the manifest with only routes/queries/actions,
  // dropping `description` (the opening anchor) and `groups` (topic descriptions)
  // before the code that reads them. Every prompt then opened with "a web app".
  test("validateManifest preserves description and groups through to the prompt", () => {
    const app = {
      description: "Plane: an issue and project tracker",
      groups: [{ path: ["availability"], description: "when you are bookable" }],
      routes: [{ path: "/x" }],
      queries: [{ name: "q" }],
      actions: [],
    };
    const checked = validateManifest(app);
    assert.ok(!checked.error);
    assert.equal(checked.manifest.description, app.description, "description must survive validation");
    assert.deepEqual(checked.manifest.groups, app.groups, "groups must survive validation");
    // and it reaches the prompt, not the fallback -- the actual mint path
    assert.match(buildInstructions(checked.manifest, null), /embedded in Plane: an issue and project tracker/);
    assert.doesNotMatch(buildInstructions(checked.manifest, null), /embedded in a web app/);
  });
});

describe("delegation to the app's own agents", () => {
  const withAgent = {
    description: "Lines Studio: an animated slide deck builder",
    routes: [{ path: "/" }],
    queries: [],
    actions: [],
    agents: [
      {
        id: "deck",
        name: "Deck builder",
        description: "Builds and edits the animated slide deck. It does NOT navigate, present or download.",
        transport: "ui",
        ui: { input: "[data-chat-input]", send: "[data-chat-send]" },
      },
    ],
  };

  test("an `ask` tool is emitted, with the agent ids as its enum", () => {
    const tools = buildTools(withAgent);
    const ask = tools.find((t) => t.name === "ask");
    assert.ok(ask, "ask tool must be present when the manifest registers an agent");
    assert.deepEqual(ask.parameters.properties.agent.enum, ["deck"]);
    assert.deepEqual(ask.parameters.required.sort(), ["agent", "instruction"]);
  });

  test("no agents => no `ask` tool (the surface stays small)", () => {
    const tools = buildTools({ routes: [], queries: [], actions: [] });
    assert.ok(!tools.some((t) => t.name === "ask"), "ask must not appear without agents");
  });

  test("the instructions list the agent by id and description, and name ask()", () => {
    const prompt = buildInstructions(withAgent, null);
    assert.match(prompt, /ask\(\{ agent, instruction \}\)/);
    assert.match(prompt, /deck \(Deck builder\): Builds and edits/);
    assert.match(prompt, /does NOT navigate, present or download/);
  });

  test("agents survive validateManifest into the prompt (the mint path)", () => {
    const checked = validateManifest(withAgent);
    assert.deepEqual(checked.manifest.agents, withAgent.agents, "agents must not be stripped");
    assert.match(buildInstructions(checked.manifest, null), /Deck builder/);
  });
});

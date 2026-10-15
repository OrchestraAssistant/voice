import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decide, splitArgs } from "../src/providers/jevDecide.js";
import { parakeetJev } from "../src/providers/parakeetJev.js";
import { validateProvider } from "../src/providers/contract.js";

const settle = () => new Promise((r) => setTimeout(r, 5));

const CATALOG = [
  { name: "tasks", kind: "query", description: "list tasks", params: [] },
  { name: "deleteTask", kind: "action", description: "delete a task", destructive: true,
    params: [{ name: "id", type: "string", required: true }] },            // free-text required
  { name: "setTheme", kind: "action", description: "set the theme",
    bodyFields: [{ name: "theme", type: "enum", enumValues: ["light", "dark"], required: true }] }, // enum
  { name: "toggleNotifications", kind: "action", description: "turn notifications on/off",
    bodyFields: [{ name: "on", type: "boolean", required: true }] },        // boolean
];

/** A JEV stand-in: answers the routing/op choice and any arg questions from a script. */
function fakeEvaluate({ intent, op, args = {} }) {
  return async (_state, questions) => {
    const out = {};
    if (questions.intent) out.intent = { type: "choice", choice: intent };
    if (questions.op) out.op = { type: "choice", choice: op };
    for (const key of Object.keys(questions)) {
      if (!key.startsWith("arg_")) continue;
      const name = key.slice(4);
      out[key] = questions[key].type === "boolean"
        ? { type: "boolean", probability: args[name] ? 1 : 0 }
        : { type: "choice", choice: args[name] };
    }
    return out;
  };
}

describe("jevDecide — splitArgs (manifest-derived gate)", () => {
  test("enum and boolean are closed (JEV can fill); string/number need a text model", () => {
    assert.deepEqual(splitArgs(CATALOG[2]).closed.map((p) => p.name), ["theme"]); // enum
    assert.deepEqual(splitArgs(CATALOG[3]).closed.map((p) => p.name), ["on"]);    // boolean
    const del = splitArgs(CATALOG[1]);
    assert.deepEqual(del.closed, []);
    assert.deepEqual(del.requiredFree.map((p) => p.name), ["id"]);
  });
});

describe("jevDecide — decide()", () => {
  test("routes a dismissal", async () => {
    assert.deepEqual(await decide({ transcript: "that's all", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "dismiss" }) }), { kind: "dismiss" });
  });
  test("routes a question to a spoken answer", async () => {
    assert.deepEqual(await decide({ transcript: "how many?", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "question" }) }), { kind: "answer" });
  });
  test("op=none is nothing matched", async () => {
    assert.deepEqual(await decide({ transcript: "...", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "command", op: "none" }) }), { kind: "none" });
  });
  test("fills an enum arg from a choice", async () => {
    const d = await decide({ transcript: "dark mode", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "command", op: "setTheme", args: { theme: "dark" } }) });
    assert.deepEqual(d, { kind: "command", name: "setTheme", args: { theme: "dark" } });
  });
  test("fills a boolean arg from a noul", async () => {
    const d = await decide({ transcript: "turn on notifications", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "command", op: "toggleNotifications", args: { on: true } }) });
    assert.deepEqual(d, { kind: "command", name: "toggleNotifications", args: { on: true } });
  });
  test("a required free-text arg returns needsText (the footgun-closer)", async () => {
    const d = await decide({ transcript: "delete the groceries task", catalog: CATALOG, evaluate: fakeEvaluate({ intent: "command", op: "deleteTask" }) });
    assert.equal(d.kind, "command");
    assert.equal(d.name, "deleteTask");
    assert.equal(d.needsText, true);
    assert.deepEqual(d.missing, ["id"]);
  });
});

/** A Parakeet stand-in: captures the loop's callbacks, lets a test push a final transcript. */
function fakeStt() {
  let h = {};
  return {
    start: async (handlers) => { h = handlers; },
    stop() {}, setEnabled() {}, setTurnDetection() {}, beginTurn() {}, endTurn() {},
    attachMic: async () => ({}), releaseMic: async () => {}, hasMic: () => true,
    final: (t) => h.onFinal(t), // test hook -> returns the handleTurn promise
  };
}

describe("parakeetJev — the provider", () => {
  test("is a conforming provider; declares cascade capabilities", () => {
    const p = parakeetJev({ stt: fakeStt(), evaluate: async () => ({}), generateText: async () => "", tts: { speak() {}, cancel() {} } });
    assert.doesNotThrow(() => validateProvider(p));
    assert.equal(p.id, "parakeet-jev");
    assert.equal(p.capabilities.textInput, true);
    assert.equal(p.capabilities.warm, false);
    assert.equal(p.capabilities.bargeIn, true); // tts present
  });

  test("throws helpfully when a client is missing (BYOK/wiring)", async () => {
    const p = parakeetJev({ evaluate: async () => ({}) }); // no stt, no generateText
    await assert.rejects(() => p.connect({ toolCatalog: CATALOG, callbacks: {} }), /missing required clients/);
  });

  test("a closed-set command reaches onToolCall with the filled args", async () => {
    const stt = fakeStt();
    const calls = [];
    const session = await parakeetJev({
      stt,
      evaluate: fakeEvaluate({ intent: "command", op: "setTheme", args: { theme: "dark" } }),
      generateText: async () => { throw new Error("should not generate text for a closed-set command"); },
    }).connect({ toolCatalog: CATALOG, callbacks: { onToolCall: async (n, a) => { calls.push({ n, a }); return { ok: true }; } } });

    await stt.final("switch to dark mode");
    assert.deepEqual(calls, [{ n: "setTheme", a: { theme: "dark" } }]);
    assert.equal(typeof session.stop, "function");
  });

  test("a free-text command escalates to generateText, then calls onToolCall", async () => {
    const stt = fakeStt();
    const calls = [];
    let genPrompt = null;
    await parakeetJev({
      stt,
      evaluate: fakeEvaluate({ intent: "command", op: "deleteTask" }),
      generateText: async ({ prompt }) => { genPrompt = prompt; return '{"id":"groceries"}'; },
    }).connect({ toolCatalog: CATALOG, callbacks: { onToolCall: async (n, a) => { calls.push({ n, a }); return {}; } } });

    await stt.final("delete the groceries task");
    assert.match(genPrompt, /deleteTask/, "the text model was asked to fill the free-text arg");
    assert.deepEqual(calls, [{ n: "deleteTask", a: { id: "groceries" } }]);
  });

  test("a dismissal hangs up; a question speaks a generated reply", async () => {
    const stt = fakeStt();
    let hungUp = null, spoke = null;
    await parakeetJev({
      stt,
      evaluate: fakeEvaluate({ intent: "dismiss" }),
      generateText: async () => "x",
    }).connect({ toolCatalog: CATALOG, callbacks: { onHangUp: (i) => { hungUp = i; } } });
    await stt.final("that's all, thanks");
    assert.ok(hungUp, "a dismissal should hang up");

    const stt2 = fakeStt();
    await parakeetJev({
      stt: stt2,
      evaluate: fakeEvaluate({ intent: "question" }),
      generateText: async () => "Three tasks.",
      tts: { speak: (t) => { spoke = t; }, cancel() {} },
    }).connect({ toolCatalog: CATALOG, callbacks: {} });
    await stt2.final("how many tasks?");
    assert.equal(spoke, "Three tasks.", "a question is answered aloud via the text model + TTS");
  });

  test("the VoiceSession exposes the full control surface", async () => {
    const session = await parakeetJev({ stt: fakeStt(), evaluate: async () => ({}), generateText: async () => "" })
      .connect({ toolCatalog: CATALOG, callbacks: {} });
    for (const fn of ["stop", "sendTextTurn", "attachMic", "releaseMic", "hasMic",
      "setMicEnabled", "setTurnDetection", "clearInputBuffer", "commitAndRespond", "cancelResponse"]) {
      assert.equal(typeof session[fn], "function", `missing ${fn}`);
    }
  });
});

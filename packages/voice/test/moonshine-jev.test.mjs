import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { moonshineJev } from "../src/providers/moonshineJev.js";
import { moonshineStt, MOONSHINE_MODELS } from "../src/providers/moonshineStt.js";
import { validateProvider } from "../src/providers/contract.js";

const CATALOG = [
  { name: "setTheme", kind: "action", description: "set the theme",
    bodyFields: [{ name: "theme", type: "enum", enumValues: ["light", "dark"], required: true }] },
];

function fakeStt() {
  let h = {};
  return {
    start: async (handlers) => { h = handlers; },
    stop() {}, setEnabled() {}, setTurnDetection() {}, beginTurn() {}, endTurn() {},
    attachMic: async () => ({}), releaseMic: async () => {}, hasMic: () => true,
    final: (t) => h.onFinal(t),
  };
}
const fakeEvaluate = ({ intent, op, args = {} }) => async (_s, qs) => {
  const out = {};
  if (qs.intent) out.intent = { type: "choice", choice: intent };
  if (qs.op) out.op = { type: "choice", choice: op };
  for (const k of Object.keys(qs)) if (k.startsWith("arg_")) out[k] = { type: "choice", choice: args[k.slice(4)] };
  return out;
};

describe("moonshineJev — the browser-STT cascade preset", () => {
  test("is a conforming provider with the moonshine id", () => {
    const p = moonshineJev({ stt: fakeStt(), evaluate: async () => ({}), generateText: async () => "" });
    assert.doesNotThrow(() => validateProvider(p));
    assert.equal(p.id, "moonshine-jev");
    assert.equal(p.capabilities.textInput, true);
    assert.equal(p.capabilities.warm, false);
  });

  test("shares the cascade loop: a command reaches onToolCall", async () => {
    const stt = fakeStt();
    const calls = [];
    await moonshineJev({
      stt,
      evaluate: fakeEvaluate({ intent: "command", op: "setTheme", args: { theme: "dark" } }),
      generateText: async () => { throw new Error("no text model needed for an enum arg"); },
    }).connect({ toolCatalog: CATALOG, callbacks: { onToolCall: async (n, a) => { calls.push({ n, a }); return {}; } } });

    await stt.final("switch to dark mode");
    assert.deepEqual(calls, [{ n: "setTheme", a: { theme: "dark" } }]);
  });
});

describe("moonshineStt — the browser STT client", () => {
  test("exposes the STT interface the cascade drives", () => {
    const s = moonshineStt({ loadTransformers: async () => ({}) });
    for (const fn of ["start", "stop", "setEnabled", "setTurnDetection", "beginTurn", "endTurn", "attachMic", "releaseMic", "hasMic"]) {
      assert.equal(typeof s[fn], "function", `missing ${fn}`);
    }
    assert.equal(s.hasMic(), false);
  });

  test("start() fails helpfully without a transformers loader", async () => {
    const s = moonshineStt({}); // no loadTransformers
    await assert.rejects(() => s.start({ withMic: false }), /loadTransformers/);
  });
});

describe("moonshineStt — model selection (swappable)", () => {
  // capture the model id transformers.js is asked to load, without a browser
  const capture = () => {
    let got = null;
    const loadTransformers = async () => ({
      pipeline: async (_task, model) => { got = model; return async () => ({ text: "" }); },
    });
    return { loadTransformers, got: () => got };
  };

  test("defaults to the base model", async () => {
    const c = capture();
    await moonshineStt({ loadTransformers: c.loadTransformers }).start({ withMic: false });
    assert.equal(c.got(), MOONSHINE_MODELS.base);
  });

  test('size: "tiny" selects the tiny model', async () => {
    const c = capture();
    await moonshineStt({ size: "tiny", loadTransformers: c.loadTransformers }).start({ withMic: false });
    assert.equal(c.got(), MOONSHINE_MODELS.tiny);
  });

  test("an explicit model id overrides size", async () => {
    const c = capture();
    await moonshineStt({ size: "tiny", model: "custom/asr-ONNX", loadTransformers: c.loadTransformers }).start({ withMic: false });
    assert.equal(c.got(), "custom/asr-ONNX");
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toolCatalog, validateProvider, REALTIME_CAPABILITIES } from "../src/providers/contract.js";
import { openaiRealtime } from "../src/providers/openaiRealtime.js";
import { fakeTransport, mintedKey, toolCall } from "./fakeTransport.mjs";

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("toolCatalog (manifest -> neutral tool list)", () => {
  const cat = toolCatalog({
    queries: [{ name: "tasks", description: "list  tasks", params: [{ name: "q", type: "string", review: { kind: "x" } }] }],
    actions: [{ name: "deleteTask", requiresConfirmation: true, group: ["tasks"], confidence: "review",
      bodyFields: [{ name: "id", type: "string", dates: [["at"]] }] }],
  });

  test("projects queries and actions, tagged by kind", () => {
    assert.deepEqual(cat.map((o) => [o.name, o.kind]), [["tasks", "query"], ["deleteTask", "action"]]);
  });
  test("destructive comes from requiresConfirmation", () => {
    assert.equal(cat.find((o) => o.name === "tasks").destructive, false);
    assert.equal(cat.find((o) => o.name === "deleteTask").destructive, true);
  });
  test("carries group + confidence; strips build-time field metadata (review, dates)", () => {
    const del = cat.find((o) => o.name === "deleteTask");
    assert.deepEqual(del.group, ["tasks"]);
    assert.equal(del.confidence, "review");
    assert.equal(del.bodyFields[0].dates, undefined, "date-encoding metadata must not reach the model");
    assert.equal(cat[0].params[0].review, undefined, "review flags must not reach the model");
  });
});

describe("validateProvider", () => {
  test("accepts a conforming provider", () => {
    assert.doesNotThrow(() => validateProvider(openaiRealtime()));
  });
  test("rejects the factory passed uncalled", () => {
    assert.throws(() => validateProvider(openaiRealtime), /call it/);
  });
  test("rejects a provider with no connect", () => {
    assert.throws(() => validateProvider({ id: "x", capabilities: {} }), /connect/);
  });
});

describe("openaiRealtime — the reference provider", () => {
  test("is a conforming provider object", () => {
    const p = openaiRealtime({ relayUrl: "r" });
    assert.equal(p.id, "openai-realtime");
    assert.deepEqual(p.capabilities, REALTIME_CAPABILITIES);
    assert.equal(typeof p.connect, "function");
    assert.equal(typeof p.mint, "function");
  });

  test("connect() returns a VoiceSession and routes tool calls to onToolCall", async () => {
    const transport = fakeTransport();
    const calls = [];
    const ready = openaiRealtime().connect({
      manifest: { routes: [], queries: [], actions: [] },
      withMic: false,
      minted: mintedKey(), // valid key -> no relay round trip
      openTransport: () => transport,
      callbacks: {
        onToolCall: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
        onStatus() {}, onTranscript() {}, onActivity() {}, onHangUp() {},
      },
    });
    transport.open();
    const session = await ready;

    for (const fn of ["stop", "sendTextTurn", "attachMic", "releaseMic", "hasMic",
      "setMicEnabled", "setTurnDetection", "clearInputBuffer", "commitAndRespond", "cancelResponse"]) {
      assert.equal(typeof session[fn], "function", `VoiceSession is missing ${fn}`);
    }

    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("navigate", { path: "/x" }));
    await settle();
    assert.deepEqual(calls, [{ name: "navigate", args: { path: "/x" } }], "a model tool call must reach onToolCall");
  });
});

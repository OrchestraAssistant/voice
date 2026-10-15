import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jevBrokerHandler, openaiText } from "../src/jev.js";

const post = (path, body) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("jevBrokerHandler -- the cascade's server half", () => {
  test("/evaluate translates boolean->noul upstream and noul->boolean back", async () => {
    let sent = null;
    const fakeFetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          answers: {
            wantsIt: { type: "noul", noul: 0.9 },
            which: { type: "choice", choice: "dark", probabilities: { dark: 0.8, light: 0.2 } },
          },
        }),
        { status: 200 },
      );
    };
    const res = await jevBrokerHandler({ jevKey: "jev-test", fetchImpl: fakeFetch })(
      post("/voice/evaluate", {
        state: "the app shows a theme toggle",
        questions: {
          wantsIt: { type: "boolean", instructions: "does the user want it on?" },
          which: { type: "choice", instructions: "which theme?", criteria: { dark: "", light: "" } },
        },
      }),
    );
    assert.equal(res.status, 200);
    // upstream received JEV's wire shape: the boolean became a noul
    assert.equal(sent.questions.wantsIt.type, "noul");
    assert.equal(sent.questions.which.type, "choice");
    assert.equal(sent.model, "jev-latest");
    assert.match(sent.state, /theme toggle/);
    // response came back in our neutral shape
    const data = await res.json();
    assert.deepEqual(data.answers.wantsIt, { type: "boolean", probability: 0.9 });
    assert.equal(data.answers.which.choice, "dark");
    assert.deepEqual(data.answers.which.probabilities, { dark: 0.8, light: 0.2 });
  });

  test("/evaluate without a JEV key -> 500", async () => {
    delete process.env.JEV_API_KEY;
    const res = await jevBrokerHandler({ fetchImpl: async () => new Response("{}", { status: 200 }) })(
      post("/voice/evaluate", { questions: {} }),
    );
    assert.equal(res.status, 500);
  });

  test("/generate calls the configured text model", async () => {
    const res = await jevBrokerHandler({ generate: async ({ prompt }) => `echo:${prompt}` })(
      post("/voice/generate", { prompt: "delete the groceries task" }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "echo:delete the groceries task");
  });

  test("/generate with no text model wired -> 500", async () => {
    const res = await jevBrokerHandler({})(post("/voice/generate", { prompt: "hi" }));
    assert.equal(res.status, 500);
  });

  test("GET -> 404 (the broker is POST-only)", async () => {
    const res = await jevBrokerHandler({ jevKey: "k" })(new Request("http://x/voice/evaluate", { method: "GET" }));
    assert.equal(res.status, 404);
  });
});

describe("openaiText -- drop-in generate() for the broker", () => {
  test("calls chat completions and returns the message content", async () => {
    let called = null;
    const fakeFetch = async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"id":"groceries"}' } }] }), { status: 200 });
    };
    const generate = openaiText({ apiKey: "sk-x", fetchImpl: fakeFetch });
    const text = await generate({ prompt: "which id?" });
    assert.match(called.url, /chat\/completions/);
    assert.match(called.init.headers.Authorization, /Bearer sk-x/);
    assert.equal(text, '{"id":"groceries"}');
  });

  test("throws without a key", async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(() => openaiText({ apiKey: "" })({ prompt: "x" }), /OPENAI_API_KEY/);
  });
});

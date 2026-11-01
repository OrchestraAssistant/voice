import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { orchestra, orchestraService } from "../src/providers/orchestra/orchestra.js";

/**
 * The service, faked to its protocol: tokens from the app's route, the
 * manifest by hash, a turn that needs tools run on the page and then is done.
 */
function fakeService({ expireFirst = false, forgetManifest = false } = {}) {
  const seen = [];
  let tokens = 0;
  let manifests = 0;
  let forgotten = !forgetManifest;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === "/voice/token") {
      tokens++;
      return json({ token: `t${tokens}`, session: "ses_1", expiresAt: "x", url: "https://orchestra.test" });
    }
    const path = url.replace("https://orchestra.test", "");
    seen.push({ path, auth: init.headers?.authorization, body });
    if (expireFirst && init.headers?.authorization === "Bearer t1") return json({ code: "token" }, 401);
    if (path === "/v1/manifest") {
      manifests++;
      return json({ hash: "h1" });
    }
    if (path === "/v1/turn") {
      if (!forgotten) { forgotten = true; return json({ code: "manifest" }, 409); }
      if (!body.cont) return json({ needs: [{ id: "p:1", kind: "tool", args: { name: "run_query", args: { name: "tasks" } } }], cont: "sealed-1" });
      if (body.cont === "sealed-1") return json({ needs: [{ id: "p:2", kind: "steps", args: { steps: [{ name: "navigate", args: { path: "/tasks/3" } }] } }], cont: "sealed-2" });
      return json({ done: { say: null, then: ["hang_up"], turnId: "t_1", refresh: false }, state: "sealed-state" });
    }
    if (path === "/v1/keyterms") return json({ done: { keyterms: ["Buy groceries"], recordTerms: ["Buy groceries"] } });
    if (path === "/v1/log") return json({ ok: true });
    return json({ error: "no route" }, 404);
  };
  return { fetchImpl, seen, counts: () => ({ tokens, manifests }) };
}

/** A transcriber with no mic: the test says the turns. */
function fakeStt() {
  const s = { keyterms: null };
  return Object.assign(s, {
    start: async (h) => { s.handlers = h; },
    stop() {},
    setKeyterms(t) { s.keyterms = t; },
    takeUsage: () => ({ seconds: 1.5 }),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("the Orchestra provider", () => {
  test("a turn runs what the service asks for on the page, in order, then hangs up when told", async () => {
    const f = fakeService();
    const stt = fakeStt();
    const calls = [];
    const hungUp = [];
    const provider = orchestra({ fetchImpl: f.fetchImpl, stt, tts: null });
    assert.equal(provider.id, "orchestra");
    const session = await provider.connect({
      manifest: { routes: [{ path: "/" }] },
      callbacks: {
        onToolCall: async (name, args) => { calls.push([name, args]); return name === "dom_snapshot" ? { elements: [] } : name === "run_query" ? [{ id: 3, title: "Buy groceries" }] : { ok: true }; },
        onHangUp: (info) => hungUp.push(info),
      },
    });
    await stt.handlers.onFinal("show me the groceries task, then that's all");
    await tick();
    const turnCalls = calls.filter(([n]) => n !== "dom_snapshot");
    assert.deepEqual(turnCalls, [["run_query", { name: "tasks" }], ["navigate", { path: "/tasks/3" }]]);
    assert.equal(hungUp.length, 1);
    // The results went back with the sealed continuation, never opened.
    const turns = f.seen.filter((s) => s.path === "/v1/turn");
    assert.deepEqual(turns[1].body, { cont: "sealed-1", results: { "p:1": [{ id: 3, title: "Buy groceries" }] } });
    assert.equal(turns[0].body.manifest, "h1");
    assert.match(turns[0].body.turn.today, /^\d{4}-\d{2}-\d{2}$/);
    // Keyterms came from the service; the turn's timing went back, with seconds heard, no audio.
    assert.deepEqual(stt.keyterms, ["Buy groceries"]);
    const timing = f.seen.find((s) => s.path === "/v1/log" && s.body.type === "timing");
    assert.equal(timing.body.stt.seconds, 1.5);
    session.stop();
  });

  test("the page needs no setting: the service's address comes from the app's token route", async () => {
    const f = fakeService();
    const svc = orchestraService({ fetchImpl: f.fetchImpl });
    await svc.upload({ routes: [] });
    assert.equal(f.seen[0].path, "/v1/manifest");
    assert.equal(f.seen[0].auth, "Bearer t1");
  });

  test("a lapsed token is renewed, and a manifest the service lost is sent again, without the user noticing", async () => {
    const f = fakeService({ expireFirst: true, forgetManifest: true });
    const stt = fakeStt();
    const provider = orchestra({ fetchImpl: f.fetchImpl, stt, tts: null });
    await provider.connect({ manifest: { routes: [] }, callbacks: { onToolCall: async (n) => (n === "dom_snapshot" ? { elements: [] } : { ok: true }) } });
    await stt.handlers.onFinal("hello");
    await tick();
    assert.equal(f.counts().tokens, 2);
    assert.equal(f.counts().manifests, 2);
    assert.ok(f.seen.some((s) => s.path === "/v1/turn" && s.body.cont === "sealed-2"));
  });

  test("transcription and the voice go to the service with the session's token", async () => {
    const f = fakeService();
    const svc = orchestraService({ fetchImpl: f.fetchImpl });
    await svc.fetch("/voice/stt-token", { method: "POST", body: "{}" });
    svc.turnId = "t_9";
    await svc.fetch("/voice/speak", { method: "POST", body: JSON.stringify({ text: "Delete it?" }) });
    assert.deepEqual(f.seen.map((s) => [s.path, s.auth]), [["/v1/stt-token", "Bearer t1"], ["/v1/speak", "Bearer t1"]]);
    assert.deepEqual(f.seen[1].body, { text: "Delete it?", turnId: "t_9" });
  });

  test("a handed-off turn comes back as a task: run on the page while the user goes on, its line when they stop speaking", async () => {
    const seen = [];
    let release;
    const held = new Promise((r) => { release = r; });
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (url === "/voice/token") return json({ token: "t1", session: "ses_1", url: "https://orchestra.test" });
      const path = url.replace("https://orchestra.test", "");
      seen.push({ path, body });
      if (path === "/v1/manifest") return json({ hash: "h1" });
      if (path === "/v1/turn") {
        const first = seen.filter((s) => s.path === "/v1/turn").length === 1;
        return json({ done: { say: null, turnId: first ? "t_1" : "t_2", ...(first && { task: { id: "k_1", start: "sealed-start" } }) }, state: "sealed-state" });
      }
      if (path === "/v1/task") {
        if (!body.cont) { await held; return json({ needs: [{ id: "p:1", kind: "tool", args: { name: "navigate", args: { path: "/tasks" } } }], cont: "task-1" }); }
        return json({ done: { say: "April or August?", taskId: "k_1", turnId: "t_1", result: "sealed-result" } });
      }
      if (path === "/v1/keyterms") return json({ done: { keyterms: [], recordTerms: [] } });
      return json({ ok: true });
    };
    const stt = fakeStt();
    const spoken = [];
    const busy = [];
    const calls = [];
    const provider = orchestra({ fetchImpl, stt, tts: { speak: async (t) => { spoken.push(t); }, cancel() {} } });
    await provider.connect({
      manifest: { routes: [] },
      callbacks: { onToolCall: async (n, a) => { calls.push([n, a]); return n === "dom_snapshot" ? { elements: [] } : { ok: true }; }, onActivity: (a) => busy.push(a.agentBusy) },
    });
    await stt.handlers.onFinal("move the month tasks around");
    assert.equal(seen.find((s) => s.path === "/v1/turn").body.tasks, true);
    await tick();
    assert.ok(seen.some((s) => s.path === "/v1/task" && s.body.task === "sealed-start"));
    assert.equal(busy.at(-1), true); // working on it

    stt.handlers.onSpeechStart(); // the user is talking when the task's question is ready
    release();
    await tick();
    assert.ok(calls.some(([n, a]) => n === "navigate" && a.path === "/tasks"));
    assert.deepEqual(spoken, []);
    stt.handlers.onSpeechEnd();
    await tick();
    assert.deepEqual(spoken, ["April or August?"]);

    // The next turn carries what the task did, and says how many are running.
    await stt.handlers.onFinal("April");
    const second = seen.filter((s) => s.path === "/v1/turn")[1].body;
    assert.deepEqual(second.finished, ["sealed-result"]);
    assert.equal(second.turn.running, 0);
    await stt.handlers.onFinal("thanks");
    assert.equal(seen.filter((s) => s.path === "/v1/turn")[2].body.finished, undefined); // taken in, not sent again
  });
});

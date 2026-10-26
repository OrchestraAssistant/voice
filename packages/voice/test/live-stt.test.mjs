import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { liveStt, realtimeUrl } from "../src/providers/orchestra/liveStt.js";

const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** A fake ElevenLabs realtime socket: session_started on open, a transcript on commit. */
function fakeSocket({ text = "mark may as done", partial = "mark may", silent = false } = {}) {
  const sockets = [];
  class Socket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => this.emit({ message_type: "session_started", session_id: "s1" }), 1);
    }
    emit(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    send(raw) {
      const m = JSON.parse(raw);
      this.sent.push(m);
      if (m.commit) setTimeout(() => {
        this.emit({ message_type: "partial_transcript", text: partial });
        if (!silent) this.emit({ message_type: "committed_transcript", text });
      }, 1);
    }
    close() { this.onclose?.(); }
  }
  return { Socket, sockets };
}
const tokenFetch = (calls = []) => async (url, init) => {
  calls.push(url);
  if (url.endsWith("/voice/stt-token")) return reply({ token: `t${calls.length}`, url: "wss://fake/realtime" });
  if (url.endsWith("/voice/transcribe")) return reply({ text: "from the clip" });
  return reply({}, 404);
};
const frame = () => new Float32Array(4096).fill(0.1);

describe("liveStt -- words transcribed while they are said", () => {
  test("the URL asks for manual commits, PCM at our rate, and the keyterms", () => {
    const u = new URL(realtimeUrl({ token: "t", language: "en", keyterms: ["Q3 report", "Ada"] }));
    assert.equal(u.searchParams.get("commit_strategy"), "manual");
    assert.equal(u.searchParams.get("audio_format"), "pcm_16000");
    assert.equal(u.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.deepEqual(u.searchParams.getAll("keyterms"), ["Q3 report", "Ada"]);
  });

  test("keyterms within Scribe Realtime's limits: 50, each 20 characters, or the connection is refused", () => {
    const long = "Mark Write Q3 report as done";
    const u = new URL(realtimeUrl({ token: "t", keyterms: [long, ...Array.from({ length: 60 }, (_, i) => `t${i}`)] }));
    const got = u.searchParams.getAll("keyterms");
    assert.equal(got.length, 50);
    assert.ok(!got.includes(long));
  });

  test("frames stream as captured; the end of the turn commits and returns the text", async () => {
    const { Socket, sockets } = fakeSocket();
    const calls = [];
    const events = [];
    const stt = liveStt({ fetchImpl: tokenFetch(calls), WebSocketImpl: Socket, onEvent: (e) => events.push(e) });
    stt.feed(frame());
    stt.feed(frame());
    const text = await stt.transcribe(new Float32Array(8192));
    assert.equal(text, "mark may as done");
    const sent = sockets[0].sent;
    assert.equal(sent.length, 3);
    assert.deepEqual(sent.map((m) => m.commit), [false, false, true]);
    assert.equal(sent[0].message_type, "input_audio_chunk");
    assert.equal(sent[0].sample_rate, 16000);
    assert.equal(Buffer.from(sent[0].audio_base_64, "base64").length, 8192); // 16-bit PCM
    assert.equal(events[0].stt, "live");
    assert.ok(!calls.some((u) => u.endsWith("/transcribe")));
  });

  test("one connection serves many turns; changed keyterms open a new one between turns", async () => {
    const { Socket, sockets } = fakeSocket();
    const stt = liveStt({ fetchImpl: tokenFetch(), WebSocketImpl: Socket });
    stt.feed(frame());
    await stt.transcribe(new Float32Array(4096));
    stt.feed(frame());
    await stt.transcribe(new Float32Array(4096));
    assert.equal(sockets.length, 1);
    stt.setKeyterms(["Ada"]);
    assert.equal(sockets.length, 1); // opens after the token arrives
    stt.feed(frame());
    await stt.transcribe(new Float32Array(4096));
    assert.equal(sockets.length, 2);
    assert.deepEqual(new URL(sockets[1].url).searchParams.getAll("keyterms"), ["Ada"]);
  });

  test("no live transcriber on the server: the clip goes to /transcribe", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => (calls.push(url), url.endsWith("/stt-token") ? reply({ error: "none" }, 501) : tokenFetch()(url, init));
    const stt = liveStt({ fetchImpl, WebSocketImpl: fakeSocket().Socket });
    stt.feed(frame());
    assert.equal(await stt.transcribe(new Float32Array(4096)), "from the clip");
    stt.feed(frame());
    await stt.transcribe(new Float32Array(4096));
    assert.equal(calls.filter((u) => u.endsWith("/stt-token")).length, 1); // asked once
  });

  test("no committed transcript in time: the last partial, else the clip", async () => {
    const { Socket } = fakeSocket({ silent: true });
    const stt = liveStt({ fetchImpl: tokenFetch(), WebSocketImpl: Socket, commitTimeoutMs: 200 });
    stt.feed(frame());
    assert.equal(await stt.transcribe(new Float32Array(4096)), "mark may");
    const quiet = fakeSocket({ silent: true, partial: "" });
    const stt2 = liveStt({ fetchImpl: tokenFetch(), WebSocketImpl: quiet.Socket, commitTimeoutMs: 200 });
    stt2.feed(frame());
    assert.equal(await stt2.transcribe(new Float32Array(4096)), "from the clip");
  });
});

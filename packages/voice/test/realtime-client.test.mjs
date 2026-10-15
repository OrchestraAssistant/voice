import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideModality, defaultReplyModality, readyToHangUp, sessionUpdate } from "../src/realtimeClient.js";
import { fakeSession } from "./fakeTransport.mjs";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

/**
 * These cover a failure mode with no symptom at the call site. A malformed
 * event is answered with an async `error` on the data channel: nothing throws,
 * no promise rejects, and the patch is silently dropped. Two session.update
 * payloads shipped without `session.type` for exactly that reason, which meant
 * push-to-talk muted the mic but never switched server VAD off.
 */
describe("realtime client", () => {
  test("session.update carries session.type", () => {
    const patch = JSON.parse(sessionUpdate({ turn_detection: null }));
    assert.equal(patch.type, "session.update");
    assert.equal(patch.session.type, "realtime", "the API rejects the patch without this, without saying so");
    assert.deepEqual(patch.session.audio.input, { turn_detection: null });
  });

  test("both turn-detection states go through the same builder", () => {
    const off = JSON.parse(sessionUpdate({ turn_detection: null }));
    const on = JSON.parse(sessionUpdate({ turn_detection: { type: "server_vad" } }));
    assert.equal(off.session.type, "realtime");
    assert.equal(on.session.type, "realtime");
    assert.deepEqual(on.session.audio.input.turn_detection, { type: "server_vad" });
  });

  test("nothing builds a session.update by hand", () => {
    // One builder means one place for the field to go missing from. A literal
    // outside it is how this bug got in twice.
    const literals = source.match(/"session\.update"/g) ?? [];
    assert.equal(literals.length, 1, "session.update is constructed somewhere other than sessionUpdate()");
  });

  test("connect waits for the channel to open", () => {
    // Resolving after setRemoteDescription hands back a session whose every
    // method throws InvalidStateError until the channel opens.
    assert.match(source, /await opened;/);
  });
});

describe("reply modality", () => {
  test("commands get a written reply", () => {
    for (const turn of [
      "Go back to the dashboard.",
      "Create a task called buy milk.",
      "Mark buy milk as done.",
      "Open the new task page.",
      "Delete the second task",
    ]) {
      assert.equal(defaultReplyModality(turn), "text", `"${turn}" should not be answered aloud`);
    }
  });

  test("questions get a spoken reply", () => {
    for (const turn of [
      "How many tasks do I have?",
      "What is on my list",
      "Which task is overdue",
      "Tell me how many users there are",
      "Read me the first task",
      "Is the report done?",
    ]) {
      assert.equal(defaultReplyModality(turn), "audio", `"${turn}" asked for an answer`);
    }
  });

  test("an unknown turn is written, not spoken", () => {
    // Speech is the expensive default, so silence about the user's intent
    // should fall to the cheap side rather than the loud one.
    assert.equal(defaultReplyModality(""), "text");
    assert.equal(defaultReplyModality(undefined), "text");
  });
});

describe("who decides the modality", () => {
  test("answer_aloud wins over a command-shaped turn", () => {
    // The whole point of the flag: the model knows what it is about to say,
    // and "and the other one?" is hopeless to classify from phrasing.
    assert.equal(decideModality({ transcript: "And the other one.", aloudRequested: true }), "audio");
    assert.equal(decideModality({ transcript: "Mark it done.", aloudRequested: true }), "audio");
  });

  test("without the flag it falls back to the transcript", () => {
    assert.equal(decideModality({ transcript: "How many tasks do I have?", aloudRequested: false }), "audio");
    assert.equal(decideModality({ transcript: "Go to the dashboard.", aloudRequested: false }), "text");
  });

  test("neither signal means text", () => {
    // Speech is the expensive default; silence about intent falls to the cheap
    // side rather than the loud one.
    assert.equal(decideModality({ transcript: "", aloudRequested: false }), "text");
    assert.equal(decideModality({ transcript: undefined, aloudRequested: undefined }), "text");
  });

  test("every path that commits audio asks for a response", () => {
    // create_response: false means a turn nobody answers is silence, with no
    // error and no server retry, so this is a correctness property.
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");
    assert.match(source, /input_audio_buffer\.committed" && serverTurns[\s\S]{0,120}requestResponse\(\)/);
    assert.match(source, /commitAndRespond\(\)[\s\S]{0,200}requestResponse\(\)/);
    // A bare server_vad patch resets create_response to true and silently
    // hands generation back to the server.
    assert.doesNotMatch(source, /turn_detection: auto \? \{ type: "server_vad" \}/);
    assert.match(source, /server_vad", create_response: false/);
  });
});

describe("one response at a time", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

  test("a request while one is in flight is deferred, not fired", () => {
    // Asking twice is `conversation_already_has_active_response`, which arrives
    // as an async error and DROPS the request -- so the turn that prompted it
    // gets no answer in any medium. Observed live: a user talking over a long
    // sequence had turns silently ignored.
    assert.match(source, /if \(responseActive\) \{[\s\S]{0,200}responseQueued = true/);
  });

  test("the flag is set on send, not on the server's echo", () => {
    // Two requests can leave before the first response.created comes back.
    //
    // Asserted by position rather than by a fixed-width window: the window
    // was 500 characters and broke the moment anything was inserted between
    // the two lines, which says nothing about whether the ORDER is right.
    const fn = source.slice(source.indexOf("function requestResponse"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    const set = body.indexOf("responseActive = true;");
    const send = body.indexOf('type: "response.create"');
    assert.ok(set > 0 && send > 0, "requestResponse no longer looks like itself");
    assert.ok(set < send, "the flag is set after the send, so a racing request would not be deferred");
  });

  test("the queue is drained once, after tool calls have run", () => {
    // Draining at the top of response.done would race the tool-call path,
    // which ends in a request of its own -- two requests, same collision.
    assert.match(source, /if \(msg\.type === "response\.done"\) \{\s*\n\s*responseActive = false;/);
    assert.doesNotMatch(source, /responseActive = false;\s*\n\s*if \(responseQueued\)/);
  });
});

describe("batch execution", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("run_action takes items, with a fallback for a model that puts fields at the top level", () => {
    // The dispatcher passes {name, items}. If a model ignores the schema and
    // puts the change fields alongside name instead, treat everything-but-name
    // as a single-item list rather than dropping the call.
    assert.match(source, /Array\.isArray\(args\.items\) && args\.items\.length > 0/);
    assert.match(source, /const \{ name: _n, items: _i, \.\.\.rest \} = args/);
  });

  test("a destructive batch stages the whole set and is confirmed once", () => {
    assert.match(source, /setPendingAction\(\{ action, batch \}\)/);
    assert.match(source, /runBatch\(pending\.action, pending\.batch\)/);
    assert.match(source, /Ask the user once to confirm/);
  });

  test("a single-item batch is indistinguishable from before", () => {
    // The model should see exactly what it saw when batching did not exist.
    assert.match(source, /batch\.length === 1 \? results\[0\] :/);
  });

  test("writes run in order, not in parallel", () => {
    // A batch of creates that races itself lands in an order nobody asked for.
    assert.match(source, /for \(const one of batch\)[\s\S]{0,160}await runAction/);
  });
});


describe("staging a destructive batch", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("says it is staged rather than executed", () => {
    assert.match(source, /Staged, NOT executed/);
  });

  test("does not echo the batch back to the model", () => {
    // It just sent it. Repeating eleven objects costs tokens to say nothing.
    assert.doesNotMatch(source, /needs_confirmation[\s\S]{0,400}JSON\.stringify\(batch\)/);
  });
});

describe("a typed turn is a new turn", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

  test("sendTextTurn clears the spoken-reply flag", () => {
    // It reaches neither of the places that reset it for a spoken turn --
    // input_audio_buffer.committed or clearInputBuffer -- so an answer_aloud
    // from an earlier question would otherwise stick to every typed turn after.
    assert.match(source, /sendTextTurn\(text\) \{[\s\S]{0,600}aloudRequested = false;/);
  });

  test("every path that begins a turn resets it", () => {
    // Three turn starts -- input_audio_buffer.committed, clearInputBuffer for
    // push-to-talk, and sendTextTurn -- plus the declaration itself.
    const resets = source.match(/aloudRequested = false/g) ?? [];
    assert.equal(resets.length, 4, "a turn start is missing its reset");
  });
});

describe("hanging up", () => {
  const quiet = { because: "that's all for now", responseActive: false, audioPlaying: false };

  test("nothing happens without a request", () => {
    // The predicate runs on every audio-stopped event in the session, which is
    // most of them. A missing `because` is the normal case, not an edge one.
    assert.equal(readyToHangUp({ ...quiet, because: null }), false);
    assert.equal(readyToHangUp({ ...quiet, because: null, force: true }), false);
  });

  test("an empty reason still hangs up", () => {
    // The model is required to send `because`, so an empty string means it
    // sent something odd -- not that it changed its mind. Falsy-checking the
    // reason would silently ignore the call and leave the mic live.
    assert.equal(readyToHangUp({ ...quiet, because: "" }), true);
  });

  test("it waits for the goodbye to be generated", () => {
    // end_session arrives inside a response. The farewell is a SECOND response,
    // created after the tool result goes back, so acting where the call lands
    // means tearing the connection down before the goodbye is even written.
    assert.equal(readyToHangUp({ ...quiet, responseActive: true }), false);
  });

  test("it waits for the goodbye to finish being spoken", () => {
    // response.done fires while audio is still coming out of the speaker.
    // Without this the farewell is cut off mid-word, which is a worse ending
    // than no farewell at all.
    assert.equal(readyToHangUp({ ...quiet, audioPlaying: true }), false);
  });

  test("once the room is quiet, it goes", () => {
    assert.equal(readyToHangUp(quiet), true);
  });

  test("the timeout overrides the wait, and only the wait", () => {
    // If a response or an audio-buffer event never completes, waiting forever
    // leaves a live microphone after the user said they were done -- the one
    // outcome this feature must not produce.
    assert.equal(readyToHangUp({ ...quiet, responseActive: true, audioPlaying: true, force: true }), true);
  });
});

describe("hang-up wiring", () => {
  test("both ways a turn can go quiet reach the gate", () => {
    // Neither covers both media on its own: a spoken goodbye ends at
    // output_audio_buffer.stopped, a written one at response.done with no
    // audio ever starting. Wiring only the first loses every text hang-up.
    const calls = source.match(/maybeHangUp\(/g) ?? [];
    assert.ok(calls.length >= 4, `expected the gate to be armed and called from several places, saw ${calls.length}`);
    assert.match(source, /audioPlaying = false;\s*\n\s*reportActivity\(\);\s*\n\s*maybeHangUp\(\);/);
  });

  test("a hang-up that never completes still releases the microphone", () => {
    assert.match(source, /hangUpTimer = setTimeout\(\(\) => maybeHangUp\(\{ force: true \}\), 15_000\)/);
  });

  test("a spoken dismissal earns a spoken goodbye", () => {
    // Otherwise the farewell is decided by the transcript heuristic, and
    // "thanks, that's all" is command-shaped -- so someone who has already
    // looked away gets a silent goodbye they never see.
    assert.match(source, /if \(lastTurnWasSpoken\) aloudRequested = true;/);
    assert.match(source, /lastTurnWasSpoken = true;/);
    assert.match(source, /lastTurnWasSpoken = false;/);
  });

  test("releasing the mic is not closing the session", async () => {
    // The two are separate on purpose: prompt caching is session-scoped, so
    // closing is the expensive way to pause.
    // Behaviour, not text: releasing the microphone must leave the channel
    // usable, because prompt caching is session-scoped and closing is the
    // expensive way to pause.
    const { session, transport } = await fakeSession({ withMic: true });
    assert.equal(transport.hasMic(), true);
    await session.releaseMic();
    assert.equal(transport.hasMic(), false, "the microphone was not released");
    session.sendTextTurn("still here?");
    assert.ok(transport.ofType("response.create").length > 0, "the session died with the microphone");
  });
});

/**
 * The rim has to be lit for the WHOLE time the agent owns the turn, not just
 * while the model is generating.
 *
 * Observed live: a user watched the rim say "ready to listen" through every
 * tool call of a four-minute session and reported that working state never
 * appeared. `response.done` carrying a function call cleared the busy flag,
 * and nothing set it again until the server acknowledged the follow-up -- so
 * the interface invited them to speak at exactly the moment it was mid-job.
 */
describe("the agent is busy for the whole turn", () => {
  test("a response that asks for tools does not end the turn", () => {
    // response.done clears responseActive, but a response carrying a function
    // call has not finished anything -- the tool has not even started. Without
    // this hold the rim went idle for the whole tool phase.
    assert.match(source, /if \(\(msg\.response\?\.output \|\| \[\]\)\.some\(\(o\) => o\.type === "function_call"\)\) toolsRunning \+= 1;/);
    assert.match(source, /agentBusy: responseActive \|\| audioPlaying \|\| toolsRunning > 0/);
  });

  test("the hold is released only after the follow-up is requested", () => {
    // Releasing between the last tool and the next response.create leaves a
    // window with nothing active, and the rim calls that idle -- a blink the
    // 700ms crossfade would start animating through.
    const done = source.slice(source.indexOf("for (const call of calls) {"));
    const request = done.indexOf("requestResponse();");
    const release = done.indexOf("toolsRunning -= 1;");
    assert.ok(request > 0 && release > 0);
    assert.ok(request < release, "the turn is handed back before the follow-up exists");
  });

  test("and it is released even if the turn throws", () => {
    // dc.send on a closed channel throws. Without the finally the rim would
    // stay lit for the rest of the session with nothing behind it.
    assert.match(source, /\} finally \{[\s\S]{0,320}toolsRunning -= 1;/);
  });

  test("asking for a response reports immediately, not on the server's echo", () => {
    // `response.created` is a round trip away. The agent is working from the
    // moment we ask, and the rim used to say idle for that whole gap.
    const request = source.slice(source.indexOf("function requestResponse"), source.indexOf('type: "response_requested"'));
    assert.match(request, /responseActive = true;[\s\S]{0,220}reportActivity\(\);/);
  });
});

describe("what the log can now explain", () => {
  test("activity is recorded and reported, and only when it changes", async () => {
    // Two reasons, and the second is why this is a behaviour test now rather
    // than a look at the source. The log has to be able to say what the user
    // was being SHOWN while a tool ran, which is the one thing that explains
    // "nothing was happening" afterwards. And `onActivity` is React state in
    // the provider, handed a fresh object every call -- so reporting an
    // unchanged value re-renders the whole widget, rim included, for nothing.
    const seen = [];
    const { transport, events } = await fakeSession({ onActivity: (a) => seen.push(a) });
    await transport.play([
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      { type: "input_audio_buffer.speech_stopped" },
    ]);
    assert.deepEqual(
      seen.map((a) => `${a.userSpeaking}/${a.agentBusy}`),
      ["true/false", "false/false"],
      "an unchanged activity was reported again",
    );
    const recorded = events.filter((e) => e.type === "activity");
    assert.equal(recorded.length, 2, "an unchanged activity was recorded again");
  });

  test("a response records why it ended", () => {
    // Ten responses in one session reported zero input and zero output, which
    // no real generation can do. With no status, cancelled, failed and
    // incomplete were indistinguishable from a deliberate silence.
    assert.match(source, /status: msg\.response\?\.status/);
    assert.match(source, /statusDetails: msg\.response\?\.status_details/);
  });

  test("a tool call records how long it took", () => {
    // Recorded only on completion, a two-second tool looked like an instant
    // one, and a tool still running looked like a tool that never started.
    assert.match(source, /const startedAt = Date\.now\(\)/);
    assert.match(source, /ms: Date\.now\(\) - startedAt/);
  });
});

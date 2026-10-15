// Browser-side WebRTC connection to the OpenAI Realtime API. The server
// mints the ephemeral token (and owns the manifest-derived tool list +
// confirmation policy); this module only ever holds a short-lived key
// scoped to one session.

// mode: "continuous" (server VAD decides turn boundaries, mic always live),
// "ptt" (mic starts muted; caller unmutes while held, then commits + asks
// for a response on release), or "ptnt" ("push to not talk" -- the mirror
// image: mic starts live and VAD keeps driving turns, caller mutes only
// while held, e.g. to say something off to the side without being heard).
import { webrtcTransport } from "./webrtcTransport.js";

/**
 * Every session.update has to carry `session.type`, and getting it wrong fails
 * in the worst available way: the API answers with an async `error` event on
 * the data channel, so nothing throws, no promise rejects, and the patch is
 * simply ignored. Two of these were shipping without it, which meant
 * push-to-talk muted the microphone but never actually switched server VAD
 * off -- the mic went quiet while the model kept deciding turns for itself.
 *
 * One builder, so there is a single place for the field to be missing from.
 */
/**
 * Does the user's turn want an answer they can HEAR, or one they can read?
 *
 * The follow-up after a tool call is a response we ask for -- the model never
 * volunteers it -- so its medium is ours to choose, and choosing is worth
 * doing. Measured over six successful commands, those follow-ups were 56% of
 * the session cost and every one of them was spoken aloud to say things like
 * "Back to the dashboard", which the user could already see had happened.
 *
 * Text by default, audio when the user actually asked something. Prompting
 * cannot do this job: told plainly to stay silent on successful commands, the
 * model spoke on 6 of 6 anyway. Modality is config, and config is obeyed.
 *
 * The transcriber punctuates, so a spoken question usually arrives with a "?"
 * already attached; the rest is for the cases where it doesn't. Override with
 * the `replyModality` option if your app's phrasing differs.
 */
const WANTS_A_SPOKEN_ANSWER =
  /\?|^\s*(what|who|whose|when|where|why|how|which|list|read)\b|\b(tell|say|read|explain|describe)\s+(me|us|it|them|that)\b/i;

export function defaultReplyModality(transcript = "") {
  return WANTS_A_SPOKEN_ANSWER.test(transcript) ? "audio" : "text";
}

/**
 * Two deciders, each used where it is strongest, and the union of them.
 *
 * `aloudRequested` is the model's own answer_aloud call, and it is the better
 * signal by some distance: the model knows what it is ABOUT to say, while the
 * transcript only hints at what was asked. "And the other one?" is hopeless
 * from phrasing and obvious once you hold the answer. But it only exists
 * AFTER the first response, since that is where the tool call arrives, and it
 * depends on the model remembering to make it.
 *
 * The transcript heuristic covers what the flag cannot: the first response of
 * a turn, and any turn the model answers directly without touching a tool.
 *
 * Union rather than either alone, because the failure modes are asymmetric. A
 * missed spoken answer leaves someone waiting to be told something; a
 * spurious one costs about 1.5 cents and mild irritation.
 */
export function decideModality({ transcript, aloudRequested, replyModality = defaultReplyModality }) {
  return aloudRequested ? "audio" : replyModality(transcript);
}

/**
 * Is it safe to hang up yet?
 *
 * Pulled out of the connection so the one rule that matters here can be
 * checked without a browser: a hang-up waits for the conversation to actually
 * go quiet. `force` is the timeout path, which overrides the wait rather than
 * cancelling it -- a goodbye that never finishes must still release the
 * microphone, because the user already said they were done.
 */
export function readyToHangUp({ because, responseActive, audioPlaying, force = false }) {
  if (because == null) return false;
  return force || (!responseActive && !audioPlaying);
}

export function sessionUpdate(input) {
  return JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input } } });
}

/**
 * Mint an ephemeral key, without connecting anything.
 *
 * Worth having on its own because the key is good for TEN minutes, not the one
 * minute the docs' summaries suggest -- measured: expires_at came back 601
 * seconds out. That is long enough to pay the mint (738ms median, and the
 * slowest of the two round trips) well before anyone intends to speak, and
 * still redeem it later.
 */
/**
 * The manifest travels with the mint request.
 *
 * It describes the app this page IS, so the page is the only party that can
 * be sure it is right. The relay used to hold its own copy, read from a file
 * path, and the two agreed only by convention -- until a relay restarted
 * without that path and built a calendar app's tools from a task manager's
 * manifest. Sending it makes them the same object.
 */
/**
 * A provider's failure message, cut down to something worth saying out loud.
 *
 * The rate-limit one runs to 240 characters of organisation id, limit
 * arithmetic and a documentation link. What the person in front of the app
 * needs is that it is busy and roughly for how long.
 */
export function shortFailure(message = "") {
  const wait = /try again in ([\d.]+)s/.exec(message)?.[1];
  if (/rate limit/i.test(message)) {
    return wait ? `Rate limited. Try again in about ${Math.ceil(Number(wait))} seconds.` : "Rate limited. Try again shortly.";
  }
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

export async function mintSession({ relayUrl = "", model, language, manifest, surface } = {}) {
  const where = `${relayUrl || ""}/voice/session`;
  let res;
  try {
    res = await fetch(where, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `surface` tells the relay which client this is, so the extension is
      // handed the browser tools (open_url) the in-page widget cannot run.
      body: JSON.stringify({ model, language, manifest, surface }),
    });
  } catch (err) {
    // No connection at all: nothing listening, DNS, CORS. `fetch` throws a
    // bare TypeError here, which says nothing about what to go and check.
    throw new Error(`Could not reach the voice relay at ${where}. Is it running? (${err.message})`);
  }

  /**
   * Read as text, then try JSON -- because the interesting failures are the
   * ones that are not JSON at all.
   *
   * `res.json()` on a relay that is down produced "Unexpected end of JSON
   * input", and the widget showed that to the user. A parser's complaint about
   * an empty string, in place of "the relay is not running", to someone who
   * only wanted to talk to their app. A dev proxy with nothing behind it
   * answers exactly this way, and so does an HTML error page from anything
   * sitting in front of the relay.
   */
  const body = await res.text();
  let data = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }
  if (!data) {
    throw new Error(`The voice relay at ${where} answered ${res.status} with no JSON. Is it running?`);
  }
  if (!res.ok) throw new Error(data.error?.message || data.error || "Failed to create realtime session");
  return {
    // What it was minted FOR, so a later caller can tell whether this key is
    // still the right one rather than only whether it has expired.
    for: { model: model ?? null, language: language ?? null },
    key: data.value,
    // Seconds from the API; milliseconds everywhere in here.
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + 9 * 60_000,
    logId: data.logId,
    logging: data.logging,
  };
}

/** Is this key still worth trying? The margin covers a slow connect. */
export function isUsable(minted, wanted = null, marginMs = 60_000) {
  if (!minted?.key || minted.expiresAt - Date.now() <= marginMs) return false;
  // A key is minted FOR a model and a language: both are session-creation
  // parameters and neither can be changed on a live session. Reusing one
  // minted before the settings changed opens a session on the old model and
  // silently ignores what the user picked.
  if (!wanted) return true;
  return minted.for?.model === wanted.model && minted.for?.language === wanted.language;
}

export async function connectRealtimeSession({
  onToolCall,
  onStatus,
  onTranscript,
  initialMode = "continuous",
  relayUrl = "",
  replyModality = defaultReplyModality,
  model,
  language,
  // The app's own manifest, forwarded to the relay so the tool list it builds
  // and the one this client executes are the same thing.
  manifest,
  // Which client this is. "extension" earns the browser tools; omitted for the
  // in-page widget.
  surface,
  onEvent,
  // Fires whenever the rim's state could have changed. Derived here because
  // this is the only place that sees the events it is derived from.
  onActivity,
  // The model hung up. Fires only once the goodbye has finished coming out of
  // the speaker -- see maybeHangUp() for why that matters.
  onHangUp,
  // A key minted earlier. Skipping the mint is most of the latency saving.
  minted,
  // Connect with no microphone. The transceiver is negotiated either way, so
  // one can be attached later without renegotiating -- which matters because
  // it is not clear the endpoint would accept a second offer/answer.
  withMic = true,
  // How to reach the world. Replaced in tests by an in-memory channel, which
  // is what makes the protocol testable at all.
  openTransport = webrtcTransport,
}) {
  // Structured record of what actually happened, for whoever wants it. Emitted
  // here rather than reconstructed by a caller, because most of it -- which
  // decider chose the modality, what a response cost -- exists nowhere else.
  const record = (event) => onEvent?.(event);
  // Transport states only. Whether the user is actually being listened to is
  // a separate question -- see isListening() -- because a connection can be
  // up with no microphone attached to it.
  onStatus?.("connecting");
  // Model and language are session-creation parameters: neither can be changed
  // on a live session, which is why they travel with the mint request rather
  // than a later session.update. The relay validates them -- a browser should
  // not be picking which model the account pays for.
  const session = isUsable(minted) ? minted : await mintSession({ relayUrl, model, language, manifest, surface });
  const ephemeralKey = session.key;
  record({
    type: "connected",
    logId: session.logId, logging: session.logging, model, language,
    premintedBy: isUsable(minted) ? Math.round((Date.now() - (minted.expiresAt - 600_000)) / 1000) : null,
  });

  // Everything that touches WebRTC lives behind this, so a test can supply
  // an object with `send` and `addEventListener` and drive the protocol
  // directly. See webrtcTransport.js for why.
  const transport = openTransport({ initialMode });
  const dc = transport.channel;

  async function attachMic() {
    const already = transport.hasMic();
    const track = await transport.attachMic();
    if (!already) record({ type: "mic_attached" });
    return track;
  }

  if (withMic) await attachMic();

  // The user's current turn, assembled from the streaming transcription deltas
  // rather than waiting for the completed event -- which arrives AFTER the
  // model's first response, too late to decide anything about it. The deltas
  // are all in before then.
  let lastUserTurn = "";
  const partialTurns = new Map();

  // Set by the model's answer_aloud call, cleared at the start of every turn.
  let aloudRequested = false;

  // Did the current turn arrive as speech or as typing? The goodbye mirrors
  // it: someone who said "thanks, that's all" out loud is probably already
  // looking away, and a farewell they never hear is not a farewell. Someone
  // who typed it is looking at the panel, where text is enough.
  let lastTurnWasSpoken = false;

  // The model's end_session call, held until it is safe to act on. It arrives
  // DURING a turn that has not finished happening: the farewell is generated
  // after the tool result goes back, so hanging up where the call lands cuts
  // off the goodbye the same rule asked for.
  let hangUpBecause = null;
  let hangUpTimer = null;
  // The rate-limit retry below is deferred; tracked so stop() can cancel it. An
  // untracked retry fired after the user stopped, calling dc.send on a closed
  // channel (uncaught InvalidStateError) and mutating state after teardown.
  let retryTimer = null;

  // Only one response can be in flight per conversation. Asking for a second
  // is `conversation_already_has_active_response`, which arrives as an async
  // error and drops the request -- so the turn that prompted it gets no answer
  // at all, in any medium. That is not hypothetical: it is what happened when
  // a user kept talking while the model was still working through a long
  // sequence, and it reads as the widget ignoring them.
  //
  // With create_response: true the server never collided with itself. Owning
  // response creation means owning this too, so requests are serialised
  // instead of fired blindly.
  let responseActive = false;
  // Whether the CURRENT turn has already been retried after a failure.
  let responseRetried = false;
  let responseQueued = false;

  // Tools currently executing. A counter rather than a flag because one
  // response can carry several calls, and they finish one at a time.
  //
  // Without this the rim went back to "ready" the moment the model finished
  // ASKING for a tool, and stayed there for the whole time the tool ran and
  // the follow-up was being requested. Observed live: a user watched the rim
  // say "ready to listen" while the agent was mid-job, spoke because the
  // interface invited them to, and reported that tool calls showed no working
  // state at all. The rim was not merely uninformative there, it was wrong.
  let toolsRunning = 0;

  // What the rim reports. `userSpeaking` is the server's own voice detector
  // saying audio is arriving; `audioPlaying` is the model's reply coming back.
  // Both are bracketed by event pairs, so this is observation rather than
  // inference -- no timers, no guessing when something finished.
  let userSpeaking = false;
  let audioPlaying = false;
  // Recorded as well as reported, and only when it actually changes. Without
  // this the log could say a tool ran but never what the user was being shown
  // while it ran, which is the one thing needed to explain "nothing was
  // happening" after the fact.
  let lastActivity = "";
  const reportActivity = () => {
    const state = { userSpeaking, agentBusy: responseActive || audioPlaying || toolsRunning > 0 };
    const key = `${state.userSpeaking}/${state.agentBusy}`;
    // Reported as well as recorded only on a real change. `onActivity` is
    // React state in the provider and this is a fresh object every call, so
    // firing it on every event re-rendered the whole widget -- rim included --
    // for a value that had not moved.
    if (key === lastActivity) return;
    lastActivity = key;
    record({ type: "activity", ...state, because: { responseActive, audioPlaying, toolsRunning } });
    onActivity?.(state);
  };

  // Is the SERVER deciding turn boundaries? In push-to-talk we send
  // turn_detection: null and the button decides, so the commit is ours and we
  // must not answer it here as well -- that would be two responses per turn.
  let serverTurns = initialMode !== "ptt";


  /**
   * Ask for a response. This is the whole of what `create_response: false`
   * buys: the server still hears where the turn ended and still commits it,
   * but nothing is generated until this runs, so every response in the
   * session is one we picked the medium for.
   *
   * The obligation that comes with it: a turn this fails to answer is
   * silence. No error, no timeout, no retry from the server. Every path that
   * commits audio has to reach here.
   */
  function requestResponse() {
    if (responseActive) {
      // Coalesced deliberately: what matters is that a response happens after
      // the current one, and it will read the freshest transcript when it does.
      responseQueued = true;
      record({ type: "response_deferred", transcript: lastUserTurn });
      return;
    }
    const modality = decideModality({ transcript: lastUserTurn, aloudRequested, replyModality });
    // Optimistic: two requests can leave before the first `response.created`
    // comes back, and the second is the one that gets rejected.
    responseActive = true;
    // The rim has to hear about this NOW, not when the server gets around to
    // `response.created`. Between those two points the agent is working and
    // the rim used to say it was idle.
    reportActivity();
    // Which decider won is the thing you tune on later, so it is recorded
    // alongside the outcome rather than inferred from it.
    record({
      type: "response_requested",
      modality,
      decidedBy: aloudRequested ? "answer_aloud" : "transcript",
      transcript: lastUserTurn,
    });
    dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: [modality] } }));
  }

  /**
   * Hang up, once nothing is still coming out of the speaker.
   *
   * Three things have to have finished: the response carrying the end_session
   * call, the follow-up response carrying the goodbye, and the audio of that
   * goodbye -- which outlives `response.done` by whole seconds. Tearing down
   * on the tool call itself cut the farewell off mid-word every time.
   *
   * Called from both places a turn can go quiet, because neither one alone
   * covers both media: a spoken goodbye ends at output_audio_buffer.stopped,
   * a written one at response.done with no audio ever starting.
   */
  function maybeHangUp({ force = false } = {}) {
    if (!readyToHangUp({ because: hangUpBecause, responseActive, audioPlaying, force })) return;
    const because = hangUpBecause;
    hangUpBecause = null;
    clearTimeout(hangUpTimer);
    record({ type: "hang_up", because, forced: force });
    onHangUp?.({ because });
  }

  // The connect promise resolves when the channel is OPEN, not when the SDP
  // exchange finishes. Those are milliseconds apart under load and much
  // further apart on a slow network, and in between every method on the
  // returned session throws InvalidStateError on send. Callers should not have
  // to know that, and a warmed session that is "connected" but unusable is
  // exactly the bug this would cause later.
  let markOpen;
  const opened = new Promise((resolve, reject) => {
    markOpen = resolve;
    setTimeout(() => reject(new Error("Realtime data channel did not open within 20s")), 20000);
  });

  dc.addEventListener("open", () => {
    markOpen();
    onStatus?.("ready");
    if (initialMode === "ptt") {
      // Session is minted with server_vad by default; ptt needs manual
      // turn detection so button-release (not silence) decides the turn.
      serverTurns = false;
      dc.send(sessionUpdate({ turn_detection: null }));
    }
  });
  dc.addEventListener("close", () => onStatus?.("closed"));

  dc.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "response.created") {
      responseActive = true;
      reportActivity();
    }

    // The user's turn, as the server hears it.
    if (msg.type === "input_audio_buffer.speech_started") {
      userSpeaking = true;
      reportActivity();
    }
    if (msg.type === "input_audio_buffer.speech_stopped") {
      userSpeaking = false;
      reportActivity();
    }

    // The reply actually coming out of the speaker, which outlasts the
    // response that produced it -- `response.done` fires while the audio is
    // still playing, so the two have to be tracked separately or the rim
    // drops back to ready mid-sentence.
    if (msg.type === "output_audio_buffer.started") {
      audioPlaying = true;
      reportActivity();
    }
    if (msg.type === "output_audio_buffer.stopped" || msg.type === "output_audio_buffer.cleared") {
      audioPlaying = false;
      reportActivity();
      maybeHangUp();
    }
    // Cleared here, but NOT drained here: the tool-call path below also ends
    // in a request, and draining at the top would let both fire for the same
    // completed response -- which is the collision this exists to prevent.
    if (msg.type === "response.done") {
      responseActive = false;
      // A response that asked for tools has NOT ended the turn: the tool loop
      // below picks it up. Holding the turn open here stops the rim blinking
      // idle in the gap between the model finishing its request and the first
      // tool starting -- a gap of one tick, but a gap the crossfade would
      // start animating through.
      if ((msg.response?.output || []).some((o) => o.type === "function_call")) toolsRunning += 1;
      reportActivity();
    }

    // The API reports malformed events this way rather than by failing the
    // send, so without this a rejected session.update is invisible.
    if (msg.type === "error") {
      console.error("Realtime API rejected an event:", msg.error);
      record({ type: "api_error", error: msg.error });
    }

    // The server has decided the user stopped and banked the audio. With
    // create_response: false that is ALL it does, so the first response of the
    // turn is ours to ask for, and its medium comes from the partial
    // transcript the deltas have already delivered.
    if (msg.type === "input_audio_buffer.committed" && serverTurns) {
      aloudRequested = false; // a new turn starts here
      lastTurnWasSpoken = true;
      requestResponse();
    }

    if (msg.type === "conversation.item.input_audio_transcription.delta") {
      const soFar = (partialTurns.get(msg.item_id) ?? "") + (msg.delta ?? "");
      partialTurns.set(msg.item_id, soFar);
      lastUserTurn = soFar;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      partialTurns.delete(msg.item_id);
      lastUserTurn = msg.transcript ?? lastUserTurn;
      record({ type: "user_turn", text: msg.transcript, seconds: msg.usage?.seconds });
      onTranscript?.({ role: "user", text: msg.transcript });
    }

    if (msg.type === "response.done") {
      const output = msg.response?.output || [];

      for (const item of output) {
        if (item.type === "message") {
          const text = (item.content || [])
            .map((c) => c.transcript || c.text)
            .filter(Boolean)
            .join(" ");
          if (text) {
            record({ type: "assistant_reply", text, modalities: msg.response?.output_modalities });
            onTranscript?.({ role: "assistant", text });
          }
        }
      }

      // `status` is the whole difference between "the model chose to say
      // nothing" and "this response never ran". Ten responses in one observed
      // session reported zero input AND zero output tokens, which no real
      // generation can do -- but with no status recorded, cancelled, failed
      // and incomplete were indistinguishable from each other and from a
      // deliberate silence.
      record({
        type: "usage",
        usage: msg.response?.usage,
        modalities: msg.response?.output_modalities,
        status: msg.response?.status,
        statusDetails: msg.response?.status_details,
      });

      /**
       * A response that FAILED, as opposed to one that finished with nothing
       * to say. It has to reach the user, and it did not.
       *
       * Observed: a session ended mid-task on
       * `rate_limit_exceeded ... Please try again in 7.853s`. The response
       * carried zero tokens, the turn closed, the rim went idle, and the
       * widget said nothing. From the outside that is indistinguishable from
       * the agent deciding to ignore you -- and the fix it was asking for was
       * to wait eight seconds, which we were holding in a string.
       *
       * Retried once, because the common cause names a delay and honouring it
       * is the whole remedy. Once and not twice: a second failure is a real
       * condition, and a widget that keeps quietly retrying is a widget that
       * hangs.
       */
      if (msg.response?.status === "failed") {
        const failure = msg.response?.status_details?.error;
        const message = failure?.message || "the model failed to answer";
        const wait = Number(/try again in ([\d.]+)s/.exec(message)?.[1]) || 0;
        record({ type: "response_failed", code: failure?.code, message, retrying: !responseRetried });

        if (!responseRetried) {
          responseRetried = true;
          // The server told us how long. Rounded up, because coming back a
          // few milliseconds early spends the retry on the same refusal.
          retryTimer = setTimeout(() => requestResponse(), Math.ceil(wait * 1000) + 250);
          return;
        }
        onTranscript?.({ role: "assistant", text: shortFailure(message) });
        return;
      }
      // A turn that got an answer clears the retry, so the next failure gets
      // its own attempt rather than inheriting an old one.
      responseRetried = false;

      const calls = output.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        // Nothing to run, so this response ends its turn. If a turn arrived
        // while it was streaming, answer that one now.
        if (responseQueued) {
          responseQueued = false;
          requestResponse();
          return;
        }
        // Nothing further is coming. If the goodbye was text there is no audio
        // to wait for, so this is where a written hang-up completes.
        maybeHangUp();
        return;
      }

      // try/finally, because the hold taken when this response asked for
      // tools MUST come back. A throw anywhere in here -- a closed data
      // channel on dc.send, say -- would otherwise leave the rim lit for
      // the rest of the session with nothing running behind it.
      try {
        for (const call of calls) {
          let args = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            // leave args empty if the model sent malformed JSON
          }
          // answer_aloud is a signal to us rather than work for the host app,
          // but it still goes through onToolCall so a host can log what the
          // model decided and the reason it gave.
          if (call.name === "answer_aloud") aloudRequested = true;
          if (call.name === "end_session") {
            hangUpBecause = args.because ?? "";
            // A spoken dismissal earns a spoken goodbye without the model having
            // to also remember answer_aloud for it.
            if (lastTurnWasSpoken) aloudRequested = true;
            // If the goodbye never arrives -- a dropped response, an audio
            // buffer event that never fires -- the microphone would stay live
            // after the user said they were done, which is the one outcome this
            // feature must not produce. Hang up anyway.
            clearTimeout(hangUpTimer);
            hangUpTimer = setTimeout(() => maybeHangUp({ force: true }), 15_000);
          }

          // Timed, because recording only on completion left a tool that took
          // two seconds indistinguishable from one that took none, and a tool
          // still running indistinguishable from one that never started.
          const startedAt = Date.now();
          let result;
          try {
            result = await onToolCall(call.name, args);
          } catch (err) {
            result = { error: String(err.message || err) };
          }

          // A tool may hand back an IMAGE (a screenshot) alongside its text. A
          // function_call_output is a STRING, so a data URL packed into it is
          // just tokens the model cannot see -- the picture has to arrive as its
          // own input_image conversation item. So it is split off here: the tool
          // output says a screenshot follows, and the image goes in behind it as
          // the user's latest content, which the follow-up response then sees.
          // This is the entire mechanism by which the model gets vision.
          let image = null;
          if (result && typeof result === "object" && typeof result.image === "string") {
            ({ image, ...result } = result);
          }
          // The data URL is hundreds of KB; a marker in the record, never the
          // bytes.
          record({
            type: "tool_call",
            name: call.name,
            args,
            result: image ? { ...result, image: "<screenshot injected as input_image>" } : result,
            ms: Date.now() - startedAt,
          });

          dc.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: call.call_id,
                output: JSON.stringify(image ? { ...result, screenshot: "attached in the next message" } : (result ?? {})),
              },
            }),
          );
          if (image) {
            dc.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_image", image_url: image }],
                },
              }),
            );
          }
        }
        // The follow-up, where answer_aloud decides the medium. Any turn that
        // arrived mid-flight is folded into this one request rather than queued
        // behind it.
        responseQueued = false;
        requestResponse();
      } finally {
        // Only now is the turn handed back. Releasing before the follow-up is
        // requested would leave a window with no response active and no tool
        // running, and the rim would call that idle.
        toolsRunning -= 1;
        reportActivity();
      }
    }
  });

  await transport.connect(ephemeralKey);
  await opened;

  return {
    stop() {
      clearTimeout(hangUpTimer);
      clearTimeout(retryTimer);
      hangUpBecause = null;
      userSpeaking = false;
      audioPlaying = false;
      responseActive = false;
      reportActivity();
      transport.close();
      onStatus?.("closed");
    },
    sendTextTurn(text) {
      // A typed turn is a NEW turn, and it reaches none of the places a spoken
      // one does: no input_audio_buffer.committed, no clearInputBuffer. Without
      // this reset, an answer_aloud from an earlier spoken question stayed set
      // and every typed turn afterwards inherited "speak this" -- observed
      // live, with "Opened settings." and "Name changed to Steve Branson."
      // coming back as audio on turns the model never flagged.
      aloudRequested = false;
      lastTurnWasSpoken = false;
      lastUserTurn = text;
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      requestResponse();
    },

    /**
     * Stop listening, keep the session.
     *
     * The softer half of stop(): the microphone is genuinely released, so the
     * OS recording indicator goes out and the user can see they were heard --
     * but the connection, its history and its cached prompt prefix survive, so
     * coming back is an attachMic() rather than a fresh connect. Prompt
     * caching is session-scoped, which makes closing and reopening the
     * expensive way to pause.
     */
    async releaseMic() {
      if (!(await transport.releaseMic())) return;
      userSpeaking = false;
      reportActivity();
      record({ type: "mic_released" });
    },

    // --- PTT / PTNT primitives, all on this same connection + history ---

    attachMic,
    hasMic: () => transport.hasMic(),
    setMicEnabled: (enabled) => transport.setMicEnabled(enabled),
    // auto=true restores server VAD (continuous); auto=false switches to
    // manual turn detection (push-to-talk decides turn end itself).
    setTurnDetection(auto) {
      serverTurns = auto;
      // create_response has to be repeated here. A bare { type: "server_vad" }
      // resets it to its default of true, so switching out of push-to-talk
      // would hand response creation quietly back to the server and undo the
      // whole arrangement, on a path nobody exercises.
      dc.send(
        sessionUpdate({ turn_detection: auto ? { type: "server_vad", create_response: false } : null }),
      );
    },
    // Reset any buffered input audio -- call on PTT press so a stale/empty
    // buffer from before the button was held doesn't bleed into the turn.
    clearInputBuffer() {
      aloudRequested = false; // a push-to-talk turn starts here
      dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    },
    // Call on PTT release: finalizes the held-down turn and asks the model
    // to respond now, without waiting on VAD (which is disabled anyway).
    commitAndRespond() {
      dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      requestResponse();
    },
    // Barge-in: stop whatever the model is currently saying/generating.
    cancelResponse() {
      dc.send(JSON.stringify({ type: "response.cancel" }));
    },
  };
}

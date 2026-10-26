/**
 * Orchestra: the hosted provider. How a turn is decided runs on Orchestra's
 * service; the page keeps only what it alone can do:
 *
 *   the page      the mic and turn-taking, live transcription, the spoken
 *                 reply, reading the screen, and the core's tools (a query, a
 *                 press, typing, a page), run when the service asks
 *   the service   understanding the turn and choosing what to do, the models
 *                 and their keys
 *
 * A turn goes up with what is on screen; the service answers with the tools
 * it needs run, the page runs them in the browser (with the user's own
 * session, against the app's own API) and sends the results back, until the
 * turn is done. What the service remembers between requests travels with
 * them, sealed: the page can neither read nor change it.
 *
 * Keys: the app registers with Orchestra and gets a secret key. Its server
 * mounts one route (@expert/voice-server/orchestra) that trades the key for a
 * short-lived session token; the page asks that route, never holds the key.
 *
 *   <VoiceProvider manifest={manifest} provider={orchestra()}>   // the default
 */
import { liveStt } from "./liveStt.js";
import { clipStt, speaker } from "./clipStt.js";

/** The user's date, YYYY-MM-DD, for "tomorrow" (the service's clock is in another time zone). */
const localToday = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The service, from the page: session tokens from the app's own server,
 * renewed when they lapse; the manifest, sent once and re-sent if the service
 * no longer holds it.
 *
 * @param {object} opts
 * @param {string} [opts.tokenUrl]  the app's route that mints a session token (default /voice/token)
 * @param {string} [opts.url]       the service's origin; by default, the one the token route names
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function orchestraService({ tokenUrl = "/voice/token", url, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  let base = url ? String(url).replace(/\/+$/, "") : null;
  let token = null;
  let session = null;
  let manifest = null; // { body, hash }
  let turnId = null;

  async function renew() {
    const r = await doFetch(tokenUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(session ? { session } : {}) });
    if (!r.ok) throw new Error(`${tokenUrl} HTTP ${r.status}: is the Orchestra token route mounted, with ORCHESTRA_KEY set?`);
    const t = await r.json();
    token = t.token;
    session = t.session ?? session;
    if (!base && t.url) base = String(t.url).replace(/\/+$/, "");
    if (!base) throw new Error(`${tokenUrl} named no service URL: set ORCHESTRA_URL on the server, or pass orchestra({ url }).`);
    return token;
  }

  /** A request with the token, renewed once when it has lapsed. */
  async function send(path, init, retried = false) {
    if (!token) await renew();
    const r = await doFetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    if (r.status === 401 && !retried) {
      await renew();
      return send(path, init, true);
    }
    return r;
  }

  const service = {
    get session() { return session; },
    /** The turn whose line is being spoken, so its voice is counted with it. */
    set turnId(id) { turnId = id; },

    /** POST JSON; a manifest the service no longer holds is sent again and the request retried. */
    async call(path, body) {
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      let r = await send(path, init);
      if (r.status === 409 && manifest) {
        await service.upload();
        r = await send(path, init);
      }
      if (!r.ok) throw new Error(`Orchestra ${path} HTTP ${r.status}`);
      return r.json();
    },

    /** The app's manifest, once a session; turns name it by its hash. */
    async upload(m) {
      if (m) manifest = { body: m, hash: null };
      const r = await send("/v1/manifest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: manifest.body }) });
      if (!r.ok) throw new Error(`Orchestra /v1/manifest HTTP ${r.status}`);
      manifest.hash = (await r.json()).hash;
      return manifest.hash;
    },
    get manifestHash() { return manifest?.hash ?? null; },

    /**
     * A fetch for the transcriber and the speaker: their /voice/<route> goes
     * to the service's /v1/<route>, with the token.
     */
    fetch: async (input, init = {}) => {
      const route = /\/voice\/([a-z-]+)$/.exec(String(input))?.[1];
      if (!route) return doFetch(input, init);
      let body = init.body;
      if (route === "speak" && turnId && typeof body === "string") {
        try { body = JSON.stringify({ ...JSON.parse(body), turnId }); } catch { /* sent as it was */ }
      }
      return send(`/v1/${route}`, { ...init, body, headers: { ...(init.headers ?? {}) } });
    },
  };
  return service;
}

/** A routine on the service, its needs run on the page until it is done. */
async function play(service, path, start, runNeed) {
  let r = await service.call(path, start);
  while (r.needs) {
    const results = Object.fromEntries(await Promise.all(r.needs.map(async (n) => [n.id, (await runNeed(n)) ?? null])));
    r = await service.call(path, { cont: r.cont, results });
  }
  return r;
}

/**
 * The Orchestra provider.
 *
 * @param {object} [opts]
 * @param {string} [opts.tokenUrl]  the app's token route (default /voice/token)
 * @param {string} [opts.url]       the service's origin; by default, the one the token route names
 * @param {boolean} [opts.live]     transcribe while the user speaks (default true); false sends each turn as a clip
 * @param {boolean} [opts.voice]    speak the few lines that need saying (default true); false shows them only
 * @param {string} [opts.language]  ISO-639-1, e.g. "en"; detected if omitted
 * @param {boolean} [opts.log]      report each session and turn's timings to the service (default true; never audio)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.service]   an orchestraService() to share; built from the options above if omitted
 * @param {object} [opts.stt]       a transcriber to use instead (liveStt / clipStt shape)
 * @param {object} [opts.tts]       a speaker to use instead ({ speak, cancel })
 */
export function orchestra({ tokenUrl, url, live = true, voice = true, language, log = true, fetchImpl, service, stt, tts, id = "orchestra" } = {}) {
  const svc = service ?? orchestraService({ tokenUrl, url, fetchImpl });
  const transcriber = stt ?? (live ? liveStt({ language, fetchImpl: svc.fetch }) : clipStt({ language, fetchImpl: svc.fetch }));
  const speaks = tts !== undefined ? tts : voice ? speaker({ fetchImpl: svc.fetch }) : null;
  return hosted({ service: svc, stt: transcriber, tts: speaks, log, id });
}

/** The provider over a service, a transcriber and a speaker. */
function hosted({ service, stt, tts, log, id }) {
  let pendingInCore = false;

  return {
    id,
    capabilities: { pushToTalk: true, bargeIn: !!tts, textInput: true, warm: false },

    /** The host's onPendingAction: what the core has staged (its own buttons can resolve it). */
    notePending(value) { pendingInCore = !!value; },

    async connect(deps = {}) {
      const cb = deps.callbacks ?? {};
      const manifest = deps.manifest ?? {};
      await service.upload(manifest);

      // The first tool that changes or opens something is when the turn took effect.
      const EFFECTS = new Set(["navigate", "run_action", "dom_click", "dom_type", "dom_highlight", "confirm_pending_action", "cancel_pending_action"]);
      let effect = null;
      const run = async (name, args) => {
        if (effect && !effect.at && EFFECTS.has(name)) effect.at = Date.now();
        return (await cb.onToolCall?.(name, args)) ?? null;
      };
      const runNeed = async (need) => {
        if (need.kind === "tool") return run(need.args.name, need.args.args);
        if (need.kind === "steps") {
          const out = [];
          for (const s of need.args.steps) {
            const result = await run(s.name, s.args);
            out.push({ name: s.name, result });
            if (result?.error) break;
          }
          return out;
        }
        return { error: `This page cannot ${need.kind}.` };
      };

      let state = null; // sealed: the service's, between turns
      let stopped = false;
      let busy = Promise.resolve();
      const activity = (userSpeaking, agentBusy) => cb.onActivity?.({ userSpeaking, agentBusy });
      const route = () => (typeof location !== "undefined" ? location.pathname : "/");
      const report = (record) => log && service.call("/v1/log", record).catch(() => {});

      let recordTerms; // the records' names, kept until a turn may have changed them
      async function refreshKeyterms({ reread = true } = {}) {
        if (!stt.setKeyterms) return;
        try {
          const screen = (await run("dom_snapshot", {}))?.elements ?? [];
          const r = await play(service, "/v1/keyterms", { manifest: service.manifestHash, screen, ...(!reread && recordTerms && { recordTerms }) }, runNeed);
          recordTerms = r.done.recordTerms;
          stt.setKeyterms(r.done.keyterms);
        } catch {
          /* keyterms are a help, never a reason to fail */
        }
      }

      const say = async (text, entry) => {
        if (!text) return;
        cb.onTranscript?.({ role: "assistant", text });
        if (!tts) return;
        stt.setEnabled?.(false); // do not hear ourselves
        try {
          await tts.speak(text, { onStart: () => { if (entry?.speechEndedAt) entry.replyMs = Date.now() - entry.speechEndedAt; } });
        } catch {
          /* the line is on screen either way */
        } finally {
          stt.setEnabled?.(true);
        }
      };

      async function handleTurn(text, heardMs, { typed = false } = {}) {
        if (stopped || !text) return;
        const t0 = Date.now();
        if (!typed) cb.onTranscript?.({ role: "user", text }); // a typed turn the core has already shown
        activity(false, true);
        const entry = { type: "timing", heardMs };
        const ended = !typed && speechEndedAt ? speechEndedAt : null;
        if (ended) entry.speechEndedAt = ended;
        effect = { at: null };
        const heard = stt.takeUsage?.();
        if (heard?.seconds) entry.stt = { seconds: Math.round(heard.seconds * 10) / 10 };
        let refresh = false;
        try {
          const screen = (await run("dom_snapshot", {}))?.elements ?? [];
          const r = await play(service, "/v1/turn", { manifest: service.manifestHash, turn: { utterance: text, route: route(), screen, pending: pendingInCore, today: localToday() }, ...(state && { state }) }, runNeed);
          const d = r.done;
          state = r.state;
          entry.turnId = d.turnId;
          refresh = d.refresh;
          if (d.corePending !== undefined) pendingInCore = d.corePending;
          entry.doneMs = Date.now() - t0;
          if (ended && effect.at) entry.effectMs = effect.at - ended;
          for (const t of d.then ?? []) {
            if (t === "hang_up") cb.onHangUp?.({ because: text });
            if (t === "back" && typeof window !== "undefined") window.history.back();
          }
          service.turnId = d.turnId;
          await say(d.say, entry);
        } catch (err) {
          entry.error = String(err.message ?? err).slice(0, 300);
          await say("Sorry, something went wrong.");
        } finally {
          service.turnId = null;
          effect = null;
          entry.totalMs = Date.now() - t0;
          delete entry.speechEndedAt;
          activity(false, false);
          report(entry);
          refreshKeyterms({ reread: refresh });
        }
      }

      // One turn at a time: a turn spoken while the last is still running waits for it.
      let speechEndedAt = 0;
      const queue = (text, opts) => {
        const heardMs = !opts?.typed && speechEndedAt ? Date.now() - speechEndedAt : undefined;
        busy = busy.then(() => handleTurn(text, heardMs, opts));
        return busy;
      };

      await stt.start({
        withMic: deps.withMic !== false,
        onFinal: (text) => queue(text),
        onSpeechStart: () => { tts?.cancel?.(); activity(true, false); },
        onSpeechEnd: () => { speechEndedAt = Date.now(); activity(false, true); },
        onError: () => say("I didn't catch that."),
      });
      refreshKeyterms();
      cb.onStatus?.("ready");
      report({
        type: "session", provider: id, route: route(),
        href: typeof location !== "undefined" ? location.href : undefined,
        manifest: { routes: manifest.routes?.length ?? 0, queries: manifest.queries?.length ?? 0, actions: manifest.actions?.length ?? 0 },
        stt: stt.feed ? "live" : "clips", tts: !!tts, mic: deps.withMic !== false,
      });

      return {
        stop() {
          stopped = true;
          stt.stop?.();
          tts?.cancel?.();
          cb.onStatus?.("closed");
        },
        sendTextTurn: (text) => queue(text, { typed: true }),
        attachMic: () => stt.attachMic?.(),
        releaseMic: async () => stt.releaseMic?.(),
        hasMic: () => stt.hasMic?.() ?? false,
        setMicEnabled: (on) => stt.setEnabled?.(on),
        setTurnDetection: (auto) => stt.setTurnDetection?.(auto),
        clearInputBuffer: () => stt.beginTurn?.(),
        commitAndRespond: () => stt.endTurn?.(),
        cancelResponse: () => tts?.cancel?.(),
      };
    },
  };
}

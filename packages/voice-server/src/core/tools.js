// Converts the generated manifest into OpenAI Realtime function-calling
// tool definitions, plus a fixed set of generic DOM/navigation primitives
// that act as the runtime fallback for anything the manifest doesn't cover.

import { rootCatalog } from "./catalog.js";

// The manifest FORMAT version this server understands. The CLI stamps the
// manifest it produces (see voice-cli core/manifestVersion.js); a manifest
// stamped NEWER than this was built by a newer CLI and may use fields this
// server does not read, so we note it (non-fatal) rather than silently
// mis-serving. Bumped in lockstep with the CLI's MANIFEST_FORMAT_VERSION only
// when the manifest's shape changes.
export const MANIFEST_FORMAT_VERSION = 1;

function jsonType(manifestType) {
  if (manifestType === "boolean") return "boolean";
  if (manifestType === "number") return "number";
  return "string"; // string, enum, and anything unrecognized default to string
}

function paramsToJsonSchema(params = [], bodyFields = []) {
  const properties = {};
  const required = [];
  for (const p of [...params, ...bodyFields]) {
    properties[p.name] = {
      type: jsonType(p.type),
      description: p.source ? `(${p.source})` : undefined,
      ...(p.enumValues ? { enum: p.enumValues } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

/**
 * Is this a manifest at all?
 *
 * The client sends it now, so this is the only thing standing between a
 * typo and a session built on nothing. Deliberately NOT a size limit: on a
 * relay you host yourself the tokens are your own, and on one we host the
 * gate belongs at the door rather than in the shape of the payload.
 *
 * Returns a normalised copy, because "no actions" and "actions missing" mean
 * the same thing to everything downstream and should not be two cases.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { error: "Expected a manifest object. Generate one with `npx @expert/voice-cli <srcDir> <outDir>` and pass it to VoiceProvider." };
  }
  // Keep every top-level field -- `description` (the prompt's opening anchor) and
  // `groups` (the catalog's topic descriptions) are read downstream by
  // buildInstructions and rootCatalog. Only the three operation arrays are
  // normalised/validated; dropping the rest silently reset the prompt to "a web
  // app" and erased group descriptions.
  const normalised = { ...manifest };
  for (const key of ["routes", "queries", "actions"]) {
    const value = manifest[key];
    if (value !== undefined && !Array.isArray(value)) {
      return { error: `manifest.${key} must be an array, got ${typeof value}.` };
    }
    normalised[key] = value ?? [];
  }
  // Format-version skew: a manifest stamped newer than this server is a warning,
  // not an error -- the callable surface is still usable, but newer fields may be
  // ignored. Missing version just means a pre-versioning manifest; left silent.
  let versionNote = null;
  const v = manifest.version;
  if (typeof v === "number" && v > MANIFEST_FORMAT_VERSION) {
    versionNote = `manifest.version ${v} is newer than this server supports (${MANIFEST_FORMAT_VERSION}); update @expert/voice-server. Serving it anyway; fields added after v${MANIFEST_FORMAT_VERSION} may be ignored.`;
  }
  // A manifest with nothing in it is legitimate -- an app whose analysis found
  // nothing still gets the DOM tools -- but it is almost never intended, so it
  // is worth being able to see in a log.
  return {
    manifest: normalised,
    empty: !normalised.routes.length && !normalised.queries.length && !normalised.actions.length,
    versionNote,
  };
}

/** " Returns a list of items with: id, title, done." -- or nothing at all. */
function describeReturns(returns) {
  if (!returns) return "";
  if (returns.kind === "array") {
    const fields = Array.isArray(returns.of) ? returns.of : null;
    return fields?.length ? ` Returns a list; each item has: ${fields.join(", ")}.` : " Returns a list.";
  }
  if (returns.kind === "object" && returns.fields?.length) return ` Returns an object with: ${returns.fields.join(", ")}.`;
  return "";
}

export function buildTools(manifest, { surface } = {}) {
  const tools = [];

  /**
   * A DISPATCHER, not one typed function per operation.
   *
   * cal.diy has 177 operations. As typed tools that is ~15k tokens of prompt
   * prefix on every single response, and it walked a live session into a
   * per-minute rate limit -- half the turns failed. The tools cannot be
   * trimmed mid-session either (they are fixed at creation for prompt caching),
   * so a "reveal more tools" step cannot add typed functions later.
   *
   * So the operations become DATA, reached through three small tools that never
   * change. `run_query` and `run_action` call an operation by name; `expand`
   * reveals a topic's operations (see catalog.js). The base prompt carries only
   * the root operations and the topic names -- everything else is one expand
   * away, and the tool surface stays a handful of entries whatever the app's
   * size.
   *
   * The names come from the catalog in the instructions and from expand's
   * results. A name the manifest does not know is answered with an error, not a
   * guess.
   */
  tools.push(
    {
      type: "function",
      name: "run_query",
      description:
        "Read data from the app by calling one of its queries by name. Names come from the catalog " +
        "in your instructions and from expand() results. For a lookup, call ONCE with no filter and " +
        "pick from the result -- never one query per thing.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The query's name, exactly as the catalog gives it." },
          args: { type: "object", description: "Arguments for the query, or {} for none." },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "run_action",
      description:
        "Change something in the app by calling one of its actions by name. `items` is a LIST: one " +
        "entry per thing to change, a single change being a list of one. Put a whole set in ONE call " +
        "-- never call the same action repeatedly. A destructive action stages first and asks for " +
        "confirmation; a list is confirmed once for the whole set.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The action's name, exactly as the catalog gives it." },
          items: {
            type: "array",
            minItems: 1,
            description: "One entry per thing to change. For a single change, pass a list of one.",
            items: { type: "object" },
          },
        },
        required: ["name", "items"],
      },
    },
    {
      type: "function",
      name: "expand",
      description:
        "Reveal the tools grouped under a topic, when the catalog shows a topic name but not its " +
        "tools. Pass the topic exactly as listed (e.g. availability or availability/schedule). " +
        "Returns that topic's tools and any sub-topics you can expand further. Expand toward what the " +
        "user asked for; do not expand everything.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "The topic path from the catalog." } },
        required: ["topic"],
      },
    },
  );

  // Delegation: when the app has its OWN agent (DELEGATION.md), the model can
  // hand it an open-ended instruction instead of trying to execute one. Only
  // emitted when the manifest registers an agent; its enum + the per-agent
  // descriptions in the instructions are what the model routes on.
  const agents = (manifest.agents ?? []).filter((a) => a?.id);
  if (agents.length) {
    tools.push({
      type: "function",
      name: "ask",
      description:
        "Hand an open-ended request to one of THIS APP'S OWN agents -- a request to create, change or " +
        "figure something out that is not a fixed operation (e.g. authoring, restyling, planning). Use it " +
        "ONLY for what the chosen agent's description says it does; for navigation and the app's listed " +
        "operations use run_query/run_action/navigate instead. The agent works and its progress shows in " +
        "the app's own panel; you will get back what it said.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: agents.map((a) => a.id), description: "Which agent, from the catalog." },
          instruction: { type: "string", description: "What to tell the agent, in plain language, as the user would say it." },
        },
        required: ["agent", "instruction"],
      },
    });
  }

    // Generic runtime fallback primitives -- used when the manifest doesn't
  // cover what's needed (an element with no corresponding manifest action,
  // or a page state the static analysis couldn't see).
  tools.push(
    {
      type: "function",
      name: "navigate",
      description: "Navigate the app to a known route path, e.g. /settings or /tasks/3",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      type: "function",
      name: "dom_snapshot",
      description:
        "List the currently visible, interactive elements on screen (buttons, links, inputs, selects) with their labels and ids. Use this when you need to click or type into something that isn't covered by a query/action tool.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "dom_click",
      description:
        "Click one or more elements, in order, by the ids returned from dom_snapshot. Pass every " +
        "click the job needs in ONE call: turning on Saturday and Sunday is one call with two ids. " +
        "Stops at the first one that fails and says what it managed.",
      parameters: {
        type: "object",
        properties: { elementIds: { type: "array", items: { type: "string" } } },
        required: ["elementIds"],
      },
    },
    {
      type: "function",
      name: "dom_type",
      description:
        "Fill one or more inputs, in order, by the ids returned from dom_snapshot. Pass every field " +
        "in ONE call. Stops at the first one that fails and says what it managed.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { elementId: { type: "string" }, text: { type: "string" } },
              required: ["elementId", "text"],
            },
          },
        },
        required: ["items"],
      },
    },
    {
      type: "function",
      name: "dom_highlight",
      description:
        "Draw a ring around one element and scroll it into view, so the user can see where it is. " +
        "Points at it; does NOT press it. Use it to answer where something is and to show someone how " +
        "to do something themselves. Takes an id from dom_snapshot. The ring clears when they touch " +
        "the page or when you do anything else.",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string" } },
        required: ["elementId"],
      },
    },
    {
      type: "function",
      name: "look_at_screen",
      description:
        "Take a screenshot of what is on screen right now and look at it. Use this when the question " +
        "is about something VISUAL that a text snapshot cannot convey -- a chart, an image, a map, a " +
        "canvas or game, a PDF or document, a layout -- or when dom_snapshot came back thin or " +
        "confusing and you still cannot tell what the user is looking at. It shows you the real " +
        "rendered page. It costs more than dom_snapshot, so use dom_snapshot to FIND controls to click " +
        "or type into, and use this to SEE what something looks like or read what is drawn rather than " +
        "written. Only the visible part of the page is captured.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "answer_aloud",
      description:
        "Call this when your NEXT reply carries information the user asked for and cannot " +
        "already see on screen -- an answer to a question, a count, a value they requested. " +
        "Call it in the SAME turn as the tool whose result you are about to report. Do NOT " +
        "call it to confirm an action the user just watched happen; those replies are shown " +
        "as text and speaking them tells the user nothing new.",
      parameters: {
        type: "object",
        properties: {
          because: {
            type: "string",
            description:
              "One short phrase saying why this needs to be heard rather than read, " +
              "e.g. \"the user asked how many tasks there are\".",
          },
        },
        required: ["because"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "end_session",
      description:
        "Hang up: stop listening and release the microphone. Call this ONLY when the user " +
        "says they are done -- \"that's all\", \"thanks, goodbye\", \"stop listening\", " +
        "\"we're finished\". Say one short goodbye in the same turn. Do NOT call it because " +
        "you think the task is complete, because there is nothing left to do, or because " +
        "something failed: finishing a job is not the same as being dismissed, and only the " +
        "user decides when the conversation is over.",
      parameters: {
        type: "object",
        properties: {
          because: {
            type: "string",
            description:
              "The user's own words that ended the conversation, e.g. \"thanks, that's all for now\".",
          },
        },
        required: ["because"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "confirm_pending_action",
      description:
        "Confirm and actually execute the destructive action that is currently awaiting confirmation. Only call this after the user has clearly said yes.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "cancel_pending_action",
      description: "Cancel the destructive action that is currently awaiting confirmation.",
      parameters: { type: "object", properties: {} },
    },
  );

  // Browser-level navigation, only where there IS a browser to drive: the
  // extension. The in-page widget cannot point the address bar at an arbitrary
  // URL, so it never sees open_url -- offering it there would be a tool that can
  // only fail. This is the seam that lets the extension's surface be a superset
  // of the widget's without the widget paying for tools it cannot run.
  if (surface === "extension") {
    tools.push({
      type: "function",
      name: "open_url",
      description:
        "Go to a web address in the current tab. Use it to FOLLOW A LINK -- pass the href that " +
        "dom_snapshot listed for that link -- or to visit a site the user names. It changes the page " +
        "reliably even on sites that fully reload, which clicking a link does not. Use dom_click for " +
        "buttons and controls; for links, prefer this.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The full URL, e.g. https://example.com/page." } },
        required: ["url"],
      },
    });
  }

  return tools;
}

/**
 * What a client is allowed to ask for. The relay owns this list rather than
 * the widget because both fields are cost and safety decisions: `model` picks
 * how much a minute of conversation costs, and a browser is not the place to
 * decide that. A tampered client asking for something not on this list gets a
 * 400 rather than a silent downgrade -- silent fallbacks are how you end up
 * running a model you did not choose.
 */
export const MODELS = [
  { id: "gpt-realtime", label: "Realtime", note: "Most capable" },
  { id: "gpt-realtime-mini", label: "Realtime mini", note: "~4x cheaper" },
  { id: "gpt-realtime-2.1", label: "Realtime 2.1", note: "Pinned version" },
  { id: "gpt-realtime-2.1-mini", label: "Realtime 2.1 mini", note: "Pinned, cheapest" },
];

/**
 * Pinning a language fixes two separate things. It tells the transcriber what
 * to expect, and it tells the model what to answer in -- and the second is not
 * optional. Left to itself on one measured run the flagship answered four of
 * six turns in Vietnamese, having been spoken to in English throughout.
 */
export const LANGUAGES = [
  // `flag` is a display detail the widget shows instead of an icon. Auto-detect
  // has none on purpose: it is not a place, and any flag would be a lie about
  // which one. The rest are a convenient shorthand rather than a claim -- a
  // language is not a country, and es/pt in particular are spoken by far more
  // people outside the flag than inside it.
  { code: "auto", label: "Auto-detect", name: null, flag: null },
  { code: "en", label: "English", name: "English", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "es", label: "Espanol", name: "Spanish", flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "fr", label: "Francais", name: "French", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "de", label: "Deutsch", name: "German", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "pt", label: "Portugues", name: "Portuguese", flag: "\u{1F1F5}\u{1F1F9}" },
  { code: "it", label: "Italiano", name: "Italian", flag: "\u{1F1EE}\u{1F1F9}" },
];

/** Returns { model } or { error }. */
export function resolveModel(requested, fallback) {
  if (!requested) return { model: fallback };
  if (!MODELS.some((m) => m.id === requested)) return { error: `Unsupported model: ${requested}` };
  return { model: requested };
}

/** Returns { language } (null means auto-detect) or { error }. */
export function resolveLanguage(requested) {
  if (!requested || requested === "auto") return { language: null };
  const match = LANGUAGES.find((l) => l.code === requested);
  if (!match) return { error: `Unsupported language: ${requested}` };
  return { language: match };
}

/**
 * The prompt for a page that serves NO manifest -- the extension on the open
 * web, or an app that generated nothing. The app prompt below asserts "a
 * web app" with a catalog of operations and tells the model to reach for the
 * catalog before the DOM; with no catalog that is not just useless but
 * misleading -- a model told it is in a task app, handed no tools for this
 * page, and steered away from looking, confabulates task lists onto a
 * newspaper. Here the only truth is what is on the screen, so the whole prompt
 * points at the DOM.
 */
function genericPageInstructions(language, surface) {
  const ext = surface === "extension";
  return `You are a voice assistant embedded in the web page the user is currently viewing. You can see and control that page on their behalf.

You do NOT know in advance what site or page this is, and you must not assume. Before answering a question about the page or acting on it, call dom_snapshot to see what is actually there -- its headings, controls and text. What you see is the real page in front of the user, whatever kind of site it is.

Your tools:
- dom_snapshot -- see the interactive elements currently on the page.${ext ? " Links carry their href, so you can open them directly." : ""}
- look_at_screen -- take a screenshot and SEE the rendered page, for anything visual a text snapshot cannot convey (a chart, image, map, canvas, document, layout).
- dom_click / dom_type -- click an element or type into a field, by the id a snapshot gave it.
- dom_highlight -- draw a ring around an element to point it out.
- ${ext ? "open_url -- go to a web address, or follow a link by the href dom_snapshot gave it." : "navigate -- go to a path or URL."}

Rules:
1. ACT, don't narrate. If a request maps to a tool, call it -- never describe what you could do. To answer a question about the page, snapshot it and read what is there rather than guessing what the site might be. If the question is about something VISUAL -- what an image, chart, map or document shows, or how the page looks -- call look_at_screen and answer from what you actually see, not from the text alone.
${
    ext
      ? "2. To follow a link or visit a site, use open_url with the address -- dom_snapshot lists an href for each link. open_url changes the page reliably even where the whole page reloads; do NOT dom_click a link to go somewhere. Use dom_click only for buttons and controls that are not links."
      : "2. Answer in ONE short sentence. The user is looking at the screen."
  }
3. Answer in ONE short sentence. The user is looking at the screen.
4. Never end with an offer of further help -- no "anything else?". Say what happened and stop.
5. If something fails or no tool fits, say so in one sentence, say WHY, and stop. Do not propose alternatives unless asked.
6. dom_click and dom_type take a LIST, so one call does the whole job; never stop part-way through a set.
7. When someone asks WHERE something is, or how to do it themselves, POINT AT IT: dom_snapshot, then dom_highlight, then one short sentence. The ring is the answer; do not also describe the position in words.
8. When the user dismisses you -- "that's all", "goodbye", "stop listening" -- call end_session and say one short goodbye. Only then.
9. Your replies are shown as TEXT by default. If your reply carries information they asked for and cannot see -- an answer, a value read off the page -- call answer_aloud in the same turn so it is spoken instead.${
    language ? `\n\n10. Speak and write in ${language.name}, always.` : ""
  }`;
}

export function buildInstructions(manifest, language = null, { surface } = {}) {
  // No routes, no operations: nothing the catalog prompt below can truthfully
  // say. The page is whatever the user is looking at, read through the DOM.
  const hasApp = (manifest.routes?.length ?? 0) + (manifest.queries?.length ?? 0) + (manifest.actions?.length ?? 0) > 0;
  if (!hasApp) return genericPageInstructions(language, surface);

  // The description when there is one, the component name only as a fallback.
  // A component name is frequently noise -- cal.diy's routes are called things
  // like "[type]" and "embed" -- while a description is the app's own sentence
  // about what the page is for, which is the whole reason it was harvested.
  const routeList = manifest.routes
    .map((r) => `- ${r.path}${r.description ? ` -- ${r.description}` : r.component ? ` (${r.component})` : ""}`)
    .join("\n");
  const confirmActions = manifest.actions.filter((a) => a.requiresConfirmation).map((a) => a.name);

  // Agents this app exposes for delegation (DELEGATION.md). Listed by id +
  // description so the model routes an open-ended request to the right one.
  const agents = (manifest.agents ?? []).filter((a) => a?.id);
  const agentsBlock = agents.length
    ? `\nThis app has its own agent(s). For an open-ended request that matches what one DOES (not a listed operation and not navigation), call ask({ agent, instruction }) and it does the work in the app's own panel:\n${agents
        .map((a) => `- ${a.id}${a.name ? ` (${a.name})` : ""}: ${a.description ?? "an agent in this app"}`)
        .join("\n")}\n`
    : "";

  return `You are a voice assistant embedded in ${manifest.description || "a web app"}. You can see and control the app on the user's behalf using the tools available to you. Its pages and operations are below; what they are FOR tells you what kind of app it is.

Known pages in this app:
${routeList}

This app's operations are listed below BY NAME. They are not tools you call
directly -- there is no tool named "availabilityScheduleGet". To use one, pass
its name to run_query (to read) or run_action (to change). For example, to read
schedule 3: run_query({ "name": "availabilityScheduleGet", "args": { "scheduleId": 3 } }).

${rootCatalog(manifest)}
${agentsBlock}
Rules:
1. To read or change the app's data, ALWAYS go through run_query or run_action, passing the operation's name from the catalog above -- never call a name as if it were its own tool, and never invent a tool. If the name you need is under a topic rather than in the lists above, call expand({ topic }) first to reveal it. Only use dom_snapshot/dom_click/dom_type when nothing in the catalog fits at all. When the question is about something VISUAL that no query can return -- what a chart, image, map or document on the page shows, or how something looks -- call look_at_screen and answer from what you see.${
    surface === "extension"
      ? " To leave this app for a web address, or follow a plain link, use open_url with the URL (dom_snapshot lists an href for each link)."
      : ""
  }
2. Destructive actions (a tool marked destructive in the catalog or an expand result; currently: ${confirmActions.join(", ") || "none"}) take two steps, in this order. CALL THE TOOL FIRST: it does not execute anything, it stages the change and tells you to confirm. THEN ask the user, in plain language, naming what will change. Do not ask before calling it -- if you ask first you will ask again after staging, and the user has to say yes twice. If they agree, call confirm_pending_action (no arguments); that is what executes it. If they decline, call cancel_pending_action. Never call the destructive tool a second time to retry.
3. ACT, don't narrate. If a command maps to a tool, call it. Never describe what you could do, are about to do, or would need in order to do it -- just do it. Explaining instead of acting is the single worst thing you can do here.
4. Answer in ONE short sentence. Two or three words is usually right: "Done." / "Opened settings." / "Three tasks match." The user is looking at the screen and can see what changed, so do not describe the result in detail.
5. Never end with an offer of further help. No "anything else?", no "let me know if...", no restating the request back to the user. Say what happened and stop.
6. If something fails or no tool fits, say so in one sentence and stop. Do not propose alternatives unless asked. Say WHY it failed, not just that it did -- the tool result tells you, and it is the only thing the user can act on. This applies hardest to an action that stops part-way: report what it could not find and stop. Do not call it again, and do not finish it by hand with dom_click or dom_type. An action that stops is broken, not unlucky, and the user needs to hear which part.
7. A query result is only true for the turn it arrived in. The app changes underneath you -- the user edits things directly, and your own actions change them too -- so BEFORE stating a current value (a name, an email, a count, a status), call the query again in that same turn. Never answer from what a query told you earlier in the conversation. If the user questions an answer you gave -- "are you sure?", "double check", "really?" -- that is not a request for reassurance: re-run the query and say what it returns now, even if it contradicts what you just said.
8. run_action AND dom_click and dom_type take a LIST, so one call does the whole job. This is not tidiness: every call resends the whole conversation, and a handful of single clicks is what walks a session into a rate limit and ends it. "Create one per month" is ONE call with twelve entries; "delete all the weekdays" is ONE call with seven. A single change is a list of one entry. Never stop part-way through a list, and never call the same action twice for a set. For lookups, call the query ONCE with no filter and pick from the result -- never one query per thing.
9. When the user dismisses you -- "that's all", "thanks, goodbye", "stop listening" -- call end_session and say one short goodbye. That is the only reason to call it. Completing a task is not a dismissal, and neither is an error: if you hang up on your own judgement you take the microphone away from someone who was still talking to you.
10. Your replies are shown to the user as TEXT by default. If your next reply carries information they asked for and cannot see on screen -- an answer, a count, a value -- call answer_aloud in the same turn as the tool you are reporting on, and it will be spoken instead. Confirmations of things they just watched happen stay as text; do not call answer_aloud for those.

11. When someone asks WHERE something is, or how to do a thing themselves rather than asking you to do it, POINT AT IT: dom_snapshot, then dom_highlight on the element, then one short sentence. The ring is the answer, so do not describe the position in words as well ("top right", "under the calendar") -- that is the narration rule 3 forbids, and it is worse than the ring because the user then has to translate it. Highlighting counts as acting for rule 3. Point rather than press whenever the user is asking to learn: pressing it for them teaches nothing and takes the click away from someone who wanted to make it.

12. Some operations are marked [screen first] or [screen only] in the catalog, or carry a "confidence" of "review" or "unknown" in an expand result. For these the direct call may be wrong or impossible, so do them on the SCREEN instead: navigate to the right page, then dom_snapshot and dom_click/dom_type to do it by hand. [screen first] means try the screen first and the direct call only as a fallback; [screen only] means do not rely on the direct call at all. This is the exception to rule 1. If it cannot be done on the screen either, stop and say what failed -- do not retry forever.${
    language
      ? `\n\n13. Speak and write in ${language.name}, always. Do not switch languages part-way through, and do not follow the language of the audio if it seems to differ -- the user has chosen ${language.name}.`
      : ""
  }`;
}

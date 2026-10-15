// Tier-1 runtime fallback: perceive and act on whatever's actually
// rendered right now, for anything the static manifest doesn't cover.

let idCounter = 0;
const registry = new Map();

/**
 * Rendered at all: it has a box and nothing has hidden it.
 *
 * Split from "currently in the viewport", which is a different question and
 * used to be the same one. Anything below the fold was filtered out of every
 * snapshot, so the agent could not see a submit button until the page happened
 * to be scrolled to it -- and answered "where is the submit button?" by saying
 * there wasn't one. Scrolling is something we can do; not knowing is not.
 */
function isRendered(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function inViewport(el) {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/**
 * How an element identifies itself, in the three ways a step can ask for it.
 *
 * One function so the snapshot and the highlight agree: a highlight holds
 * these rather than the node, because React replaces nodes on almost every
 * state change and a ring pinned to a detached node points at nothing.
 *
 * These are the identifiers the PAGE carries, as opposed to the `el-N` the
 * snapshot hands out, which is ours and lives only until the next snapshot.
 * Emitted when the app wrote one and absent when it did not -- most apps are a
 * mix, so neither can be required.
 *
 * Worth having because a label is not unique and was never meant to be.
 * cal.com labels the button that opens a new schedule "New" and the one that
 * opens a new event type "New", and gives them data-testid="new-schedule" and
 * data-testid="new-event-type". A flow anchored to the label opens whichever
 * dialog the current page happens to offer.
 */
function describeElement(el) {
  const testId = el.getAttribute("data-testid") || undefined;
  return {
    // A test id shared by a dozen elements identifies none of them, and costs
    // tokens on every one. cal.diy renders eleven settings tabs all carrying
    // `data-testid="vertical-tab-undefined"` -- a template that interpolated
    // something absent. Worse than no test id, because a step anchored to it
    // matches whichever came first and looks deliberate.
    testId: testId && !testId.endsWith("-undefined") ? testId : undefined,
    domId: el.id || undefined,
    label: labelFor(el),
  };
}

/** A rich-text editor: contenteditable, but not an input or textarea. */
function isRichText(el) {
  return el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";
}

function labelFor(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText?.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.innerText.trim();
  }
  // Rich-text editors carry their placeholder in a data attribute, because the
  // real one only exists on inputs.
  const placeholder = el.placeholder || el.getAttribute("data-placeholder");
  if (placeholder) return placeholder;

  const wrapping = el.closest("label");
  if (wrapping) {
    const text = wrapping.innerText?.trim();
    if (text) return text.slice(0, 80);
  }

  // An editor's own text is its CONTENT, not its name, and using it as a label
  // means a field renamed itself every time someone typed. cal.diy's
  // description editor has no aria-label and no label element, so the visible
  // heading above it is the only thing that names it.
  if (isRichText(el)) return headingAbove(el);

  const text = el.innerText?.trim();
  if (text) return text.slice(0, 80);
  return el.getAttribute("title") || null;
}

/** The nearest short piece of text rendered directly above an element. */
function headingAbove(el) {
  let node = el;
  for (let hops = 0; hops < 4 && node; hops++) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      const text = sibling.innerText?.trim();
      // Short enough to be a name rather than a paragraph.
      if (text && text.length <= 40) return text;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * What the agent can see.
 *
 * The contenteditable entries are not decoration. Asked to fill in a
 * description, the agent found Title, URL and Duration in this list, no
 * description field at all, and typed the description into the URL. The field
 * was a `<div contenteditable role="textbox">` -- a rich-text editor, which is
 * how most apps render a description -- and it matched none of the tags here.
 *
 * `contenteditable="false"` is excluded deliberately: it marks a region as NOT
 * editable inside one that is.
 */
const SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");

/** Does being "checked" mean anything for this element? */
function isCheckable(el, role) {
  if (role === "checkbox" || role === "switch") return true;
  return el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
}

/**
 * Drops every absent field before the object is serialised.
 *
 * `undefined` disappears through JSON.stringify on its own, so this exists for
 * the ones that are present and empty. A snapshot of one cal.diy page ran to
 * 6739 characters, and every character of it is resent with every later turn
 * of the conversation -- cached, so it costs nothing in money, and counted in
 * full against the tokens-per-minute limit that ended a session.
 */
function prune(element) {
  for (const key of Object.keys(element)) {
    if (element[key] === undefined || element[key] === null || element[key] === "") delete element[key];
  }
  return element;
}

export function snapshot({ href = false } = {}) {
  registry.clear();
  const elements = Array.from(document.querySelectorAll(SELECTOR)).filter(isRendered);
  return elements.map((el) => {
    const id = `el-${idCounter++}`;
    // The node AND what it looked like, so an id survives a re-render. See
    // resolve().
    registry.set(id, { el, want: describeElement(el) });
    const rich = isRichText(el);
    const described = describeElement(el);
    const role = el.getAttribute("role") || (rich ? "textbox" : undefined);
    const tag = el.tagName.toLowerCase();
    const value = rich ? el.innerText?.trim().slice(0, 200) : "value" in el ? el.value : undefined;
    return prune({
      id,
      tag,
      // The role is what tells a div holding text apart from a div you press,
      // now that both can appear here. Dropped when it only repeats the tag,
      // which is most of the time: `<button role="button">` says nothing the
      // tag did not.
      role: role === tag ? undefined : role,
      // `type` on a <button> is "submit" or "button" and tells the model
      // nothing about what pressing it does; on an input it is the difference
      // between a date and a checkbox.
      inputType: tag === "input" ? el.type || undefined : undefined,
      editable: rich || undefined,
      ...described,
      // A domId that only restates the label is two copies of one fact.
      domId: described.domId === described.label ? undefined : described.domId,
      // `offscreen` rather than absent: the agent can scroll, so a thing it
      // cannot currently see is still a thing it can point at or press.
      offscreen: inViewport(el) ? undefined : true,
      // Where a link goes, so the model can open_url straight to it rather than
      // synthesising a click that a full-page reload may swallow. Opt-in (`href`)
      // because it is only useful where there is a browser to drive -- the
      // extension -- and a page full of links would otherwise add its URLs to
      // every snapshot the in-page widget resends. http(s) only: a "#", a
      // "javascript:" or a "mailto:" is not somewhere to navigate.
      href: href && el.tagName === "A" && /^https?:/i.test(el.href) ? el.href : undefined,
      // An empty field is the normal state of a field, and saying so for every
      // one of them is the single biggest line item in a page of inputs.
      value: value || undefined,
      // Only where being checked is a state the thing HAS. Every text input
      // carries `checked === false` as a property, so reporting it blindly put
      // a meaningless false on every field in every form.
      checked: isCheckable(el, role) ? el.checked : undefined,
    });
  });
}

/** The first rendered element matching a set of criteria, without a snapshot. */
function findLive(want) {
  return Array.from(document.querySelectorAll(SELECTOR))
    .filter(isRendered)
    .find((candidate) => matches(describeElement(candidate), want));
}

function resolve(elementId) {
  const entry = registry.get(elementId);
  if (!entry) throw new Error(`Unknown or stale element id: ${elementId}. Call dom_snapshot again.`);

  // An element captured before a re-render is still a perfectly good object
  // that is no longer in the page. Clicking it does nothing, silently, and
  // reports success -- which reads to the user as the agent ignoring them.
  // React replaces nodes on almost every state change, so this is the common
  // case after any action, not an edge one.
  //
  // Re-found by what it looked like rather than surrendered. Every "call
  // dom_snapshot again" is a round trip AND a fresh copy of the whole page
  // resent with every later turn -- which is what walked a session into a
  // token-per-minute limit. The id is a handle to a thing, not to a node.
  if (!entry.el.isConnected) {
    const again = findLive(entry.want);
    if (!again) {
      throw new Error(`Element ${elementId} (${describe(entry.want)}) is no longer on the page. Call dom_snapshot again.`);
    }
    entry.el = again;
  }
  return entry.el;
}

/** Click a resolved element. The shared core of click() and delegation's "send". */
function clickElement(el) {
  el.scrollIntoView({ block: "center" });
  el.click();
}

export function click(elementId) {
  clickElement(resolve(elementId));
}

/**
 * React installs its own `value` setter on the element, so assigning
 * `el.value` updates the DOM without the component ever hearing about it. The
 * prototype's original setter is the one React's onChange listens behind.
 *
 * Read on first use rather than at module scope. At module scope this touched
 * `window` the instant the bundle was evaluated, which made the whole package
 * unimportable anywhere there is no DOM -- it threw "window is not defined"
 * during a server render before a single component was used. Found by
 * installing the built tarball into a Next.js app, which is the only place
 * that could have found it: every test we had runs in a browser or imports
 * the source directly.
 */
let nativeValueSetters = null;
function nativeValueSetter(tagName) {
  nativeValueSetters ??= {
    INPUT: Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set,
    TEXTAREA: Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set,
  };
  return nativeValueSetters[tagName];
}

export function typeText(elementId, text) {
  fillElement(resolve(elementId), text);
}

/** Put `text` into a resolved field, the React/rich-text-safe way. Shared by
 *  typeText() and delegation (which types into the app's own chat input). */
function fillElement(el, text) {
  // Same reason `click` does it: now that a snapshot reports what is below the
  // fold, the element handed back may not be on screen, and a field being
  // filled that the user cannot see is the widget working in secret.
  el.scrollIntoView({ block: "center" });
  el.focus();

  /**
   * A rich-text editor has no `value` to set. Its content is DOM, and the
   * editor keeps its own model of that DOM -- Lexical, ProseMirror and Quill
   * all do -- so assigning textContent changes what is on screen and leaves
   * the model behind it untouched, which the next keystroke overwrites.
   *
   * They all listen for beforeinput/input instead, which is what
   * execCommand("insertText") produces. Deprecated, and still the only
   * instruction every one of them understands.
   */
  if (isRichText(el)) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    if (!document.execCommand("insertText", false, text)) {
      // Last resort. Visibly correct, and possibly not what the editor thinks.
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  const setter = nativeValueSetter(el.tagName);
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const delegateSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Delegate an instruction to the app's OWN agent by driving its chat UI -- the
 * `ui` transport in DELEGATION.md. We type into the app's real chat input and
 * send, so the turn shows in the app's own panel and its own hooks fire; then we
 * wait for the turn to finish and read back what it said, to narrate by voice.
 *
 *   ui = { input, send?, transcript?, done?, attach? }   -- CSS selectors
 *   done = { appears } | { gone } | { enabled } | { settles: true } | undefined
 */
export async function delegate(ui = {}, instruction, { maxMs = 180_000 } = {}) {
  const input = ui.input && document.querySelector(ui.input);
  if (!input) return { error: `Could not find the agent's chat input (${ui.input ?? "no selector given"}).` };

  const log = ui.transcript ? document.querySelector(ui.transcript) : null;
  const before = log ? (log.innerText ?? "").trim() : "";
  const rawBefore = log ? (log.innerText ?? "") : ""; // the quiet-transcript check's baseline

  fillElement(input, instruction);
  // Send with the declared control, else Enter on the input (what most chats bind).
  const sendBtn = ui.send ? document.querySelector(ui.send) : null;
  if (sendBtn) clickElement(sendBtn);
  else pressEnter(input);

  const settled = await waitForTurn(ui.done, log, maxMs, rawBefore);
  const after = log ? (log.innerText ?? "").trim() : "";
  const reply = replyDelta(before, after);

  return {
    status: settled.done ? "completed" : "sent",
    ...(reply ? { reply } : {}),
    ...(settled.done
      ? {}
      : { note: "Sent, but could not confirm the turn finished. Snapshot or ask the user to check." }),
  };
}

function pressEnter(el) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
}

/**
 * Wait for a delegated turn to finish, per the agent's `done` signal. A declared
 * signal is polled directly; with none (or `settles`), we fall back to "the
 * transcript started changing and then went quiet", which needs a transcript.
 */
async function waitForTurn(done, log, maxMs, baseline = "") {
  const start = Date.now();
  const poll = 80;
  const over = () => Date.now() - start > maxMs;

  const signal = () => {
    if (!done) return null;
    if (done.appears) return !!document.querySelector(done.appears);
    if (done.gone) return !document.querySelector(done.gone);
    if (done.enabled) { const e = document.querySelector(done.enabled); return !!e && !e.disabled; }
    return null; // { settles:true } -> fall through to the quiet-transcript check
  };

  if (signal() !== null) {
    while (!over()) {
      if (signal() === true) return { done: true };
      await delegateSleep(poll);
    }
    return { done: false };
  }

  // Fallback: the transcript changes (vs. before we sent), then stops for ~600ms.
  let last = baseline;
  let changed = false;
  let quiet = 0;
  while (!over()) {
    await delegateSleep(poll);
    const now = log ? log.innerText : "";
    if (now !== last) { changed = true; quiet = 0; last = now; }
    else if (changed && (quiet += poll) >= 600) return { done: true };
  }
  return { done: changed };
}

/** The new text the agent added: the suffix of `after` beyond `before`, trimmed
 *  to something speakable (the full turn stays visible in the app's own panel). */
function replyDelta(before, after) {
  if (!after) return "";
  const delta = after.startsWith(before) ? after.slice(before.length).trim() : after;
  return delta.length > 600 ? delta.slice(-600).trim() : delta;
}

/**
 * A flow: several interactions that together do one thing.
 *
 * Some of what an app can do has no URL and no endpoint. Creating an event
 * type in cal.diy opens a dialog with four fields and a Continue button, and
 * the address bar never changes. The agent could only reach it by taking a
 * snapshot, guessing which element was which, and clicking around -- which is
 * exactly how it typed a description into a URL field.
 *
 * Modelled as an ACTION rather than as a new kind of thing, because that is
 * what it is: it takes named inputs, changes something, and is what a person
 * asks for. The only difference from an HTTP action is that it executes as a
 * sequence of interactions. The model calls action_createEventType with three
 * fields and never learns that a dialog exists.
 *
 * Steps target by LABEL first. Selectors break on every redesign, and a label
 * is both what dom_snapshot already reports and what the person asking would
 * have said. But a label is not unique and was never meant to be, so a step
 * may also carry `testId` or `domId`, and then BOTH have to match.
 *
 * Enrich, never replace. Some apps write a data-testid on everything, some on
 * nothing, and most are in between; a flow against a bare app has the label
 * and has to work with it. So an identifier constrains a step when the app
 * happens to provide one and is silent when it does not.
 *
 * What that buys, from the run that prompted it: cal.diy labels the button
 * opening a new schedule "New" and the one opening a new event type "New".
 * `click: "New"` from the availability page opened the schedule dialog, then
 * spent four seconds looking for a field called "Title" that a schedule
 * dialog does not have, and stopped. With `testId: "new-event-type"` it stops
 * at step one instead, which is both faster and the truth.
 *
 * `page` is the other half and a different guarantee: the identifier says
 * WHICH element, the page says WHERE the flow is valid. Checked once before
 * anything is clicked, so a flow aimed at the wrong screen never opens
 * anything at all.
 */
export async function runFlow(steps = [], args = {}, { page, timeoutMs = 4000, pollMs = 100 } = {}) {
  const performed = [];

  if (page && !onPage(page)) {
    return {
      status: "stopped",
      at: "before step 1",
      because: `this flow runs on ${page} and the app is on ${location.pathname}`,
      completed: performed,
      hint: `Navigate to ${page} first, then call this again.`,
    };
  }

  for (const [index, step] of steps.entries()) {
    const label = step.click ?? step.type ?? step.check;
    const want = { label, testId: step.testId, domId: step.domId };
    const named = step.testId ?? step.domId ?? label;
    const at = `step ${index + 1} of ${steps.length} ("${named}")`;

    // A field with nothing to put in it is skipped, not failed. That is what
    // makes optional inputs optional: the model omits `description` and the
    // flow simply does not visit it.
    if (step.type) {
      const value = args[step.from ?? step.type];
      if (value === undefined || value === null || value === "") {
        performed.push({ step: index + 1, skipped: `no value for ${step.from ?? step.type}` });
        continue;
      }
      const el = await waitForTarget(want, timeoutMs, pollMs);
      if (!el) return stopped(at, performed, `could not find a field matching ${describe(want)}`);
      typeText(el.id, String(value));
      performed.push({ step: index + 1, typed: label });
      continue;
    }

    const el = await waitForTarget(want, timeoutMs, pollMs);
    if (!el) return stopped(at, performed, `could not find ${describe(want)}`);
    click(el.id);
    performed.push({ step: index + 1, clicked: label });
  }

  return { status: "completed", steps: performed };
}

/**
 * Stopping midway is a real state, not just a failure.
 *
 * A flow that filled two fields and could not find the third has left a
 * half-completed dialog on screen. Saying only "it failed" invites the model
 * to start again from the top, which fills the first two fields twice.
 */
/**
 * Is the app on the page this flow was written for?
 *
 * Segment-wise, with `:param` and `[param]` matching any one segment, so a
 * flow declared for /availability/:id runs on /availability/49. Both spellings
 * because the manifest carries whichever the app's own router uses.
 *
 * A prefix would be wrong: /availability would then satisfy a flow written for
 * /availability/49, which is a different screen with different buttons.
 */
export function onPage(page, path = location.pathname) {
  const want = String(page).split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return false;
  return want.every((seg, i) => seg.startsWith(":") || (seg.startsWith("[") && seg.endsWith("]")) || seg === have[i]);
}

/**
 * What a step was looking for, in the words the step used.
 *
 * Named so a failure says which criterion it was, rather than "could not find
 * New" when the step was actually anchored to a test id. The reason a flow
 * stopped is the whole value of stopping.
 */
function describe(want) {
  const parts = [];
  if (want.label) parts.push(`"${want.label}"`);
  if (want.testId) parts.push(`data-testid="${want.testId}"`);
  if (want.domId) parts.push(`id="${want.domId}"`);
  return parts.join(" with ") || "an unnamed element";
}

/**
 * A flow that could not finish, and what the model is to do about it.
 *
 * The hint reads and does not write, and that is the whole line. Looking at
 * where the app got to is how the model tells the user something they can act
 * on -- "the dialog is open, nothing was saved" -- and rule 6 in the session
 * prompt separately forbids finishing the job with dom_click or dom_type. So
 * this may say "go and look" without inviting improvisation: the read is here,
 * the ban on writing is there, and between them the model can diagnose without
 * being able to repair.
 *
 * That split matters because a flow that cannot find its own field is a
 * MANIFEST bug. A model clever enough to route around it hides the bug and
 * ships a flow that only works when the model is clever. Reporting the state
 * costs nothing and is the thing that gets the manifest fixed.
 *
 * `because` names the criterion that failed, and rule 6 requires it be said
 * rather than swallowed. The one sentence the model is allowed has to carry
 * the diagnosis: without it the user watches a dialog open and nothing happen,
 * which is exactly how this was found.
 */
function stopped(at, performed, because) {
  return {
    status: "stopped",
    at,
    because,
    completed: performed,
    hint: "The app is part-way through this flow. Take a dom_snapshot to see where it is rather than starting over.",
  };
}


/**
 * Waits for a labelled element to exist.
 *
 * Clicking "New" opens a dialog, and the dialog is not there on the next line
 * of JavaScript. Without waiting, every flow whose first step opens something
 * fails on its second step.
 */
/**
 * Every criterion a step gave us has to match. Criteria the step left out are
 * not checked, so a step carrying only a label behaves exactly as before.
 *
 * This is the constraining half of the pair. `testId` and `domId` narrow a
 * label that is not unique; they do not replace it. Plenty of apps write
 * neither, and a flow against one of those has nothing but the label and has
 * to work anyway -- which is why an absent criterion is silence rather than a
 * failed match.
 */
function matches(element, want) {
  if (want.testId && element.testId !== want.testId) return false;
  if (want.domId && element.domId !== want.domId) return false;
  if (!want.label) return true;
  const wanted = String(want.label).trim().toLowerCase();
  const seen = (element.label ?? "").trim().toLowerCase();
  return seen === wanted || seen.startsWith(`${wanted}:`) || seen.startsWith(`${wanted} `);
}

async function waitForTarget(want, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = snapshot().filter((e) => matches(e, want));
    // What is on screen beats what is not, then the shortest label containing
    // the word, which prefers "Title" over "Title of the recurring event".
    // Ordering rather than filtering: a field below the fold is still the
    // right field when it is the only one, and typing scrolls to it.
    if (found.length) {
      return found.sort(
        (a, b) => (a.offscreen ? 1 : 0) - (b.offscreen ? 1 : 0) || (a.label ?? "").length - (b.label ?? "").length,
      )[0];
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A cheap read of what page this is -- its <title> and main heading. The L0 of
 * the live-context loop: enough to orient the model ("you are on the Projects
 * page") without a full interactive snapshot, and it rides the navigate result
 * rather than a separate conversation item, so there is nothing to evict.
 */
export function pageContext() {
  if (typeof document === "undefined") return {};
  const title = document.title?.trim() || undefined;
  // The first <h1> with text -- the page's own name for itself, when it has one.
  const h1 = Array.from(document.querySelectorAll("h1")).find((el) => isRendered(el) && el.innerText?.trim());
  const heading = h1?.innerText?.trim().slice(0, 120) || undefined;
  return prune({ title, heading });
}

/**
 * Is a readiness marker present? Anywhere in the page, not only among the
 * things you can press.
 *
 * The rest of this module deliberately looks at interactive elements only --
 * that is what an agent can act on. A page's "I am ready" marker is usually
 * not one of those: it is the list that wraps the results, the heading of the
 * section, the container the data renders into. cal.diy's event type list is a
 * <ul data-testid="event-types">, which the interactive selector will never
 * see. So a test id or an element id is matched against the whole document,
 * and only a `label` falls back to the interactive search, since a label is a
 * property of a control.
 */
/**
 * An identifier, or a shape an identifier has.
 *
 * `*` stands for the part that varies. It exists because the interesting
 * markers are frequently NOT constants: cal.diy's schedule switches are
 * written `data-testid={\`\${weekday}-switch\`}`, so the element is
 * `Sunday-switch` in English and `Domingo-switch` in Spanish. Waiting for the
 * English one works until someone changes language, and `*-switch` works for
 * both -- while still being specific enough to mean "the schedule editor has
 * rendered".
 *
 * That the pattern is available at all is the point: a template literal in the
 * source spells out every part except the hole, so the SHAPE is knowable
 * statically even when the value is not.
 *
 * Compiled to an attribute selector rather than a regex. CSS already has
 * prefix, suffix and contains matching, so `*-switch` is `[data-testid$=...]`
 * and the browser does the work at native speed on every poll.
 */
function selectorFor(attribute, pattern) {
  const parts = String(pattern).split("*");
  if (parts.length === 1) return `[${attribute}="${CSS.escape(pattern)}"]`;
  // All wildcard and nothing else would match the entire page, which is not a
  // readiness signal, it is a way of always being ready.
  if (!parts.some(Boolean)) return null;
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  const clauses = [];
  if (first) clauses.push(`[${attribute}^="${CSS.escape(first)}"]`);
  if (last) clauses.push(`[${attribute}$="${CSS.escape(last)}"]`);
  // Anything between the ends has to be present, though not in any order CSS
  // can express. Good enough: the ends carry nearly all the specificity.
  for (const middle of parts.slice(1, -1)) {
    if (middle) clauses.push(`[${attribute}*="${CSS.escape(middle)}"]`);
  }
  return clauses.join("");
}

function isThere(want) {
  if (want.testId) {
    const selector = selectorFor("data-testid", want.testId);
    if (selector && document.querySelector(selector)) return true;
  }
  if (want.domId) {
    const selector = selectorFor("id", want.domId);
    if (selector && document.querySelector(selector)) return true;
  }
  if (want.testId || want.domId) return false;
  return !!findLive(want);
}

/**
 * How many labelled, usable controls the page currently has.
 *
 * Labelled only: a skeleton's placeholder boxes are not things you can press
 * or fill, so counting them would call a skeleton "settled".
 */
function countControls() {
  return Array.from(document.querySelectorAll(SELECTOR)).filter((el) => isRendered(el) && labelFor(el)).length;
}

/**
 * Wait for a page to be worth looking at.
 *
 * A snapshot taken too early is not empty, it is WRONG: it reports the app
 * shell and nothing else, and the model reads that as "the thing you asked
 * about is not on this screen". That is exactly how a working session ended --
 * navigate, snapshot 420ms later, conclude the availability editor did not
 * exist, and leave the one page that could have done the job.
 *
 * Two ways to know, and the declared one is always better.
 *
 * `readyWhen` is the page saying what "ready" looks like: the criteria of an
 * element that only exists once the real content is there. It is exact, it
 * returns the moment that element appears, and because we know what we are
 * waiting for it is safe to wait a while.
 *
 * Without it we have to guess, and the obvious guesses are all wrong. Network
 * idle never happens in an app that polls. Mutation quiescence returns on a
 * STABLE SKELETON, which is the trap -- a skeleton that has finished rendering
 * is perfectly quiet. And a spinner is often animated in CSS, mutating nothing
 * at all, so watching mutations sees a settled page while it spins.
 *
 * So the fallback watches the thing the agent actually cares about: how many
 * labelled, interactive elements exist. Skeletons are divs and contribute
 * almost none; when content arrives the count jumps. It ignores CSS animation
 * completely. It is still a guess, so its cap is short and it says when it ran
 * out rather than claiming the page was ready.
 */
export async function waitForPage({ readyWhen = null, declaredMs = 8000, guessMs = 1200, quietMs = 250, pollMs = 60 } = {}) {
  const wanted = (Array.isArray(readyWhen) ? readyWhen : readyWhen ? [readyWhen] : []).filter(Boolean);

  if (wanted.length) {
    /**
     * The marker, or a page that has clearly stopped arriving. Whichever
     * comes first.
     *
     * A declared marker is only ever a claim about a page with content in it.
     * Wait for `*-switch` on a schedule that has no days, or for a row on a
     * list with nothing in it, and it never appears -- not because the page is
     * slow but because there is nothing to render. Holding the full timeout
     * there punishes the empty case hardest, and the empty case is the one a
     * new user sees first.
     *
     * So the settle heuristic runs alongside, with a much longer quiet window
     * than it gets on its own. Long, because it is a tie-breaker here rather
     * than the answer: a page whose shell settles at 450ms must not be allowed
     * to beat a marker that is genuinely still coming. Three consecutive quiet
     * seconds against an eight second ceiling means a slow page is still
     * waited for and an empty one gives up in a third of the time.
     *
     * Either way it says which happened. "The marker appeared" is knowledge;
     * "nothing has changed for a while" is a guess, and §35's rule is that a
     * guess never gets to claim readiness.
     */
    const deadline = Date.now() + declaredMs;
    // A third of the budget, never less than six quiet windows. Tied to the
    // budget rather than a flat number because the two cases pull opposite
    // ways and there is no threshold that serves both: too short and a marker
    // that was genuinely still coming gets abandoned, too long and an empty
    // page is punished for being empty. Whoever raises `declaredMs` because
    // their app is slow gets proportionally more patience, which is what they
    // meant by raising it.
    const patience = Math.max(quietMs * 6, declaredMs / 3);
    let last = -1;
    let steadySince = Date.now();

    for (;;) {
      if (wanted.every(isThere)) return { ready: true, by: "declared" };

      const count = countControls();
      const now = Date.now();
      if (count !== last) {
        last = count;
        steadySince = now;
      } else if (now - steadySince >= patience) {
        return {
          ready: false,
          by: "declared",
          assumed: true,
          settledWithout: wanted.filter((w) => !isThere(w)).map(describe),
        };
      }
      if (now >= deadline) {
        return { ready: false, by: "declared", missing: wanted.filter((w) => !isThere(w)).map(describe) };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Undeclared, we can only guess, and the guess CANNOT tell a finished page
   * from a shell that has stopped changing.
   *
   * A page whose chrome renders in 200ms and whose content arrives at two
   * seconds is stable on its shell from about 450ms. Waiting longer does not
   * help and neither does a bigger cap: the cap is only ever reached by a page
   * that never stops changing at all. Stability is simply not evidence of
   * readiness, and there is no undeclared signal that is.
   *
   * So this never reports readiness, only that it stopped waiting, and says
   * the reading was assumed. The caller turns that into an instruction to look
   * again rather than conclude something is absent -- which costs one extra
   * snapshot in the bad case, against abandoning the task in the bad case
   * before. `readyWhen` on the route is the actual fix; this is what honesty
   * looks like in its absence.
   */
  const deadline = Date.now() + guessMs;
  let last = -1;
  let steadySince = Date.now();
  for (;;) {
    const count = countControls();
    const now = Date.now();
    if (count !== last) {
      last = count;
      steadySince = now;
    } else if (now - steadySince >= quietMs) {
      return { ready: false, by: "settled", assumed: true };
    }
    if (now >= deadline) return { ready: false, by: "settled", assumed: true, stillChanging: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A list of interactions, in order, as ONE call.
 *
 * Rule 8 has always said every action tool takes a list, and the DOM
 * primitives were not action tools, so they never did. That gap only shows on
 * the path the model reaches for when the manifest covers nothing -- which is
 * where it spends its time in an app the manifest under-describes. Asked to
 * turn on Saturday and Sunday, it had to spend two round trips on two
 * switches, and each round trip resends the whole conversation. Three
 * snapshots and a handful of single clicks is what crossed a 40,000
 * tokens-per-minute ceiling in a two-minute session.
 *
 * Stops at the first failure and reports what it managed, the same shape a
 * flow uses. A batch that carried on past a failed step would be worse than
 * single calls: the model would learn the outcome of six interactions at once
 * with no idea which of them the page was in a fit state for.
 */
export function runSteps(steps = []) {
  const done = [];
  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1} of ${steps.length}`;
    try {
      if (step.text !== undefined) {
        typeText(step.elementId, step.text);
        done.push({ step: index + 1, typed: step.elementId });
      } else {
        click(step.elementId);
        done.push({ step: index + 1, clicked: step.elementId });
      }
    } catch (err) {
      return { status: "stopped", at, because: err.message, completed: done };
    }
  }
  return { status: "completed", steps: done };
}

/**
 * Pointing at something, as opposed to pressing it.
 *
 * The whole reason this is cheap: the overlay already exists. It is a
 * viewport-sized fixed box in a shadow root, mounted outside the host tree, in
 * the browser's top layer, with `pointer-events: none` -- which is exactly
 * what drawing over an app you do not control requires, and it was built for
 * the listening rim. A ring is one more layer in it.
 *
 * The target is held as CRITERIA, never as a node. React replaces nodes on
 * almost every state change, so a ring pinned to a node points at nothing a
 * moment later; `liveTarget()` re-finds it from what it looked like.
 *
 * A read, so it needs no confirmation and can damage nothing. It is also the
 * answer to a question the widget could not previously answer at all: "where
 * is the submit button" was unanswerable while snapshots stopped at the fold.
 */
let spotlight = null; // { want }
const watchers = new Set();

/** Called with the target's criteria, or null when it clears. */
export function subscribeHighlight(fn) {
  watchers.add(fn);
  fn(spotlight?.want ?? null);
  return () => watchers.delete(fn);
}

const announce = () => watchers.forEach((fn) => fn(spotlight?.want ?? null));

export function highlight(elementId) {
  const el = resolve(elementId);
  const want = describeElement(el);
  if (!want.testId && !want.domId && !want.label) {
    return { error: `Element ${elementId} has nothing to identify it by, so a highlight could not follow it.` };
  }
  spotlight = { want };
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  announce();
  return { status: "highlighted", ...want };
}

export function clearHighlight() {
  if (!spotlight) return;
  spotlight = null;
  announce();
}

/**
 * Where the highlighted element is right now, or null if it has gone.
 *
 * Deliberately does NOT call snapshot(): that clears the registry, which would
 * invalidate every `el-N` the model is holding. Re-finding a ring's target
 * must not pull the ground out from under the model's next dom_click.
 */
export function highlightRect() {
  if (!spotlight) return null;
  const el = findLive(spotlight.want);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // The element's own corner radius travels with its box, so a ring around a
  // pill is a pill and a ring around a circle is a circle. A fixed radius is
  // the tell that a highlight was drawn by something that never looked at what
  // it was pointing at.
  const style = window.getComputedStyle(el);
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    radius: [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ],
  };
}

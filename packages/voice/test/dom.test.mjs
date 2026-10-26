import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, startHarness } from "./harness.mjs";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/domActions.js"), "utf8");

/**
 * The DOM tools are what carries the product on an app whose data layer we
 * cannot read, and every case here is a failure observed on a real one.
 */
describe("what the agent can see and touch", { concurrency: false }, () => {
  let browser;
  let harness;
  let page;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
    page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { snapshot, typeText, click, pageContext };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  const field = (label) =>
    page.evaluate((wanted) => window.__dom.snapshot().find((e) => e.label === wanted), label);

  test("pageContext reads the page's own name for the L0 live context", async () => {
    // The cheap orientation read that rides the navigate result: the page's
    // <title> and its first rendered <h1>, no full snapshot.
    const ctx = await page.evaluate(() => {
      document.title = "Field Test";
      const h = document.createElement("h1");
      h.textContent = "  Your work  ";
      document.body.prepend(h);
      const out = window.__dom.pageContext();
      h.remove();
      return out;
    });
    assert.equal(ctx.title, "Field Test");
    assert.equal(ctx.heading, "Your work", "the visible heading is trimmed and returned");
  });

  test("href is opt-in, http(s) only, and never leaks into the widget's snapshot", async () => {
    // The extension asks for href so it can open_url straight to a link; the
    // in-page widget does not, so a page full of links never adds its URLs to
    // every snapshot the widget resends.
    const links = await page.evaluate(() => {
      const mk = (href, text) => {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = text;
        a.id = `probe-${text}`;
        document.body.appendChild(a);
        return a;
      };
      mk("https://example.com/story", "story");
      mk("mailto:x@y.z", "mail");
      const withHref = window.__dom.snapshot({ href: true });
      const without = window.__dom.snapshot();
      document.querySelectorAll('[id^="probe-"]').forEach((n) => n.remove());
      const pick = (list, label) => list.find((e) => e.label === label);
      return {
        story: pick(withHref, "story")?.href,
        mail: pick(withHref, "mail")?.href,
        storyDefault: pick(without, "story")?.href,
      };
    });
    assert.equal(links.story, "https://example.com/story", "an http link carries its href when asked");
    assert.equal(links.mail, undefined, "mailto: is not somewhere to navigate");
    assert.equal(links.storyDefault, undefined, "the default snapshot has no href");
  });

  test("a rich-text editor is visible at all", async () => {
    // It is a <div contenteditable role="textbox">, which matched none of the
    // tags collected before. Asked to fill in a description on cal.diy, the
    // agent saw Title, URL and Duration, no description, and typed the
    // description into the URL.
    const editor = await field("Description");
    assert.ok(editor, "the editor is still invisible to dom_snapshot");
    assert.equal(editor.role, "textbox");
    assert.equal(editor.editable, true, "nothing distinguishes it from a div you press");
  });

  test("it is named by the heading above it", async () => {
    // It has no aria-label, no <label for>, and no placeholder attribute. The
    // visible heading is the only thing that names it.
    assert.equal((await field("Description")).label, "Description");
  });

  test("its own text is reported as content, never as its name", async () => {
    // Using innerText as the label meant the field renamed itself the moment
    // anyone typed into it.
    const editor = await field("Description");
    await page.evaluate((id) => window.__dom.typeText(id, "A quick video meeting."), editor.id);
    const after = await field("Description");
    assert.equal(after.label, "Description", "the label followed the content");
    assert.equal(after.value, "A quick video meeting.");
  });

  test("typing reaches it through events, not by assignment", async () => {
    // A rich-text editor keeps its own model of its DOM, so assigning
    // textContent changes the screen and leaves the model behind it, which the
    // next keystroke overwrites. execCommand("insertText") is the instruction
    // every editor understands.
    assert.match(source, /execCommand\("insertText"/);
    const editor = await field("Description");
    const events = await page.evaluate((id) => {
      const el = document.getElementById("host-editor");
      const seen = [];
      for (const type of ["beforeinput", "input", "change"]) el.addEventListener(type, () => seen.push(type));
      window.__dom.typeText(id, "hello");
      return seen;
    }, editor.id);
    assert.ok(events.includes("input"), `an editor listening for input heard nothing (${events})`);
  });

  test("an ordinary input still works the old way", async () => {
    const title = await field("Title");
    await page.evaluate((id) => window.__dom.typeText(id, "Quick chat"), title.id);
    assert.equal(await page.inputValue("#host-title"), "Quick chat");
  });

  test("a dropdown takes one of its options, by value or by what it shows; any other is an error", async () => {
    const out = await page.evaluate(() => {
      const select = document.createElement("select");
      select.id = "host-theme";
      select.setAttribute("aria-label", "Theme");
      for (const [value, text] of [["light", "Light"], ["dark", "Dark"]]) select.add(new Option(text, value));
      let changes = 0;
      select.addEventListener("change", () => changes++);
      document.body.append(select);
      const id = window.__dom.snapshot().find((e) => e.label === "Theme").id;
      window.__dom.typeText(id, "Dark");
      const byText = select.value;
      window.__dom.typeText(id, "light");
      const byValue = select.value;
      let error = null;
      try {
        window.__dom.typeText(id, "blue");
      } catch (err) {
        error = err.message;
      }
      const after = select.value;
      select.remove();
      return { byText, byValue, after, error, changes };
    });
    assert.equal(out.byText, "dark");
    assert.equal(out.byValue, "light");
    assert.equal(out.after, "light", "a choice it does not have changed it anyway");
    assert.match(out.error, /not one of this dropdown's options: Light, Dark/);
    assert.equal(out.changes, 2);
  });

  test("an element that left the page says so instead of doing nothing", async () => {
    // React replaces nodes on almost every state change, so an id captured
    // before an action is routinely detached after it. Clicking a detached
    // node does nothing, silently, and reports success -- which reads to the
    // user as the agent ignoring them.
    const failure = await page.evaluate(() => {
      const snapshot = window.__dom.snapshot();
      const target = snapshot.find((e) => e.label === "Title");
      document.getElementById("host-title").remove();
      try {
        window.__dom.click(target.id);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    assert.ok(failure, "clicking a detached element reported success");
    assert.match(failure, /no longer on the page/);
    assert.match(failure, /dom_snapshot again/, "the message has to say what to do next");
  });
});

/**
 * Flows: several interactions that together do one thing.
 *
 * Some of what an app can do has no URL and no endpoint. Creating an event
 * type in cal.diy opens a dialog with four fields, and the address bar never
 * changes. The agent could reach it only by snapshotting, guessing which
 * element was which, and clicking around -- which is how it typed a
 * description into a URL field.
 */
/**
 * Pointing at something instead of pressing it, which is what makes the widget
 * usable for teaching an app rather than only for operating it.
 */
/**
 * Rule 8 has always said every action tool takes a list. The DOM primitives
 * were not action tools, so they never did -- and that is the path the model
 * falls back to whenever the manifest covers nothing, which is where it spends
 * its time in an app the manifest under-describes.
 */
describe("doing several things in one call", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { snapshot, runSteps };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
    return page;
  }
  // ONE snapshot for every id a test needs. Each snapshot clears the registry
  // on purpose: an id is only meaningful against the page it was taken from,
  // and letting an old one resolve after a navigation is how a click lands on
  // a same-named button somewhere else entirely.
  const idsOf = (page, labels) =>
    page.evaluate((wanted) => {
      const els = window.__dom.snapshot();
      return wanted.map((l) => els.find((e) => (e.label ?? "").trim() === l)?.id);
    }, labels);

  test("a list of interactions runs in order, as one call", async () => {
    // Asked to turn on Saturday and Sunday, it had to spend two round trips on
    // two switches -- and every round trip resends the whole conversation,
    // which is what walked a real session into a rate limit.
    const page = await fresh();
    const [title, notes] = await idsOf(page, ["Title", "Add detail"]);
    const result = await page.evaluate(
      ([t, n]) => window.__dom.runSteps([{ elementId: t, text: "Filled" }, { elementId: n }]),
      [title, notes],
    );

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.steps.length, 2);
    assert.equal(await page.inputValue("#host-title"), "Filled");
    await page.close();
  });

  test("it stops at the first failure and says what it managed", async () => {
    // Carrying on past a failure would be worse than single calls: the model
    // would learn the outcome of six interactions at once with no idea which
    // of them the page was in a fit state for.
    const page = await fresh();
    const [title] = await idsOf(page, ["Title"]);
    const result = await page.evaluate(
      (t) => window.__dom.runSteps([{ elementId: t, text: "Half" }, { elementId: "el-nope" }]),
      title,
    );

    assert.equal(result.status, "stopped");
    assert.match(result.at, /step 2 of 2/);
    assert.deepEqual(result.completed, [{ step: 1, typed: title }]);
    assert.equal(await page.inputValue("#host-title"), "Half", "the partial state is real, and stays");
    await page.close();
  });

  test("an id survives the element being re-rendered", async () => {
    // React replaces nodes on almost every state change, and every "call
    // dom_snapshot again" is a round trip AND a fresh copy of the whole page
    // resent with every later turn. The id is a handle to a thing, not a node.
    const page = await fresh();
    const [title] = await idsOf(page, ["Title"]);
    await page.evaluate(() => {
      const old = document.getElementById("host-title");
      old.replaceWith(old.cloneNode(true));
    });
    const result = await page.evaluate((t) => window.__dom.runSteps([{ elementId: t, text: "still works" }]), title);

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await page.inputValue("#host-title"), "still works");
    await page.close();
  });

  test("a snapshot leaves out what it cannot mean", async () => {
    const page = await fresh();
    const els = await page.evaluate(() => window.__dom.snapshot());
    const text = els.find((e) => e.tag === "input" && e.inputType === "text");
    assert.ok(text, "no text input in the harness");
    assert.equal("checked" in text, false, "a text input reported whether it was checked");
    assert.equal(
      els.some((e) => (e.testId ?? "").endsWith("-undefined")),
      false,
      "a test id shared by everything identifies nothing and costs tokens on each",
    );
    assert.equal(els.some((e) => e.role && e.role === e.tag), false, "role repeating tag");
    assert.equal(els.some((e) => e.value === ""), false, "empty is the normal state of a field");
    await page.close();
  });
});

/**
 * A snapshot taken too early is not empty, it is WRONG: it describes the app
 * shell, and the model reads that as "what you asked about is not here". That
 * is how a working session ended -- navigate, look 420ms later, conclude the
 * availability editor did not exist, and leave the page that had it.
 */
describe("waiting for a page to be worth looking at", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { waitForPage, snapshot };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
    return page;
  }

  test("a declared trigger returns the moment it appears", async () => {
    const page = await fresh();
    await page.evaluate(() => {
      setTimeout(() => {
        const el = document.createElement("button");
        el.setAttribute("data-testid", "schedule-editor");
        el.textContent = "Sunday";
        document.body.append(el);
      }, 400);
    });
    const started = Date.now();
    const out = await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "schedule-editor" } }));
    const took = Date.now() - started;

    assert.deepEqual(out, { ready: true, by: "declared" });
    assert.ok(took >= 350 && took < 1500, `waited ${took}ms, which is not "as soon as it appeared"`);
    await page.close();
  });

  test("a trigger may be any element, not only one you can press", async () => {
    // A page's "I am ready" marker is usually a container: cal.diy's event
    // types are a <ul data-testid="event-types">, which the interactive
    // selector will never see.
    const page = await fresh();
    await page.evaluate(() => {
      const ul = document.createElement("ul");
      ul.setAttribute("data-testid", "event-types");
      document.body.append(ul);
    });
    assert.deepEqual(
      await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "event-types" } })),
      { ready: true, by: "declared" },
    );
    await page.close();
  });

  test("a trigger may be a shape, for the ids an app builds at runtime", async () => {
    // cal.diy writes its schedule switches as `data-testid={`${weekday}-switch`}`,
    // so the element is Sunday-switch in English and Domingo-switch in
    // Spanish. Waiting for the English one works until someone changes
    // language. The source spells out everything except the hole, so the SHAPE
    // is knowable even where the value is not.
    const page = await fresh();
    await page.evaluate(() => {
      setTimeout(() => {
        const el = document.createElement("button");
        el.setAttribute("data-testid", "Domingo-switch"); // a Spanish-speaking user
        document.body.append(el);
      }, 300);
    });
    assert.deepEqual(
      await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "*-switch" }, declaredMs: 3000 })),
      { ready: true, by: "declared" },
    );
    await page.close();
  });

  test("a shape still has to be specific enough to mean something", async () => {
    // `*` alone matches every element on the page, which is not a readiness
    // signal, it is a way of always being ready.
    const page = await fresh();
    const out = await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "*" }, declaredMs: 300 }));
    assert.equal(out.ready, false, "an all-wildcard pattern reported the page ready");
    await page.close();
  });

  test("a shape can be anchored at either end", async () => {
    const page = await fresh();
    await page.evaluate(() => {
      const el = document.createElement("button");
      el.setAttribute("data-testid", "row-42-name");
      document.body.append(el);
    });
    for (const pattern of ["row-*", "*-name", "row-*-name"]) {
      assert.equal(
        (await page.evaluate((p) => window.__dom.waitForPage({ readyWhen: { testId: p }, declaredMs: 300 }), pattern)).ready,
        true,
        `${pattern} did not match row-42-name`,
      );
    }
    assert.equal(
      (await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "col-*" }, declaredMs: 200 }))).ready,
      false,
      "matched a prefix it does not have",
    );
    await page.close();
  });

  test("an empty page stops waiting long before the timeout", async () => {
    // A marker is a claim about a page with content in it. Wait for a row on a
    // list with no rows, or *-switch on a schedule with no days, and it never
    // comes -- not because the page is slow but because there is nothing to
    // render. Holding the full timeout punishes the empty case hardest, and
    // the empty case is what a new user sees first.
    const page = await fresh();
    const started = Date.now();
    const out = await page.evaluate(() =>
      window.__dom.waitForPage({ readyWhen: { testId: "row-*" }, declaredMs: 9000, quietMs: 60 }),
    );
    const took = Date.now() - started;

    assert.equal(out.ready, false, "an empty page is not evidence the marker arrived");
    assert.equal(out.assumed, true, "a guess must not be reported as knowledge");
    assert.match(JSON.stringify(out.settledWithout), /row-\*/);
    assert.ok(took < 4000, `waited ${took}ms of a 9000ms budget on a page that was never going to change`);
    await page.close();
  });

  test("a slow marker still beats the settle heuristic", async () => {
    // The tie-breaker must not become the answer: a shell that settles at
    // 450ms cannot be allowed to give up on a marker that is genuinely still
    // on its way.
    const page = await fresh();
    await page.evaluate(() => {
      setTimeout(() => {
        const el = document.createElement("button");
        el.setAttribute("data-testid", "row-1");
        el.textContent = "Late row";
        document.body.append(el);
      }, 2200);
    });
    const out = await page.evaluate(() =>
      window.__dom.waitForPage({ readyWhen: { testId: "row-*" }, declaredMs: 9000, quietMs: 60 }),
    );
    assert.deepEqual(out, { ready: true, by: "declared" });
    await page.close();
  });

  test("a trigger that never arrives says so instead of claiming ready", async () => {
    const page = await fresh();
    const out = await page.evaluate(() => window.__dom.waitForPage({ readyWhen: { testId: "never" }, declaredMs: 400 }));
    assert.equal(out.ready, false);
    assert.match(JSON.stringify(out.missing), /never/);
    await page.close();
  });

  test("with nothing declared it waits for the controls to stop arriving", async () => {
    // The fallback watches labelled interactive elements, not mutations: a
    // skeleton is divs and contributes almost none, and a spinner animated in
    // CSS mutates nothing at all.
    const page = await fresh();
    await page.evaluate(() => {
      setTimeout(() => {
        for (let i = 0; i < 5; i++) {
          const b = document.createElement("button");
          b.textContent = `Late ${i}`;
          document.body.append(b);
        }
      }, 300);
    });
    const before = await page.evaluate(() => window.__dom.snapshot().length);
    const out = await page.evaluate(() => window.__dom.waitForPage({ guessMs: 3000 }));
    const after = await page.evaluate(() => window.__dom.snapshot().length);

    // Never `ready: true`. Stability is not evidence: a page whose shell
    // renders in 200ms and whose content lands at two seconds is stable on the
    // shell from 450ms, and a bigger cap does not help because the cap is only
    // reached by a page that never stops changing.
    assert.deepEqual(out, { ready: false, by: "settled", assumed: true });
    assert.ok(after >= before + 5, `waited but only saw ${after - before} of the 5 late controls`);
    await page.close();
  });

  test("a page that never settles is reported, not waited on forever", async () => {
    const page = await fresh();
    await page.evaluate(() => {
      let n = 0;
      setInterval(() => {
        const b = document.createElement("button");
        b.textContent = `Endless ${n++}`;
        document.body.append(b);
      }, 50);
    });
    const out = await page.evaluate(() => window.__dom.waitForPage({ guessMs: 600 }));
    assert.deepEqual(out, { ready: false, by: "settled", assumed: true, stillChanging: true });
    await page.close();
  });
});

describe("highlighting an element", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({
      content: `${source}\nwindow.__dom = { snapshot, highlight, clearHighlight, highlightRect };`,
      type: "module",
    });
    await page.waitForFunction(() => window.__dom);
    return page;
  }
  const find = (page, label) =>
    page.evaluate((l) => window.__dom.snapshot().find((e) => e.label === l)?.id, label);

  test("the ring lands on the element, not near it", async () => {
    const page = await fresh();
    const id = await find(page, "Title");
    const result = await page.evaluate((i) => window.__dom.highlight(i), id);
    assert.equal(result.status, "highlighted");

    const [box, real] = await page.evaluate(() => [
      window.__dom.highlightRect(),
      document.getElementById("host-title").getBoundingClientRect().toJSON(),
    ]);
    assert.ok(Math.abs(box.top - real.top) < 1, `ring at ${box.top}, element at ${real.top}`);
    assert.ok(Math.abs(box.left - real.left) < 1);
    assert.ok(Math.abs(box.width - real.width) < 1);
    await page.close();
  });

  test("it follows the element when the page scrolls", async () => {
    // The reason this is tracked per frame rather than measured once. A ring
    // that stays where the element used to be is worse than no ring: it points
    // confidently at the wrong thing.
    const page = await fresh();
    const id = await find(page, "Title");
    await page.evaluate((i) => window.__dom.highlight(i), id);

    const before = await page.evaluate(() => window.__dom.highlightRect().top);
    await page.evaluate(() => {
      document.body.style.paddingTop = "600px";
      window.scrollTo(0, 300);
    });
    const after = await page.evaluate(() => window.__dom.highlightRect().top);
    assert.notEqual(Math.round(before), Math.round(after), "the ring did not move with the page");
    await page.close();
  });

  test("it survives the element being re-rendered", async () => {
    // React replaces nodes on almost every state change, so a ring holding a
    // node points at a detached element within a turn. It holds the criteria
    // and re-finds them.
    const page = await fresh();
    const id = await find(page, "Title");
    await page.evaluate((i) => window.__dom.highlight(i), id);

    await page.evaluate(() => {
      const old = document.getElementById("host-title");
      const fresh = old.cloneNode(true);
      old.replaceWith(fresh); // a new node, same identity
    });
    const box = await page.evaluate(() => window.__dom.highlightRect());
    assert.ok(box, "the ring gave up when the node was replaced");
    await page.close();
  });

  test("it reports nothing once the element is gone", async () => {
    const page = await fresh();
    const id = await find(page, "Title");
    await page.evaluate((i) => window.__dom.highlight(i), id);
    await page.evaluate(() => document.getElementById("host-title").remove());
    assert.equal(await page.evaluate(() => window.__dom.highlightRect()), null);
    await page.close();
  });

  test("finding the target does not invalidate the model's element ids", async () => {
    // highlightRect() walks the DOM itself rather than calling snapshot(),
    // which clears the registry. Re-finding a ring's target must not pull the
    // ground out from under the next dom_click.
    const page = await fresh();
    const id = await find(page, "Title");
    await page.evaluate((i) => window.__dom.highlight(i), id);
    await page.evaluate(() => window.__dom.highlightRect());

    const stillResolves = await page.evaluate((i) => {
      try {
        window.__dom.highlight(i);
        return true;
      } catch {
        return false;
      }
    }, id);
    assert.ok(stillResolves, "highlighting stale-ended the ids the model was holding");
    await page.close();
  });
});

describe("running a flow", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { snapshot, typeText, click, runFlow };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
    return page;
  }
  const run = (page, steps, args) =>
    page.evaluate(([s, a]) => window.__dom.runFlow(s, a, { timeoutMs: 2000 }), [steps, args]);

  test("named inputs land in labelled fields", async () => {
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { type: "Description", from: "description" }],
      { title: "Quick chat", description: "A short one." });

    assert.equal(result.status, "completed");
    assert.equal(await page.inputValue("#host-title"), "Quick chat");
    assert.equal(await page.evaluate(() => document.getElementById("host-editor").innerText.trim()), "A short one.");
    await page.close();
  });

  test("a field with no value is skipped, which is what makes it optional", async () => {
    // The model omits `description` and the flow simply does not visit it,
    // rather than typing "undefined" into the page.
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { type: "Description", from: "description" }],
      { title: "Only a title" });

    assert.equal(result.status, "completed");
    assert.match(result.steps[1].skipped, /no value for description/);
    assert.equal(await page.evaluate(() => document.getElementById("host-editor").innerText.trim()), "");
    await page.close();
  });

  test("it waits for what a click opens", async () => {
    // Clicking "New" opens a dialog, and the dialog is not there on the next
    // line of JavaScript. Without waiting, every flow whose first step opens
    // something fails on its second.
    const page = await fresh();
    const result = await run(page, [{ click: "Add detail" }, { type: "Notes", from: "notes" }], { notes: "later" });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await page.inputValue("#host-notes"), "later");
    await page.close();
  });

  test("a snapshot reports what is below the fold, flagged", async () => {
    // It used to stop at the viewport edge, so "where is the submit button?"
    // was unanswerable whenever the page was scrolled above it -- and the
    // honest answer from the tools was that there wasn't one. Scrolling is
    // something we can do; not knowing is not.
    const page = await fresh();
    await page.evaluate(() => {
      const far = document.createElement("button");
      far.textContent = "Submit";
      far.style.marginTop = "3000px";
      document.getElementById("host-form").append(far);
    });
    const found = await page.evaluate(() => window.__dom.snapshot().find((e) => e.label === "Submit"));
    assert.ok(found, "the agent cannot see past the fold");
    assert.equal(found.offscreen, true, "it is reported, but not as if it were on screen");
    await page.close();
  });

  test("a flow prefers the match on screen but still reaches the one that is not", async () => {
    // Ordering, not filtering: a field below the fold is the right field when
    // it is the only one, and typing scrolls to it.
    const page = await fresh();
    await page.evaluate(() => {
      const label = document.createElement("label");
      label.textContent = "Faraway";
      const input = document.createElement("input");
      input.id = "host-far";
      label.setAttribute("for", "host-far");
      input.style.marginTop = "3000px";
      document.getElementById("host-form").append(label, input);
    });
    const result = await run(page, [{ type: "Faraway", from: "v" }], { v: "reached" });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await page.inputValue("#host-far"), "reached");
    await page.close();
  });

  test("a label alone cannot tell two identical buttons apart", async () => {
    // Not a bug to fix, a limit to record. Two buttons labelled "New" is
    // cal.diy's real markup, and a flow with nothing but the label opens
    // whichever came first -- which is how it opened a schedule dialog while
    // trying to create an event type.
    const page = await fresh();
    await run(page, [{ click: "New" }], {});
    assert.equal(await page.isVisible("#host-schedule-panel"), true, "the first New is what a bare label reaches");
    assert.equal(await page.isVisible("#host-event-panel"), false);
    await page.close();
  });

  test("a test id constrains the label to the button that was meant", async () => {
    const page = await fresh();
    const result = await run(page, [
      { click: "New", testId: "new-event-type" },
      { type: "Event title", from: "title" },
    ], { title: "Quick chat" });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await page.isVisible("#host-schedule-panel"), false, "the wrong dialog was opened");
    assert.equal(await page.inputValue("#host-event-title"), "Quick chat");
    await page.close();
  });

  test("an identifier that matches nothing stops the flow, and says which one", async () => {
    // The whole point of anchoring: fail at step one rather than three steps
    // into the wrong dialog. And the reason has to name the criterion, or the
    // report says "could not find New" about a step that never wanted a label.
    const page = await fresh();
    const result = await run(page, [{ click: "New", testId: "new-booking" }], {});

    assert.equal(result.status, "stopped");
    assert.match(result.because, /new-booking/);
    assert.equal(await page.isVisible("#host-schedule-panel"), false);
    assert.equal(await page.isVisible("#host-event-panel"), false);
    await page.close();
  });

  test("an app with no test ids still works on labels alone", async () => {
    // Enrichment, not a requirement. Most apps write these on some elements
    // and not others, and a flow against a bare one has the label and has to
    // work with it.
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }], { title: "No anchors here" });

    assert.equal(result.status, "completed");
    assert.equal(await page.inputValue("#host-title"), "No anchors here");
    await page.close();
  });

  test("a flow declared for another page never clicks anything", async () => {
    // The other half, and a different guarantee: the identifier says which
    // element, the page says where the flow is valid. Checked before step one,
    // so the wrong screen opens nothing at all.
    const page = await fresh();
    const result = await page.evaluate(
      ([s, a]) => window.__dom.runFlow(s, a, { timeoutMs: 2000, page: "/event-types" }),
      [[{ click: "New", testId: "new-event-type" }], {}],
    );

    assert.equal(result.status, "stopped");
    assert.match(result.because, /\/event-types/);
    assert.equal(await page.isVisible("#host-event-panel"), false, "it clicked despite being on the wrong page");
    await page.close();
  });

  test("a stopped flow may be looked at, and says which criterion failed", async () => {
    // The hint reads and does not write. Looking at where the app got to is
    // how the model tells the user something actionable -- "the dialog is
    // open, nothing was saved" -- while rule 6 in the session prompt
    // separately forbids finishing the job with dom_click or dom_type. The
    // read is here, the ban on writing is there.
    //
    // `because` has to name the criterion, not just the label: a step anchored
    // to a test id that reports "could not find New" describes a step that
    // never wanted a label.
    const page = await fresh();
    const result = await run(page, [{ click: "New", testId: "new-booking" }], {});

    assert.equal(result.status, "stopped");
    assert.match(result.hint, /dom_snapshot/, "the model cannot report a state it may not look at");
    assert.match(result.because, /new-booking/);
    await page.close();
  });

  test("stopping partway says where it got to, not just that it failed", async () => {
    // A flow that filled one field and could not find the next has left a
    // half-completed form on screen. "It failed" invites the model to start
    // again from the top, which fills the first field twice. So the result has
    // to carry which step, which criterion, and what already happened.
    const page = await fresh();
    const result = await run(page, [{ type: "Title", from: "title" }, { click: "Nonexistent Button" }], { title: "Half" });

    assert.equal(result.status, "stopped");
    assert.match(result.at, /step 2 of 2/);
    assert.match(result.because, /could not find "Nonexistent Button"/);
    assert.deepEqual(result.completed[0], { step: 1, typed: "Title" });
    assert.match(result.hint, /rather than starting over/, "a retry would fill the first field twice");
    assert.equal(await page.inputValue("#host-title"), "Half", "the partial state is real, and stays");
    await page.close();
  });

  test("a shorter label wins over a longer one containing it", async () => {
    // "Title" must not match "Title of the recurring event" when both exist.
    const page = await fresh();
    await page.evaluate(() => {
      const extra = document.createElement("label");
      extra.textContent = "Title of the recurring event";
      const input = document.createElement("input");
      input.id = "host-decoy";
      extra.setAttribute("for", "host-decoy");
      document.getElementById("host-form").append(extra, input);
    });
    await run(page, [{ type: "Title", from: "title" }], { title: "right one" });
    assert.equal(await page.inputValue("#host-title"), "right one");
    assert.equal(await page.inputValue("#host-decoy"), "");
    await page.close();
  });
});

describe("delegate() drives the app's own chat (the ui transport)", { concurrency: false }, () => {
  let browser;
  let harness;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await browser?.close();
    await harness?.server.close();
  });

  async function fresh() {
    const page = await browser.newPage();
    await page.goto(harness.url("?mount=shadow"));
    await page.addScriptTag({ content: `${source}\nwindow.__dom = { delegate };`, type: "module" });
    await page.waitForFunction(() => window.__dom);
    // A fake app chat: an input, a send button, a transcript, and a "running"
    // indicator that is added on send and removed when the turn finishes.
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend",
        `<textarea data-chat-input></textarea><button data-chat-send>Send</button><div data-chat-log></div>`);
      const input = document.querySelector("[data-chat-input]");
      const log = document.querySelector("[data-chat-log]");
      document.querySelector("[data-chat-send]").addEventListener("click", () => {
        log.innerText += "you: " + input.value + "\n";
        const ind = document.createElement("div");
        ind.setAttribute("data-turn-running", "");
        document.body.appendChild(ind);
        setTimeout(() => {
          log.innerText += "agent: added a beat about breeder reactors";
          ind.remove(); // the turn is done
        }, 150);
      });
    });
    return page;
  }

  const ui = {
    input: "[data-chat-input]",
    send: "[data-chat-send]",
    transcript: "[data-chat-log]",
    done: { gone: "[data-turn-running]" },
  };

  test("types the instruction, sends it, waits for done, and reads the reply", async () => {
    const page = await fresh();
    const result = await page.evaluate(
      ([u, text]) => window.__dom.delegate(u, text, { maxMs: 5000 }),
      [ui, "add a beat about breeder reactors"],
    );
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.match(result.reply, /added a beat about breeder reactors/);
    // the instruction really went into the app's own input
    assert.equal(await page.inputValue("[data-chat-input]"), "add a beat about breeder reactors");
    await page.close();
  });

  test("a missing input selector is reported, not thrown", async () => {
    const page = await fresh();
    const result = await page.evaluate(() => window.__dom.delegate({ input: "#nope" }, "hi", { maxMs: 500 }));
    assert.match(result.error, /chat input/);
    await page.close();
  });

  test("Enter sends when no send selector is given", async () => {
    const page = await fresh();
    // rebind: this chat sends on Enter in the textarea instead of a button
    await page.evaluate(() => {
      const input = document.querySelector("[data-chat-input]");
      const log = document.querySelector("[data-chat-log]");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { log.innerText += "agent: ok"; }
      });
    });
    const result = await page.evaluate(
      ([u, text]) => window.__dom.delegate(u, text, { maxMs: 3000 }),
      [{ input: "[data-chat-input]", transcript: "[data-chat-log]", done: { settles: true } }, "do it"],
    );
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.match(result.reply, /ok/);
    await page.close();
  });
});

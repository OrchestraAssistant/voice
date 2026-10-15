import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clickTab, launchBrowser, preparePage, recordTransition, startHarness } from "./harness.mjs";

/**
 * Every case here is a bug this widget actually shipped, and every one of them
 * looked correct in a screenshot. A transparent panel over a white page looks
 * like a white panel; a 350ms overshoot is not visible in a still; a stacking
 * failure inside a shadow root behaves perfectly at mount="inline". So these
 * assert numbers, and they run against the mount that ships.
 */

const TOLERANCE = 2; // px, for spring easing and sub-pixel layout

/** The panel never leaves the interval between where it started and where it ends. */
function assertNoOvershoot(samples, what) {
  const outers = samples.map((s) => s.outer);
  const [start, end] = [outers[0], outers.at(-1)];
  const ceiling = Math.max(start, end) + TOLERANCE;
  const floor = Math.min(start, end) - TOLERANCE;
  assert.ok(
    Math.max(...outers) <= ceiling,
    `${what}: reached ${Math.max(...outers)}px between ${start} and ${end}. The panel balloons and snaps back.`,
  );
  assert.ok(Math.min(...outers) >= floor, `${what}: dropped to ${Math.min(...outers)}px between ${start} and ${end}.`);
}

/**
 * The measured wrapper is never taller than the tallest single pane. If it is,
 * the outgoing pane is still in layout flow and the wrapper is measuring both
 * stacked -- which is popLayout's `position: absolute` rule having been
 * injected into a tree the panes are not in.
 */
function assertPanesNeverStack(samples, what) {
  for (const s of samples) {
    if (!s.panes.length) continue;
    const tallest = Math.max(...s.panes);
    assert.ok(
      s.inner <= tallest + TOLERANCE,
      `${what}: wrapper measured ${s.inner}px against a tallest pane of ${tallest}px (panes ${s.panes}). ` +
        `The outgoing pane never left the flow.`,
    );
  }
}

/** The wrapper measures at its final width, so content cannot rewrap mid-transition. */
function assertWidthStable(samples, what) {
  const widths = [...new Set(samples.map((s) => s.innerWidth))];
  assert.equal(widths.length, 1, `${what}: measured wrapper changed width across ${widths}. Content rewraps as it animates.`);
}

describe("widget", { concurrency: false }, () => {
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

  async function open(query) {
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url(query));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    return page;
  }

  test("the panel has a real surface, not a transparent one", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const background = await page.evaluate(
      () => getComputedStyle(window.__find(".interpreter-widget > div")).backgroundColor,
    );
    // Semantic tokens map through `@theme inline`. Under a plain `@theme` they
    // resolve against a :root that has no --iv-* to find, every one of them
    // computes to the guaranteed-invalid value, and this reads rgba(0, 0, 0, 0).
    assert.notEqual(background, "rgba(0, 0, 0, 0)", "bg-background resolved to nothing; theme tokens are inert");
    await page.close();
  });

  test("the selected tab is highlighted", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const background = await page.evaluate(
      () => getComputedStyle(window.__find('.interpreter-widget button[aria-label="Talk"]')).backgroundColor,
    );
    // bg-foreground/4 lives in @layer utilities and has to beat our own
    // zero-specificity `button { background: transparent }` reset. It only does
    // while that reset is inside @layer base: unlayered would win regardless.
    assert.notEqual(background, "rgba(0, 0, 0, 0)", "selected tab is transparent; our reset outranks our utilities");
    await page.close();
  });

  test("opening does not overshoot", async () => {
    const page = await open("?mount=shadow");
    const samples = await recordTransition(page, () => clickTab(page, "Talk"));
    assertNoOvershoot(samples, "open");
    assertWidthStable(samples, "open");
    await page.close();
  });

  test("closing does not overshoot", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Talk"));
    assertNoOvershoot(samples, "close");
    await page.close();
  });

  test("switching tabs never stacks the panes, in the shadow root", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Settings"));
    assertPanesNeverStack(samples, "shadow tab switch");
    assertNoOvershoot(samples, "shadow tab switch");
    await page.close();
  });

  test("switching tabs never stacks the panes, inline", async () => {
    // The other direction of the same bug: popLayout must be pointed at
    // document.head here, not at a shadow root the panes are not in.
    const page = await open("");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const samples = await recordTransition(page, () => clickTab(page, "Settings"));
    assertPanesNeverStack(samples, "inline tab switch");
    assertNoOvershoot(samples, "inline tab switch");
    await page.close();
  });

  test("all chrome shares one overlay host", async () => {
    const page = await open("?mount=shadow&glow=1");
    const hosts = await page.evaluate(() => document.querySelectorAll("[data-interpreter-overlay]").length);
    // Two hosts cannot agree an order in the top layer without re-raising
    // themselves at each other, which is a loop, not a race.
    assert.equal(hosts, 1, "more than one overlay host; the top-layer order is up for grabs again");
    await page.close();
  });

  test("the top layer settles instead of churning", async () => {
    const page = await open("?mount=shadow&glow=1");
    await clickTab(page, "Talk");
    await page.waitForTimeout(1200);
    const toggles = await page.evaluate(() => window.__toggles);
    // The runaway measured ~1800/second. A healthy open is single digits.
    assert.ok(toggles < 20, `${toggles} toggle events with the rim and panel both up; something is re-raising in a loop`);
    await page.close();
  });

  test("an inline panel does not claim the top layer", async () => {
    const page = await open("");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    const toggles = await page.evaluate(() => window.__toggles);
    assert.equal(toggles, 0, "an overlay containing nothing raised itself on behalf of an inline panel");
    await page.close();
  });

  test("clicking outside closes the panel", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    await page.click(".page h1");
    await page.waitForTimeout(700);
    const selected = await page.evaluate(() => !!window.__find('.interpreter-widget button[aria-label="Settings"]'));
    assert.equal(selected, false, "panel stayed open after a click outside it");
    await page.close();
  });

  test("pressing inside the panel does not close it", async () => {
    const page = await open("?mount=shadow");
    await clickTab(page, "Talk");
    await page.waitForTimeout(700);
    // The listener is on document, where target has been retargeted to the
    // shadow host, so this only stays open if the check reads composedPath().
    // `composed: true` is what real UI events carry.
    await page.evaluate(() =>
      window
        .__find(".interpreter-widget form input")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true })),
    );
    await page.waitForTimeout(700);
    const stillOpen = await page.evaluate(() => !!window.__find('.interpreter-widget button[aria-label="Settings"]'));
    assert.equal(stillOpen, true, "a press inside the panel closed it; click-outside cannot see through the boundary");
    await page.close();
  });
});

/**
 * Reduced from cal.diy, where mounting the widget collapsed a desktop sidebar
 * into a mobile bottom bar across the whole app.
 *
 * The harness page declares `.hidden` and a `.md:flex` override on an element
 * that must be visible above 768px, which is the shape of every Tailwind app.
 * The widget must not put a competing `.hidden` into the host document: it
 * lands later in the same layer, and media queries carry no specificity, so
 * the host's responsive rule loses silently.
 */
describe("the host's own CSS survives the widget", { concurrency: false }, () => {
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

  test("a host utility overridden at a breakpoint still wins", async () => {
    const page = await browser.newPage();
    await preparePage(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(harness.url("?mount=shadow"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));

    const display = await page.evaluate(() => getComputedStyle(document.querySelector("#host-sidebar")).display);
    assert.equal(display, "flex", "the widget's stylesheet is overriding the host's own utilities");
    await page.close();
  });

  test("nothing of ours reaches a document stylesheet", async () => {
    // The direct form of the same property, and the one that generalises: the
    // collision above only happens because our sheet is in the host document
    // at all. If it is not there, it cannot lose or win against anything.
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));

    const leaked = await page.evaluate(() =>
      [...document.styleSheets]
        .map((sheet, i) => {
          try {
            return { i, text: [...sheet.cssRules].map((r) => r.cssText).join("\n") };
          } catch {
            return { i, text: "" };
          }
        })
        .filter((s) => s.text.includes("--iv-surface") || s.text.includes(".interpreter-widget"))
        .map((s) => s.i),
    );
    assert.deepEqual(leaked, [], "the widget's stylesheet is in the host document");
    await page.close();
  });

  test("and the widget is styled anyway, from inside its own root", async () => {
    // The other half of the property: it must not avoid the collision by
    // simply shipping no styles. The chrome is painted because the bubble
    // injects the compiled sheet into its shadow root, not the document.
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    // The outer wrapper only positions; the pill inside it carries the paint,
    // and that paint comes from a Tailwind class resolved inside the shadow
    // root -- which is the whole point being asserted.
    const bg = await page.evaluate(() =>
      getComputedStyle(window.__find(".interpreter-widget").firstElementChild).backgroundColor,
    );
    assert.ok(bg && bg !== "rgba(0, 0, 0, 0)", `widget chrome is unstyled (${bg})`);
    await page.close();
  });
});

/**
 * The assembled tier.
 *
 * Reduced from the first real integration: the host rendered only
 * <InterpreterBubble/>, got no rim, and nothing said so. The bubble and the
 * rim ship separately on purpose, but "assemble them yourself" is a step a
 * host can silently skip, and the result looks finished.
 */
describe("<Interpreter/> renders the whole interface", { concurrency: false }, () => {
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

  /**
   * Which pieces of chrome are MOUNTED, which is not the same as which are
   * visible. The rim only paints once a session is live, and this harness has
   * no relay behind it, so counting children would say "no rim" even when the
   * component is there. Each piece injects its own stylesheet into the shared
   * root when it mounts, so that is the honest signal.
   */
  const mounted = (page) =>
    page.evaluate(() => {
      const host = document.querySelector("[data-interpreter-overlay]");
      if (!host) return null;
      const css = [...host.shadowRoot.querySelectorAll("style")].map((s) => s.textContent).join("\n");
      return {
        panel: css.includes("interpreter-widget") || css.includes("--iv-surface"),
        rim: css.includes("mask-composite"),
        // The class, not the keyframe: a keyframe name is a styling detail
        // and this only wants to know the layer mounted at all.
        spotlight: css.includes("spotlight-frame"),
        layers: [...host.shadowRoot.querySelectorAll("[data-overlay-layer]")].map((el) =>
          el.getAttribute("data-overlay-layer"),
        ),
      };
    });

  test("one component fills every layer", async () => {
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow&assembled=1"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    await page.waitForTimeout(400);

    const on = await mounted(page);
    assert.ok(on, "no overlay host at all");
    // Order is paint order, and it is an argument, not an accident: the rim is
    // ambient and sits behind, the spotlight points at the HOST app so it goes
    // above the rim, and the panel is on top because a ring that covered it
    // would hide the thing doing the explaining.
    assert.deepEqual(on.layers, ["rim", "spotlight", "panel"], "the overlay lost a layer");
    assert.ok(on.panel, "the bubble did not mount");
    assert.ok(on.rim, "the rim did not mount, which is the bug this exists for");
    assert.ok(on.spotlight, "the spotlight did not mount");
    await page.close();
  });

  test("typing in the widget never reaches the host's shortcuts", async () => {
    // A host that binds keyboard shortcuts asks "is the user typing?" by
    // looking at document.activeElement, which for focus inside a shadow root
    // is the shadow HOST -- a div, not an input. cal.diy's kbar does exactly
    // that, with two-letter chords bound to navigation, so typing "let's" into
    // our command box fired its `e`,`t` chord and the app navigated away
    // mid-sentence. It read as the agent wandering off; the agent had made no
    // tool calls at all.
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow&assembled=1"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      window.__hostSaw = [];
      document.addEventListener("keydown", (e) => window.__hostSaw.push(e.key));
    });

    // Open the panel and type into the command box, the way a person would.
    await page.evaluate(() => window.__find(".interpreter-widget button")?.click());
    await page.waitForTimeout(700);
    const typed = await page.evaluate(async () => {
      const input = window.__find('input[placeholder="Type a command…"]') ?? window.__find("input");
      if (!input) return null;
      input.focus();
      return document.activeElement?.tagName;
    });
    assert.ok(typed, "no command input to type into");
    // The host's own check, run for real: this is what it sees while we type.
    assert.equal(typed, "DIV", "activeElement is the shadow host -- the very thing that fools the guard");

    await page.keyboard.type("let");
    await page.waitForTimeout(200);

    const hostSaw = await page.evaluate(() => window.__hostSaw);
    assert.deepEqual(hostSaw, [], `the host received ${JSON.stringify(hostSaw)} while the user typed into the widget`);

    const value = await page.evaluate(() => {
      const input = window.__find('input[placeholder="Type a command…"]') ?? window.__find("input");
      return input?.value;
    });
    assert.equal(value, "let", "stopping the host from hearing it also stopped us");
    await page.close();
  });

  test("the bubble alone still leaves the rim empty, as it should", async () => {
    // The tier below is not broken, it is just a tier lower. Asserting the
    // difference keeps the two honest: if the bubble started drawing its own
    // rim, the assembled component would be pointless and this would say so.
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    await page.waitForTimeout(400);

    const on = await mounted(page);
    assert.ok(on.panel, "the bubble did not mount");
    assert.equal(on.rim, false, "something mounted a rim nobody asked for");
    await page.close();
  });
});

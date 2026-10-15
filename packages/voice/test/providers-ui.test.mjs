import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clickTab, launchBrowser, preparePage, startHarness } from "./harness.mjs";

/**
 * The engine picker, driven in a real browser.
 *
 * `providers=multi` mounts two fake engines (dev/fake-providers.js) with
 * DIFFERENT capabilities: a full-duplex "realtime" one and an "on-device"
 * cascade that can only do continuous + text. The point of this suite is the
 * thing a unit test cannot reach -- that picking an engine in Settings swaps
 * the live pipeline AND that the controls adapt to what it can do, so a user
 * never sees a push-to-talk button an engine cannot honour.
 */
describe("the engine picker", () => {
  let browser, harness, page;

  before(async () => {
    browser = await launchBrowser();
    harness = await startHarness();
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await harness?.server.close();
  });

  // Text of every button inside the widget, across the open shadow root.
  const widgetButtons = (page) =>
    page.evaluate(() => {
      const roots = [document, ...[...document.querySelectorAll("[data-interpreter-overlay]")].map((h) => h.shadowRoot)];
      const out = [];
      for (const root of roots) {
        for (const b of root?.querySelectorAll(".interpreter-widget button") ?? []) {
          const t = (b.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t) out.push(t);
        }
      }
      return out;
    });

  const openSettings = (page) =>
    page.evaluate(() => window.__find('.interpreter-widget button[aria-label="Settings"]').click());

  const clickRow = (page, label) =>
    page.evaluate((l) => {
      const roots = [document, ...[...document.querySelectorAll("[data-interpreter-overlay]")].map((h) => h.shadowRoot)];
      for (const root of roots) {
        for (const b of root?.querySelectorAll(".interpreter-widget button") ?? []) {
          if ((b.textContent ?? "").includes(l)) return b.click();
        }
      }
      throw new Error(`no row "${l}"`);
    }, label);

  before(async () => {
    page = await browser.newPage();
    await preparePage(page);
    await page.goto(harness.url("?mount=shadow&assembled=1&providers=multi"));
    await page.waitForFunction(() => window.__find?.(".interpreter-widget"));
    // The bubble opens closed; clicking Talk expands it and reveals the tab
    // strip, then Settings holds the engine picker.
    await clickTab(page, "Talk");
    await page.waitForTimeout(200);
    await openSettings(page);
    await page.waitForTimeout(200);
  });

  test("offers both wired engines", async () => {
    const buttons = await widgetButtons(page);
    assert.ok(buttons.some((t) => t.includes("Realtime (fake)")), `engine list missing realtime: ${buttons}`);
    assert.ok(buttons.some((t) => t.includes("On-device (fake cascade)")), `engine list missing cascade: ${buttons}`);
  });

  test("the full-duplex engine offers push-to-talk", async () => {
    const buttons = await widgetButtons(page);
    assert.ok(buttons.some((t) => t.includes("Push to talk")), `realtime should offer PTT: ${buttons}`);
  });

  test("switching to the cascade engine drops the modes it cannot do", async () => {
    await clickRow(page, "On-device (fake cascade)");
    await page.waitForTimeout(150);
    const buttons = await widgetButtons(page);
    assert.ok(buttons.some((t) => t.includes("Continuous")), "continuous is always available");
    assert.ok(!buttons.some((t) => t.includes("Push to talk")), `cascade cannot PTT, so the row must go: ${buttons}`);
    assert.ok(!buttons.some((t) => t.includes("Push to not talk")), "ptnt row must go too");
  });

  test("and switching back restores them", async () => {
    await clickRow(page, "Realtime (fake)");
    await page.waitForTimeout(150);
    const buttons = await widgetButtons(page);
    assert.ok(buttons.some((t) => t.includes("Push to talk")), `PTT should return on the realtime engine: ${buttons}`);
  });
});

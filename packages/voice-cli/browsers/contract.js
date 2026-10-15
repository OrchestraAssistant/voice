/**
 * What a probe needs from a browser, and nothing more.
 *
 * Kept deliberately tiny, because the moment a stage reaches for
 * `page.$eval` or a Puppeteer handle, the choice of browser stops being an
 * implementation detail and the seam is gone. Everything a readiness probe
 * does is: open a page, ask what is on it, repeatedly, then close.
 *
 * A driver is an object with:
 *
 *   name              what it is, for the report
 *   available()       whether it can run here, and why not if it cannot
 *   open(url, opts)   -> a page
 *   close()
 *
 * and a page is:
 *
 *   inventory()       -> [{ testId, domId, label, tag, visible }]
 *   url()             -> where it actually ended up, after redirects
 *   close()
 *
 * `inventory` rather than "the DOM" on purpose: it is the one measurement a
 * readiness probe makes, and naming it that way means a driver that cannot do
 * layout can still say so per element (`visible: null`) instead of a stage
 * having to know which engine it is talking to.
 *
 * There are two implementations today and the difference is instructive.
 * Chrome computes layout, so it knows two of cal.diy's eight login controls
 * are hidden. Lightpanda does not: every element reports a 5x5 box and
 * `display: block`, so `visible` is unknowable there. A readiness probe does
 * not care -- it measures what EXISTS over time -- but an agent would care
 * very much, which is exactly why the contract makes it explicit rather than
 * letting a stage assume.
 */

export function validateDriver(driver) {
  const problems = [];
  if (!driver || typeof driver !== "object") return ["not an object"];
  if (typeof driver.name !== "string" || !driver.name) problems.push("needs a name");
  for (const method of ["available", "open", "close"]) {
    if (typeof driver[method] !== "function") problems.push(`needs ${method}()`);
  }
  return problems;
}

export function validatePage(page) {
  const problems = [];
  if (!page || typeof page !== "object") return ["not an object"];
  for (const method of ["inventory", "url", "close"]) {
    if (typeof page[method] !== "function") problems.push(`needs ${method}()`);
  }
  return problems;
}

/**
 * The script a driver evaluates in the page.
 *
 * Here rather than in a driver so every engine reports the same shape and the
 * stage cannot tell them apart. It is a string because that is the one thing
 * every remote-evaluation API takes; sharing a function would mean each driver
 * serialising it its own way.
 *
 * Deliberately NOT the widget's own snapshot(): that filters to what is
 * visible and usable, which is the right answer for an agent choosing what to
 * press and the wrong one here. A readiness probe wants to see the skeleton
 * arrive and be replaced, including the parts a person never could press.
 */
export const INVENTORY_SCRIPT = `(() => {
  const SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="combobox"], [role="textbox"], [data-testid]';
  const label = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim().slice(0, 60);
  return Array.from(document.querySelectorAll(SELECTOR)).map((el) => {
    const box = el.getBoundingClientRect();
    // A driver with no layout engine reports a constant stub for every
    // element. Reporting null beats reporting a confident lie: a stage can
    // then decline to reason about visibility instead of believing it.
    const laidOut = box.width !== box.height || box.width > 8;
    return {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid') || undefined,
      domId: el.id || undefined,
      label: label(el) || undefined,
      // Where the app says its own instances are. A list page links to its
      // detail pages, which is how a route with a parameter gets a real id
      // without anyone guessing one. Same-origin only: an outbound link is
      // somebody else's site.
      href: el.tagName === 'A' && el.href && el.href.startsWith(location.origin)
        ? el.pathname + el.search
        : undefined,
      visible: laidOut ? box.width > 0 && box.height > 0 : null,
    };
  });
})()`;

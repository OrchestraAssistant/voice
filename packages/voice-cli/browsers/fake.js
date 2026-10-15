/**
 * A browser with no browser, for testing the stages that use one.
 *
 * The same argument as the fake data channel: everything that decides how a
 * stage behaves would otherwise live behind a real browser, and the only thing
 * a test could do is assert that the source reads a certain way. Here a test
 * says what the page did over time and asserts what the stage concluded.
 *
 * `frames` is the inventory at each successive sample, so a test can describe
 * a skeleton being replaced by content by simply listing both.
 */
export function fakeBrowser({ pages = {}, availability = { ok: true, using: "fake" } } = {}) {
  const opened = [];

  return {
    name: "fake",
    opened,
    async available() {
      return availability;
    },
    async open(url) {
      opened.push(url);
      const script = pages[url] ?? pages["*"] ?? { frames: [[]] };
      let at = 0;
      return {
        async inventory() {
          // The last frame repeats forever: a page that has finished loading
          // stays loaded, and a test should not have to pad it.
          const frame = script.frames[Math.min(at, script.frames.length - 1)];
          at += 1;
          return frame;
        },
        url() {
          return script.landsOn ?? url;
        },
        async close() {},
      };
    },
    async close() {},
  };
}

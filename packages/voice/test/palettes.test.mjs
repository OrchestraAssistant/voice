import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PALETTES, RIM_MODES, STATES, SWATCHES, fixedPalettes, hueGap, hueSat, meanSat, mixColor, mixPalettes, rimGradient } from "../src/palettes.js";
import { rimState } from "../src/listening.js";

/** The perceptual ruler. Measuring evenness in RGB distance is exactly what
 *  OKLab exists to replace, so the tests measure in OKLab. */
function oklab(color) {
  const [R, G, B] = color.match(/\d+/g).map(Number);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(R), lin(G), lin(B)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2,
  ];
}

describe("rim palettes", () => {
  test("one palette per state, four stops each", () => {
    // Four stops because the gradient has four; the number of STATES is a
    // separate question, asserted below.
    for (const s of STATES) assert.equal(PALETTES[s].length, 4, `${s} has the wrong number of stops`);
    for (const [name, p] of Object.entries(SWATCHES)) assert.equal(p.length, 4, `swatch ${name}`);
  });

  test("no two palettes share a stop position", () => {
    // Told apart in peripheral vision or not at all. A blue that fades to a
    // slightly different blue reads as a rendering bug, not a change of state.
    for (let i = 0; i < 4; i++) {
      const at = STATES.map((s) => PALETTES[s][i]);
      assert.equal(new Set(at).size, at.length, `stop ${i + 1} repeats across palettes: ${at}`);
    }
  });

  test("three states, and each wears a named swatch", () => {
    // Thinking and speaking back were separate at first. Both are the agent
    // holding the floor, and the rim's job is to say whose turn it is.
    assert.deepEqual(STATES, ["ready", "listening", "working"]);
    assert.equal(PALETTES.ready, SWATCHES.prism);
    assert.equal(PALETTES.listening, SWATCHES.orchid);
    assert.equal(PALETTES.working, SWATCHES.lagoon);
  });

  test("arcade is named but unworn, and says why", () => {
    // Naming a palette is the point of SWATCHES; wearing one is PALETTES.
    assert.ok(SWATCHES.arcade);
    assert.ok(!Object.values(PALETTES).includes(SWATCHES.arcade));
  });

  test("every palette clears its neighbours by at least 18 degrees", () => {
    // True again now there are three: the closest any two stops get is 20deg.
    // With four it was 3, because arcade's cornflower sat on prism's blue.
    for (const [name, p] of Object.entries(PALETTES)) {
      for (const [other, q] of Object.entries(PALETTES)) {
        if (other === name) continue;
        for (const c of p) {
          for (const d of q) {
            const gap = hueGap(hueSat(c).h, hueSat(d).h);
            assert.ok(gap >= 18, `${name} ${c} is ${gap.toFixed(0)}deg from ${other} ${d}`);
          }
        }
      }
    }
  });

  test("all of them are saturated, so none relies on being colourless", () => {
    for (const s of STATES) assert.ok(meanSat(PALETTES[s]) > 0.5, `${s} is washed out`);
  });

  test("the ends are exactly the palettes", () => {
    // A crossfade landing 2% short leaves the settled colour subtly wrong, and
    // there is nothing on screen to compare it against.
    assert.equal(mixColor("#3B82F6", "#06B6D4", 0), "rgb(59, 130, 246)");
    assert.equal(mixColor("#3B82F6", "#06B6D4", 1), "rgb(6, 182, 212)");
  });

  test("an interrupted fade can be re-parsed as its own starting point", () => {
    // Mid-fade colours come back as rgb() strings, and interrupting means
    // mixing FROM one of those rather than from a hex palette.
    const midway = mixPalettes(PALETTES.listening, PALETTES.working, 0.4);
    assert.match(midway[0], /^rgb\(/);
    const onward = mixPalettes(midway, PALETTES.ready, 0.5);
    assert.match(onward[0], /^rgb\(/);
    assert.equal(onward.length, 4);
  });

  test("the default mix is even to the eye, which is what reads as movement", () => {
    // A rim change measured as abrupt in use, and the easing was only half of
    // it. Linear light is not perceptually uniform, so an even ramp through it
    // LOOKS like it accelerates: on orchid to lagoon it carried 10% of the
    // visible change in the first eighth and 17% in the last. OKLab is built
    // so equal steps are equally visible.
    const spread = (space) => {
      const steps = [...Array(9)].map((_, i) => oklab(mixColor("#F0ABFC", "#06B6D4", i / 8, space)));
      const each = steps.slice(1).map((c, i) => Math.hypot(...c.map((v, k) => v - steps[i][k])));
      const total = each.reduce((a, b) => a + b, 0);
      const percent = each.map((d) => (d / total) * 100);
      return Math.max(...percent) - Math.min(...percent);
    };
    assert.ok(spread("oklab") < 3, `oklab is uneven: ${spread("oklab").toFixed(1)}%`);
    assert.ok(spread("oklab") < spread("linear"));
    assert.ok(spread("linear") < spread("srgb"), "sRGB is the worst of the three, as expected");
  });

  test("and it keeps the most colour at the midpoint, where sRGB goes muddy", () => {
    // A straight lerp in sRGB dips through a low-chroma middle, worst on blue
    // to green -- exactly the trip from listening to working.
    const chroma = (space) => {
      const [, a, b] = oklab(mixColor("#3B82F6", "#22C55E", 0.5, space));
      return Math.hypot(a, b);
    };
    assert.ok(chroma("oklab") > chroma("srgb"), "the midpoint is muddier than a plain sRGB lerp");
    assert.ok(chroma("oklab") > chroma("linear"));
  });

  test("the gradient carries the angle and no wrapping fifth stop", () => {
    // The angle rotates across a viewport-sized box, so the two ends sit on
    // opposite screen edges; a fifth stop would put a seam on screen.
    const g = rimGradient(123, mixPalettes(PALETTES.ready, PALETTES.ready, 0));
    assert.match(g, /^linear-gradient\(123deg, /);
    assert.equal(g.match(/rgb\(/g).length, 4);
  });
});

describe("rimState", () => {
  const live = { transport: "ready", micAttached: true, mode: "continuous", holding: false,
    userSpeaking: false, agentBusy: false };

  test("a warm connection with no microphone shows nothing", () => {
    // The whole reason the transport/micAttached split exists: a session the
    // user never started must not light the rim.
    assert.equal(rimState({ ...live, micAttached: false }), null);
    assert.equal(rimState({ ...live, transport: "connecting" }), null);
    assert.equal(rimState({ ...live, transport: "idle" }), null);
  });

  test("connected and quiet is ready", () => {
    assert.equal(rimState(live), "ready");
  });

  test("speech arriving is listening", () => {
    assert.equal(rimState({ ...live, userSpeaking: true }), "listening");
  });

  test("the agent holding the floor wins over everything", () => {
    // If it is speaking and the user talks over it, the interruption belongs
    // to the next turn; flickering between the two would say nothing.
    assert.equal(rimState({ ...live, agentBusy: true }), "working");
    assert.equal(rimState({ ...live, agentBusy: true, userSpeaking: true }), "working");
  });

  test("a typed turn still lights the rim, with no microphone at all", () => {
    // Observed: someone types a command, the agent navigates and calls tools
    // for several seconds, and the screen says nothing the whole time. The
    // agent being busy is a fact about the AGENT; gating it on the microphone
    // conflated "can I hear you" with "am I doing something".
    assert.equal(rimState({ ...live, micAttached: false, agentBusy: true }), "working");
    // But only once there is a session. Nothing can be busy before that.
    assert.equal(rimState({ ...live, transport: "connecting", agentBusy: true }), null);
  });

  test("push-to-talk shows nothing until the button is held", () => {
    // The mic rests MUTED in ptt, so a rim saying "ready" over it would be
    // claiming to hear someone it cannot hear.
    assert.equal(rimState({ ...live, mode: "ptt", holding: false }), null);
    assert.equal(rimState({ ...live, mode: "ptt", holding: true }), "listening");
  });

  test("push-to-not-talk goes dark exactly while it is muted", () => {
    // Holding the button is a deliberate "do not hear me". It used to show
    // ready, which is the one thing the rim must never say over a shut mic.
    assert.equal(rimState({ ...live, mode: "ptnt", holding: true }), null);
    assert.equal(rimState({ ...live, mode: "ptnt", holding: false }), "ready");
  });

  test("but a muted microphone does not hide the agent working", () => {
    // The two gates are independent: mute silences what we HEAR, not what the
    // rim reports about what the agent is doing.
    assert.equal(rimState({ ...live, mode: "ptt", holding: false, agentBusy: true }), "working");
    assert.equal(rimState({ ...live, mode: "ptnt", holding: true, agentBusy: true }), "working");
  });
});

import { useState } from "react";

import { InterpreterBubble } from "./InterpreterBubble.jsx";
import { ListeningGlow } from "./ListeningGlow.jsx";
import { Spotlight } from "./Spotlight.jsx";
import { rimState } from "./listening.js";
import { useInterpreter } from "./VoiceProvider.jsx";

/**
 * The whole interface, assembled the way we think it should look.
 *
 * This is the top of three tiers, and it exists because the tier below it
 * failed a real host. The bubble and the rim ship separately so they can be
 * used apart, which means a host has to import both, call `useInterpreter()`,
 * derive the rim's state itself and render two things in the right places.
 * Nothing breaks if it renders only the bubble -- it simply gets no ambient
 * feedback, silently. That happened on the first real integration, and the
 * app looked fine, so nothing pointed at what was missing.
 *
 * The tiers, in the order a host should reach for them:
 *
 *   <Interpreter/>          this. One component, both pieces, our opinion.
 *   bubble + rim separately for a host that wants one, or both placed its
 *                           own way.
 *   useInterpreter()        the raw session for a host building its own UI.
 *
 * Deliberately thin: everything here is composition, and a host that wants
 * something else can drop a tier without losing anything but the assembly.
 */
export function Interpreter({ mount, rim = true, tuneRim = false }) {
  const { transport, micAttached, mode, holding, userSpeaking, agentBusy, rimPalettes } = useInterpreter();
  const live = rimState({ transport, micAttached, mode, holding, userSpeaking, agentBusy });

  /**
   * ---- TEMPORARY: the rim bench -----------------------------------------
   *
   * `tuneRim` adds a third tab to the panel that drives the rim by hand. Off
   * unless a host asks for it, so this costs a customer one unread boolean.
   *
   * `driving` is the only part that takes the session's state away. `space`
   * and `crossfadeMs` go to the rim either way, which is the point: a fade can
   * be compared against another during a real conversation rather than only
   * against a memory of one. To delete: this block, `tuneRim`, and the pieces
   * named in InterpreterBubble's RIM_TAB comment.
   */
  const [tuning, setTuning] = useState({
    driving: false,
    state: "listening",
    space: "oklch",
    crossfadeMs: 1200,
    gapMs: 250,
  });
  const state = tuning.driving ? tuning.state : live;

  return (
    <>
      {/* `active` and `state` are separate: the rim fades out on null rather
          than snapping, so it needs to keep rendering the colours it is
          leaving from. */}
      {rim ? (
        <ListeningGlow
          active={state !== null}
          state={state ?? "ready"}
          palettes={rimPalettes}
          space={tuning.space}
          crossfadeMs={tuning.crossfadeMs}
        />
      ) : null}
      {/* Points at the host app, so it renders whether or not the rim does. */}
      <Spotlight />
      <InterpreterBubble mount={mount} bench={tuneRim ? { tuning, setTuning } : null} />
    </>
  );
}

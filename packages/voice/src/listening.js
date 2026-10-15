// No JSX in here on purpose: isListening() is a pure predicate, and keeping it
// in a plain module means it can be unit-tested directly by `node --test`
// without a JSX loader or a browser. It is also the widget's only promise
// about privacy, so it is worth being able to assert cheaply and often.

/**
 * Derives "is the mic actually capturing audio right now" from transport, mic
 * attachment, mode and hold state. Emphatically NOT the same thing as "the
 * connection is up": ptt only listens while held, ptnt listens except while
 * held, and a session can be established with no microphone on it at all.
 */
export function isListening({ transport, micAttached, mode, holding }) {
  // Two independent conditions, and keeping them independent is the point. A
  // connection can be up with no microphone on it -- warmed ahead of the user
  // asking to talk, say -- and nothing about that should suggest we are
  // listening. `transport === "ready"` alone used to imply it, which would
  // light this rim on a session the user never started.
  if (transport !== "ready" || !micAttached) return false;
  if (mode === "ptt") return holding;
  if (mode === "ptnt") return !holding;
  return true; // continuous
}

/**
 * Which of the rim's three states to show, or null for "do not show it".
 *
 * Three, not four: thinking and speaking back are both the agent holding the
 * floor, and neither is a moment when anything the user does changes what
 * happens next. What the rim has to carry is whose turn it is.
 *
 *   null        nothing worth saying. No session, no open microphone, or a
 *               microphone the user is deliberately holding shut.
 *   "working"   the agent has the floor. Checked FIRST, and before the
 *               microphone is considered at all, because it is a fact about
 *               the AGENT rather than about listening -- a typed turn puts the
 *               agent to work exactly as a spoken one does, and leaving that
 *               dark meant someone who typed a command got no feedback of any
 *               kind while it ran.
 *   "listening" audio is actually arriving and being forwarded.
 *   "ready"     the microphone is open and nothing is being sent.
 *
 * `ready` is gated on the microphone being genuinely OPEN, not merely
 * attached. Push-to-talk rests muted, so it shows nothing until the button is
 * held; push-to-not-talk shows nothing while the button holds it shut. The rim
 * saying "I can hear you" over a muted microphone is the one claim it must
 * never make. A muted-but-connected state may earn its own palette later; for
 * now it is simply dark.
 */
export function rimState({ transport, micAttached, mode, holding, userSpeaking, agentBusy }) {
  if (transport !== "ready") return null;
  // Before the microphone gate on purpose -- see "working" above.
  if (agentBusy) return "working";
  if (!isListening({ transport, micAttached, mode, holding })) return null;
  // Server VAD reports speech directly. Push-to-talk switches that detector
  // off, so there the button IS the signal.
  if (mode === "ptt" ? holding : userSpeaking) return "listening";
  return "ready";
}

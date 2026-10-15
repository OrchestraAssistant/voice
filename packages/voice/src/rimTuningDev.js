import { useSyncExternalStore } from "react";

/**
 * TEMPORARY -- live tuning of the listening rim's geometry, so the band
 * width and the inner-corner rounding can be dialled in while looking at
 * the real app instead of guessing numbers off a screenshot.
 *
 * Deliberately a standalone store rather than React context or a prop
 * chain. VoiceProvider's context value is the widget's *public* API and a
 * tuning control has no business in it, and drilling one from App down
 * through InterpreterBubble into InterpreterPanel would put it in the
 * package's component signatures. This way it's one file plus two call
 * sites.
 *
 * DEFAULTS is the shipped look: 80px is the reference's Gaussian extent,
 * and 0px of corner rounding is the reference's own square inner corner.
 * Whatever these end up at, they become ListeningGlow's prop defaults and
 * this file goes away -- delete it, drop the "Rim" block at the bottom of
 * InterpreterPanel.jsx, and drop the two `useRimTuning()` call sites.
 */
const DEFAULTS = { width: 80, corner: 0 };

let tuning = DEFAULTS;
const listeners = new Set();

/** Partial update, e.g. setRimTuning({ width: 96 }). */
export function setRimTuning(patch) {
  // A new object per set, but a stable one between sets: useSyncExternalStore
  // compares snapshots by identity and would loop on a fresh object each read.
  tuning = { ...tuning, ...patch };
  for (const notify of listeners) notify();
}

export function resetRimTuning() {
  setRimTuning(DEFAULTS);
}

export function useRimTuning() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => tuning,
  );
}

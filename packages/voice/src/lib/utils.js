import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The `cn()` every shadcn/skiper component imports from "@/lib/utils".
 * Provided here so those components paste in verbatim -- clsx handles
 * conditional classes, twMerge resolves conflicting Tailwind utilities
 * (last one wins) instead of leaving both in the class string.
 *
 * Bundled into dist/voice.js at build time, so consumers never install
 * clsx or tailwind-merge themselves.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

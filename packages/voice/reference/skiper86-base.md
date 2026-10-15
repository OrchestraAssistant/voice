# "base" — the literal 1:1 port of skiper86

Kept for reference only. Not code: it lives here as Markdown rather than a
`.jsx` file specifically so Tailwind's scanner doesn't emit utilities for
classes nothing renders.

SNAPSHOT, not imported/used anywhere -- kept only so "base" is easy to
reference or revert to. This is the literal 1:1 port of the pasted
Skiper86 / AppleBorderGradient component: same single element, same
`background` gradient-array animation, same ::after inset-2px/blur-xl
technique. Confirmed behavior: blocks real page content, because the
technique was never actually transparent in the middle -- it only
looked that way in the original because its content sat in a higher
stacking position above a mostly-empty demo backdrop. See the CSS
block that shipped alongside this (also called "base") for the
matching .listening-glow / .listening-glow::after rules:

  .listening-glow {
    position: fixed;
    inset: 0;
    z-index: 2000;
    pointer-events: none;
  }
  .listening-glow::after {
    content: "";
    position: absolute;
    inset: 2px;
    background: var(--bg);
    filter: blur(24px);
  }

```jsx
import { AnimatePresence, motion } from "framer-motion";

export function ListeningGlowBase({ active }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          animate={{
            opacity: 1,
            background: [
              "linear-gradient(0deg, rgb(59, 130, 246), rgb(168, 85, 247), rgb(239, 68, 68), rgb(249, 115, 22))",
              "linear-gradient(360deg, rgb(59, 130, 246), rgb(168, 85, 247), rgb(239, 68, 68), rgb(249, 115, 22))",
            ],
          }}
          transition={{
            opacity: { duration: 0.5, ease: "easeInOut" },
            duration: 5,
            repeat: Infinity,
            ease: "linear",
          }}
          className="listening-glow"
          aria-hidden="true"
        />
      )}
    </AnimatePresence>
  );
}
```

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import {
  AudioLines,
  Check,
  Cpu,
  CornerDownLeft,
  Hand,
  Languages,
  MessageSquare,
  Mic,
  MicOff,
  Palette,
  Settings2,
  SlidersHorizontal,
  Waypoints,
} from "lucide-react";
import useMeasure from "react-use-measure";

// ?inline hands us the *compiled* stylesheet as a string (Tailwind already
// run over it) so it can be injected into the shadow root, where the host
// document's CSS cannot reach it and ours cannot leak out.
import rawWidgetCss from "./styles.css?inline";

/**
 * Bake `rem` to `px` before the sheet enters the shadow root.
 *
 * A shadow root isolates the cascade but NOT `rem`: a rem always resolves
 * against the DOCUMENT root's font-size, never the shadow host. Dropped into one
 * app that is invisible, but the extension carries this widget onto any page,
 * and a site with `html { font-size: 10px }` (common for rem-math) silently
 * rescaled the whole widget. Baking to px at the 16px base makes the widget's
 * size page-independent -- byte-identical on a normal page, no longer distorted
 * on a weird one. Safe as a plain regex because the compiled sheet carries `rem`
 * only in declaration values and `@media` conditions, never in a selector (no
 * arbitrary-value `rem` classes), so there is nothing in a selector to corrupt.
 * The inline-mount sheet (dist/voice.css) is a separate copy and keeps rem, so a
 * host that mounts inline still controls scale through its own root.
 */
const widgetCss = rawWidgetCss.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${parseFloat(n) * 16}px`);

import { cn } from "@/lib/utils";
import { useInterpreter } from "./VoiceProvider.jsx";
import { useOverlayLayer } from "./ScreenOverlay.jsx";

/**
 * Click-outside, hand-written rather than pulling in usehooks-ts for a
 * single hook -- a distributed widget shouldn't drag a utility package
 * along for ten lines. The handler goes through a ref so its identity
 * churning between renders doesn't resubscribe the listener every time.
 *
 * composedPath() carries the whole story, in both places we mount. In the
 * host's tree it is the ordinary ancestor chain; from inside the overlay's
 * shadow root, `event.target` is retargeted to the shadow host but the path
 * still lists the real nodes it passed through, so the same check works.
 *
 * That is true because the root is OPEN. A closed root truncates
 * composedPath() at the boundary -- verified, not assumed -- and this hook
 * then needed a third branch comparing against the overlay host, because
 * neither contains() nor the path could see in. Opening the root deleted
 * that branch along with the two broken iterations it originally cost.
 */
function useOnClickOutside(ref, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event) => {
      const el = ref.current;
      if (!el) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : null;
      const inside = path ? path.includes(el) : el.contains(event.target);
      if (inside) return;
      handlerRef.current(event);
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref]);
}

const TABS = [
  { title: "Talk", icon: Mic },
  { title: "Settings", icon: Settings2 },
];

/**
 * ---- TEMPORARY: the rim bench -------------------------------------------
 *
 * A third tab that drives the rim by hand, so a transition can be judged over
 * a real host app instead of over the tuner page at dev/rim.html. The tuner
 * still exists and still has the palette editors; this is the same idea moved
 * to where the app is.
 *
 * It does NOT exist unless a host passes `tuneRim` to <Interpreter/>, so
 * nothing here reaches a customer by default. To delete it, remove: this
 * block, the RimTabContent component, `case 2:` in the content switch, and
 * the `tuneRim` prop in Interpreter.jsx.
 */
const RIM_TAB = { title: "Rim", icon: SlidersHorizontal };
const RIM_STATES = ["ready", "listening", "working"];

const transition = {
  delay: 0.1,
  type: "spring",
  bounce: 0,
  duration: 0.6,
};

// Collapsed, the pill is exactly one icon-only tab plus the strip's own
// padding; open, it's the content width. 52 = the strip's h-9 (36px) inside
// its p-2 (8px a side).
const COLLAPSED_WIDTH = 56;
const COLLAPSED_HEIGHT = 52;
const PANEL_WIDTH = 290;

// Content slides in from the side the new tab sits on, so the movement
// always matches the direction the selection travelled.
const variants = {
  initial: (direction) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

/**
 * The skiper original uses shadcn's ScrollArea here, which is Radix. This is
 * the same thing in one line and no dependency -- the panel needs a scroll
 * container, not a custom scrollbar.
 */
function ScrollArea({ className, children }) {
  return <div className={className}>{children}</div>;
}

// The one row shape everything in the panel is built from: full width, icon
// and label on the left, a quiet detail on the right.
const ROW =
  "flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2 text-sm font-medium hover:bg-muted";

/**
 * The tab strip. Only the selected tab reveals its label; the rest stay
 * icon-only, and the whole strip is a single icon-width pill while
 * nothing is selected.
 */
function ExpandedTabs({ tabs, className, selected, setSelected, setDirection }) {
  const handleTabSelect = (index) => {
    if (selected === null) {
      setSelected(index);
      return;
    }
    if (selected === index) {
      setSelected(null);
      return;
    }
    setDirection(index > selected ? 1 : -1);
    setSelected(index);
  };

  return (
    <div className={cn("flex h-9 w-full items-center justify-center gap-1", className)}>
      {tabs.map((tab, index) => (
        <motion.button
          key={tab.title}
          type="button"
          initial={false}
          animate={{
            gap: selected === index ? ".5rem" : 0,
            paddingLeft: selected === index ? "1rem" : ".5rem",
            paddingRight: selected === index ? "1rem" : ".5rem",
          }}
          onClick={() => {
            handleTabSelect(index);
          }}
          aria-label={tab.title}
          className={cn(
            "relative flex h-full items-center justify-center rounded-2xl px-4 text-sm font-medium transition-colors duration-300 after:absolute after:right-0 after:top-0 after:h-full after:w-3 after:translate-x-full after:content-['']",
            selected === index
              ? cn("bg-foreground/4")
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {tab.icon && <tab.icon className="size-4" />}
          <AnimatePresence initial={false}>
            {selected === index && (
              <motion.span
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={transition}
                className="overflow-hidden whitespace-nowrap font-medium tracking-tight"
              >
                {tab.title}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      ))}
    </div>
  );
}

/**
 * Live/idle indicator, borrowed from the skiper list rows. It reports the
 * MICROPHONE, not the connection: the ping is the widget saying "you are being
 * heard", so a warm connection with no mic on it has no business animating it.
 */
function StatusDot({ transport, live }) {
  const color = live
    ? "bg-emerald-500"
    : transport === "connecting"
      ? "bg-amber-500"
      : transport === "error"
        ? "bg-red-500"
        : "bg-muted-foreground";

  return (
    <span className={cn("size-2 rounded-2xl", color)}>
      {live && <span className={cn("block size-2 animate-ping rounded-2xl", color)} />}
    </span>
  );
}

/** Talk tab: connect/disconnect, push-to-talk, transcript, typed commands. */
function TalkTabContent() {
  const {
    transport,
    micAttached,
    transcript,
    pendingAction,
    error,
    mode,
    holding,
    start,
    stop,
    sendText,
    confirmManually,
    cancelManually,
    holdStart,
    holdEnd,
    capabilities,
  } = useInterpreter();
  const [textInput, setTextInput] = useState("");
  const live = transport === "ready" && micAttached;
  const busy = live || transport === "connecting";

  const holdLabel = mode === "ptt" ? (holding ? "Listening…" : "Hold to talk") : holding ? "Muted" : "Hold to mute";

  return (
    <div className="mb-2 flex flex-col gap-0.5">
      <button type="button" onClick={busy ? stop : start} className={ROW}>
        <span className="flex items-center gap-2">
          {live ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          {live ? "Stop listening" : transport === "connecting" ? "Connecting…" : "Start listening"}
        </span>
        <span className="text-muted-foreground flex items-center gap-3 text-xs">
          {live ? "live" : transport}
          <StatusDot transport={transport} live={live} />
        </span>
      </button>

      {live && mode !== "continuous" && capabilities.pushToTalk && (
        <button
          type="button"
          className={cn(ROW, "touch-none select-none", holding && "bg-foreground/4")}
          onMouseDown={holdStart}
          onMouseUp={holdEnd}
          onMouseLeave={holdEnd}
          onTouchStart={(e) => {
            e.preventDefault();
            holdStart();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            holdEnd();
          }}
        >
          <span className="flex items-center gap-2">
            <Hand className="size-4" />
            {holdLabel}
          </span>
          <span className="text-muted-foreground text-xs">Ctrl+Space</span>
        </button>
      )}

      {pendingAction && (
        <div className="bg-foreground/4 mt-1 flex flex-col gap-2 rounded-xl p-2">
          <p className="text-sm">
            Confirm <span className="font-medium">{pendingAction.description}</span>?
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={confirmManually}
              className="bg-foreground text-background h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={cancelManually}
              className="hover:bg-muted h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-destructive px-2 py-1 text-xs">{error}</p>}

      {transcript.length > 0 && (
        <div className="mt-1 max-h-44 space-y-1 overflow-y-auto p-1">
          {transcript.slice(-8).map((turn, i) => (
            <p
              key={i}
              className={cn(
                "rounded-xl px-2 py-1 text-sm",
                turn.role === "assistant" ? "text-muted-foreground" : "bg-foreground/4",
              )}
            >
              {turn.text}
            </p>
          ))}
        </div>
      )}

      {capabilities.textInput && (
      <form
        className="bg-foreground/4 mt-1 flex h-10 items-center gap-2 rounded-xl px-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (textInput.trim()) sendText(textInput.trim());
          setTextInput("");
        }}
      >
        <MessageSquare className="text-muted-foreground size-4 shrink-0" />
        <input
          aria-label="Type a command"
          placeholder="Type a command…"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          className="placeholder:text-muted-foreground h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none"
        />
        <button
          type="submit"
          aria-label="Send"
          className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
        >
          <CornerDownLeft className="size-4" />
        </button>
      </form>
      )}
    </div>
  );
}

const MODES = [
  { id: "continuous", label: "Continuous", icon: AudioLines },
  { id: "ptt", label: "Push to talk", icon: Mic },
  { id: "ptnt", label: "Push to not talk", icon: MicOff },
];

/**
 * One selectable row. `note` is the quiet detail on the right when unselected.
 * `flag` takes the icon's place when a row has one -- sized and boxed to the
 * same 16px square so a mixed list of flags and icons still lines up.
 */
function ChoiceRow({ icon: Icon, flag, label, note, selected, onSelect }) {
  return (
    <button type="button" onClick={onSelect} className={cn(ROW, selected && "bg-foreground/4")}>
      <span className="flex min-w-0 items-center gap-2">
        {flag ? (
          <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-[13px] leading-none">
            {flag}
          </span>
        ) : (
          Icon && <Icon className="size-4 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </span>
      {selected ? (
        <Check className="size-4 shrink-0" />
      ) : (
        note && <span className="text-muted-foreground shrink-0 text-xs">{note}</span>
      )}
    </button>
  );
}

/**
 * Settings: microphone mode, model, language.
 *
 * Mode is free to change on a live session. Model and language are not -- both
 * are fixed when the session is minted -- so choosing one reconnects, and the
 * conversation so far is lost. The note under those sections says so, because
 * a control that silently drops your history is worse than one that warns you.
 */
/**
 * ---- TEMPORARY: the rim bench, continued --------------------------------
 *
 * `bench` is `{ tuning, setTuning }` from <Interpreter/>. `driving` decides
 * whether the rim listens to these buttons or to the session; `space` and
 * `crossfadeMs` are passed to the rim EITHER way, so an A/B can be judged
 * during a real conversation without taking the session's state away.
 *
 * "Play a turn" is here because a real spoken turn is not one transition. The
 * server ends it with two separate messages -- speech_stopped clears the
 * speaking flag, and input_audio_buffer.committed is what asks for the
 * response -- so the rim genuinely passes through `ready` on the way from
 * listening to working. How long that lasts is a network question we cannot
 * currently read back from a log, hence the slider: set the gap, watch what it
 * does to the fade.
 */
function RimTabContent({ tuning, setTuning }) {
  const set = (patch) => setTuning((current) => ({ ...current, ...patch }));
  const timers = useRef([]);

  // A replay is a chain of timeouts, so every one of them has to be
  // cancellable: switching tabs mid-turn would otherwise leave the rim being
  // driven by a sequence nobody can see any more.
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => stop, []);

  const playTurn = () => {
    stop();
    const steps = [
      [0, "listening"],
      [1400, "ready"],
      [1400 + tuning.gapMs, "working"],
      [3600 + tuning.gapMs, "ready"],
    ];
    for (const [at, state] of steps) {
      timers.current.push(setTimeout(() => set({ driving: true, state }), at));
    }
  };

  const Row = ({ label, children }) => (
    <div className="flex items-center justify-between gap-2 px-2 py-1">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      {children}
    </div>
  );

  return (
    <div className="mb-2 flex flex-col gap-0.5">
      <div className="flex gap-1 px-2">
        {RIM_STATES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => { stop(); set({ driving: true, state: name }); }}
            className={cn(
              "h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium",
              tuning.driving && tuning.state === name ? "bg-foreground text-background" : "bg-foreground/4",
            )}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { stop(); set({ driving: true, state: null }); }}
          className={cn(
            "h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium",
            tuning.driving && tuning.state === null ? "bg-foreground text-background" : "bg-foreground/4",
          )}
        >
          off
        </button>
      </div>

      <div className="flex gap-1 px-2 pt-1">
        <button type="button" onClick={playTurn} className="bg-foreground/4 h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium">
          Play a turn
        </button>
        <button
          type="button"
          onClick={() => { stop(); set({ driving: false }); }}
          className={cn(
            "h-8 flex-1 cursor-pointer rounded-lg text-xs font-medium",
            tuning.driving ? "bg-foreground/4" : "bg-foreground text-background",
          )}
        >
          Session
        </button>
      </div>

      <Row label="path">
        <select
          value={tuning.space}
          onChange={(e) => set({ space: e.target.value })}
          className="bg-foreground/4 h-8 cursor-pointer rounded-lg px-2 text-xs"
        >
          <option value="oklch">OKLCh (round the wheel)</option>
          <option value="oklab">OKLab (through grey)</option>
          <option value="linear">linear light</option>
          <option value="srgb">sRGB</option>
        </select>
      </Row>

      <Row label={`fade ${tuning.crossfadeMs}ms`}>
        <input
          type="range" min="200" max="3000" step="100" value={tuning.crossfadeMs}
          onChange={(e) => set({ crossfadeMs: Number(e.target.value) })}
          className="w-32 cursor-pointer"
        />
      </Row>

      <Row label={`ready gap ${tuning.gapMs}ms`}>
        <input
          type="range" min="0" max="1000" step="25" value={tuning.gapMs}
          onChange={(e) => set({ gapMs: Number(e.target.value) })}
          className="w-32 cursor-pointer"
        />
      </Row>

      <p className="text-muted-foreground px-2 pt-1 text-xs">
        The gap is the `ready` a real turn passes through between speaking and
        the reply being asked for.
      </p>
    </div>
  );
}

function SettingsTabContent() {
  const { mode, setMode, options, model, language, setModel, setLanguage, rimMode, setRimMode, rimModes,
    providers, providerId, setProvider, capabilities } = useInterpreter();

  // Only the modes the live engine supports. A cascade that cannot hold a turn
  // offers continuous only -- showing push-to-talk would be a dead control.
  const modes = MODES.filter((m) => m.id === "continuous" || capabilities.pushToTalk);

  return (
    <ScrollArea className="mb-2 max-h-72 space-y-2 overflow-y-auto">
      {providers.length > 1 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground px-2 py-1 text-xs">Voice engine</span>
          {providers.map((p) => (
            <ChoiceRow
              key={p.id}
              icon={Waypoints}
              label={p.label}
              selected={providerId === p.id}
              onSelect={() => setProvider(p.id)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-0.5 pt-2">
        <span className="text-muted-foreground px-2 py-1 text-xs">Microphone</span>
        {modes.map((m) => (
          <ChoiceRow
            key={m.id}
            icon={m.icon}
            label={m.label}
            selected={mode === m.id}
            onSelect={() => setMode(m.id)}
          />
        ))}
      </div>

      <div className="flex flex-col gap-0.5 pt-2">
        <span className="text-muted-foreground px-2 py-1 text-xs">Edge glow</span>
        {rimModes.map((m) => (
          <ChoiceRow
            key={m.id}
            icon={Palette}
            label={m.label}
            note={m.note}
            selected={rimMode === m.id}
            onSelect={() => setRimMode(m.id)}
          />
        ))}
      </div>

      {/* Model and language are the realtime relay's options; they configure
          that engine's mint and mean nothing to a cascade, whose STT/decision
          are wired by the host. `capabilities.warm` is the realtime engine's
          tell (only it pre-mints a credential), so the two sections follow the
          live engine rather than showing stale controls after a switch. */}
      {capabilities.warm && options.languages?.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-2">
          <span className="text-muted-foreground px-2 py-1 text-xs">Language</span>
          {options.languages.map((l) => (
            <ChoiceRow
              key={l.code}
              icon={Languages}
              flag={l.flag}
              label={l.label}
              selected={language === l.code}
              onSelect={() => setLanguage(l.code)}
            />
          ))}
        </div>
      )}

      {capabilities.warm && options.models?.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-2">
          <span className="text-muted-foreground px-2 py-1 text-xs">Model</span>
          {options.models.map((m) => (
            <ChoiceRow
              key={m.id}
              icon={Cpu}
              label={m.label}
              note={m.note}
              selected={model === m.id}
              onSelect={() => setModel(m.id)}
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

/**
 * The default drop-in UI: an icon-only pill that expands into a tabbed
 * panel. Closed, it's a single mic button -- the Settings tab only exists
 * once the panel has been opened. Selecting a tab reveals its label and
 * leaves the others icon-only; selecting it again collapses the whole
 * thing back to the pill.
 *
 * Opening the pill deliberately does NOT start a session -- the Talk
 * button inside does. Otherwise reaching Settings would mean going live
 * on the mic first.
 *
 * Renders into the shared overlay's `panel` layer -- a shadow root mounted
 * on <body> by <VoiceProvider> -- not into the host app's tree. That isn't
 * decoration: a host's bare `button {}` / `form {}` rules are the same
 * specificity as our own base rules and load after ours, so in the host's
 * document they simply win, and raising our specificity to answer them
 * would then stomp the Tailwind utilities this component is built out of.
 * Inside the shadow root neither side can reach the other, so both problems
 * stop existing rather than being traded against each other.
 */
export function InterpreterBubble({ mount = "shadow", bench = null }) {
  const [direction, setDirection] = useState(1);
  const [ref, bounds] = useMeasure();
  const [selected, setSelected] = useState(null);
  const { warm, warmup } = useInterpreter();

  // Opening the panel is the intent signal: deliberate, far rarer than a page
  // view, and separated from the Talk click by however long it takes to read
  // the panel. Does nothing unless <VoiceProvider warmup> says so, and never
  // touches the microphone.
  useEffect(() => {
    if (selected !== null) warm?.();
  }, [selected, warm]);

  // Under "hover" the pointer reaching the pill is the signal instead, which
  // is earlier than the click that opens the panel, so the connect has longer
  // to finish. It also fires for anyone whose cursor merely crosses that
  // corner of the screen, which is the trade. Touch has no hover, so the
  // panel-open trigger above is what covers it there.
  const onPointerEnter = warmup === "hover" ? () => warm?.() : undefined;

  const containerRef = useRef(null);
  useOnClickOutside(containerRef, () => setSelected(null));

  // "inline" renders into the host's own tree, where its stylesheet reaches
  // us -- kept as a switch so the difference stays observable rather than
  // arguable. "shadow" is the real default, and the only one that uses the
  // overlay: inline must not claim a layer (it would have an empty overlay
  // fighting host modals for the top layer on behalf of nothing), must not
  // inject the stylesheet into a root it never renders into, and above all
  // must not be handed that root -- popLayout would then style a tree its
  // panes are not in, which is the same silent failure in the other
  // direction.
  const inline = mount === "inline";

  // `active` is this layer's vote on holding the top of the top layer: an
  // idle pill shouldn't displace a host's open modal, an expanded panel
  // should sit above one.
  const { container, root } = useOverlayLayer("panel", {
    enabled: !inline,
    active: selected !== null,
    css: widgetCss,
  });

  // Settings only exists once the panel is open; indices stay stable
  // (talk 0, settings 1, rim bench 2) so `selected` survives the array
  // growing. The bench is absent unless a host asked for it -- see RIM_TAB.
  const all = bench ? [...TABS, RIM_TAB] : TABS;
  const tabs = selected === null ? all.slice(0, 1) : all;

  const content = useMemo(() => {
    switch (selected) {
      case 0:
        return <TalkTabContent />;
      case 1:
        return <SettingsTabContent />;
      case 2:
        return bench ? <RimTabContent {...bench} /> : <div></div>;
      default:
        return <div></div>;
    }
    // `bench` as well as `selected`: the bench's controls read and write its
    // own state, so memoising on the tab index alone would hand back a pane
    // rendered from the values the tab was opened with.
  }, [selected, bench]);

  const widget = (
    <div ref={containerRef} className="interpreter-widget" onPointerEnter={onPointerEnter}>
      <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
        <motion.div
          initial={false}
          animate={{
            height: selected === null ? COLLAPSED_HEIGHT : bounds.height,
            width: selected === null ? COLLAPSED_WIDTH : PANEL_WIDTH,
          }}
          className={cn(
            "bg-background relative mx-auto overflow-hidden rounded-3xl shadow-[0_8px_24px_rgba(0,0,0,0.16)]",
          )}
        >
          {/* The animated pane sits inside this measured wrapper and the tab
              strip is absolutely positioned *within* it, so bounds.height is
              the content's height and the strip never adds to it (the pane's
              pb-11 reserves its room).

              The pinned width is the one addition to the original's markup,
              and it is what makes the open/close resize monotonic. Left to
              size itself, this wrapper is as wide as the animating container
              -- so at the start of an open it is 56px wide, the content wraps,
              and it measures 348px tall before unwrapping down to 188 as the
              width catches up. The panel visibly ballooned and then collapsed.
              Measuring at the final width instead means the only thing that
              changes during the transition is how much of it is revealed:
              height goes 52 -> 188 and stops. The container's overflow-hidden
              does the clipping, and the tab strip is unaffected because it is
              absolute against the container, not against this wrapper.

              The original gets away without this because it moves 200 -> 290,
              which is too small a change to rewrap anything. */}
          <div ref={ref} style={{ width: PANEL_WIDTH }}>
            {/* `root` is what makes popLayout work inside the shadow root, and
                without it this component is subtly broken in the only mount
                that ships. popLayout takes the outgoing pane out of flow by
                injecting a `[data-motion-pop-id] { position: absolute }` style
                block at runtime -- into `document.head` unless told otherwise
                (framer-motion's PopChild: `const parent = root ?? document.head`).
                A stylesheet in document.head does not apply inside a shadow
                root, so the rule silently never matched, the outgoing pane
                stayed in flow, and the wrapper measured BOTH panes stacked:
                the panel jumped to their combined height and the incoming
                content sat below the empty space where the outgoing one still
                was. It looked correct at mount="inline" the whole time, which
                is exactly why it was worth being suspicious of a fix verified
                only there. */}
            <AnimatePresence mode="popLayout" initial={false} custom={direction} root={root ?? undefined}>
              <motion.div
                key={selected}
                variants={variants}
                initial="initial"
                animate="active"
                exit="exit"
                custom={direction}
                className="bg-background/80 p-2 pb-11"
              >
                {content}
              </motion.div>
            </AnimatePresence>

            <div className="bg-background absolute bottom-0 w-full p-2">
              <ExpandedTabs
                tabs={tabs}
                selected={selected}
                setSelected={setSelected}
                setDirection={setDirection}
              />
            </div>
          </div>
        </motion.div>
      </MotionConfig>
    </div>
  );

  // Inline mount renders into the host's light DOM, so the exported sheet is
  // scoped under `.iv-scope` (see tailwindProperties.js) and the widget must
  // sit under it. `display:contents` adds no box -- it is only a selector
  // ancestor -- so a fixed/absolute widget positions exactly as before. The
  // shadow mount needs none of this: its sheet is isolated by the shadow root.
  if (inline) {
    return (
      <div className="iv-scope" style={{ display: "contents" }}>
        {widget}
      </div>
    );
  }

  return container ? createPortal(widget, container) : null;
}

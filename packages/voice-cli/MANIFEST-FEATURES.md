# What the manifest knows, and when it learned it

A record of every capability the analyser has, in the order they arrived, in
plain language. Kept because the numbers are reproducible from git and the
*reasoning* is not: a commit says what changed, this says what it was for and
what it cost.

Each capability is a stage in the registry. `voice-cli --stages` lists them,
`--only` and `--without` run a subset, and every generated manifest records
which ones produced it in `generatedBy`. So a comparison is a flag, not a
checkout.

Costs are prompt tokens: instructions plus tool definitions, which is what the
model is actually sent. Measured against cal.diy (Next.js, tRPC, 81 routes) and
the demo app (React Router, 4 routes), both unpruned.

---

## 1. Routes from React Router — `react-router`

`<Route path="/tasks/:id" element={<TaskDetail/>} />`. Scans every source file,
not one hardcoded `App.jsx`, because routes are commonly split across a
`routes/` directory.

**Cal +0. Demo +0** (it was already the baseline.)

## 2. Operations from hook wrappers — `request-hooks`

Exported hooks calling `useQuery`/`useMutation` alongside a fetch helper. The
helper is matched by shape against several common names rather than requiring
one, and arrow-function hooks count as well as declarations.

Fixed two things that had made every generated manifest subtly wrong: a URL
assembled as `` `${BASE}/tasks${search ? `?search=${search}` : ""}` `` emitted
the ternary as `{param1}`, marked required, producing an endpoint no request
could satisfy; and parameters carried `source: "hook-arg"`, which the widget
does not act on, so every filter found was dropped at request time.

**Demo −14 tokens** — the only thing nine versions of work is worth to an app
that already fitted the original assumptions.

## 3. Routes from the filesystem — `next-app-router`, `next-pages-router`

Next.js routes the filesystem, so there is nothing in the source to parse.
Both routers, both `src/`-nested and root layouts, route groups dropped,
`[param]` converted, catch-alls wildcarded, parallel routes and framework
plumbing excluded.

Detectors declare when they do not apply, because the Pages Router detector
once claimed four routes from a plain React app's `src/pages/` components
folder — a coincidence of naming that produced results indistinguishable from
real ones.

**Cal +691 tokens, +81 routes.**

## 4. Endpoints from Next.js APIs — `next-route-handlers`, `next-pages-api`

The easiest endpoints in any framework to read: the filesystem gives the URL,
the exported function names give the method. Pages API routes need their verbs
read out of `req.method` branches; a handler with no branch is assumed to read
and never to write, because guessing a write would invent an operation.

**Cal +2,749 tokens, +28 operations.**

## 5. Machinery left out — `infrastructure`

This found 84 endpoints on cal and then had to leave out 56: cron jobs, OAuth
handshakes, webhook receivers. Discovering an endpoint and offering it to a
voice agent are different decisions. Rules belong to the framework that
produces those paths, and only frameworks that actually applied get a say.

**Cal: 84 endpoints → 28.** Without it the prefix was ~10,900 tokens.

## 6. Request bodies from schemas — `zod-bodies`

The body cannot be recovered from the call that sends it, since it is built
from component state. A validation schema is the only place the field names
and types are written down.

**Demo: 2 actions gain their bodies.** Without it a write action can be
addressed and change nothing.

## 7. Request bodies from types — `typescript-types`

A validation library is one way an app *might* describe its data; a type is how
a TypeScript app describes its data by definition, and a Zod schema exists to
produce one. Optionality comes from `?:`, which is exact rather than heuristic,
and a union of string literals becomes an enum carrying its legal values.

Zod runs first: writing a schema is a statement of intent about the wire, while
a type sharing a name is a correlation.

**Cal +0** — it is tRPC, so it has no named input types to match.

## 8. Procedures from tRPC — `trpc-routers`

A tRPC client contains no URLs at all, which is why hunting for them found 209
call sites and zero endpoints. Read from the server instead, where the shape is
declarative. The mount is read rather than assumed: stock tRPC addresses
procedures by a dotted path, cal splits into a dozen handlers by namespace.

**Cal +15,894 tokens, 28 → 177 operations.** Three quarters of cal's entire
cost, and the step without which cal has no operations at all. This is what
made choosing what ships more important than finding it.

## 9. Call-site counts — `call-sites`

How often the app's own code references each operation. 52 of cal's 177 are
referenced nowhere: schedulers, webhooks, endpoints published for third-party
consumers, uptime probes, dead code. Path patterns catch cron and webhooks;
nothing in a pattern catches `/api/version` or `/api/me`.

Recorded and reported, never acted on. Zero is a strong signal and still only a
signal.

**+0 tokens** — the model never sees it. It is for whoever writes the include
list.

## 10. Hand corrections — `hand-corrections`

The generated manifest used to carry a field asking people not to run the
generator again, because doing so destroyed their edits. Corrections now live
in `manifest.overlay.json`, which the generator reads and never writes, and an
`include` list chooses what ships.

**Cal: 177 operations → 22 chosen, ~21,500 tokens → ~3,900.**

## 11. Page descriptions from source — `page-metadata`

What each page declares about itself: a metadata export, a heading, a title
prop, or a positional `generateMetadata(t => t("a"), t => t("b"))`. Locale keys
are resolved against the app's own translation files, without which every page
in an internationalised app describes itself as a key — worse than nothing,
because a key looks like information.

**Cal +627 tokens, 53 of 81 routes described.** Probing the running app
described 20, because a client-rendered page serves a shell.

---

# What the probe adds, against a running app

Stages too, with `role: "probe"`. They never run at generate time, because
they need a live application and usually a session. Findings come back as
overlay-shaped patches rather than being applied, so a person reads the diff
before any of it becomes prompt content.

Requests are remembered for the length of a run: three of these walk the same
routes, and on a development server every one of those is a route compile.

## Route reachability — `reachability`

A route that 404s is one the agent has been told exists; it will send someone
there confidently and be wrong. Found `/auth/verify-email-change` on cal —
which turned out to exist as a file and return 404 without a token, so the
manifest has no way yet to say "real, given a parameter".

## What a query returns — `query-shapes`

The manifest cannot express this, so the model infers the shape from the tool
name. One call answers it, and it reaches the model as a sentence for about a
dozen tokens.

## Which fields the server truly requires — `required-fields`

Needs `--writes`, because probing a write means performing one. Sends one
request per declared-required field, each missing exactly that one.
Found the demo's `updateSettings` declaring `name`, `email` and `theme` all
required while the server accepts `{"theme":"dark"}` alone — so the manifest was
telling the model to invent a name and an email to change one setting.

## What to wait for on a page — `readiness`

Needs a browser, so it is opt-in: `probe.js ... --browser`. The browser is the
developer's own, found rather than shipped -- 12MB of puppeteer-core against
262MB for a downloaded Chromium -- and it sits behind a driver contract so the
engine can be swapped without a stage noticing.

Opens each parameterless route, samples what exists twelve times over three
seconds, and proposes the most PAGE-SPECIFIC stable element as that route's
`readyWhen`. A measurement, not a judgement, which is why it is a probe and not
an agent: nothing here is decided, only counted.

The whole difficulty is telling a page's content from the app's chrome, since
both can render late. Three signals, all mechanical, settle it:

- **Specificity across routes.** A marker that shows up on many pages is
  furniture no matter how late it arrives, and the one on the fewest pages is
  the page's own. This is the primary ranking. An early attempt keyed on
  arrival time instead and picked cal.diy's late-mounting gear icon over the
  day switches that were there from the first frame -- so arrival time was
  dropped entirely. `Sunday-switch`, on one route, wins; `settings-icon`, on
  fourteen, is named and refused.
- **Source spread breaks ties.** A `data-testid` written in one source file is
  page content; one in twenty is a shared component's. It vetoes a marker rare
  in this crawl but common in the code (`new_webhook`, 124 files) and confirms
  the specific one (`app-store-app-card-apple-calendar`, 1 file).
- **Some markers mean absence, not readiness.** `404-page`, `error-page` and
  `maintenance` are excluded by name: proposing one says "wait for this route
  to fail," which is a reachability finding in the wrong place.

A redirect is checked at both ends, since cal.diy bounces an unauthenticated
visitor after DOMContentLoaded and a start-only check measured the login page
as though it were the route.

Run it signed in. The probe hands its cookie jar to the browser, so `--login`
covers both halves; without it most of an authenticated app is unmeasurable and
says so. A `__Secure-` session cookie forces one wrinkle: it may only be set
against an https origin, so the browser is given the base URL with its scheme
swapped to https while the host is kept aligned.

It also generalises a measured VALUE back to the SHAPE it was built from. The
probe can only see `Sunday-switch`; the source holds `data-testid={`${weekday}-switch`}`.
Storing the literal would key the wait to one locale and one row of data, so
static analysis harvests the test-id templates (the `*`-holed shapes) and the
probe swaps its measured id for the matching one -- `*-switch`, `app-store-app-card-*`.
A shape needs a real stem, not just separators between holes: `${a}-${b}` is
`*-*`, which matches almost anything, and is dropped. An id that fits no
template keeps its own text, because it was not built from one.

This is the pipeline's division of labour exactly: static analysis knows the
shape and not the value, the probe knows the value and not the shape, and
matching one to the other recovers what neither could produce alone.

## Page copy, harvested — `page-copy`

The rendered heading and the line under it. Superseded for most apps by reading
the source (11), which sees pages that never render on the server.

---

# What a flow can pin down

Flow steps are hand-written in the overlay: nothing can infer a click sequence
from source, and this is where a person says what a dialog is for.

## An element the step actually meant — `testId` / `domId`

A step targets by label, because a label is what `dom_snapshot` reports and
what the person asking would have said. But a label is not unique and was never
meant to be, so a step may also carry `testId` (a `data-testid`) or `domId` (an
authored `id`), and then both have to match.

Enrich, never require. Apps write these on some elements and not others, and a
flow against a bare app has the label and has to work with it. cal.diy's create
dialog is the honest case: of five steps, two have a test id and three have
nothing but their label.

Found by a failure. cal.diy labels the button opening a new schedule "New" and
the one opening a new event type "New", telling them apart only by
`data-testid`. `click: "New"` from the availability page opened the schedule
dialog, hunted four seconds for a field called "Title" that a schedule dialog
does not have, and stopped — three steps into the wrong screen. Anchored, it
stops at step one.

## When a page is ready to be read — `readyWhen`

A route may declare what "ready" looks like: the `testId`, `domId` or `label`
of an element that exists only once the real content has rendered. `navigate`
waits for it before returning.

Written by hand, because it is a claim about how the app renders that nothing
in the source states. cal.diy's schedule editor uses `Sunday-switch`; its event
type list uses the `event-types` container. Matched anywhere in the document,
not only among the things you can press, since a readiness marker is usually a
wrapper rather than a control.

Found the hard way. A session navigated to the right schedule, snapshotted
420ms later, saw the app shell, concluded the availability editor "was not on
this screen", and left. The switches were not hidden from the snapshot, they
did not exist yet.

**Not inferable, which is why it is hand-written.** A static analyser would
have to find, for each route, the element that appears only once data has
arrived. In cal.diy that lives nowhere near the route: 0 of 79 page files
contain a loading state at all, because the pages are thin and the loading sits
several imports away in shared view components. Next.js's own `loading.tsx`
convention covers 16 of those 79 routes, and it says a route HAS a loading
state, not what "loaded" looks like. A wrong `readyWhen` is also worse than
none: it fails slowly and confidently, either waiting out the full timeout or
matching something that renders DURING loading. The right way to learn this is
to measure it -- load the route in a browser, watch what appears last and
stays -- which is a probe stage, not an analyser one.

Without it, `navigate` guesses briefly and says when it gave up. The obvious
guesses are all wrong: network idle never happens in an app that polls,
mutation quiescence returns on a STABLE SKELETON, and a spinner animated in CSS
mutates nothing at all. So the fallback watches the count of labelled
interactive elements instead -- skeletons are divs and contribute almost none,
and content arriving makes it jump. And the guess never claims readiness. Stability is not evidence of it: a page
whose chrome renders in 200ms and whose content arrives at two seconds is
stable on its shell from about 450ms, so an undeclared wait reports `assumed`
either way. A bigger cap does not help, because the cap is only ever reached by
a page that never stops changing at all.

## Where the flow is valid — `page`

The other half, and a different guarantee: the identifier says WHICH element,
the page says WHERE the flow runs. Checked once before anything is clicked, so
a flow aimed at the wrong screen opens nothing at all. Matched segment-wise
with `:param` and `[param]` standing for one segment, so a flow declared for
`/availability/:id` runs on `/availability/49` and not on `/availability`.

The two fail at different points, which is the reason to have both.

---

# Deferred, with reasons

See DESIGN-CHOICES §25. An agent pass that drives the app and writes
descriptions and flows; and tiering the manifest so only tier one reaches the
prompt. Both wanted, neither yet worth the complexity — harvesting and counting
cover most of the same ground, and no manifest has yet been large enough after
honest pruning to need tiers.

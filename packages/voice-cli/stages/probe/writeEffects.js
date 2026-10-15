import { encodeOperation, unwrapReply, at, classifyEffect } from "../../core/effects.js";

/**
 * Whether a write actually changes state, by reading the state back.
 *
 * A status says a request was accepted; it does not say the app did anything.
 * A handler can answer 200 and no-op -- cal.diy's schedule.update returns the
 * unchanged schedule when `name` is absent, though the schema calls `name`
 * optional -- and every check that trusts the status is fooled. This one reads
 * the observed value before the write and again after, and only a real change
 * counts as a verified effect.
 *
 * Needs `--writes` (it performs writes) and a fixture (`--effects file.json`):
 * a map of action name to the natural call to make and where to watch for its
 * result. The fixture is required because the payload cannot be synthesised --
 * to know a payload that works is to already know the contract the no-op hides,
 * so the call has to come from a person who wrote down what they would say. See
 * core/effects.js for that argument in full.
 *
 * Fixture shape, per action:
 *   {
 *     "availabilityScheduleUpdate": {
 *       "read":    { "query": "availabilityList", "args": {} },
 *       "observe": "schedules.0.availability.0.days",
 *       "write":   { "scheduleId": 50, "schedule": [[{ "start": "...", "end": "..." }]] },
 *       "restore": { "scheduleId": 50, "schedule": [[...original...]] }   // optional
 *     }
 *   }
 *
 * `observe` is a dot/index path into the READ reply (already unwrapped from
 * tRPC's envelope). `restore`, when given, is a second write that puts the
 * state back, so the probe leaves the instance as it found it.
 */
export const writeEffects = {
  name: "write-effects",
  role: "probe",
  describe: "whether a write truly changes state, read back after the fact",
  needsWrites: true,

  async run({ manifest, ask, askFresh, effects }) {
    if (!effects || !Object.keys(effects).length) {
      return { notes: ["no --effects fixture; nothing to verify"] };
    }
    // The reads MUST bypass the run-wide GET cache: the before and after use the
    // same URL, and a cached second read would return the first and hide every
    // change, turning every write into a false no-op. `askFresh` is the uncached
    // fetcher; in tests only `ask` is passed and it is already uncached.
    const read = askFresh ?? ask;

    const actions = manifest.actions ?? [];
    const queries = manifest.queries ?? [];
    const verified = [];
    const notes = [];
    const problems = [];

    const readObserved = async (readSpec, observe) => {
      const query = queries.find((q) => q.name === readSpec.query);
      if (!query) return { error: `no query "${readSpec.query}"` };
      const { method, url } = encodeOperation(query, readSpec.args ?? {});
      const res = await read(method, url);
      if (res.error) return { error: res.error };
      return { value: at(unwrapReply(res.body), observe) };
    };

    for (const [actionName, spec] of Object.entries(effects)) {
      const action = actions.find((a) => a.name === actionName);
      if (!action) {
        notes.push(`${actionName}: no such action in the manifest`);
        continue;
      }
      if (!spec.read || !spec.write) {
        notes.push(`${actionName}: fixture needs both "read" and "write"`);
        continue;
      }

      const before = await readObserved(spec.read, spec.observe);
      if (before.error) {
        notes.push(`${actionName}: could not read before (${before.error})`);
        continue;
      }

      const req = encodeOperation(action, spec.write);
      const wrote = await ask(req.method, req.url, req.body);

      const after = await readObserved(spec.read, spec.observe);
      if (after.error) {
        notes.push(`${actionName}: could not read after (${after.error})`);
        continue;
      }

      const { outcome, note } = classifyEffect({ status: wrote.status, before: before.value, after: after.value });

      if (outcome === "verified") {
        verified.push({ name: actionName, verified: true });
        notes.push(`${actionName}: verified -- the write moved ${spec.observe}`);
      } else if (outcome === "silent-noop") {
        verified.push({ name: actionName, verified: false });
        problems.push(
          `${actionName} accepted the write (2xx) but ${spec.observe} did not change -- ` +
            `a field the schema calls optional is likely load-bearing, or the payload shape is wrong`,
        );
      } else if (outcome === "rejected") {
        notes.push(`${actionName}: ${note} -- rejected, not a no-op (see required-fields)`);
      } else {
        notes.push(`${actionName}: ${note}`);
      }

      // Put it back, if the fixture said how.
      if (spec.restore) {
        const undo = encodeOperation(action, spec.restore);
        await ask(undo.method, undo.url, undo.body);
      }
    }

    return { corrections: { actions: verified }, notes, problems };
  },
};

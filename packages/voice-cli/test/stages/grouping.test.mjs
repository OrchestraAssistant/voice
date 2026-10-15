import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { grouping, groupKeyOf } from "../../stages/grouping.js";

describe("groupKeyOf (the entity a name acts on)", () => {
  test("a leading verb strips to the entity", () => {
    assert.equal(groupKeyOf("createCycle"), "cycle");
    assert.equal(groupKeyOf("createIssueLink"), "issue");
    assert.equal(groupKeyOf("deleteWatchlistEntry"), "watchlist");
  });
  test("multi-word verb qualifiers (findMany/createOne) are stripped", () => {
    assert.equal(groupKeyOf("findManyApplicationRegistrations"), "application");
    assert.equal(groupKeyOf("createOneWorkflow"), "workflow");
    assert.equal(groupKeyOf("findAllUsers"), "users");
  });
  test("a namespaced name keeps its namespace (no leading verb)", () => {
    assert.equal(groupKeyOf("availabilityScheduleUpdate"), "availability");
    assert.equal(groupKeyOf("bookingsConfirm"), "bookings");
  });
  test("a single-character fragment is skipped (oAuth -> auth, not o)", () => {
    assert.equal(groupKeyOf("oAuthCreateClient"), "auth");
  });
});

/** `count` realistically-named actions for `entity` (verb + Entity + suffix word). */
function cluster(entity, count) {
  const verbs = ["create", "update", "delete", "get", "list", "archive", "restore", "move", "assign", "toggle"];
  const suffixes = ["Link", "Reaction", "Comment", "Label", "State", "Member", "View", "Note", "Tag", "Field"];
  const Ent = entity[0].toUpperCase() + entity.slice(1);
  return Array.from({ length: count }, (_, i) => ({ name: `${verbs[i % verbs.length]}${Ent}${suffixes[i % suffixes.length]}${i}` }));
}

describe("the grouping policy", () => {
  const inTopic = (m, k) => m.actions.filter((o) => o.group?.[0] === k).length;
  const atRoot = (m) => m.actions.filter((o) => !o.group?.length).length;

  test("a mid-size app is left entirely at root (grouping is for large apps)", () => {
    // 50 ops: comfortably over the OLD budget (40), under the new one -- exactly
    // the field-test case that was wrongly grouped at 43.
    const m = { queries: [], actions: [...cluster("issue", 25), ...cluster("cycle", 25)] };
    grouping.run({ manifest: m });
    assert.ok(m.actions.every((o) => !o.group), "a 50-op app must ship flat");
  });

  test("a large app groups only the long tail; the dominant entity stays at root", () => {
    const m = {
      queries: [],
      actions: [
        ...cluster("issue", 60), // dominant / most-spoken-to -> must stay at root
        ...cluster("label", 10),
        ...cluster("state", 8),
        ...cluster("webhook", 6),
        ...["alpha", "beta", "gamma"].map((u) => ({ name: `create${u[0].toUpperCase()}${u.slice(1)}` })),
      ],
    }; // 87 ops -> must come down to <= 80
    grouping.run({ manifest: m });
    assert.ok(atRoot(m) <= 80, `root ${atRoot(m)} must be within budget`);
    assert.equal(inTopic(m, "issue"), 0, "the dominant cluster is NOT buried behind an expand");
    // the smallest tail clusters move first, just enough to fit
    assert.equal(inTopic(m, "webhook"), 6, "the smallest tail cluster is grouped");
    assert.equal(inTopic(m, "state"), 8, "the next-smallest is grouped");
    assert.ok(!m.actions.find((o) => o.name === "createAlpha").group, "singletons stay at root");
  });

  test("it groups no more than the budget requires", () => {
    // 60 + 25 = 85 ops. Grouping the 25-cluster alone (-> 60 root) suffices, so the
    // 60-cluster is never touched.
    const m = { queries: [], actions: [...cluster("issue", 60), ...cluster("cycle", 25)] };
    grouping.run({ manifest: m });
    assert.equal(inTopic(m, "cycle"), 25, "the smaller cluster moves");
    assert.equal(inTopic(m, "issue"), 0, "the larger cluster stays -- budget already met");
    assert.ok(atRoot(m) <= 80);
  });

  test("an operation that already carries a group is left untouched", () => {
    const m = { queries: [], actions: cluster("issue", 90) }; // over budget, so grouping fires
    m.actions[0].group = ["custom"];
    grouping.run({ manifest: m });
    assert.deepEqual(m.actions[0].group, ["custom"], "a hand/overlay group is the floor");
  });
});

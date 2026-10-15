import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDestructive } from "./destructive.js";

describe("isDestructive (the requiresConfirmation default)", () => {
  test("a DELETE is destructive whatever its name", () => {
    assert.equal(isDestructive({ method: "DELETE", name: "fetchThing" }), true);
    assert.equal(isDestructive({ method: "delete" }), true);
  });

  test("POST-based destructive ops are caught by name -- the tRPC/GraphQL case", () => {
    // Mutations are always POST, so the HTTP method said nothing; these all
    // sailed through unconfirmed before.
    for (const n of [
      "deleteTask", "removeUser", "destroySession", "deactivateAccount",
      "cancelSubscription", "archiveProject", "transferOwnership", "resetPassword",
      "revokeAccess", "suspendUser", "refundOrder", "payoutBalance", "purgeCache",
      "disableFeature", "unpublishPost", "terminateInstance",
    ]) {
      assert.equal(isDestructive({ method: "POST", name: n }), true, n);
    }
  });

  test("verb-at-the-end names (cal/tRPC dotted paths) are caught too", () => {
    assert.equal(isDestructive({ name: "availabilityScheduleDelete" }), true);
    assert.equal(isDestructive({ name: "schedule.delete" }), true);
    assert.equal(isDestructive({ name: "cyclesRemove" }), true);
  });

  test("ordinary writes are not flagged", () => {
    for (const n of [
      "createTask", "updateProfile", "addComment", "sendInvite", "saveDraft",
      "listUsers", "getSchedule", "markRead", "duplicateEvent", "reorderColumns",
    ]) {
      assert.equal(isDestructive({ method: "POST", name: n }), false, n);
    }
  });

  test("a verb inside a longer word is not a match", () => {
    assert.equal(isDestructive({ name: "undeletedItems" }), false);
    assert.equal(isDestructive({ name: "transferable" }), false);
  });

  test("a missing name or method is not a throw", () => {
    assert.equal(isDestructive({}), false);
    assert.equal(isDestructive(), false);
  });
});

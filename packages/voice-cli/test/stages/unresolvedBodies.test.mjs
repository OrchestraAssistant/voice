import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedBodies } from "../../stages/unresolvedBodies.js";

/** Run the stage over one action and return its review array. */
const flag = (action) => {
  unresolvedBodies.run({ actions: [action] });
  return action.review;
};

describe("unresolved-bodies enricher", () => {
  test("a declared-but-unresolved zod schema names the symbol to chase", () => {
    const r = flag({ name: "webhookCreate", method: "POST", bodyFields: [], _inputSchema: "ZCreateInputSchema" });
    assert.equal(r[0].kind, "unknown");
    assert.match(r[0].reason, /ZCreateInputSchema/);
    assert.match(r[0].reason, /where it is defined/);
  });

  test("a named-but-unresolved TS type points at the type (the axios case)", () => {
    const r = flag({ name: "createIssue", method: "POST", bodyFields: [], _inputType: "TIssuePayload" });
    assert.equal(r[0].kind, "unknown");
    assert.match(r[0].reason, /TIssuePayload/);
    assert.match(r[0].reason, /type/);
  });

  test("a hook with no schema points at the form", () => {
    const r = flag({ name: "usersUpdate", method: "PUT", bodyFields: [], _hookName: "useUsersUpdate" });
    assert.match(r[0].reason, /useUsersUpdate/);
    assert.match(r[0].reason, /form/);
  });

  test("nothing declared points at the handler", () => {
    const r = flag({ name: "createCancel", method: "POST", bodyFields: [] });
    assert.match(r[0].reason, /handler/);
  });

  test("a write whose body another enricher FILLED is not flagged -- the whole point", () => {
    const action = { name: "createIssue", method: "POST", _inputType: "TIssuePayload", bodyFields: [{ name: "title", type: "string", required: true }] };
    unresolvedBodies.run({ actions: [action] });
    assert.equal(action.review, undefined);
  });

  test("the flag is appended to existing field-level review, not overwritten", () => {
    const action = { name: "x", method: "POST", bodyFields: [], review: [{ field: "grid", kind: "opaque", reason: "…" }] };
    unresolvedBodies.run({ actions: [action] });
    assert.equal(action.review.length, 2);
    assert.equal(action.review[0].kind, "opaque");
    assert.equal(action.review[1].kind, "unknown");
  });

  test("a GET with no body is not flagged -- it takes no input to specify", () => {
    const action = { name: "list", method: "GET", bodyFields: [] };
    unresolvedBodies.run({ actions: [action] });
    assert.equal(action.review, undefined);
  });

  test("a DELETE with no body is not flagged as a write", () => {
    const action = { name: "removeThing", method: "DELETE", bodyFields: [] };
    unresolvedBodies.run({ actions: [action] });
    assert.equal(action.review, undefined);
  });

  test("a variable-less GraphQL mutation is not flagged -- its inputs are fully declared", () => {
    const action = { name: "logout", method: "POST", transport: "graphql", bodyFields: [] };
    unresolvedBodies.run({ actions: [action] });
    assert.equal(action.review, undefined);
  });
});

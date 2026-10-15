import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, graphql, rest, transportFor, trpc } from "../src/transports.js";

/**
 * The wire format is the part that is easy to get subtly wrong and impossible
 * to check by eye. Every expectation here was confirmed against a running
 * cal.diy before it was written down.
 */
describe("REST", () => {
  const query = { method: "GET", endpoint: "/api/tasks", params: [{ name: "search", source: "query-string" }] };

  test("query-string parameters are appended, url ones substituted", () => {
    assert.equal(rest.request({ operation: query, args: { search: "yoga" } }).url, "/api/tasks?search=yoga");
    assert.equal(buildUrl("/api/tasks/{id}", { id: 7 }), "/api/tasks/7");
  });

  test("only declared body fields are sent", () => {
    // Anything else the model invented would be forwarded straight into the
    // app's own API.
    const action = { method: "PUT", endpoint: "/api/tasks/{id}", bodyFields: [{ name: "done" }], params: [] };
    const { body } = rest.request({ operation: action, args: { id: 3, done: true, sneaky: "x" } });
    assert.deepEqual(body, { done: true });
  });

  test("a failure keeps the server's message when there is one", () => {
    assert.throws(() => rest.read({ error: "Task not found" }, { ok: false, status: 404 }), /Task not found/);
    assert.throws(() => rest.read(null, { ok: false, status: 500 }), /Request failed: 500/);
  });
});

describe("tRPC", () => {
  const list = { method: "GET", endpoint: "/api/trpc/availability/list", transport: "trpc" };
  const update = { method: "POST", endpoint: "/api/trpc/availability/schedule.update", transport: "trpc" };

  test("a query carries superjson-wrapped input in the query string", () => {
    // Verified against the running app: this exact shape returns a structured
    // tRPC reply, while a plain REST call returns an HTML page.
    const { method, url } = trpc.request({ operation: list, args: { username: "pro" } });
    assert.equal(method, "GET");
    const input = JSON.parse(decodeURIComponent(url.split("input=")[1]));
    assert.deepEqual(input, { json: { username: "pro" } });
  });

  test("a query with no arguments still sends an empty envelope", () => {
    // It used to omit `?input=` entirely, so tRPC parsed the input as
    // `undefined` -- and a zod object rejects `undefined` even when every
    // field in it is optional. Two of cal.diy's availability queries take
    // nothing mandatory and answered "Invalid input" to a call that asked for
    // nothing, and a session burned five tool calls finding that out.
    const { url } = trpc.request({ operation: list, args: {} });
    const input = JSON.parse(decodeURIComponent(url.split("input=")[1]));
    assert.deepEqual(input, { json: {} });
  });

  test("a mutation puts the envelope in the body", () => {
    const { method, url, body } = trpc.request({ operation: update, args: { id: 4, name: "Weekdays" } });
    assert.equal(method, "POST");
    assert.equal(url, "/api/trpc/availability/schedule.update");
    assert.deepEqual(body, { json: { id: 4, name: "Weekdays" } });
  });

  test("a mutation with no arguments sends an empty object, not a null", () => {
    // Same reason as the query above, and `null` is not better than
    // `undefined` here: `z.object({...}).safeParse(null)` is rejected too. An
    // empty object is the one value an all-optional schema accepts.
    assert.deepEqual(trpc.request({ operation: update, args: {} }).body, { json: {} });
  });

  test("a declared date field is superjson-tagged so z.date() accepts it", () => {
    // The exact failure from a live run: the schema is
    // `schedule: z.array(z.array(z.object({ start: z.date(), end: z.date() })))`,
    // the model sent valid ISO strings, and with no superjson meta they stayed
    // strings and z.date() said "Expected date, received string". The manifest
    // now carries the date paths (arrays transparent), so the body must arrive
    // with both the ISO in `json` and a `["Date"]` tag at each path in `meta`.
    const withDates = {
      ...update,
      bodyFields: [
        { name: "scheduleId" },
        { name: "schedule", dates: [["start"], ["end"]] },
      ],
    };
    const { body } = trpc.request({
      operation: withDates,
      args: {
        scheduleId: 50,
        schedule: [[{ start: "1970-01-01T09:00:00.000Z", end: "1970-01-01T17:00:00.000Z" }], []],
      },
    });
    assert.deepEqual(body.json.schedule, [
      [{ start: "1970-01-01T09:00:00.000Z", end: "1970-01-01T17:00:00.000Z" }],
      [],
    ]);
    assert.deepEqual(body.meta, {
      values: {
        "schedule.0.0.start": ["Date"],
        "schedule.0.0.end": ["Date"],
      },
    });
    assert.equal("scheduleId" in body.meta.values ? "tagged" : "plain", "plain"); // a number is not tagged
  });

  test("a field with no dates is byte-identical to the old envelope", () => {
    // The superjson change must not touch anything that did not carry a date.
    const { body } = trpc.request({
      operation: { ...update, bodyFields: [{ name: "name" }] },
      args: { name: "Weekdays" },
    });
    assert.deepEqual(body, { json: { name: "Weekdays" } });
    assert.equal("meta" in body, false);
  });

  test("an unparseable date string is left alone rather than crashing", () => {
    // `new Date("09:00")` is Invalid and cannot be serialised. Leaving it a
    // string lets the server answer "Invalid date" instead of the widget throwing.
    const { body } = trpc.request({
      operation: { ...update, bodyFields: [{ name: "at", dates: [[]] }] },
      args: { at: "09:00" },
    });
    assert.equal(body.json.at, "09:00");
    assert.equal(body.meta, undefined);
  });

  test("the reply is unwrapped out of result.data.json", () => {
    assert.deepEqual(trpc.read({ result: { data: { json: [{ id: 1 }] } } }, { ok: true }), [{ id: 1 }]);
  });

  test("an error keeps the reason, which the HTTP status alone throws away", () => {
    // Observed: { error: { json: { message: "UNAUTHORIZED", ... } } } with a
    // 401. Reporting "Request failed: 401" discards the half that explains it.
    assert.throws(
      () => trpc.read({ error: { json: { message: "UNAUTHORIZED" } } }, { ok: false, status: 401 }),
      /UNAUTHORIZED/,
    );
  });

  test("a transport-shaped failure with no body still fails", () => {
    assert.throws(() => trpc.read(null, { ok: false, status: 500 }), /Request failed: 500/);
  });
});

describe("GraphQL", () => {
  const createTask = {
    transport: "graphql",
    endpoint: "/graphql",
    operationName: "CreateTask",
    document: "mutation CreateTask($title: String!) { createTask(input: { title: $title }) { id } }",
    bodyFields: [{ name: "title" }, { name: "priority" }],
  };

  test("POSTs the document and only the declared variables", () => {
    const { method, url, body } = graphql.request({ operation: createTask, args: { title: "yoga", priority: "high", sneaky: "x" } });
    assert.equal(method, "POST");
    assert.equal(url, "/graphql");
    assert.equal(body.query, createTask.document);
    assert.equal(body.operationName, "CreateTask");
    assert.deepEqual(body.variables, { title: "yoga", priority: "high" }); // sneaky dropped
  });

  test("no variables means no variables key, and the endpoint defaults", () => {
    const { url, body } = graphql.request({ operation: { transport: "graphql", document: "query { me { id } }", bodyFields: [] }, args: {} });
    assert.equal(url, "/graphql");
    assert.equal("variables" in body, false);
  });

  test("a 200 with an errors array is a failure, and the message is kept", () => {
    // GraphQL returns 200 OK on a failed operation, so status alone is a lie.
    assert.throws(
      () => graphql.read({ errors: [{ message: "title must not be blank" }] }, { ok: true, status: 200 }),
      /title must not be blank/,
    );
  });

  test("data is unwrapped on success", () => {
    assert.deepEqual(graphql.read({ data: { createTask: { id: "1" } } }, { ok: true, status: 200 }), { createTask: { id: "1" } });
  });
});

describe("choosing one", () => {
  test("no transport means REST, which every older manifest relies on", () => {
    assert.equal(transportFor({ endpoint: "/api/tasks" }), rest);
    assert.equal(transportFor(undefined), rest);
  });

  test("and a declared one is used", () => {
    assert.equal(transportFor({ transport: "trpc" }), trpc);
    assert.equal(transportFor({ transport: "graphql" }), graphql);
  });
});

import fs from "node:fs";
import { isDestructive } from "../../core/destructive.js";
import { walk } from "../../core/parse.js";

/**
 * Operations, read from an OpenAPI / Swagger JSON spec.
 *
 * When an app ships one of these it is the cheapest producer there is: the
 * operations, their methods, their parameters AND their request bodies are all
 * written down, typed, in one file -- no AST, no inference, no schema hunting.
 * A spec is the answer to every question the other producers have to work for.
 *
 *   { "paths": { "/pets/{id}": {
 *       "patch": { "operationId": "updatePet",
 *         "parameters": [{ "name": "id", "in": "path", "required": true }],
 *         "requestBody": { "content": { "application/json": {
 *           "schema": { "$ref": "#/components/schemas/PetUpdate" } } } } } } } }
 *
 * The path is already in our `{param}` shape. `operationId` is the tool name
 * when present; otherwise it is derived from the method and path. JSON only --
 * a YAML spec would pull in a parser dependency this package does not carry;
 * generated specs (swagger-jsdoc, drf-spectacular, NestJS) are JSON far more
 * often than not, and a JSON spec covers the case without the weight.
 */

/** A file whose name says "spec" -- cheap to check before parsing. */
const SPEC_NAME = /(openapi|swagger|api-?docs)\b.*\.json$/i;

const WRITE_VERBS = { post: "create", put: "update", patch: "update", delete: "delete" };
const METHODS = ["get", "post", "put", "patch", "delete"];

/** OpenAPI scalar types -> the manifest's small vocabulary. */
function mapType(schema) {
  if (!schema) return "string";
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) return "enum";
  switch (schema.type) {
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return "array";
    case "object": return "object";
    default: return "string";
  }
}

/** Follow a local `$ref` (#/components/schemas/X) to its schema, once. */
function deref(node, spec, seen = new Set()) {
  let cur = node;
  while (cur && typeof cur.$ref === "string") {
    if (seen.has(cur.$ref)) return {};
    seen.add(cur.$ref);
    const parts = cur.$ref.replace(/^#\//, "").split("/");
    cur = parts.reduce((o, k) => o?.[decodeURIComponent(k.replace(/~1/g, "/").replace(/~0/g, "~"))], spec);
  }
  return cur ?? {};
}

/** The object schema's fields, merging allOf and resolving refs. */
function fieldsFromSchema(schema, spec, depth = 0) {
  schema = deref(schema, spec);
  if (!schema || depth > 6) return [];
  // allOf composes several schemas into one; merge their properties/required.
  if (Array.isArray(schema.allOf)) {
    const merged = { properties: {}, required: [] };
    for (const part of schema.allOf) {
      const p = deref(part, spec);
      Object.assign(merged.properties, p.properties ?? {});
      if (Array.isArray(p.required)) merged.required.push(...p.required);
    }
    schema = { ...merged, ...schema, properties: { ...merged.properties, ...(schema.properties ?? {}) } };
  }
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(props)
    .filter(([, prop]) => prop && !deref(prop, spec).readOnly) // readOnly fields are responses, not input
    .map(([name, prop]) => {
      const p = deref(prop, spec);
      const type = mapType(p);
      const out = { name, required: required.has(name), type };
      if (type === "enum") out.enumValues = p.enum.filter((v) => typeof v === "string");
      return out;
    });
}

/** requestBody -> body fields, from the application/json schema. */
function bodyFields(operation, spec) {
  const content = deref(operation.requestBody ?? {}, spec).content;
  const json = content?.["application/json"] ?? content?.["application/*+json"];
  return json?.schema ? fieldsFromSchema(json.schema, spec) : [];
}

/** parameters -> url + query params, resolving refs. */
function params(operation, spec, pathParams) {
  const all = [...(pathParams ?? []), ...(operation.parameters ?? [])].map((p) => deref(p, spec));
  const out = [];
  const seen = new Set();
  for (const p of all) {
    if (!p.name || seen.has(`${p.in}:${p.name}`)) continue;
    seen.add(`${p.in}:${p.name}`);
    if (p.in === "path" || p.in === "query") {
      const type = mapType(p.schema);
      const field = {
        name: p.name,
        type,
        required: p.in === "path" ? true : !!p.required,
        source: p.in === "path" ? "url" : "query-string",
      };
      // A closed set of values is the whole point of an enum param; dropping it
      // (fieldsFromSchema keeps it, this did not) showed the model an "enum"
      // with no members.
      if (type === "enum" && Array.isArray(p.schema?.enum)) {
        field.enumValues = p.schema.enum.filter((v) => typeof v === "string");
      }
      out.push(field);
    }
  }
  return out;
}

/** updatePet, or a name from method + path when there is no operationId. */
function nameFrom(operation, method, path) {
  if (typeof operation.operationId === "string" && operation.operationId) {
    // Normalise to a camelCase tool name: "Pets_update" / "pets-update" -> petsUpdate.
    return operation.operationId
      .replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
      .replace(/^(.)/, (c) => c.toLowerCase());
  }
  const parts = path.split("/").filter((s) => s && s !== "api").map((s) => (s.startsWith("{") ? `by-${s.slice(1, -1)}` : s));
  const camel = parts.join("-").replace(/[^a-zA-Z0-9-]/g, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/-/g, "");
  const verb = WRITE_VERBS[method];
  return verb ? verb + camel.charAt(0).toUpperCase() + camel.slice(1) : camel;
}

/** Parse a candidate file; return the spec object only if it looks like one. */
function readSpec(file) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const isSpec = spec && typeof spec === "object" && (spec.openapi || spec.swagger) && spec.paths && typeof spec.paths === "object";
  return isSpec ? spec : null;
}

export const openapiSpec = {
  name: "openapi-spec",
  role: "producer",
  describe: "an OpenAPI/Swagger JSON spec (openapi.json, swagger.json): paths -> typed operations",

  run({ srcDir, root }) {
    const queries = [];
    const actions = [];
    const seen = new Set();

    const roots = [...new Set([srcDir, root].filter(Boolean))];
    const files = roots.flatMap((dir) => walk(dir, (n) => SPEC_NAME.test(n)));
    for (const file of [...new Set(files)]) {
      const spec = readSpec(file);
      if (!spec) continue;

      // A server-relative base path applies to every operation.
      const base = (Array.isArray(spec.servers) && typeof spec.servers[0]?.url === "string"
        ? spec.servers[0].url.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, "")
        : (spec.basePath ?? "")) || "";

      for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem || typeof pathItem !== "object") continue;
        const endpoint = (base + rawPath).replace(/\/{2,}/g, "/");
        const pathParams = pathItem.parameters;
        for (const method of METHODS) {
          const operation = pathItem[method];
          if (!operation || typeof operation !== "object") continue;
          const name = nameFrom(operation, method, endpoint);
          if (!name || seen.has(name)) continue; // two specs, or a duplicate operationId
          seen.add(name);

          const entry = {
            name,
            description: operation.summary || operation.description || `Auto-detected ${method.toUpperCase()} ${endpoint} (OpenAPI)`,
            method: method.toUpperCase(),
            endpoint,
            params: params(operation, spec, pathParams),
          };
          if (method === "get") {
            queries.push(entry);
          } else {
            actions.push({ ...entry, requiresConfirmation: isDestructive({ method, name: entry.name }), bodyFields: bodyFields(operation, spec) });
          }
        }
      }
    }
    return { queries, actions };
  },
};

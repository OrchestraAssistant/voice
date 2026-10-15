/**
 * Everything we can read, in one list.
 *
 * This is the file you edit to add coverage. A new framework is a directory
 * under frameworks/ exporting detectors, plus a line here. Nothing else in the
 * pipeline learns that the framework exists: not the runner, not the merge,
 * not the report, not the exclusion engine.
 *
 * Order within a role does not matter -- the runner sorts producers before
 * enrichers -- with one deliberate exception noted below.
 */
import { reactRouter } from "./frameworks/react/router.js";
import { reactRouterConfig } from "./frameworks/react/routerConfig.js";
import { tanstackRouter } from "./frameworks/tanstack/router.js";
import { tanstackServerRoutes } from "./frameworks/tanstack/serverRoutes.js";
import { remixFsRoutes } from "./frameworks/remix/fsRoutes.js";
import { astroPages } from "./frameworks/astro/pages.js";
import { requestHooks } from "./frameworks/react/requestHooks.js";
import { nextAppRouter, nextPagesRouter } from "./frameworks/next/routes.js";
import { nextRouteHandlers, nextPagesApi } from "./frameworks/next/api.js";
import { trpcRouters } from "./frameworks/trpc/router.js";
import { axiosServices } from "./frameworks/rest/axiosServices.js";
import { openapiSpec } from "./frameworks/openapi/spec.js";
import { graphqlOperations } from "./frameworks/graphql/operations.js";
import { zodBodies } from "./schema/zod.js";
import { valibotBodies } from "./schema/valibot.js";
import { yupBodies } from "./schema/yup.js";
import { arktypeBodies } from "./schema/arktype.js";
import { tsTypes } from "./schema/typescript.js";
import { appMeta } from "./stages/appMeta.js";
import { unresolvedBodies } from "./stages/unresolvedBodies.js";
import { pageMetadata } from "./schema/pageMetadata.js";
import { callSites } from "./stages/callSites.js";
import { handCorrections } from "./stages/handCorrections.js";
import { infrastructure } from "./stages/infrastructure.js";
import { confidence } from "./stages/confidence.js";
import { grouping } from "./stages/grouping.js";
import { reachability } from "./stages/probe/reachability.js";
import { queryShapes } from "./stages/probe/queryShapes.js";
import { pageCopy } from "./stages/probe/pageCopy.js";
import { requiredFields } from "./stages/probe/requiredFields.js";
import { writeEffects } from "./stages/probe/writeEffects.js";
import { readiness } from "./stages/probe/readiness.js";

export const STAGES = [
  // Producers: find the operations.
  reactRouter,
  reactRouterConfig,
  tanstackRouter,
  tanstackServerRoutes,
  remixFsRoutes,
  astroPages,
  requestHooks,
  nextAppRouter,
  nextPagesRouter,
  nextRouteHandlers,
  nextPagesApi,
  trpcRouters,
  axiosServices,
  openapiSpec,
  graphqlOperations,

  // Enrichers: fill in what the producers could not see. Zod before
  // TypeScript on purpose -- writing a schema is a statement of intent about
  // the wire, while a type that shares a name is a correlation, and the
  // TypeScript reader only fills what is still empty.
  zodBodies,
  // The other validation schemas sit beside Zod and before TypeScript, for the
  // same reason: a schema is a statement of intent about the wire, while a type
  // that shares a name is a correlation. Each only fills a body still empty.
  valibotBodies,
  yupBodies,
  arktypeBodies,
  tsTypes,
  // Last of the body enrichers: it flags whatever none of them could fill, so
  // it must see the finished bodies. Placed after tsTypes for that reason.
  unresolvedBodies,
  // Not about operations at all: the app's own one-line identity for the prompt.
  appMeta,
  pageMetadata,
  callSites,

  // Policies: what the result should look like, rather than what is in it.
  // Hand corrections first, because naming something there is a deliberate act
  // that outranks the exclusion default.
  handCorrections,
  infrastructure,
  // Last, so it sees every review flag and any probe verdict the overlay
  // carried in, and turns them into the one path-picking word.
  confidence,
  // The classifier pass: last, so it clusters only the operations that
  // survived every producer, enricher and policy above.
  grouping,

  // Probes: run by the probe command, against a live app. They never run at
  // generate time -- they need a running application and, usually, a session.
  reachability,
  queryShapes,
  pageCopy,
  requiredFields,
  // After required-fields on purpose: that stage reads a STATUS, this one reads
  // the state back to catch a 2xx that changed nothing.
  writeEffects,
  readiness,
];

/** The old name, kept because "detector" reads better for the producers. */
export const DETECTORS = STAGES;

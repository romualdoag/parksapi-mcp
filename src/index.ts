#!/usr/bin/env node
/**
 * parksapi-mcp — generic MCP server over @themeparks/parksapi.
 *
 * No per-park code: every destination the library registers
 * (80+ worldwide) is reachable through these tools. Most destinations
 * need upstream API credentials — pass them as env vars (see parksapi
 * docs, e.g. `.env` keys like UNIVERSALORLANDO_*); public ones such as
 * `efteling` work with no credentials.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listDestinations,
  listCategories,
  getDestination,
  getEntities,
  getLiveData,
  getSchedules,
} from "./service.js";
import {
  getWaitHistory,
  getWaitStatistics,
  exportWaitHistory,
} from "./history.js";

const server = new McpServer({
  name: "parksapi-mcp",
  version: "0.2.0",
});

type TextResult = {
  content: [{ type: "text"; text: string }];
};

type ErrorResult = {
  content: [{ type: "text"; text: string }];
  isError: true;
};

function asText(obj: unknown): TextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function asError(err: unknown): ErrorResult {
  return {
    content: [
      { type: "text", text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

/** Run a tool handler: success → JSON text, throw → isError result (no protocol error). */
async function safe(
  fn: () => Promise<unknown>,
): Promise<TextResult | ErrorResult> {
  try {
    return asText(await fn());
  } catch (err) {
    return asError(err);
  }
}

const destinationParam = z
  .string()
  .describe(
    "Destination id, e.g. 'universalorlando', 'efteling', 'dlp'. See list_destinations.",
  );
const limitParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max items to return (default 50 when omitted; must be positive when given).");
const entityIdParam = z
  .string()
  .optional()
  .describe("Filter to a single entity id (matches entry.id or entry.entityId).");
const historyEntityNameParam = z
  .string()
  .optional()
  .describe("Attraction name for history resolution, e.g. \"Hagrid's Magical Creatures Motorbike Adventure\".");
const historyDaysParam = z
  .number()
  .int()
  .positive()
  .max(3660)
  .optional()
  .describe("Number of recent park-local calendar days (default 7; API calls are split into 31-day chunks).");
const historyDateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Park-local calendar date in YYYY-MM-DD form; use from + to for an explicit range.");
const historyTargetSchema = {
  destination: destinationParam.optional(),
  entityId: entityIdParam,
  entityName: historyEntityNameParam,
  days: historyDaysParam,
  from: historyDateParam,
  to: historyDateParam,
};

server.registerTool(
  "list_destinations",
  {
    description:
      "List all theme-park destinations the library supports (id, name, category). Optionally filter by category.",
    inputSchema: {
      category: z.string().optional().describe("Filter by category, e.g. 'Universal' (case-insensitive). See list_categories."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ category }) => safe(() => listDestinations(category)),
);

server.registerTool(
  "list_categories",
  {
    description: "List all destination categories for filtering list_destinations.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => safe(() => listCategories()),
);

server.registerTool(
  "get_destination",
  {
    description:
      "Get details for one destination: id, name, category and the data available (entities, live data, schedules).",
    inputSchema: { destination: destinationParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination }) => safe(() => getDestination(destination)),
);

server.registerTool(
  "get_entities",
  {
    description:
      "Get entities (parks, rides, shows, restaurants, hotels) for a destination, with hierarchy resolved. Returns the first 50 by default; pass limit to override.",
    inputSchema: {
      destination: destinationParam,
      entityType: z
        .string()
        .optional()
        .describe("Filter by type, e.g. 'ATTRACTION', 'SHOW', 'RESTAURANT' (case-insensitive)."),
      limit: limitParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityType, limit }) =>
    safe(() => getEntities(destination, { entityType, limit })),
);

server.registerTool(
  "get_live_data",
  {
    description:
      "Get live data (wait times, statuses, queues) for a destination. Optionally filter to one entity. Returns the first 50 by default; pass limit to override.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityId, limit }) =>
    safe(() => getLiveData(destination, { entityId, limit })),
);

server.registerTool(
  "get_schedules",
  {
    description:
      "Get schedules (operating hours, show times) for a destination. Optionally filter to one entity. Returns the first 50 by default; pass limit to override. Note: hosted Orlando parks expose park-level hours only (one entry keyed by the park entity, e.g. '<destination>park'); filtering by an attraction id yields no rows.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityId, limit }) =>
    safe(() => getSchedules(destination, { entityId, limit })),
);

server.registerTool(
  "get_wait_history",
  {
    description:
      "Get historical standby-wait observations from ThemeParks.wiki for the last X park-local days or an explicit date range. Resolve an attraction by the current parksapi entity id or by entityName.",
    inputSchema: {
      ...historyTargetSchema,
      daily: z.boolean().optional().describe("Return daily summaries instead of raw wait-change observations."),
      limit: z.number().int().positive().max(10000).optional().describe("Maximum observations returned (default 2000)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityId, entityName, days, from, to, daily, limit }) =>
    safe(() => getWaitHistory({ destination, entityId, entityName, days, from, to, daily, limit })),
);

server.registerTool(
  "get_wait_statistics",
  {
    description:
      "Estimate the statistical best times for a ride: groups historical standby waits by local weekday and time bucket, returning min, median, mean, p90 and sample count.",
    inputSchema: {
      ...historyTargetSchema,
      bucketMinutes: z.number().int().positive().optional().describe("Time bucket size; must divide 60 (default 60)."),
      minSamples: z.number().int().positive().optional().describe("Exclude buckets with fewer observations (default 3)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityId, entityName, days, from, to, bucketMinutes, minSamples }) =>
    safe(() => getWaitStatistics({ destination, entityId, entityName, days, from, to, bucketMinutes, minSamples })),
);

server.registerTool(
  "export_wait_history",
  {
    description:
      "Export historical standby-wait observations as CSV or JSON. The result includes a filename and data text suitable for saving as a file.",
    inputSchema: {
      ...historyTargetSchema,
      format: z.enum(["csv", "json"]).optional().describe("Export format (default CSV)."),
      daily: z.boolean().optional().describe("Export daily summaries instead of raw observations."),
      limit: z.number().int().positive().max(10000).optional().describe("Maximum raw observations (default 10000)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ destination, entityId, entityName, days, from, to, format, daily, limit }) =>
    safe(() => exportWaitHistory({ destination, entityId, entityName, days, from, to, format, daily, limit })),
);

await server.connect(new StdioServerTransport());

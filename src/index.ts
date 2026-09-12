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

const server = new McpServer({
  name: "parksapi-mcp",
  version: "0.1.0",
});

type TextResult = {
  content: [{ type: "text"; text: string }];
};

function asText(obj: unknown): TextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
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
  .describe("Max items to return (default: all).");
const entityIdParam = z
  .string()
  .optional()
  .describe("Filter to a single entity id (matches entry.id or entry.entityId).");

server.registerTool(
  "list_destinations",
  {
    description:
      "List all theme-park destinations the library supports (id, name, category). Optionally filter by category.",
    inputSchema: {
      category: z.string().optional().describe("Filter by category, e.g. 'Universal'. See list_categories."),
    },
  },
  async ({ category }) => asText(await listDestinations(category)),
);

server.registerTool(
  "list_categories",
  {
    description: "List all destination categories for filtering list_destinations.",
    inputSchema: {},
  },
  async () => asText(await listCategories()),
);

server.registerTool(
  "get_destination",
  {
    description:
      "Get details for one destination: id, name, category and the data available (entities, live data, schedules).",
    inputSchema: { destination: destinationParam },
  },
  async ({ destination }) => asText(await getDestination(destination)),
);

server.registerTool(
  "get_entities",
  {
    description:
      "Get all entities (parks, rides, shows, restaurants, hotels) for a destination, with hierarchy resolved.",
    inputSchema: {
      destination: destinationParam,
      entityType: z
        .string()
        .optional()
        .describe("Filter by type, e.g. 'ATTRACTION', 'SHOW', 'RESTAURANT'."),
      limit: limitParam,
    },
  },
  async ({ destination, entityType, limit }) =>
    asText(await getEntities(destination, { entityType, limit })),
);

server.registerTool(
  "get_live_data",
  {
    description:
      "Get live data (wait times, statuses, queues) for a destination. Optionally filter to one entity.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
  },
  async ({ destination, entityId, limit }) =>
    asText(await getLiveData(destination, { entityId, limit })),
);

server.registerTool(
  "get_schedules",
  {
    description:
      "Get schedules (operating hours, show times) for a destination. Optionally filter to one entity.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
  },
  async ({ destination, entityId, limit }) =>
    asText(await getSchedules(destination, { entityId, limit })),
);

await server.connect(new StdioServerTransport());

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
  getAllDestinations,
  getAllCategories,
  getDestinationById,
  getDestinationsByCategory,
} from "@themeparks/parksapi";

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

async function getInstance(destination: string) {
  const entry = await getDestinationById(destination);
  if (!entry) {
    const all = await getAllDestinations();
    throw new Error(
      `Unknown destination '${destination}'. Call list_destinations (${all.length} available) to find a valid id.`,
    );
  }
  return new entry.DestinationClass();
}

function withLimit<T>(arr: T[], limit?: number) {
  if (limit === undefined || limit <= 0) {
    return { count: arr.length, truncated: false as const, data: arr };
  }
  return {
    count: arr.length,
    truncated: arr.length > limit,
    data: arr.slice(0, limit),
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

function matchesEntity(entry: Record<string, unknown>, entityId?: string) {
  if (!entityId) return true;
  return entry["id"] === entityId || entry["entityId"] === entityId;
}

server.registerTool(
  "list_destinations",
  {
    description:
      "List all theme-park destinations the library supports (id, name, category). Optionally filter by category.",
    inputSchema: {
      category: z.string().optional().describe("Filter by category, e.g. 'Universal'. See list_categories."),
    },
  },
  async ({ category }) => {
    const list = category
      ? await getDestinationsByCategory(category)
      : await getAllDestinations();
    return asText(
      list.map((d) => ({ id: d.id, name: d.name, category: d.category })),
    );
  },
);

server.registerTool(
  "list_categories",
  {
    description: "List all destination categories for filtering list_destinations.",
    inputSchema: {},
  },
  async () => asText(await getAllCategories()),
);

server.registerTool(
  "get_destination",
  {
    description:
      "Get details for one destination: id, name, category and the data available (entities, live data, schedules).",
    inputSchema: { destination: destinationParam },
  },
  async ({ destination }) => {
    const entry = await getDestinationById(destination);
    if (!entry) {
      throw new Error(
        `Unknown destination '${destination}'. Call list_destinations to find a valid id.`,
      );
    }
    return asText({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      available: ["get_entities", "get_live_data", "get_schedules"],
    });
  },
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
  async ({ destination, entityType, limit }) => {
    const park = await getInstance(destination);
    let entities = await park.getEntities();
    if (entityType) {
      entities = entities.filter((e) => e.entityType === entityType);
    }
    return asText({ destination, entityType: entityType ?? "all", ...withLimit(entities, limit) });
  },
);

server.registerTool(
  "get_live_data",
  {
    description:
      "Get live data (wait times, statuses, queues) for a destination. Optionally filter to one entity.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
  },
  async ({ destination, entityId, limit }) => {
    const park = await getInstance(destination);
    const live = await park.getLiveData();
    const filtered = live.filter((e) =>
      matchesEntity(e as unknown as Record<string, unknown>, entityId),
    );
    return asText({ destination, entityId: entityId ?? "all", ...withLimit(filtered, limit) });
  },
);

server.registerTool(
  "get_schedules",
  {
    description:
      "Get schedules (operating hours, show times) for a destination. Optionally filter to one entity.",
    inputSchema: { destination: destinationParam, entityId: entityIdParam, limit: limitParam },
  },
  async ({ destination, entityId, limit }) => {
    const park = await getInstance(destination);
    const schedules = await park.getSchedules();
    const filtered = schedules.filter((e) =>
      matchesEntity(e as unknown as Record<string, unknown>, entityId),
    );
    return asText({ destination, entityId: entityId ?? "all", ...withLimit(filtered, limit) });
  },
);

await server.connect(new StdioServerTransport());

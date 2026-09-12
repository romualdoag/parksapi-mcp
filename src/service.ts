/**
 * parksapi-mcp service layer — pure logic behind the MCP tools.
 * Kept separate from index.ts (stdio wiring) so it can be unit-tested.
 */
import {
  getAllDestinations,
  getAllCategories,
  getDestinationById,
  getDestinationsByCategory,
} from "@themeparks/parksapi";

export async function getInstance(destination: string) {
  const entry = await getDestinationById(destination);
  if (!entry) {
    const all = await getAllDestinations();
    throw new Error(
      `Unknown destination '${destination}'. Call list_destinations (${all.length} available) to find a valid id.`,
    );
  }
  return new entry.DestinationClass();
}

export function withLimit<T>(arr: T[], limit?: number) {
  if (limit === undefined || limit <= 0) {
    return { count: arr.length, truncated: false as const, data: arr };
  }
  return {
    count: arr.length,
    truncated: arr.length > limit,
    data: arr.slice(0, limit),
  };
}

export function matchesEntity(entry: Record<string, unknown>, entityId?: string) {
  if (!entityId) return true;
  return entry["id"] === entityId || entry["entityId"] === entityId;
}

export async function listDestinations(category?: string) {
  const list = category
    ? await getDestinationsByCategory(category)
    : await getAllDestinations();
  return list.map((d) => ({ id: d.id, name: d.name, category: d.category }));
}

export async function listCategories() {
  return getAllCategories();
}

const AVAILABLE = ["get_entities", "get_live_data", "get_schedules"] as const;

export async function getDestination(destination: string) {
  const entry = await getDestinationById(destination);
  if (!entry) {
    throw new Error(
      `Unknown destination '${destination}'. Call list_destinations to find a valid id.`,
    );
  }
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    available: [...AVAILABLE],
  };
}

export async function getEntities(
  destination: string,
  opts: { entityType?: string; limit?: number } = {},
) {
  const park = await getInstance(destination);
  let entities = await park.getEntities();
  if (opts.entityType) {
    entities = entities.filter((e) => e.entityType === opts.entityType);
  }
  return {
    destination,
    entityType: opts.entityType ?? "all",
    ...withLimit(entities, opts.limit),
  };
}

export async function getLiveData(
  destination: string,
  opts: { entityId?: string; limit?: number } = {},
) {
  const park = await getInstance(destination);
  const live = await park.getLiveData();
  const filtered = live.filter((e) =>
    matchesEntity(e as unknown as Record<string, unknown>, opts.entityId),
  );
  return {
    destination,
    entityId: opts.entityId ?? "all",
    ...withLimit(filtered, opts.limit),
  };
}

export async function getSchedules(
  destination: string,
  opts: { entityId?: string; limit?: number } = {},
) {
  const park = await getInstance(destination);
  const schedules = await park.getSchedules();
  const filtered = schedules.filter((e) =>
    matchesEntity(e as unknown as Record<string, unknown>, opts.entityId),
  );
  return {
    destination,
    entityId: opts.entityId ?? "all",
    ...withLimit(filtered, opts.limit),
  };
}

/**
 * parksapi-mcp service layer — pure logic behind the MCP tools.
 * Kept separate from index.ts (stdio wiring) so it can be unit-tested.
 */
import {
  getAllDestinations,
  getAllCategories,
  getDestinationById,
} from "@themeparks/parksapi";
import { HOSTED_BY_ID, HOSTED_DESTINATIONS } from "./hosted.js";

function matchesCategory(
  category: string | string[] | undefined,
  wanted: string,
): boolean {
  if (!category) return false;
  const list = Array.isArray(category) ? category : [category];
  return list.some((c) => c.toLowerCase() === wanted.toLowerCase());
}

export async function getInstance(destination: string) {
  const hosted = HOSTED_BY_ID.get(destination);
  if (hosted) return new hosted.DestinationClass();
  const entry = await getDestinationById(destination);
  if (!entry) {
    const all = await getAllDestinations();
    const total = all.length + HOSTED_DESTINATIONS.length;
    throw new Error(
      `Unknown destination '${destination}'. Call list_destinations (${total} available) to find a valid id.`,
    );
  }
  return new entry.DestinationClass();
}

export function withLimit<T>(arr: T[], limit?: number) {
  // limit <= 0 / NaN / undefined = all (MCP schema enforces positive,
  // so 0 never reaches the service via tools — direct callers get "all").
  if (limit === undefined || !(limit > 0)) {
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
  // Case-insensitive on both sides: upstream getDestinationsByCategory is
  // exact-match ('disney' ≠ 'Disney'), so filter the full registry here.
  const all = await getAllDestinations();
  const list = category
    ? all.filter((d) => matchesCategory(d.category as string | string[] | undefined, category))
    : all;
  const base = list.map((d) => ({ id: d.id, name: d.name, category: d.category }));
  const hosted = HOSTED_DESTINATIONS.filter(
    (d) => !category || matchesCategory(d.category, category),
  ).map((d) => ({ id: d.id, name: d.name, category: d.category }));
  const seen = new Set(base.map((d) => d.id));
  return [...base, ...hosted.filter((d) => !seen.has(d.id))];
}

export async function listCategories() {
  const cats = new Set<string>(await getAllCategories());
  for (const d of HOSTED_DESTINATIONS) cats.add(d.category);
  return [...cats];
}

const AVAILABLE = ["get_entities", "get_live_data", "get_schedules"] as const;

export async function getDestination(destination: string) {
  const hosted = HOSTED_BY_ID.get(destination);
  if (hosted) {
    return {
      id: hosted.id,
      name: hosted.name,
      category: hosted.category,
      available: [...AVAILABLE],
    };
  }
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
    const wanted = opts.entityType.toUpperCase();
    entities = entities.filter(
      (e) => String(e.entityType).toUpperCase() === wanted,
    );
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

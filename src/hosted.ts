/**
 * hosted.ts — Orlando parks missing from @themeparks/parksapi, served here.
 *
 * The open-source library leaves Walt Disney World (4 parks) out of scope
 * (see upstream TODO.MD: Disney locked down the direct facility-service
 * API) and covers Universal Orlando only with app-extracted API credentials
 * (empty defaults → "Invalid URL" without them). The legacy JS library
 * serves these parks as "HostedPark" shims over the public collector
 * endpoint https://api.themeparks.wiki/preview/parks/<ParkAPIID>/{waittime,calendar/}.
 *
 * This module ports that HostedPark pattern into the MCP as seven native
 * Destination subclasses (4x WDW + 3x Universal Orlando Resort), so the
 * existing get_entities / get_live_data / get_schedules tools work
 * unchanged. No credentials needed — the preview API is public.
 */
import {
  Destination,
  DestinationConstructor,
  Entity,
  LiveData,
  EntitySchedule,
  StringToScheduleType,
} from "@themeparks/parksapi";

const PREVIEW_BASE = "https://api.themeparks.wiki/preview/parks";
const TIMEZONE = "America/New_York";

/** Raw attraction row from <base>/<park>/waittime */
export type HostedAttraction = {
  id: string;
  name: string;
  waitTime?: number | null;
  status?: string | null;
  active?: boolean;
  lastUpdate?: string;
  meta?: {
    type?: string;
    latitude?: number;
    longitude?: number;
    entityId?: string;
  };
};

export type HostedWaittimeResponse = { attractions?: HostedAttraction[] };

export type HostedSpecial = {
  openingTime: string;
  closingTime: string;
  type: string;
  description?: string;
};

export type HostedCalendarDay = {
  date: string;
  openingTime: string;
  closingTime: string;
  type: string;
  special?: HostedSpecial[];
};

export type HostedCalendarResponse = { calendar?: HostedCalendarDay[] };

// ---- tiny TTL cache over fetch (waittime changes fast, calendar slowly) ----

type CacheEntry = { expires: number; data: unknown };
const cache = new Map<string, CacheEntry>();

type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetchFn: FetchFn = (url, init) =>
  fetch(url, { headers: { "user-agent": "parksapi-mcp/hosted-disney" }, signal: init?.signal }) as Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;

/** Override the HTTP fetcher (used by unit tests). */
export function __setHostedFetch(fn: FetchFn): void {
  fetchFn = fn;
}

/** Clear the response cache (used by unit tests). */
export function __clearHostedCache(): void {
  cache.clear();
}

async function fetchPreview<T>(path: string, ttlMs: number): Promise<T> {
  const url = `${PREVIEW_BASE}/${path}`;
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.data as T;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const resp = await fetchFn(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Preview API ${resp.status} for ${path}`);
    const data = (await resp.json()) as T;
    cache.set(url, { expires: now + ttlMs, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---- status mapping (preview API -> LiveStatusType) ----

const STATUS_MAP: Record<string, string> = {
  operating: "OPERATING",
  open: "OPERATING",
  closed: "CLOSED",
  down: "DOWN",
  refurbishment: "REFURBISHMENT",
  maintenance: "REFURBISHMENT",
};

export function mapPreviewStatus(status: unknown, active: unknown): string {
  if (active === false) return "CLOSED";
  if (typeof status !== "string") return "CLOSED";
  return STATUS_MAP[status.trim().toLowerCase()] ?? "CLOSED";
}

/** Strip the "<ParkAPIID>_" prefix the collector prepends to some ids. */
export function normalizeEntityId(rawId: string): string {
  const idx = rawId.indexOf("_");
  return idx >= 0 ? rawId.slice(idx + 1) : rawId;
}

function mapEntityType(raw: unknown): "ATTRACTION" | "RESTAURANT" | "SHOW" {
  const t = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (t === "RESTAURANT" || t === "SHOW" || t === "ATTRACTION") return t;
  return "ATTRACTION";
}

// ---- pure mappers (unit-tested offline) ----

export function mapAttractionToEntity(
  a: HostedAttraction,
  parkId: string,
  destinationId: string,
  timezone: string = TIMEZONE,
): Entity {
  const entity: Record<string, unknown> = {
    id: normalizeEntityId(a.id),
    name: a.name,
    entityType: mapEntityType(a.meta?.type),
    parentId: parkId,
    destinationId,
    timezone,
  };
  if (typeof a.meta?.latitude === "number" && typeof a.meta?.longitude === "number") {
    entity.location = { latitude: a.meta.latitude, longitude: a.meta.longitude };
  }
  return entity as unknown as Entity;
}

export function mapAttractionToLive(a: HostedAttraction): LiveData {
  const live: Record<string, unknown> = {
    id: normalizeEntityId(a.id),
    status: mapPreviewStatus(a.status, a.active),
  };
  if (
    live.status === "OPERATING" &&
    typeof a.waitTime === "number" &&
    Number.isFinite(a.waitTime)
  ) {
    live.queue = { STANDBY: { waitTime: a.waitTime } };
  }
  if (typeof a.lastUpdate === "string") live.lastUpdated = a.lastUpdate;
  return live as unknown as LiveData;
}

function mapScheduleType(raw: unknown): string {
  if (typeof raw === "string") {
    if (raw.trim().toLowerCase() === "operating") return "OPERATING";
    try {
      return StringToScheduleType(raw);
    } catch {
      // fall through to INFO
    }
  }
  return "INFO";
}

export function mapCalendarDayToEntries(day: HostedCalendarDay): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  if (day.openingTime && day.closingTime) {
    entries.push({
      date: day.date,
      type: mapScheduleType(day.type),
      openingTime: day.openingTime,
      closingTime: day.closingTime,
    });
  }
  for (const s of day.special ?? []) {
    if (!s.openingTime || !s.closingTime) continue;
    entries.push({
      date: day.date,
      type: mapScheduleType(s.type),
      description: s.description ?? s.type,
      openingTime: s.openingTime,
      closingTime: s.closingTime,
    });
  }
  return entries;
}

// ---- Destination base + the four Orlando parks ----

export type HostedParkDef = {
  /** Legacy collector ParkAPIID, e.g. 'WaltDisneyWorldMagicKingdom' */
  parkApiId: string;
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  category: string;
};

/** Base class for collector-fed ("hosted") parks: Disney WDW + Universal Orlando. */
export abstract class HostedCollectorPark extends Destination {
  abstract readonly parkDef: HostedParkDef;

  constructor(options?: DestinationConstructor) {
    super(options);
  }

  /** Lowercase MCP id, e.g. 'waltdisneyworldmagickingdom' */
  get hostedId(): string {
    return this.parkDef.parkApiId.toLowerCase();
  }

  protected async fetchWaittime(): Promise<HostedAttraction[]> {
    const data = await fetchPreview<HostedWaittimeResponse>(`${this.parkDef.parkApiId}/waittime`, 60_000);
    return Array.isArray(data.attractions) ? data.attractions : [];
  }

  protected async fetchCalendar(): Promise<HostedCalendarDay[]> {
    const data = await fetchPreview<HostedCalendarResponse>(
      `${this.parkDef.parkApiId}/calendar/`,
      12 * 3_600_000,
    );
    return Array.isArray(data.calendar) ? data.calendar : [];
  }

  async getDestinations(): Promise<Entity[]> {
    const d = this.parkDef;
    return [
      {
        id: this.hostedId,
        name: d.name,
        entityType: "DESTINATION",
        timezone: d.timezone,
        location: { latitude: d.latitude, longitude: d.longitude },
      } as unknown as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const d = this.parkDef;
    const parkId = `${this.hostedId}park`;
    const parkEntity = {
      id: parkId,
      name: d.name,
      entityType: "PARK",
      parentId: this.hostedId,
      destinationId: this.hostedId,
      timezone: d.timezone,
      location: { latitude: d.latitude, longitude: d.longitude },
    } as unknown as Entity;
    const attractions = await this.fetchWaittime();
    const entities = attractions.map((a) =>
      mapAttractionToEntity(a, parkId, this.hostedId, d.timezone),
    );
    return [parkEntity, ...entities];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const attractions = await this.fetchWaittime();
    return attractions.map(mapAttractionToLive);
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const parkId = `${this.hostedId}park`;
    const days = await this.fetchCalendar();
    const schedule = days.flatMap(mapCalendarDayToEntries);
    return [{ id: parkId, schedule } as unknown as EntitySchedule];
  }
}

const ORLANDO_TZ = "America/New_York";

export class WaltDisneyWorldMagicKingdom extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "WaltDisneyWorldMagicKingdom",
    name: "Magic Kingdom - Walt Disney World Florida",
    latitude: 28.3852,
    longitude: -81.5639,
    timezone: ORLANDO_TZ,
    category: "Disney",
  };
}

export class WaltDisneyWorldEpcot extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "WaltDisneyWorldEpcot",
    name: "Epcot - Walt Disney World Florida",
    latitude: 28.3747,
    longitude: -81.5494,
    timezone: ORLANDO_TZ,
    category: "Disney",
  };
}

export class WaltDisneyWorldHollywoodStudios extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "WaltDisneyWorldHollywoodStudios",
    name: "Hollywood Studios - Walt Disney World Florida",
    latitude: 28.3575,
    longitude: -81.5583,
    timezone: ORLANDO_TZ,
    category: "Disney",
  };
}

export class WaltDisneyWorldAnimalKingdom extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "WaltDisneyWorldAnimalKingdom",
    name: "Animal Kingdom - Walt Disney World Florida",
    latitude: 28.3554,
    longitude: -81.5903,
    timezone: ORLANDO_TZ,
    category: "Disney",
  };
}

export class UniversalStudiosFlorida extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "UniversalStudiosFlorida",
    name: "Universal Studios Florida - Universal Orlando Resort",
    latitude: 28.4794,
    longitude: -81.4678,
    timezone: ORLANDO_TZ,
    category: "Universal",
  };
}

export class UniversalIslandsOfAdventure extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "UniversalIslandsOfAdventure",
    name: "Islands of Adventure - Universal Orlando Resort",
    latitude: 28.472,
    longitude: -81.4715,
    timezone: ORLANDO_TZ,
    category: "Universal",
  };
}

export class UniversalVolcanoBay extends HostedCollectorPark {
  readonly parkDef: HostedParkDef = {
    parkApiId: "UniversalVolcanoBay",
    name: "Volcano Bay - Universal Orlando Resort",
    latitude: 28.4611,
    longitude: -81.4733,
    timezone: ORLANDO_TZ,
    category: "Universal",
  };
}

export type HostedRegistryEntry = {
  id: string;
  name: string;
  category: string;
  DestinationClass: new () => Destination;
};

function entry(
  DestinationClass: new () => Destination,
  parkApiId: string,
  name: string,
  category: string,
): HostedRegistryEntry {
  return { id: parkApiId.toLowerCase(), name, category, DestinationClass };
}

/**
 * Collector-fed Orlando parks: the four Walt Disney World parks plus the
 * three Universal Orlando Resort parks (Studios, Islands, Volcano Bay).
 * The upstream TS library covers neither group without app credentials,
 * so both are served via the public collector API here.
 */
export const HOSTED_DESTINATIONS: HostedRegistryEntry[] = [
  entry(
    WaltDisneyWorldMagicKingdom,
    "WaltDisneyWorldMagicKingdom",
    "Magic Kingdom - Walt Disney World Florida",
    "Disney",
  ),
  entry(
    WaltDisneyWorldEpcot,
    "WaltDisneyWorldEpcot",
    "Epcot - Walt Disney World Florida",
    "Disney",
  ),
  entry(
    WaltDisneyWorldHollywoodStudios,
    "WaltDisneyWorldHollywoodStudios",
    "Hollywood Studios - Walt Disney World Florida",
    "Disney",
  ),
  entry(
    WaltDisneyWorldAnimalKingdom,
    "WaltDisneyWorldAnimalKingdom",
    "Animal Kingdom - Walt Disney World Florida",
    "Disney",
  ),
  entry(
    UniversalStudiosFlorida,
    "UniversalStudiosFlorida",
    "Universal Studios Florida - Universal Orlando Resort",
    "Universal",
  ),
  entry(
    UniversalIslandsOfAdventure,
    "UniversalIslandsOfAdventure",
    "Islands of Adventure - Universal Orlando Resort",
    "Universal",
  ),
  entry(
    UniversalVolcanoBay,
    "UniversalVolcanoBay",
    "Volcano Bay - Universal Orlando Resort",
    "Universal",
  ),
];

export const HOSTED_BY_ID = new Map<string, HostedRegistryEntry>(
  HOSTED_DESTINATIONS.map((e) => [e.id, e]),
);

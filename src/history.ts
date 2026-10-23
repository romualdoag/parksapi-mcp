import {getInstance} from "./service.js";
import {
  getUnfetchedDates,
  groupConsecutiveDates,
  loadHistoryDays,
  loadHistoryPoints,
  loadTargetEnvelope,
  resolveNode,
  saveHistoryDays,
  saveHistoryPoints,
  type HistoryNode,
} from "./historyCache.js";

const API_BASE = "https://api.themeparks.wiki/v1";
const DEFAULT_DAYS = 7;
const MAX_RANGE_DAYS = 31;
const MAX_POINTS = 10_000;
const DEFAULT_BUCKET_MINUTES = 60;
const DEFAULT_LIMIT = 2_000;

/** Stable v1 park ids for the hosted Orlando destinations. */
const KNOWN_PARK_IDS: Record<string, string> = {
  universalstudiosflorida: "eb3f4560-2383-4a36-9152-6b3e5ed6bc57",
  universalislandsofadventure: "267615cc-8943-4c2a-ae2c-5da728ca591f",
  universalvolcanobay: "fe78a026-b91b-470c-b906-9d2266b692da",
  universalepicuniverse: "12dbb85b-265f-44e6-bccf-f1faa17211fc",
};

type HistoryFetch = (
  url: string,
  init?: {signal?: AbortSignal; headers?: Record<string, string>},
) => Promise<Response>;
let fetchFn: HistoryFetch = (url, init) =>
  fetch(url, {
    headers: init?.headers,
    signal: init?.signal,
  });

const HISTORY_USER_AGENT = 'parksapi-mcp/history/0.2';

function hasApiKey(): boolean {
  return !!process.env.THEMEPARKS_API_KEY;
}

function anonHeaders(): Record<string, string> {
  return {'user-agent': HISTORY_USER_AGENT};
}

function keyedHeaders(): Record<string, string> {
  return {
    'user-agent': HISTORY_USER_AGENT,
    ...(process.env.THEMEPARKS_API_KEY
      ? {'x-api-key': process.env.THEMEPARKS_API_KEY}
      : {}),
  };
}

export function __setHistoryFetch(fn: HistoryFetch): void {
  fetchFn = fn;
}

export function __resetHistoryFetch(): void {
  fetchFn = (url, init) =>
    fetch(url, {
      headers: init?.headers,
      signal: init?.signal,
    });
}

type FetchError = Error & {earliestAllowedDate?: string; httpStatus?: number};

async function fetchJson<T>(path: string, useKey: boolean): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const response = await fetchFn(`${API_BASE}${path}`, {
      headers: useKey ? keyedHeaders() : anonHeaders(),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      let detail = '';
      let earliest = '';
      try {
        const body = (await response.json()) as {
          error?: {type?: string; message?: string; earliestAllowedDate?: string};
        };
        if (body?.error?.message) detail = ` — ${body.error.message}`;
        if (body?.error?.earliestAllowedDate) {
          earliest = body.error.earliestAllowedDate;
          detail += ` [earliestAllowedDate=${earliest}]`;
        }
        if (body?.error?.type) detail = ` (${body.error.type})${detail}`;
      } catch {
        /* ignore parse errors, use status only */
      }
      const hint =
        response.status === 403 && !hasApiKey()
          ? ' — sem THEMEPARKS_API_KEY a janela é ~7 dias; gere uma chave no perfil ThemeParks.wiki e exporte THEMEPARKS_API_KEY para ampliar'
          : '';
      const err = new Error(
        `ThemeParks history API returned HTTP ${response.status} for ${path}${detail}${hint}`,
      ) as FetchError;
      if (earliest) err.earliestAllowedDate = earliest;
      err.httpStatus = response.status;
      throw err;
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Anon-first: live/destination lookups never burn key budget. */
async function apiJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, false);
}

/**
 * History fetch: tenta anônimo primeiro e só repete com a chave quando o
 * upstream barra a janela (HISTORY_WINDOW_EXCEEDED). Cada chamada com chave
 * consome o budget free (300 req/min, 600 history/hora).
 */
async function apiJsonAuto<T>(path: string): Promise<{data: T; keyUsed: boolean}> {
  try {
    return {data: await fetchJson<T>(path, false), keyUsed: false};
  } catch (err) {
    const earliest = (err as FetchError)?.earliestAllowedDate;
    if (earliest && hasApiKey()) {
      return {data: await fetchJson<T>(path, true), keyUsed: true};
    }
    throw err;
  }
}

type V1Park = {id: string; name: string};
type V1Destination = {id: string; name: string; slug?: string; externalId?: string; parks?: V1Park[]};
type V1Destinations = {destinations?: V1Destination[]};

type V1LiveRow = {
  id: string;
  name: string;
  entityType?: string;
  parkId?: string;
  status?: string;
};
type V1Live = {id: string; name: string; timezone?: string; parkId?: string; entityType?: string; liveData?: V1LiveRow[]};

type HistoryPoint = {
  time: string;
  changed?: string[];
  status?: string;
  queue?: Record<string, {waitTime?: number | null; [key: string]: unknown}>;
};

type HistoryEntity = {
  id: string;
  name: string;
  entityType?: string;
  coverage?: {firstRecordedAt?: string};
  history?: HistoryPoint[];
  days?: Array<Record<string, unknown>>;
};

type HistoryResponse = {
  id: string;
  name: string;
  entityType?: string;
  timezone?: string;
  range?: {from?: string; to?: string; clamped?: boolean};
  history?: HistoryPoint[];
  days?: Array<Record<string, unknown>>;
  entities?: HistoryEntity[];
  /** True quando algum chunk precisou da THEMEPARKS_API_KEY (budget consumido). */
  keyUsed?: boolean;
  /** True quando tudo saiu do cache local, zero chamadas upstream. */
  cacheHit?: boolean;
};

export type HistoryTarget = {
  apiEntityId: string;
  name: string;
  entityType?: string;
  parkId: string;
  parkName?: string;
  destination?: string;
  timezone: string;
};

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date '${value}', expected YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date '${value}'`);
  return d;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function rangeFromDays(days: number, timezone: string): {from: string; to: string} {
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error("days must be an integer between 1 and 3660");
  }
  const to = todayInTimezone(timezone);
  return {from: dateString(addDays(parseDate(to), -(days - 1))), to};
}

function choosePark(destination: V1Destination, localId: string): V1Park {
  const parks = destination.parks ?? [];
  if (parks.length === 1) return parks[0];
  const wanted = normalizeName(localId.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const match = parks.find((p) => normalizeName(p.name).includes(wanted) || wanted.includes(normalizeName(p.name)));
  if (match) return match;
  throw new Error(`Destination '${localId}' maps to ${parks.length} parks; use a concrete park destination or api entityId.`);
}

async function resolveParkId(destination?: string): Promise<{id: string; name: string; timezone: string}> {
  if (!destination) throw new Error("destination is required unless entityId is a ThemeParks.wiki UUID");
  const known = KNOWN_PARK_IDS[destination];
  if (known) {
    const live = await apiJson<V1Live>(`/entity/${known}/live`);
    return {id: known, name: live.name, timezone: live.timezone ?? "America/New_York"};
  }
  const registry = await apiJson<V1Destinations>("/destinations");
  const wanted = destination.toLowerCase();
  const matches = (registry.destinations ?? []).filter((d) =>
    [d.id, d.slug, d.externalId, d.name].filter(Boolean).some((x) => String(x).toLowerCase() === wanted),
  );
  if (matches.length !== 1) {
    throw new Error(`Could not resolve '${destination}' to one ThemeParks.wiki destination`);
  }
  const park = choosePark(matches[0], destination);
  const live = await apiJson<V1Live>(`/entity/${park.id}/live`);
  return {id: park.id, name: park.name, timezone: live.timezone ?? "America/New_York"};
}

export async function resolveHistoryTarget(opts: {
  destination?: string;
  entityId?: string;
  entityName?: string;
}): Promise<HistoryTarget> {
  if (opts.entityId && isUuid(opts.entityId)) {
    const live = await apiJson<V1Live>(`/entity/${opts.entityId}/live`);
    return {
      apiEntityId: opts.entityId,
      name: live.name,
      entityType: live.entityType ?? "ATTRACTION",
      parkId: live.parkId ?? opts.entityId,
      destination: opts.destination,
      timezone: live.timezone ?? "America/New_York",
    };
  }
  const park = await resolveParkId(opts.destination);
  if (!opts.entityId && !opts.entityName) {
    return {apiEntityId: park.id, name: park.name, entityType: "PARK", parkId: park.id, parkName: park.name, destination: opts.destination, timezone: park.timezone};
  }
  let wantedName = opts.entityName;
  if (opts.entityId && !isUuid(opts.entityId)) {
    const local = await getInstance(opts.destination as string).then((x) => x.getEntities());
    const match = local.find((e) => String((e as unknown as Record<string, unknown>).id) === opts.entityId ||
      String((e as unknown as Record<string, unknown>).entityId) === opts.entityId);
    if (!match) throw new Error(`No local entity '${opts.entityId}' found in '${opts.destination}'`);
    wantedName = String((match as unknown as Record<string, unknown>).name);
  }
  const live = await apiJson<V1Live>(`/entity/${park.id}/live`);
  const normalized = normalizeName(wantedName ?? "");
  const match = (live.liveData ?? []).find((e) => normalizeName(e.name) === normalized);
  if (!match) throw new Error(`Could not resolve attraction '${wantedName}' in ${park.name}`);
  return {
    apiEntityId: match.id,
    name: match.name,
    entityType: match.entityType,
    parkId: park.id,
    parkName: park.name,
    destination: opts.destination,
    timezone: live.timezone ?? park.timezone,
  };
}

function mergeHistoryResponses(responses: HistoryResponse[], daily: boolean): HistoryResponse {
  const first = responses[0];
  const mergedRange = {from: responses[0].range?.from, to: responses.at(-1)?.range?.to};
  const hasEntityList = responses.some((response) => (response.entities ?? []).length > 0);
  if (!hasEntityList) {
    const history = responses.flatMap((response) => response.history ?? []).sort((a, b) => a.time.localeCompare(b.time));
    const days = responses.flatMap((response) => response.days ?? []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {...first, range: mergedRange, history: daily ? undefined : history, days: daily ? days : undefined};
  }
  const byId = new Map<string, HistoryEntity>();
  for (const response of responses) {
    for (const entity of response.entities ?? []) {
      const existing = byId.get(entity.id);
      if (!existing) {
        byId.set(entity.id, {...entity, history: entity.history ? [...entity.history] : undefined, days: entity.days ? [...entity.days] : undefined});
      } else if (daily) {
        existing.days = [...(existing.days ?? []), ...(entity.days ?? [])];
      } else {
        existing.history = [...(existing.history ?? []), ...(entity.history ?? [])];
      }
    }
  }
  const entities = [...byId.values()].map((entity) => {
    if (entity.history) entity.history.sort((a, b) => a.time.localeCompare(b.time));
    if (entity.days) entity.days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return entity;
  });
  return {...first, range: mergedRange, entities};
}

export async function getHistoryRange(target: HistoryTarget, range: {from: string; to: string}, daily = false): Promise<HistoryResponse> {
  const from = parseDate(range.from);
  const to = parseDate(range.to);
  if (from > to) throw new Error("from must be on or before to");
  const fromStr = dateString(from);
  const toStr = dateString(to);
  // Nó da hierarquia cidade → destino/parque → atração: cada linha do cache
  // carrega o caminho completo para análise em qualquer nível.
  const node: HistoryNode = resolveNode({
    destination: target.destination,
    parkId: target.parkId,
    parkName: target.parkName,
    entityName: target.name,
    entityType: target.entityType,
    timezone: target.timezone,
  });
  const envelope = {
    id: target.apiEntityId,
    name: target.name,
    entityType: target.entityType,
    timezone: target.timezone,
  };

  // Só busca os dias sem cobertura (recentes sempre refetch: o upstream
  // continua anexando pontos a hoje/ontem). Chave só sob demanda via
  // apiJsonAuto — cada chamada com chave consome o budget free.
  // Ranges que terminam no passado não precisam do refetch de dias recentes:
  // tudo coberto = zero chamadas (cacheHit). Só o range "vivo" atualiza
  // hoje + ontem, que o upstream continua anexando. (2 = HISTORY_RECENT_REFRESH_DAYS)
  const todayStr = todayInTimezone(target.timezone);
  const liveCutoff = dateString(addDays(parseDate(todayStr), -2));
  const missing = getUnfetchedDates(
    target.apiEntityId,
    fromStr,
    toStr,
    daily,
    toStr > liveCutoff ? undefined : 0,
  );
  const responses: HistoryResponse[] = [];
  let clampedFrom: string | undefined;
  let keyUsed = false;
  let fetchCount = 0;

  for (const gap of groupConsecutiveDates(missing)) {
    let cursor = parseDate(gap.from);
    const gapEnd = parseDate(gap.to);
    while (cursor <= gapEnd) {
      const chunkEnd = new Date(Math.min(addDays(cursor, MAX_RANGE_DAYS - 1).getTime(), gapEnd.getTime()));
      const chunkFrom = dateString(cursor);
      const chunkTo = dateString(chunkEnd);
      const params = new URLSearchParams({from: chunkFrom, to: chunkTo});
      const suffix = daily ? "/history/daily" : "/history";
      try {
        const {data, keyUsed: ku} = await apiJsonAuto<HistoryResponse>(
          `/entity/${target.apiEntityId}${suffix}?${params}`,
        );
        keyUsed = keyUsed || ku;
        fetchCount++;
        responses.push(data);
        const chunkDates = datesBetween(chunkFrom, chunkTo);
        if (!daily) {
          const pts: {entityId: string; entityName: string; time: string; point: unknown}[] = [];
          for (const e of data.entities ?? []) {
            for (const p of e.history ?? []) {
              pts.push({entityId: e.id, entityName: e.name, time: p.time, point: p});
            }
          }
          for (const p of data.history ?? []) {
            pts.push({entityId: data.id, entityName: data.name, time: p.time, point: p});
          }
          saveHistoryPoints(target.apiEntityId, node, envelope, pts, chunkDates, false);
        } else {
          const dys: {entityId: string; entityName: string; date: string; day: unknown}[] = [];
          for (const e of data.entities ?? []) {
            for (const d of e.days ?? []) {
              dys.push({entityId: e.id, entityName: e.name, date: String(d.date), day: d});
            }
          }
          for (const d of data.days ?? []) {
            dys.push({entityId: data.id, entityName: data.name, date: String(d.date), day: d});
          }
          saveHistoryDays(target.apiEntityId, node, envelope, dys, chunkDates, true);
        }
      } catch (err) {
        const earliest = (err as FetchError)?.earliestAllowedDate;
        if (earliest && chunkFrom < earliest) {
          // Fora da janela alcançável (sem chave ou além dos 30d): serve o
          // que o cache já tem em vez de falhar.
          clampedFrom = earliest;
          cursor = parseDate(earliest);
          continue;
        }
        throw err;
      }
      cursor = addDays(chunkEnd, 1);
    }
  }

  let merged = buildCachedResponse(target, fromStr, toStr, daily);
  if (!merged) {
    if (!responses.length) throw new Error("History window exceeded and no data in allowed range — defina THEMEPARKS_API_KEY para ampliar a janela (~7 dias sem chave)");
    merged = mergeHistoryResponses(responses, daily);
  }
  if (keyUsed) merged.keyUsed = true;
  if (fetchCount === 0) merged.cacheHit = true;
  if (clampedFrom) merged.range = {...merged.range, from: clampedFrom, clamped: true};
  return merged;
}

function datesBetween(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  const cursor = parseDate(fromStr);
  const end = parseDate(toStr);
  while (cursor <= end) {
    out.push(dateString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Reconstroi a resposta a partir do cache em qualquer nível da hierarquia. */
function buildCachedResponse(
  target: HistoryTarget,
  fromStr: string,
  toStr: string,
  daily: boolean,
): HistoryResponse | null {
  if (!daily) {
    const pts = loadHistoryPoints(target.apiEntityId, fromStr, toStr);
    if (!pts.length) return null;
    const byEntity = new Map<string, {name: string; points: unknown[]}>();
    for (const p of pts) {
      const entry = byEntity.get(p.entityId) ?? {name: p.entityName, points: []};
      entry.points.push(p.point);
      byEntity.set(p.entityId, entry);
    }
    const entries = [...byEntity.entries()];
    if (entries.length === 1) {
      const [eid, items] = entries[0];
      return {
        id: eid,
        name: items.name,
        entityType: target.entityType,
        timezone: target.timezone,
        range: {from: fromStr, to: toStr},
        history: items.points as HistoryPoint[],
      };
    }
    return {
      id: target.apiEntityId,
      name: target.name,
      entityType: target.entityType,
      timezone: target.timezone,
      range: {from: fromStr, to: toStr},
      entities: entries.map(([eid, items]) => ({
        id: eid,
        name: items.name,
        history: items.points as HistoryPoint[],
      })),
    };
  }
  const dys = loadHistoryDays(target.apiEntityId, fromStr, toStr);
  if (!dys.length) return null;
  const byEntity = new Map<string, {name: string; days: unknown[]}>();
  for (const d of dys) {
    const entry = byEntity.get(d.entityId) ?? {name: d.entityName, days: []};
    entry.days.push(d.day);
    byEntity.set(d.entityId, entry);
  }
  const entries = [...byEntity.entries()];
  if (entries.length === 1) {
    const [eid, items] = entries[0];
    return {
      id: eid,
      name: items.name,
      entityType: target.entityType,
      timezone: target.timezone,
      range: {from: fromStr, to: toStr},
      days: items.days as Array<Record<string, unknown>>,
    };
  }
  return {
    id: target.apiEntityId,
    name: target.name,
    entityType: target.entityType,
    timezone: target.timezone,
    range: {from: fromStr, to: toStr},
    entities: entries.map(([eid, items]) => ({
      id: eid,
      name: items.name,
      days: items.days as Array<Record<string, unknown>>,
    })),
  };
}

export type WaitObservation = {
  entityId: string;
  entityName: string;
  time: string;
  status?: string;
  waitMinutes: number;
  localDate: string;
  weekday: string;
  localTime: string;
};

export function extractWaitObservations(response: HistoryResponse): WaitObservation[] {
  const timezone = response.timezone ?? "America/New_York";
  const series: HistoryEntity[] = response.entities?.length
    ? response.entities
    : [{id: response.id, name: response.name, entityType: response.entityType, history: response.history}];
  const out: WaitObservation[] = [];
  for (const entity of series) {
    for (const point of entity.history ?? []) {
      const wait = point.queue?.STANDBY?.waitTime;
      if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) continue;
      const date = new Date(point.time);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(date);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
      out.push({
        entityId: entity.id,
        entityName: entity.name,
        time: point.time,
        status: point.status,
        waitMinutes: wait,
        localDate: `${get("year")}-${get("month")}-${get("day")}`,
        weekday: get("weekday"),
        localTime: `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`,
      });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function calculateWaitStatistics(observations: WaitObservation[], bucketMinutes = DEFAULT_BUCKET_MINUTES, minSamples = 1) {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 5 || bucketMinutes > 240 || 60 % bucketMinutes !== 0) {
    throw new Error("bucketMinutes must divide 60 and be between 5 and 240");
  }
  const groups = new Map<string, WaitObservation[]>();
  for (const observation of observations) {
    const [hourText, minuteText] = observation.localTime.split(":");
    const bucket = Math.floor(Number(minuteText) / bucketMinutes) * bucketMinutes;
    const key = `${observation.weekday}|${hourText.padStart(2, "0")}:${String(bucket).padStart(2, "0")}`;
    const list = groups.get(key) ?? [];
    list.push(observation);
    groups.set(key, list);
  }
  const buckets = [...groups.entries()].map(([key, values]) => {
    const [weekday, localTime] = key.split("|");
    const waits = values.map((v) => v.waitMinutes);
    return {
      weekday, localTime, samples: waits.length,
      min: Math.min(...waits),
      p10: Math.round(percentile(waits, 0.10) * 10) / 10,
      median: Math.round(percentile(waits, 0.50) * 10) / 10,
      mean: Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10,
      p90: Math.round(percentile(waits, 0.90) * 10) / 10,
      max: Math.max(...waits),
    };
  }).filter((b) => b.samples >= minSamples);
  const byMedian = [...buckets].sort((a, b) => a.median - b.median || b.samples - a.samples);
  const byMean = [...buckets].sort((a, b) => a.mean - b.mean || b.samples - a.samples);
  return {
    observations: observations.length,
    bucketMinutes,
    minSamples,
    buckets,
    bestByMedian: byMedian.slice(0, 10),
    bestByMean: byMean.slice(0, 10),
  };
}

export async function getWaitHistory(opts: {
  destination?: string;
  entityId?: string;
  entityName?: string;
  days?: number;
  from?: string;
  to?: string;
  daily?: boolean;
  limit?: number;
}) {
  const target = await resolveHistoryTarget(opts);
  const range = opts.from && opts.to
    ? {from: opts.from, to: opts.to}
    : rangeFromDays(opts.days ?? DEFAULT_DAYS, target.timezone);
  const response = await getHistoryRange(target, range, opts.daily ?? false);
  if (opts.daily) {
    const entities = response.entities?.map((entity) => ({...entity, days: (entity.days ?? []).slice(0, opts.limit ?? DEFAULT_LIMIT)}));
    return {
      ...response,
      target,
      ...(entities ? {entities} : {days: (response.days ?? []).slice(0, opts.limit ?? DEFAULT_LIMIT)}),
    };
  }
  const observations = extractWaitObservations(response);
  return {
    target,
    range: response.range,
    observations: (opts.limit ? observations.slice(0, opts.limit) : observations.slice(0, DEFAULT_LIMIT)),
    count: observations.length,
    truncated: observations.length > (opts.limit ?? DEFAULT_LIMIT),
  };
}

export async function getWaitStatistics(opts: {
  destination?: string;
  entityId?: string;
  entityName?: string;
  days?: number;
  from?: string;
  to?: string;
  bucketMinutes?: number;
  minSamples?: number;
}) {
  const target = await resolveHistoryTarget(opts);
  const range = opts.from && opts.to
    ? {from: opts.from, to: opts.to}
    : rangeFromDays(opts.days ?? DEFAULT_DAYS, target.timezone);
  const response = await getHistoryRange(target, range, false);
  const observations = extractWaitObservations(response);
  return {
    target,
    range: response.range,
    timezone: target.timezone,
    statistics: calculateWaitStatistics(observations, opts.bucketMinutes ?? DEFAULT_BUCKET_MINUTES, opts.minSamples ?? 3),
  };
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportWaitHistory(opts: {
  destination?: string;
  entityId?: string;
  entityName?: string;
  days?: number;
  from?: string;
  to?: string;
  format?: "json" | "csv";
  daily?: boolean;
  limit?: number;
}) {
  const target = await resolveHistoryTarget(opts);
  const range = opts.from && opts.to
    ? {from: opts.from, to: opts.to}
    : rangeFromDays(opts.days ?? DEFAULT_DAYS, target.timezone);
  const response = await getHistoryRange(target, range, opts.daily ?? false);
  if (opts.daily) {
    const body = JSON.stringify({target, range: response.range, entities: response.entities}, null, 2);
    return {format: "json", filename: `${target.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-history-daily.json`, data: body};
  }
  const observations = extractWaitObservations(response).slice(0, opts.limit ?? MAX_POINTS);
  if ((opts.format ?? "csv") === "json") {
    return {format: "json", filename: `${target.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-wait-history.json`, data: JSON.stringify({target, range: response.range, observations}, null, 2)};
  }
  const header = "entityId,entityName,time,localDate,weekday,localTime,status,waitMinutes";
  const rows = observations.map((o) => [o.entityId, o.entityName, o.time, o.localDate, o.weekday, o.localTime, o.status, o.waitMinutes].map(csvCell).join(","));
  return {format: "csv", filename: `${target.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-wait-history.csv`, data: `${header}\n${rows.join("\n")}\n`, count: observations.length, truncated: extractWaitObservations(response).length > observations.length};
}

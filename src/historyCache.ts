import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

/**
 * Local incremental cache for ThemeParks.wiki history responses.
 *
 * Depth: cidade → destino/parque → atração. Every stored row carries the
 * full node (city, destination, park, entity) so cached data can be
 * listed and analyzed at any level without hitting the upstream API.
 *
 * Why: every history call without cache hits api.themeparks.wiki and — when
 * the free anonymous window (~7d) doesn't cover the range — burns the
 * THEMEPARKS_API_KEY budget (300 req/min, 600 history/hour, 30d window).
 * Repeat and overlapping queries only fetch dates not yet covered. Recent
 * dates (today + yesterday by default) are always re-fetched because the
 * upstream keeps appending points to them; older dates are immutable.
 *
 * Location: HISTORY_CACHE_PATH, default ./history-cache.sqlite in the
 * server's working directory (same convention as the upstream cache.sqlite).
 * HISTORY_CACHE_ENABLED=0 disables it (fail-soft bypass). The file is
 * git-ignored on purpose — cached upstream data must never be committed.
 */

export const HISTORY_RECENT_REFRESH_DAYS = 2;

/** Hierarchy node: cidade → destino/parque → atração. */
export type HistoryNode = {
  city: string;
  destination: string;
  parkId: string;
  parkName: string;
  entityName: string;
  entityType: string;
  timezone: string;
};

export type StoredPoint = {entityId: string; entityName: string; time: string; point: unknown};
export type StoredDay = {entityId: string; entityName: string; date: string; day: unknown};

/** Local destination id → cidade. Hosted Orlando parks first; fallback abaixo. */
const CITY_BY_DESTINATION: Record<string, string> = {
  waltdisneyworldmagickingdom: 'Orlando',
  waltdisneyworldepcot: 'Orlando',
  waltdisneyworldhollywoodstudios: 'Orlando',
  waltdisneyworldanimalkingdom: 'Orlando',
  universalstudiosflorida: 'Orlando',
  universalislandsofadventure: 'Orlando',
  universalvolcanobay: 'Orlando',
  universalepicuniverse: 'Orlando',
  universalorlando: 'Orlando',
  seaworldorlando: 'Orlando',
  legolandorlando: 'Orlando',
  peppapigthemeparkflorida: 'Orlando',
  buschgardenstampa: 'Tampa',
  efteling: 'Kaatsheuvel',
  europapark: 'Rust',
  disneylandparis: 'Paris',
};

export function resolveCity(destination: string | undefined, timezone: string): string {
  if (destination && CITY_BY_DESTINATION[destination.toLowerCase()]) {
    return CITY_BY_DESTINATION[destination.toLowerCase()];
  }
  const part = timezone.split('/').at(-1) ?? timezone;
  return part.replace(/_/g, ' ');
}

export function resolveNode(opts: {
  destination?: string;
  parkId: string;
  parkName?: string;
  entityName: string;
  entityType?: string;
  timezone: string;
}): HistoryNode {
  return {
    city: resolveCity(opts.destination, opts.timezone),
    destination: opts.destination ?? '',
    parkId: opts.parkId,
    parkName: opts.parkName ?? '',
    entityName: opts.entityName,
    entityType: opts.entityType ?? '',
    timezone: opts.timezone,
  };
}

let dbPathOverride: string | undefined;
let db: DatabaseSync | null = null;

export function isHistoryCacheEnabled(): boolean {
  return process.env.HISTORY_CACHE_ENABLED !== '0';
}

function cacheDbPath(): string {
  return (
    dbPathOverride ??
    process.env.HISTORY_CACHE_PATH ??
    path.join(process.cwd(), 'history-cache.sqlite')
  );
}

/** Test hook: point the cache at another file (or ':memory:'). */
export function __resetHistoryCacheForTests(dbPath = ':memory:'): void {
  closeHistoryCache();
  dbPathOverride = dbPath;
}

export function closeHistoryCache(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function ensureColumn(
  store: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = store.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
  if (!cols.some((c) => c.name === column)) {
    store.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function getDb(): DatabaseSync | null {
  if (!isHistoryCacheEnabled()) return null;
  if (db) return db;
  try {
    const opened = new DatabaseSync(cacheDbPath());
    opened.exec('PRAGMA journal_mode=WAL');
    opened.exec('PRAGMA busy_timeout=5000');
    opened.exec(`
      CREATE TABLE IF NOT EXISTS history_targets (
        target_id TEXT PRIMARY KEY,
        city TEXT NOT NULL DEFAULT '',
        destination TEXT NOT NULL DEFAULT '',
        park_id TEXT NOT NULL DEFAULT '',
        park_name TEXT NOT NULL DEFAULT '',
        entity_name TEXT NOT NULL DEFAULT '',
        entity_type TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        envelope_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS history_points (
        target_id TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        destination TEXT NOT NULL DEFAULT '',
        park_id TEXT NOT NULL DEFAULT '',
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL DEFAULT '',
        time TEXT NOT NULL,
        point_json TEXT NOT NULL,
        PRIMARY KEY (target_id, entity_id, time)
      );
      CREATE TABLE IF NOT EXISTS history_days (
        target_id TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        destination TEXT NOT NULL DEFAULT '',
        park_id TEXT NOT NULL DEFAULT '',
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL,
        day_json TEXT NOT NULL,
        PRIMARY KEY (target_id, entity_id, date)
      );
      CREATE TABLE IF NOT EXISTS history_fetched (
        target_id TEXT NOT NULL,
        date TEXT NOT NULL,
        daily INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (target_id, date, daily)
      );
      CREATE INDEX IF NOT EXISTS idx_points_hierarchy
        ON history_points(city, destination, park_id, entity_id, time);
      CREATE INDEX IF NOT EXISTS idx_days_hierarchy
        ON history_days(city, destination, park_id, entity_id, date);
    `);
    // Migração suave de DBs criados pela versão anterior (só target_id/entidade).
    for (const [table, column, ddl] of [
      ['history_targets', 'city', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'destination', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'park_id', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'park_name', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'entity_name', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'entity_type', "TEXT NOT NULL DEFAULT ''"],
      ['history_targets', 'timezone', "TEXT NOT NULL DEFAULT ''"],
      ['history_points', 'city', "TEXT NOT NULL DEFAULT ''"],
      ['history_points', 'destination', "TEXT NOT NULL DEFAULT ''"],
      ['history_points', 'park_id', "TEXT NOT NULL DEFAULT ''"],
      ['history_points', 'entity_name', "TEXT NOT NULL DEFAULT ''"],
      ['history_days', 'city', "TEXT NOT NULL DEFAULT ''"],
      ['history_days', 'destination', "TEXT NOT NULL DEFAULT ''"],
      ['history_days', 'park_id', "TEXT NOT NULL DEFAULT ''"],
      ['history_days', 'entity_name', "TEXT NOT NULL DEFAULT ''"],
    ] as const) {
      ensureColumn(opened, table, column, ddl);
    }
    db = opened;
    return db;
  } catch {
    // Fail-soft: um cwd read-only ou arquivo travado nunca quebra history calls.
    return null;
  }
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Datas em [from, to] sem cobertura aproveitável. Datas dentro de
 * `refreshRecentDays` de `to` (padrão: hoje + ontem, já que ranges
 * normalmente terminam hoje) contam sempre como missing — o upstream
 * continua anexando pontos a elas. Datas antigas só faltam quando nunca
 * buscadas.
 */
export function getUnfetchedDates(
  targetId: string,
  from: string,
  to: string,
  daily: boolean,
  refreshRecentDays = HISTORY_RECENT_REFRESH_DAYS,
): string[] {
  const store = getDb();
  const dates = eachDate(from, to);
  if (!store) return dates;
  const cutoff = addDaysStr(to, -refreshRecentDays);
  const rows = store
    .prepare(
      'SELECT date FROM history_fetched WHERE target_id = ? AND daily = ? AND date >= ? AND date <= ?',
    )
    .all(targetId, daily ? 1 : 0, from, to) as {date: string}[];
  const covered = new Set(rows.map((r) => r.date));
  return dates.filter((d) => d > cutoff || !covered.has(d));
}

/** Agrupa datas YYYY-MM-DD consecutivas em sub-ranges {from, to}. */
export function groupConsecutiveDates(dates: string[]): {from: string; to: string}[] {
  const ranges: {from: string; to: string}[] = [];
  for (const d of dates) {
    const last = ranges.at(-1);
    if (last && addDaysStr(last.to, 1) === d) last.to = d;
    else ranges.push({from: d, to: d});
  }
  return ranges;
}

export function loadHistoryPoints(
  targetId: string,
  from: string,
  to: string,
): StoredPoint[] {
  const store = getDb();
  if (!store) return [];
  // Timestamps ISO ordenam lexicograficamente; limites do dia como prefixos.
  const rows = store
    .prepare(
      `SELECT entity_id AS entityId, entity_name AS entityName, time, point_json AS pointJson
       FROM history_points WHERE target_id = ? AND time >= ? AND time < ? ORDER BY time`,
    )
    .all(targetId, `${from}T00:00:00`, `${addDaysStr(to, 1)}T00:00:00`) as {
    entityId: string;
    entityName: string;
    time: string;
    pointJson: string;
  }[];
  return rows.map((r) => ({
    entityId: r.entityId,
    entityName: r.entityName,
    time: r.time,
    point: JSON.parse(r.pointJson) as unknown,
  }));
}

export function loadHistoryDays(
  targetId: string,
  from: string,
  to: string,
): StoredDay[] {
  const store = getDb();
  if (!store) return [];
  const rows = store
    .prepare(
      `SELECT entity_id AS entityId, entity_name AS entityName, date, day_json AS dayJson
       FROM history_days WHERE target_id = ? AND date >= ? AND date <= ? ORDER BY date`,
    )
    .all(targetId, from, to) as {
    entityId: string;
    entityName: string;
    date: string;
    dayJson: string;
  }[];
  return rows.map((r) => ({
    entityId: r.entityId,
    entityName: r.entityName,
    date: r.date,
    day: JSON.parse(r.dayJson) as unknown,
  }));
}

export function loadTargetEnvelope(targetId: string): Record<string, unknown> | null {
  const store = getDb();
  if (!store) return null;
  const row = store
    .prepare('SELECT envelope_json AS envelopeJson FROM history_targets WHERE target_id = ?')
    .get(targetId) as {envelopeJson: string} | undefined;
  if (!row) return null;
  return JSON.parse(row.envelopeJson) as Record<string, unknown>;
}

function upsertTarget(
  store: DatabaseSync,
  targetId: string,
  node: HistoryNode,
  envelope: Record<string, unknown>,
): void {
  store
    .prepare(
      `INSERT OR REPLACE INTO history_targets
       (target_id, city, destination, park_id, park_name, entity_name, entity_type, timezone, envelope_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      targetId,
      node.city,
      node.destination,
      node.parkId,
      node.parkName,
      node.entityName,
      node.entityType,
      node.timezone,
      JSON.stringify(envelope),
    );
}

function markFetched(
  store: DatabaseSync,
  targetId: string,
  fetchedDates: string[],
  daily: boolean,
  now: string,
): void {
  const stmt = store.prepare(
    'INSERT OR REPLACE INTO history_fetched (target_id, date, daily, fetched_at) VALUES (?, ?, ?, ?)',
  );
  const dailyInt = daily ? 1 : 0;
  for (const d of fetchedDates) stmt.run(targetId, d, dailyInt, now);
}

export function saveHistoryPoints(
  targetId: string,
  node: HistoryNode,
  envelope: Record<string, unknown>,
  points: {entityId: string; entityName?: string; time: string; point: unknown}[],
  fetchedDates: string[],
  daily: boolean,
): void {
  const store = getDb();
  if (!store) return;
  const insertPoint = store.prepare(
    `INSERT OR REPLACE INTO history_points
     (target_id, city, destination, park_id, entity_id, entity_name, time, point_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  try {
    store.exec('BEGIN IMMEDIATE');
    upsertTarget(store, targetId, node, envelope);
    for (const p of points) {
      insertPoint.run(
        targetId,
        node.city,
        node.destination,
        node.parkId,
        p.entityId,
        p.entityName ?? node.entityName,
        p.time,
        JSON.stringify(p.point),
      );
    }
    markFetched(store, targetId, fetchedDates, daily, now);
    store.exec('COMMIT');
  } catch {
    try {
      store.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    /* fail-soft: o chamador já tem os dados em memória */
  }
}

export function saveHistoryDays(
  targetId: string,
  node: HistoryNode,
  envelope: Record<string, unknown>,
  days: {entityId: string; entityName?: string; date: string; day: unknown}[],
  fetchedDates: string[],
  daily: boolean,
): void {
  const store = getDb();
  if (!store) return;
  const insertDay = store.prepare(
    `INSERT OR REPLACE INTO history_days
     (target_id, city, destination, park_id, entity_id, entity_name, date, day_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  try {
    store.exec('BEGIN IMMEDIATE');
    upsertTarget(store, targetId, node, envelope);
    for (const d of days) {
      insertDay.run(
        targetId,
        node.city,
        node.destination,
        node.parkId,
        d.entityId,
        d.entityName ?? node.entityName,
        d.date,
        JSON.stringify(d.day),
      );
    }
    markFetched(store, targetId, fetchedDates, daily, now);
    store.exec('COMMIT');
  } catch {
    try {
      store.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    /* fail-soft */
  }
}

export type HierarchyEntry = {
  city: string;
  destination: string;
  parkId: string;
  parkName: string;
  entityName: string;
  entityType: string;
  timezone: string;
  targetId: string;
};

/** Navega o cache em profundidade: cidade → destino/parque → atração. */
export function listHierarchy(): HierarchyEntry[] {
  const store = getDb();
  if (!store) return [];
  return store
    .prepare(
      `SELECT city, destination, park_id AS parkId, park_name AS parkName,
              entity_name AS entityName, entity_type AS entityType, timezone,
              target_id AS targetId
       FROM history_targets ORDER BY city, destination, entity_name`,
    )
    .all() as HierarchyEntry[];
}

export type PointQuery = {
  city?: string;
  destination?: string;
  parkId?: string;
  entityId?: string;
  from?: string;
  to?: string;
  limit?: number;
};

/**
 * Lê pontos do cache em qualquer nível da hierarquia — cidade inteira,
 * um parque, ou uma atração — sem tocar no upstream.
 */
export function queryPoints(filter: PointQuery): StoredPoint[] {
  const store = getDb();
  if (!store) return [];
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (filter.city) {
    conds.push('city = ?');
    args.push(filter.city);
  }
  if (filter.destination) {
    conds.push('destination = ?');
    args.push(filter.destination);
  }
  if (filter.parkId) {
    conds.push('park_id = ?');
    args.push(filter.parkId);
  }
  if (filter.entityId) {
    conds.push('entity_id = ?');
    args.push(filter.entityId);
  }
  if (filter.from) {
    conds.push('time >= ?');
    args.push(`${filter.from}T00:00:00`);
  }
  if (filter.to) {
    conds.push('time < ?');
    args.push(`${filter.to}T00:00:00`);
  }
  // Filtros vazios em coluna: não confundir com IS NULL (colunas têm DEFAULT '').
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(filter.limit ?? 2000, 10000));
  const rows = store
    .prepare(
      `SELECT entity_id AS entityId, entity_name AS entityName, time, point_json AS pointJson
       FROM history_points ${where} ORDER BY time LIMIT ${limit}`,
    )
    .all(...args) as {entityId: string; entityName: string; time: string; pointJson: string}[];
  return rows.map((r) => ({
    entityId: r.entityId,
    entityName: r.entityName,
    time: r.time,
    point: JSON.parse(r.pointJson) as unknown,
  }));
}

/* ------------------------------------------------------------------ */
/* KV frio: entities / schedules (dados quase estáticos, TTLs longos).  */
/*                                                                     */
/* Entities mudam poucas vezes ao ano (atração nova, rename); o status  */
/* ao vivo continua vindo do live fresco — o cache aqui só evita        */
/* refazer o listing a cada restart. Schedules (horários) mudam por    */
/* evento/estação: 24h por padrão. Live/wait times NÃO entram aqui de   */
/* propósito: dado quente, 60s em memória já é o certo.                */
/* ------------------------------------------------------------------ */

export function entitiesCacheTtlHours(): number {
  return Number(process.env.ENTITIES_CACHE_TTL_HOURS ?? 168); // 7 dias
}

export function schedulesCacheTtlHours(): number {
  return Number(process.env.SCHEDULES_CACHE_TTL_HOURS ?? 24); // 1 dia
}

function ensureKvTable(store: DatabaseSync): void {
  store.exec(`
    CREATE TABLE IF NOT EXISTS kv_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
}

/** Lê do KV se fresco; `undefined` = miss, expirado, desligado ou erro. */
export function kvGet(key: string, ttlHours: number): unknown | undefined {
  const store = getDb();
  if (!store) return undefined;
  try {
    ensureKvTable(store);
    const row = store
      .prepare('SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM kv_cache WHERE key = ?')
      .get(key) as {valueJson: string; fetchedAt: string} | undefined;
    if (!row) return undefined;
    const ageMs = Date.now() - Date.parse(row.fetchedAt);
    if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return undefined;
    return JSON.parse(row.valueJson) as unknown;
  } catch {
    return undefined;
  }
}

/** Grava no KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store
      .prepare('INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), new Date().toISOString());
  } catch {
    /* fail-soft */
  }
}

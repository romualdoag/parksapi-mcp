import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  __resetHistoryCacheForTests,
  closeHistoryCache,
  getUnfetchedDates,
  groupConsecutiveDates,
  listHierarchy,
  loadHistoryPoints,
  queryPoints,
  resolveCity,
  resolveNode,
  saveHistoryPoints,
} from '../src/historyCache.js';
import {
  __resetHistoryFetch,
  __setHistoryFetch,
  getHistoryRange,
} from '../src/history.js';

const NODE = resolveNode({
  destination: 'universalislandsofadventure',
  parkId: 'park-1',
  parkName: 'Islands of Adventure',
  entityName: 'Test Ride',
  entityType: 'ATTRACTION',
  timezone: 'America/New_York',
});

const TARGET = {
  apiEntityId: 'ride-1',
  name: 'Test Ride',
  entityType: 'ATTRACTION',
  parkId: 'park-1',
  parkName: 'Islands of Adventure',
  destination: 'universalislandsofadventure',
  timezone: 'America/New_York',
};

beforeEach(() => {
  __resetHistoryCacheForTests(':memory:');
});

afterEach(() => {
  __resetHistoryFetch();
  closeHistoryCache();
});

describe('hierarchy depth (cidade → parque → atração)', () => {
  it('resolves Orlando for hosted destinations, timezone city otherwise', () => {
    expect(resolveCity('universalislandsofadventure', 'America/New_York')).toBe('Orlando');
    expect(resolveCity('buschgardenstampa', 'America/New_York')).toBe('Tampa');
    expect(resolveCity('someotherpark', 'Europe/Paris')).toBe('Paris');
  });

  it('stores the full node on every row for level queries', () => {
    saveHistoryPoints(
      'ride-1',
      NODE,
      {id: 'ride-1', name: 'Test Ride'},
      [{entityId: 'ride-1', time: '2026-10-20T12:00:00Z', point: {time: '2026-10-20T12:00:00Z'}}],
      ['2026-10-20'],
      false,
    );
    const [entry] = listHierarchy();
    expect(entry).toMatchObject({
      city: 'Orlando',
      destination: 'universalislandsofadventure',
      parkId: 'park-1',
    });
    expect(queryPoints({city: 'Orlando'})).toHaveLength(1);
    expect(queryPoints({city: 'Paris'})).toHaveLength(0);
    expect(queryPoints({destination: 'universalislandsofadventure'})).toHaveLength(1);
  });
});

describe('incremental cache', () => {
  it('marks only uncovered dates missing; recent days always refetch', () => {
    saveHistoryPoints('ride-1', NODE, {id: 'ride-1'}, [], ['2026-10-10', '2026-10-22'], false);
    // to=2026-10-23 → recent = 10-22, 10-23 → both missing; 10-10 covered.
    const missing = getUnfetchedDates('ride-1', '2026-10-10', '2026-10-23', false);
    expect(missing).toContain('2026-10-11');
    expect(missing).toContain('2026-10-22');
    expect(missing).toContain('2026-10-23');
    expect(missing).not.toContain('2026-10-10');
  });

  it('groups consecutive dates into sub-ranges', () => {
    expect(
      groupConsecutiveDates(['2026-10-10', '2026-10-11', '2026-10-13']),
    ).toEqual([
      {from: '2026-10-10', to: '2026-10-11'},
      {from: '2026-10-13', to: '2026-10-13'},
    ]);
  });

  it('second identical range serves old dates from cache (zero upstream calls)', async () => {
    const calls: string[] = [];
    __setHistoryFetch(async (url) => {
      calls.push(url);
      const u = new URL(url);
      const from = u.searchParams.get('from')!;
      return new Response(
        JSON.stringify({
          id: 'ride-1',
          name: 'Test Ride',
          timezone: 'America/New_York',
          range: {from, to: u.searchParams.get('to')},
          history: [{time: `${from}T12:00:00Z`, queue: {STANDBY: {waitTime: 10}}}],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const first = await getHistoryRange(TARGET, {from: '2026-10-01', to: '2026-10-10'});
    expect(first.history).toHaveLength(1);
    expect(first.cacheHit).toBeUndefined();
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const second = await getHistoryRange(TARGET, {from: '2026-10-01', to: '2026-10-10'});
    // Range histórico (termina no passado): tudo coberto = zero chamadas.
    expect(calls).toHaveLength(0);
    expect(second.cacheHit).toBe(true);
    expect(second.history).toHaveLength(1);
    expect(loadHistoryPoints('ride-1', '2026-10-01', '2026-10-10')).toHaveLength(1);
  });

  it('refreshes recent days on ranges ending today', async () => {
    const calls: string[] = [];
    __setHistoryFetch(async (url) => {
      calls.push(url);
      const u = new URL(url);
      const from = u.searchParams.get('from')!;
      return new Response(
        JSON.stringify({
          id: 'ride-1',
          name: 'Test Ride',
          timezone: 'America/New_York',
          range: {from, to: u.searchParams.get('to')},
          history: [{time: `${from}T12:00:00Z`, queue: {STANDBY: {waitTime: 10}}}],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const today = new Date().toISOString().slice(0, 10);
    await getHistoryRange(TARGET, {from: '2026-10-01', to: today});
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    const second = await getHistoryRange(TARGET, {from: '2026-10-01', to: today});
    // O gap recente (hoje + ontem) sempre refaz fetch: 1 chamada incremental.
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBeUndefined();
  });

  it('uses the key only when the anonymous window is exceeded', async () => {
    const seen: {url: string; key: boolean}[] = [];
    const prev = process.env.THEMEPARKS_API_KEY;
    process.env.THEMEPARKS_API_KEY = 'test-key';
    try {
      __setHistoryFetch(async (url, init) => {
        const keyed = (init?.headers as Record<string, string> | undefined)?.['x-api-key'] === 'test-key';
        seen.push({url, key: keyed});
        if (!keyed) {
          return new Response(
            JSON.stringify({
              error: {
                type: 'HISTORY_WINDOW_EXCEEDED',
                message: 'key needed',
                earliestAllowedDate: '2026-10-17',
              },
            }),
            {status: 403, headers: {'content-type': 'application/json'}},
          );
        }
        return new Response(
          JSON.stringify({
            id: 'ride-1',
            name: 'Test Ride',
            timezone: 'America/New_York',
            range: {from: '2026-10-01', to: '2026-10-10'},
            history: [{time: '2026-10-05T12:00:00Z', queue: {STANDBY: {waitTime: 10}}}],
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        );
      });
      const res = await getHistoryRange(TARGET, {from: '2026-10-01', to: '2026-10-10'});
      expect(res.keyUsed).toBe(true);
      expect(seen[0].key).toBe(false);
      expect(seen.at(-1)?.key).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.THEMEPARKS_API_KEY;
      else process.env.THEMEPARKS_API_KEY = prev;
    }
  });
});

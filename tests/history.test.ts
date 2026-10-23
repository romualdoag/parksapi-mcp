import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetHistoryFetch,
  __setHistoryFetch,
  calculateWaitStatistics,
  extractWaitObservations,
  getHistoryRange,
} from "../src/history.js";

const target = {
  apiEntityId: "ride-1",
  name: "Test Ride",
  entityType: "ATTRACTION",
  parkId: "park-1",
  timezone: "America/New_York",
};

afterEach(() => {
  __resetHistoryFetch();
  vi.restoreAllMocks();
});

describe("history observation mapping", () => {
  it("extracts direct-entity history and localizes the timestamp", () => {
    const observations = extractWaitObservations({
      id: "ride-1",
      name: "Test Ride",
      timezone: "America/New_York",
      history: [
        {
          time: "2026-10-22T14:00:00Z",
          status: "OPERATING",
          queue: { STANDBY: { waitTime: 25 } },
        },
      ],
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      entityId: "ride-1",
      localDate: "2026-10-22",
      weekday: "Thursday",
      localTime: "10:00",
      waitMinutes: 25,
    });
  });

  it("ignores null and negative waits", () => {
    const observations = extractWaitObservations({
      id: "ride-1",
      name: "Test Ride",
      history: [
        { time: "2026-10-22T12:00:00Z", queue: { STANDBY: { waitTime: null } } },
        { time: "2026-10-22T12:01:00Z", queue: { STANDBY: { waitTime: -1 } } },
      ],
    });
    expect(observations).toEqual([]);
  });
});

describe("statistics", () => {
  it("groups by weekday and time bucket and filters sparse buckets", () => {
    const observations = [
      ...Array.from({ length: 3 }, (_, i) => ({
        entityId: "ride-1", entityName: "Test Ride", time: `2026-10-22T1${4 + i}:00:00Z`,
        status: "OPERATING", waitMinutes: 20 + i, localDate: "2026-10-22",
        weekday: "Thursday", localTime: `10:${String(i * 10).padStart(2, "0")}`,
      })),
      {
        entityId: "ride-1", entityName: "Test Ride", time: "2026-10-22T15:00:00Z",
        status: "OPERATING", waitMinutes: 5, localDate: "2026-10-22",
        weekday: "Thursday", localTime: "11:00",
      },
    ];
    const result = calculateWaitStatistics(observations, 60, 3);
    expect(result.observations).toBe(4);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ weekday: "Thursday", localTime: "10:00", samples: 3, median: 21 });
  });
});

describe("history range chunking", () => {
  it("splits ranges over 31 days and merges direct-entity history", async () => {
    const calls: string[] = [];
    __setHistoryFetch(async (url) => {
      calls.push(url);
      const u = new URL(url);
      const from = u.searchParams.get("from")!;
      return new Response(JSON.stringify({
        id: "ride-1", name: "Test Ride", timezone: "America/New_York",
        range: { from, to: u.searchParams.get("to") },
        history: [{ time: `${from}T12:00:00Z`, queue: { STANDBY: { waitTime: 10 } } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await getHistoryRange(target, { from: "2026-01-01", to: "2026-02-05" });
    expect(calls).toHaveLength(2);
    expect(result.history).toHaveLength(2);
    expect(result.range).toEqual({ from: "2026-01-01", to: "2026-02-05" });
  });
});

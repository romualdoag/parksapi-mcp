/** Offline tests for the hosted Walt Disney World destinations (stubbed fetch). */
import { describe, it, expect, beforeEach } from "vitest";
import {
  HOSTED_DESTINATIONS,
  __setHostedFetch,
  __clearHostedCache,
  mapAttractionToEntity,
  mapAttractionToLive,
  mapCalendarDayToEntries,
  mapPreviewStatus,
  normalizeEntityId,
} from "../src/hosted.js";
import { getDestination, getInstance, listDestinations } from "../src/service.js";

const WAITTIME_FIXTURE = {
  attractions: [
    {
      id: "WaltDisneyWorldMagicKingdom_16491297",
      name: "The Barnstormer",
      waitTime: 10,
      status: "Operating",
      active: true,
      lastUpdate: "2026-09-12T19:42:09.049Z",
      meta: { type: "ATTRACTION", latitude: 28.4207, longitude: -81.5783 },
    },
    {
      id: "some-uuid-down-ride",
      name: "Broken Coaster",
      waitTime: null,
      status: "Down",
      active: true,
      meta: { type: "ATTRACTION" },
    },
    {
      id: "WaltDisneyWorldMagicKingdom_999",
      name: "Closed Diner",
      waitTime: null,
      status: "Closed",
      active: false,
      meta: { type: "RESTAURANT" },
    },
    {
      id: "WaltDisneyWorldMagicKingdom_1000",
      name: "Refurb Ride",
      waitTime: null,
      status: "Refurbishment",
      active: true,
      meta: { type: "ATTRACTION" },
    },
  ],
};

const CALENDAR_FIXTURE = {
  calendar: [
    {
      date: "2026-09-12",
      openingTime: "2026-09-12T08:00:00-04:00",
      closingTime: "2026-09-12T23:00:00-04:00",
      type: "Operating",
      special: [
        {
          openingTime: "2026-09-12T07:30:00-04:00",
          closingTime: "2026-09-12T08:00:00-04:00",
          type: "TICKETED_EVENT",
          description: "Early Entry",
        },
      ],
    },
  ],
};

const V1_LIVE_FIXTURE = {
  liveData: [
    {
      id: "stardust-id",
      name: "Stardust Racers",
      entityType: "ATTRACTION",
      parkId: "12dbb85b-265f-44e6-bccf-f1faa17211fc",
      status: "OPERATING",
      queue: { STANDBY: { waitTime: 10 } },
      lastUpdated: "2026-09-13T12:50:51.067Z",
    },
    {
      id: "other-park-ride",
      name: "Not Epic Ride",
      entityType: "ATTRACTION",
      parkId: "eb3f4560-2383-4a36-9152-6b3e5ed6bc57",
      status: "OPERATING",
      queue: { STANDBY: { waitTime: 5 } },
      lastUpdated: "2026-09-13T12:50:51.067Z",
    },
  ],
};

const V1_SCHEDULE_FIXTURE = {
  id: "12dbb85b-265f-44e6-bccf-f1faa17211fc",
  name: "Universal Epic Universe",
  schedule: [
    {
      date: "2026-09-13",
      type: "OPERATING",
      openingTime: "2026-09-13T10:00:00-04:00",
      closingTime: "2026-09-13T20:00:00-04:00",
    },
  ],
};

function stubFetch() {
  __clearHostedCache();
  __setHostedFetch(async (url: string) => {
    if (url.includes("/v1/entity/") && url.endsWith("/live")) {
      return { ok: true, status: 200, json: async () => V1_LIVE_FIXTURE };
    }
    if (url.includes("/v1/entity/") && url.includes("/schedule")) {
      return { ok: true, status: 200, json: async () => V1_SCHEDULE_FIXTURE };
    }
    const body = url.includes("/calendar/")
      ? CALENDAR_FIXTURE
      : WAITTIME_FIXTURE;
    return { ok: true, status: 200, json: async () => body };
  });
}

beforeEach(() => {
  stubFetch();
});

describe("preview API mapping", () => {
  it("maps statuses", () => {
    expect(mapPreviewStatus("Operating", true)).toBe("OPERATING");
    expect(mapPreviewStatus("Closed", true)).toBe("CLOSED");
    expect(mapPreviewStatus("Down", true)).toBe("DOWN");
    expect(mapPreviewStatus("Refurbishment", true)).toBe("REFURBISHMENT");
    expect(mapPreviewStatus("Operating", false)).toBe("CLOSED");
    expect(mapPreviewStatus(null, true)).toBe("CLOSED");
    expect(mapPreviewStatus("SomethingWeird", true)).toBe("CLOSED");
  });

  it("normalizes entity ids", () => {
    expect(normalizeEntityId("WaltDisneyWorldMagicKingdom_16491297")).toBe("16491297");
    expect(normalizeEntityId("some-uuid")).toBe("some-uuid");
  });

  it("maps entities with hierarchy + location", () => {
    const e = mapAttractionToEntity(
      WAITTIME_FIXTURE.attractions[0],
      "waltdisneyworldmagickingdompark",
      "waltdisneyworldmagickingdom",
    );
    expect(e.id).toBe("16491297");
    expect(e.entityType).toBe("ATTRACTION");
    expect((e as any).parentId).toBe("waltdisneyworldmagickingdompark");
    expect((e as any).destinationId).toBe("waltdisneyworldmagickingdom");
    expect((e as any).location).toEqual({ latitude: 28.4207, longitude: -81.5783 });
    const r = mapAttractionToEntity(
      WAITTIME_FIXTURE.attractions[2],
      "p",
      "d",
    );
    expect(r.entityType).toBe("RESTAURANT");
  });

  it("maps live data with standby queue only when operating with a wait", () => {
    const ok = mapAttractionToLive(WAITTIME_FIXTURE.attractions[0]);
    expect(ok.status).toBe("OPERATING");
    expect((ok as any).queue).toEqual({ STANDBY: { waitTime: 10 } });
    const down = mapAttractionToLive(WAITTIME_FIXTURE.attractions[1]);
    expect(down.status).toBe("DOWN");
    expect((down as any).queue).toBeUndefined();
    const closed = mapAttractionToLive(WAITTIME_FIXTURE.attractions[2]);
    expect(closed.status).toBe("CLOSED");
  });

  it("maps calendar days to operating + special entries", () => {
    const entries = mapCalendarDayToEntries(CALENDAR_FIXTURE.calendar[0]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: "2026-09-12", type: "OPERATING" });
    expect(entries[1]).toMatchObject({
      date: "2026-09-12",
      type: "TICKETED_EVENT",
      description: "Early Entry",
    });
  });
});

describe("hosted registry wiring", () => {
  it("exposes the four Orlando Disney parks", () => {
    const ids = new Set(HOSTED_DESTINATIONS.map((d) => d.id));
    for (const id of [
      "waltdisneyworldanimalkingdom",
      "waltdisneyworldepcot",
      "waltdisneyworldhollywoodstudios",
      "waltdisneyworldmagickingdom",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    for (const d of HOSTED_DESTINATIONS.filter((x) =>
      x.id.startsWith("waltdisneyworld"),
    )) {
      expect(d.category).toBe("Disney");
    }
  });

  it("exposes the four Universal Orlando Resort parks", () => {
    const ids = new Set(HOSTED_DESTINATIONS.map((d) => d.id));
    for (const id of [
      "universalstudiosflorida",
      "universalislandsofadventure",
      "universalvolcanobay",
      "universalepicuniverse",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    for (const d of HOSTED_DESTINATIONS.filter((x) =>
      ["universalstudiosflorida", "universalislandsofadventure", "universalvolcanobay", "universalepicuniverse"].includes(x.id),
    )) {
      expect(d.category).toBe("Universal");
    }
    expect(HOSTED_DESTINATIONS).toHaveLength(8);
  });

  it("lists them via listDestinations + Disney filter", async () => {
    const all = await listDestinations();
    const ids = new Set(all.map((d) => d.id));
    for (const d of HOSTED_DESTINATIONS) expect(ids.has(d.id)).toBe(true);
    const disney = await listDestinations("Disney");
    const dids = new Set(disney.map((d) => d.id));
    expect(dids.has("waltdisneyworldmagickingdom")).toBe(true);
    expect(dids.has("disneylandparis")).toBe(true);
    const universal = await listDestinations("Universal");
    const uids = new Set(universal.map((d) => d.id));
    expect(uids.has("universalstudiosflorida")).toBe(true);
    expect(uids.has("universalislandsofadventure")).toBe(true);
    expect(uids.has("universalvolcanobay")).toBe(true);
    expect(uids.has("universalepicuniverse")).toBe(true);
    expect(uids.has("universalorlando")).toBe(true);
  });

  it("describes a hosted destination", async () => {
    const d = await getDestination("waltdisneyworldepcot");
    expect(d.id).toBe("waltdisneyworldepcot");
    expect(d.category).toBe("Disney");
    expect(d.available).toEqual(["get_entities", "get_live_data", "get_schedules"]);
  });

  it("builds entities/live/schedules end to end (stubbed)", async () => {
    const park = await getInstance("waltdisneyworldmagickingdom");
    const entities = await park.getEntities();
    // DESTINATION + PARK + 4 attractions
    expect(entities.length).toBe(6);
    const live = await park.getLiveData();
    expect(live.length).toBe(4);
    const schedules = await park.getSchedules();
    expect(schedules.length).toBe(1);
    expect((schedules[0] as any).schedule.length).toBe(2);
  });

  it("builds a Universal park end to end (stubbed)", async () => {
    const d = await getDestination("universalstudiosflorida");
    expect(d.id).toBe("universalstudiosflorida");
    expect(d.category).toBe("Universal");
    const park = await getInstance("universalstudiosflorida");
    const entities = await park.getEntities();
    expect(entities.length).toBe(6);
    expect((entities[0] as any).timezone).toBe("America/New_York");
    const live = await park.getLiveData();
    expect(live.length).toBe(4);
    const schedules = await park.getSchedules();
    expect(schedules.length).toBe(1);
  });

  it("builds Epic Universe from the v1 API (stubbed, filters by parkId)", async () => {
    const d = await getDestination("universalepicuniverse");
    expect(d.id).toBe("universalepicuniverse");
    expect(d.category).toBe("Universal");
    const park = await getInstance("universalepicuniverse");
    const entities = await park.getEntities();
    // DESTINATION + PARK + 1 epic row (the other-park row is filtered out)
    expect(entities.length).toBe(3);
    expect((entities[2] as any).name).toBe("Stardust Racers");
    const live = await park.getLiveData();
    expect(live.length).toBe(1);
    expect((live[0] as any).name).toBe("Stardust Racers");
    expect((live[0] as any).queue).toEqual({ STANDBY: { waitTime: 10 } });
    const schedules = await park.getSchedules();
    expect(schedules.length).toBe(1);
    expect((schedules[0] as any).schedule.length).toBe(1);
  });
});

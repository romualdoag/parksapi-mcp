/** Live tests against the public Efteling API (no credentials needed). */
import { describe, it, expect } from "vitest";
import { getEntities, getLiveData, getSchedules } from "../src/service.js";

describe("efteling live data", () => {
  it(
    "returns entities with resolved hierarchy",
    async () => {
      const r = await getEntities("efteling", { limit: 200 });
      expect(r.count).toBeGreaterThan(10);
      expect(r.data.length).toBeGreaterThan(10);
      const ids = new Set(r.data.map((e) => e.id as string));
      expect(ids.has("efteling")).toBe(true);
      for (const e of r.data) {
        expect(typeof e.id).toBe("string");
        expect(typeof e.entityType).toBe("string");
      }
    },
    120_000,
  );

  it(
    "filters entities by type",
    async () => {
      const r = await getEntities("efteling", { entityType: "ATTRACTION", limit: 5 });
      expect(r.data.length).toBeGreaterThan(0);
      for (const e of r.data) expect(e.entityType).toBe("ATTRACTION");
    },
    120_000,
  );

  it(
    "returns live wait times",
    async () => {
      const r = await getLiveData("efteling", { limit: 5 });
      expect(r.count).toBeGreaterThan(0);
      expect(r.data.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "returns schedules",
    async () => {
      const r = await getSchedules("efteling", { limit: 5 });
      expect(r.count).toBeGreaterThan(0);
    },
    120_000,
  );
});

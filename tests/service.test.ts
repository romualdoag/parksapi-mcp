/** Offline unit tests: helpers + registry-backed reads (no network). */
import { describe, it, expect } from "vitest";
import {
  withLimit,
  matchesEntity,
  listDestinations,
  listCategories,
  getDestination,
  getInstance,
} from "../src/service.js";

describe("withLimit", () => {
  it("returns everything when no limit is given", () => {
    expect(withLimit([1, 2, 3])).toEqual({
      count: 3,
      truncated: false,
      data: [1, 2, 3],
    });
  });

  it("slices and flags truncation", () => {
    expect(withLimit([1, 2, 3], 2)).toEqual({
      count: 3,
      truncated: true,
      data: [1, 2],
    });
  });

  it("does not flag truncation when limit covers the array", () => {
    const r = withLimit([1, 2], 5);
    expect(r.truncated).toBe(false);
    expect(r.data).toEqual([1, 2]);
  });

  it("treats 0 / negative / NaN as unlimited (schema enforces positive via MCP)", () => {
    for (const limit of [0, -3, NaN]) {
      const r = withLimit([1, 2, 3], limit);
      expect(r.truncated).toBe(false);
      expect(r.data).toEqual([1, 2, 3]);
    }
  });
});

describe("matchesEntity", () => {
  it("matches everything without a filter", () => {
    expect(matchesEntity({ id: "x" })).toBe(true);
  });

  it("matches on id or entityId", () => {
    expect(matchesEntity({ id: "a" }, "a")).toBe(true);
    expect(matchesEntity({ entityId: "a" }, "a")).toBe(true);
    expect(matchesEntity({ id: "b" }, "a")).toBe(false);
  });
});

describe("registry", () => {
  it("lists all destinations including universalorlando and efteling", async () => {
    const dests = await listDestinations();
    expect(dests.length).toBeGreaterThan(70);
    const ids = new Set(dests.map((d) => d.id));
    expect(ids.has("universalorlando")).toBe(true);
    expect(ids.has("efteling")).toBe(true);
  });

  it("filters by category", async () => {
    const all = await listDestinations();
    const cats = new Set<string>();
    for (const d of all) {
      const c = d.category;
      if (Array.isArray(c)) c.forEach((x) => cats.add(x));
      else cats.add(c);
    }
    const pick = [...cats].find((c) => c.toLowerCase().includes("universal")) ?? [...cats][0];
    const filtered = await listDestinations(pick);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });

  it("lists categories", async () => {
    const cats = await listCategories();
    expect(cats.length).toBeGreaterThan(0);
  });

  it("filters by category case-insensitively ('disney' == 'Disney')", async () => {
    const upper = await listDestinations("Disney");
    const lower = await listDestinations("disney");
    expect(lower.length).toBeGreaterThan(0);
    expect(new Set(lower.map((d) => d.id))).toEqual(
      new Set(upper.map((d) => d.id)),
    );
    expect(lower.some((d) => d.id === "waltdisneyworldmagickingdom")).toBe(true);
  });

  it("describes a destination", async () => {
    const d = await getDestination("efteling");
    expect(d.id).toBe("efteling");
    expect(d.available).toEqual(["get_entities", "get_live_data", "get_schedules"]);
  });

  it("rejects unknown destinations", async () => {
    await expect(getDestination("not-a-park")).rejects.toThrow(/Unknown destination/);
    await expect(getInstance("not-a-park")).rejects.toThrow(/Unknown destination/);
  });
});

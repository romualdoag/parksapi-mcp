# parksapi-mcp

Generic MCP server over [`@themeparks/parksapi`](https://github.com/ThemeParks/parksapi) — every destination the library supports (80+ theme parks worldwide) with no per-park code, **plus** the 8 Orlando parks the library can't serve without app credentials, via the public [`api.themeparks.wiki`](https://www.themeparks.wiki/api) APIs (see `src/hosted.ts`).

## Tools

| Tool | Description | Input |
|---|---|---|
| `list_destinations` | All destination ids (id, name, category) | `{category?}` |
| `list_categories` | All categories for filtering | — |
| `get_destination` | Details for one destination id | `{destination}` |
| `get_entities` | Entities (rides, shows, restaurants…) with hierarchy resolved | `{destination, entityType?, limit?}` |
| `get_live_data` | Live wait times / statuses / queues | `{destination, entityId?, limit?}` |
| `get_schedules` | Operating hours / show times | `{destination, entityId?, limit?}` |

All tools return JSON as text. `entityType` filters e.g. `ATTRACTION`, `SHOW`, `RESTAURANT` (case-insensitive). `entityId` matches `entry.id` or `entry.entityId`. `limit` caps returned items (omitted: all; via MCP it must be a positive int — direct `withLimit(arr, 0)` also means "all"). `category` in `list_destinations` is case-insensitive (`disney` == `Disney`). Unknown destinations return a tool result with `isError: true` (plain message, no protocol error).

## Requirements

Node 22+.

## Cache

The vendored upstream library keeps a SQLite cache at `./cache.sqlite` (plus `-shm`/`-wal`) in the server's working directory — override with `CACHE_DB_PATH` (e.g. `CACHE_DB_PATH="$TMPDIR/parksapi-cache.sqlite"`). The files are git-ignored; wipe them with:

```bash
npm run clean
```

## Run

```bash
npm run setup:upstream   # once per clone: install + build vendored lib
npm install
npm run build
npm start                # stdio MCP server
```

Claude Desktop / Hermes config:

```json
{
  "mcpServers": {
    "parksapi": {
      "command": "node",
      "args": ["/path/to/parksapi-mcp/dist/index.js"],
      "env": { "EFTELING_APIKEY": "..." }
    }
  }
}
```

## Orlando parks (no credentials needed)

The TS library leaves Walt Disney World out of scope (Disney locked down the direct facility-service API) and covers Universal Orlando only with app-extracted API keys (without them `universalorlando` fails with `Invalid URL`). This server fills the gap with 8 native destinations (same `get_entities` / `get_live_data` / `get_schedules` interface, no credentials):

| Park | `destination` | Source |
|---|---|---|
| Magic Kingdom | `waltdisneyworldmagickingdom` | preview collector |
| EPCOT | `waltdisneyworldepcot` | preview collector |
| Hollywood Studios | `waltdisneyworldhollywoodstudios` | preview collector |
| Animal Kingdom | `waltdisneyworldanimalkingdom` | preview collector |
| Universal Studios Florida | `universalstudiosflorida` | preview collector |
| Islands of Adventure | `universalislandsofadventure` | preview collector |
| Volcano Bay | `universalvolcanobay` | preview collector |
| Epic Universe | `universalepicuniverse` | v1 live + schedule API |

7 parks read `https://api.themeparks.wiki/preview/parks/<ParkAPIID>/{waittime,calendar}` (the `HostedPark` pattern from the legacy JS library). Epic Universe has no ParkAPIID in the preview feed (404), so it reads the v1 live API (`universalresort_orlando/live` filtered by Epic parkId) plus the v1 schedule endpoint.

To add more hosted parks (e.g. Disneyland California), add one entry to `HOSTED_DESTINATIONS` in `src/hosted.ts`.

## Credentials

Most library-backed destinations need upstream API credentials as env vars (see the [parksapi docs](https://github.com/ThemeParks/parksapi)). Public ones such as `efteling` and all 8 Orlando hosted parks work with no credentials.

## Tests (vitest, 32 tests)

```bash
npm test   # build + full suite
```

- `tests/service.test.ts` — registry/helpers (offline)
- `tests/hosted.test.ts` — WDW + Universal mapping, Epic v1 fallback, registry (offline, stubbed fetch)
- `tests/live.test.ts` — Efteling live (no credentials)
- `tests/protocol.test.ts` — real server over JSON-RPC stdio

## Examples

- `list_destinations` → browse ids (`efteling`, `waltdisneyworldmagickingdom`, `universalepicuniverse`…)
- `get_live_data {destination: "waltdisneyworldmagickingdom"}` → Magic Kingdom wait times
- `get_live_data {destination: "universalepicuniverse"}` → Epic Universe wait times (v1-backed)
- `get_schedules {destination: "efteling"}` → operating hours

## Upstream

`upstream/` is a snapshot of [ThemeParks/parksapi](https://github.com/ThemeParks/parksapi) (`2460a5e`). Refresh it with:

```bash
rm -rf upstream && git clone --depth 1 https://github.com/ThemeParks/parksapi.git upstream && rm -rf upstream/.git && npm run setup:upstream
```

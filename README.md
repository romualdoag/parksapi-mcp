# parksapi-mcp

Generic MCP server over [`@themeparks/parksapi`](https://github.com/ThemeParks/parksapi) —
every destination the library supports (80+ theme parks worldwide), no per-park code.

## Tools

| Tool | Description |
|---|---|
| `list_destinations` | All destination ids (`{category?}` filter) |
| `list_categories` | All categories |
| `get_destination` | Details for one destination id |
| `get_entities` | Entities (rides, shows, restaurants…) `{destination, entityType?, limit?}` |
| `get_live_data` | Live wait times / statuses `{destination, entityId?, limit?}` |
| `get_schedules` | Operating hours / show times `{destination, entityId?, limit?}` |

## Run

Requires Node 24+.

```bash
npm run setup:upstream   # install + build vendored lib (once per clone)
npm install
npm run build
npm start          # stdio MCP server
```

`upstream/` is a snapshot of
[ThemeParks/parksapi](https://github.com/ThemeParks/parksapi) (`2460a5e`).
Refresh it with: `rm -rf upstream && git clone --depth 1
https://github.com/ThemeParks/parksapi.git upstream && rm -rf upstream/.git
&& npm run setup:upstream`.

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

## Tests (vitest, 17 testes)

```bash
npm test   # build + suite completa
```

- `tests/service.test.ts` — helpers e registry (offline)
- `tests/live.test.ts` — Efteling ao vivo (sem credenciais)
- `tests/protocol.test.ts` — servidor real via JSON-RPC stdio

## Credentials

Most destinations need upstream API credentials via env vars (see the
[parksapi docs](https://github.com/ThemeParks/parksapi)); `efteling` works
without any. Copy `.env.example` to `.env` if running outside an MCP host.

## Examples

- `list_destinations` → find `id: "universalorlando"`
- `get_live_data {destination: "universalorlando"}` → wait times for Epic Universe & co.
- `get_schedules {destination: "efteling"}` → operating hours

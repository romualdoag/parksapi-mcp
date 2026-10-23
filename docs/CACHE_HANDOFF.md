# Handoff: estratégia de cache frio para MCPs (cold cache)

Padrão extraído do `parksapi-mcp` (`src/historyCache.ts` + `src/history.ts`).
Objetivo: repetir chamadas caras ao upstream sem queimar budget de API,
servir restart do gateway sem rajada de refetch, e nunca versionar dados
de terceiros. Copie a estrutura, ajuste TTLs e nomes por MCP.

## Princípios (não negociáveis)

1. **Quente vs frio**: dado quente (filas ao vivo, status) fica em memória
   com TTL curto (60s). Dado frio (histórico, entities, horários,
   registry) vai pro SQLite persistente com TTL longo.
2. **Chave sob demanda**: tenta anônimo primeiro; só repete com a chave
   quando o upstream barra a janela (`HISTORY_WINDOW_EXCEEDED` /
   `earliestAllowedDate`). Cada chamada com chave consome budget — marque
   na resposta (`keyUsed`) pra ser auditável.
3. **Incremental por data**: nunca refaz o range inteiro. Guarda cobertura
   por dia (`fetched_days`) e busca só os gaps, em sub-ranges consecutivos
   (respeitando o chunk máximo da API, ex. 31 dias).
4. **Recente sempre atualiza**: últimos N dias (padrão 2 = hoje + ontem)
   sempre refazem fetch — o upstream continua anexando pontos. Data antiga
   é imutável: buscou uma vez, nunca mais.
5. **Range histórico não falha**: se o pedido termina no passado e está
   tudo coberto, serve 100% do cache (`cacheHit: true`, zero chamadas).
6. **Fail-soft**: qualquer erro de SQLite (cwd read-only, lock, schema)
   desliga o cache e segue direto pro upstream. Cache nunca quebra chamada.
7. **Dados de terceiros fora do git**: `*.sqlite*` no `.gitignore`.
   Nunca commitar nem dar push no banco.

## Schema (SQLite via `node:sqlite`)

```sql
-- Hierarquia cidade → destino/parque → atração em cada linha
history_targets (target_id PK, city, destination, park_id, park_name,
                 entity_name, entity_type, timezone, envelope_json)
history_points  (target_id, city, destination, park_id, entity_id,
                 entity_name, time, point_json, PK(target_id, entity_id, time))
history_days    (…mesma forma…, date, day_json, PK(target_id, entity_id, date))
history_fetched (target_id, date, daily, fetched_at, PK(target_id, date, daily))
-- KV genérico pra dado frio (entities, schedules, registry)
kv_cache        (key PK, value_json, fetched_at)
```

- Migração suave: `ensureColumn()` via `PRAGMA table_info` — DBs locais
  antigos ganham as colunas sem perder dados (o banco é descartável mesmo).
- `node:sqlite` no Node 22 é experimental e **não tem `createTransaction`**
  nos tipos: use `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` manual.
- Índices por hierarquia (`city, destination, park_id, entity_id, time`)
  pra leitura em qualquer nível (`queryPoints`, `listHierarchy`).

## TTLs praticados

| Dado | TTL | Por quê |
|---|---|---|
| Live / wait times | 60s em memória | Quente; staleness prejudica decisão |
| History recente (hoje/ontem) | sempre refetch | Upstream anexa pontos |
| History antiga | infinita | Imutável após cobertura |
| Entities (lista de atrações etc.) | 7 dias (`ENTITIES_CACHE_TTL_HOURS=168`) | Muda poucas vezes/ano; status vem do live |
| Schedules / calendário | 24h (`SCHEDULES_CACHE_TTL_HOURS=24`) | Muda por evento/estação |
| Registry de destinos | 30 dias | Praticamente estático |

Status ao vivo NUNCA sai do cache frio: nomes/IDs podem ter 7 dias,
aberto/fechado e fila vêm sempre do live fresco.

## Wiring (checklist por MCP)

1. `fetch` puro como transporte; headers (`user-agent`, `x-api-key`)
   montados por chamada (`anonHeaders()` vs `keyedHeaders()`).
2. `apiJsonAuto()`: tenta anônimo → em `WINDOW_EXCEEDED` com chave
   disponível, repete com chave e marca `keyUsed`.
3. Leituras que não precisam de chave (live, registry) usam o path
   anônimo direto.
4. `getHistoryRange()`-like: missing = `getUnfetchedDates()` →
   `groupConsecutiveDates()` → fetch por chunk → `save*` + `markFetched`
   → reconstrói do cache (`buildCachedResponse`) → cai pro merge em
   memória se cache desligado/vazio.
5. Range com `to` no passado: `refreshRecentDays = 0` (full hit possível).
6. Env knobs: `HISTORY_CACHE_PATH` (default `./history-cache.sqlite`),
   `HISTORY_CACHE_ENABLED=0` (bypass), `*_TTL_HOURS` por dataset.
7. Stubs de fetch em teste precisam aceitar `init.headers`
   (a assinatura mudou: `{signal, headers}`).

## Testes (checklist)

- Roundtrip save/load + colunas de hierarquia (`listHierarchy`,
  `queryPoints` por cidade/destino).
- `getUnfetchedDates`: antiga coberta não volta; recente sempre volta.
- Incremental: 2ª chamada no range histórico = 0 chamadas upstream
  (`cacheHit: true`); range vivo = 1 chamada só no gap recente.
- Chave sob demanda: stub 403 `WINDOW_EXCEEDED` → 1ª tentativa sem
  `x-api-key`, retry com chave, `keyUsed: true`.
- Suite com `HISTORY_CACHE_PATH=":memory:"` no `vitest.config.ts`
  (+ `__resetHistoryCacheForTests(':memory:')` no `beforeEach`).
- `npm audit` + `npm audit fix` antes de shippar; resto em cadeia dev
  (vitest/tinypool) só com major — documentar e seguir.

## Status no parksapi-mcp (2026-10-23)

Feito: `historyCache.ts` (hierarquia + incremental + KV), anon-first em
`history.ts`, clamp de janela, `keyUsed`/`cacheHit`, testes (48 passando),
README + `.gitignore`, skill `parksapi-mcp` com rotina de audit.
Pendente: ligar o KV em `service.ts#getEntities/#getSchedules`
(helpers `kvGet`/`kvSet` + TTLs prontos; zerar KV no `beforeEach` de
`tests/hosted.test.ts`), restart do gateway (destacado) pra valer.
Banco local nunca commitado.

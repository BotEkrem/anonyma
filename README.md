# Anonyma

Ephemeral anonymous text, voice, and video chat. Text messages are encrypted at rest (AES-256-GCM) and hard-deleted after **10 minutes**. Separate match queues + lobby room modes for text / voice / video. Live media via LiveKit. No accounts.

## Stack

- **gateway / core / match** — NestJS (TypeScript)
- **realtime** — Rust (Axum WebSocket fanout)
- **shared** — DTOs, RMQ contracts, crypto helpers
- **web** — Vite + React landing & chat / media UI
- **LiveKit** — voice & video SFU (JWT minted by gateway)
- **Postgres + Drizzle** — sessions / rooms metadata
- **MongoDB TTL** — encrypted message blobs
- **Redis** — presence, matchmaking, rate limits
- **RabbitMQ** — inter-service RPC + events
- **Docker Compose / Rancher K8s** — deploy
- **Grafana + Prometheus + Uptime Kuma** — status & observability
- **Cloudflare Turnstile** — bot protection on session/room create

## Quick start (local)

```bash
cp .env.example .env
pnpm install
pnpm --filter @anonyma/shared build

# infra only
docker compose -f docker-compose.dev.yml up -d postgres mongo redis rabbitmq

# apps
pnpm dev:core
pnpm dev:match
pnpm dev:gateway
pnpm dev:realtime
pnpm dev:web
```

- Web: http://localhost:5173  
- API: http://localhost:3000  
- WS: ws://localhost:3003/ws  
- RabbitMQ UI: http://localhost:15672 (`anonyma` / `anonyma`)  
- Grafana: http://localhost:3004 (compose profile with observability)  
- Uptime Kuma: http://localhost:3005  

Full stack via Compose:

```bash
docker compose -f docker-compose.dev.yml up -d --build
# optional: --profile observability  (Grafana / Prometheus / Uptime Kuma)
```

- Dev compose: [`docker-compose.dev.yml`](docker-compose.dev.yml)  
- Prod compose: [`docker-compose.prod.yml`](docker-compose.prod.yml)

## Production

Use [`docker-compose.prod.yml`](docker-compose.prod.yml) behind Traefik. Set `DOMAIN`, `EDGE_NETWORK`, and secrets in the host env (not committed).

## Rancher / Kubernetes (optional)

```bash
# create deploy/k8s/secrets.yaml from your secrets manager, then:
kubectl apply -k deploy/k8s
```

Enable WAF + Turnstile; set `TURNSTILE_*` and `TURNSTILE_SKIP=false`.

## Checks

`pnpm check` runs everything a change should pass: builds the shared packages,
type-checks every app (tests included), lints with ESLint (TypeScript and React
hook rules) and runs the Node and Rust tests.

## Database schema

`apps/core/src/db/schema.ts` is the only definition. To change it, edit the
schema, run `pnpm --filter @anonyma/core db:generate` and commit the new file in
`apps/core/drizzle/`. Core applies pending migrations when it starts (one pod at
a time). A database created before migrations were tracked refuses to start
until `pnpm --filter @anonyma/core db:baseline` (or `node dist/db/baseline.js`
in the core image) records the first migration as applied.

## Security notes

- Session cookie is HttpOnly; only SHA-256 hashes stored in Postgres
- Message bodies AES-256-GCM with roomId AAD; reply previews scrubbed on delete/edit
- WS tickets are encrypted, single-use (Redis GETDEL), and sent after connect (not in the URL)
- Production Redis uses `requirepass`; gateway stays off the Traefik edge (Turnstile via internal proxy)
- Rate limits on session / room / join / match / message; nginx CSP + hardening headers
- Max message length 2KB; message TTL 600s (Mongo TTL index on `t`)

## Repo layout

```
apps/gateway  apps/core  apps/match  apps/realtime  apps/web
packages/shared
deploy/docker  deploy/k8s  deploy/observability
docker-compose.dev.yml  docker-compose.prod.yml
```

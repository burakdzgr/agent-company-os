# agent-company-os

AI Agent Company OS. Architecture package lives in `docs/architecture/` — start at
`docs/architecture/docs/architecture/docs/35-CLAUDE-CODE-HANDOFF.md`.

## Prerequisites

- Docker Engine 27+ with Compose v2.29+
- Node.js 22 LTS, pnpm 9.x (`corepack enable`)

## Boot

```bash
git clone <repo> && cd agent-company-os
cp .env.example .env
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test

# infrastructure services
docker compose -f infrastructure/docker/compose.yaml up -d postgres nats temporal temporal-ui
```

Temporal UI: http://localhost:8080 · Postgres: localhost:5432 · NATS: localhost:4222

# RuhuTickets — Cloud-Native Ticket Booking (Starter)

This repo is a **starter pack** for a 4-person undergraduate cloud engineering project.
It includes microservice stubs, Docker Compose for local dev, Postgres/Redis/RabbitMQ,
seed data, simple REST APIs, and CI/CD & Helm skeletons.

> Matches EC7205 Assignment 2 requirements: scalability, HA, security, deployment, sync/async comms, extensibility, and docs.

## Quick start (local)
```bash
cp .env.example .env
docker compose -f deploy/compose/docker-compose.yaml up -d --build
# Run DB migrations & seed
docker compose -f deploy/compose/docker-compose.yaml exec inventory npm run db:migrate  
docker compose -f deploy/compose/docker-compose.yaml exec inventory npm run db:seed
# Try APIs
curl -s http://localhost:8080/health
curl -s http://localhost:8080/api/v1/events
```
Then open RabbitMQ UI at http://localhost:15672 (guest/guest).

## Services
- **api-gateway**: thin BFF/edge routing, auth middleware, rate-limiting
- **inventory**: events, ticket types, seat reservations (Redis TTL lock + Postgres authoritative state)
- **order**: order state + saga orchestration with outbox
- **payment**: mock payment adapter (idempotent), webhook endpoint
- **notification**: consumes events and logs "email" sends

## Tech
- Node.js (Express + Zod) • Postgres • Redis • RabbitMQ
- Docker • Docker Compose (local) • Helm skeletons (k8s) • GitHub Actions sample
- OpenTelemetry logs/metrics stubs

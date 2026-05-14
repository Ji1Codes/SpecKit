# Implementation Plan: Jira Integration

**Branch**: `001-jira-integration` | **Date**: 2026-05-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-jira-integration/spec.md`

---

## Summary

Extend the existing FastAPI application with a Jira integration layer that periodically polls a configured Jira project, ingests ticket data into a local SQLite/PostgreSQL database, protects locally-resolved ticket state, extracts plain text from Atlassian Document Format (ADF) descriptions, computes SLA compliance, and pushes status transitions back to Jira when local state changes. The integration is exposed via two REST endpoints (`POST /api/jira/poll`, `GET /api/jira/tickets`) and a core `poll_jira_tickets` async service function.

---

## Technical Context

**Language/Version**: Python 3.11

**Primary Dependencies**: FastAPI, httpx (async HTTP client for Jira REST API), SQLAlchemy 2.x (async session + ORM), pydantic v2, python-dotenv

**Storage**: SQLite (dev) via SQLAlchemy async engine; PostgreSQL (prod) via same ORM layer — no raw SQL, migrations handled externally

**Testing**: pytest + pytest-asyncio + httpx AsyncClient; unit tests mock `httpx.AsyncClient`; integration tests use an in-memory SQLite database

**Target Platform**: Linux/Windows server (same binary, platform-agnostic Python)

**Project Type**: web-service + background polling (sync triggered via REST endpoint; scheduling is external)

**Performance Goals**: Poll up to 500 Jira tickets per cycle; complete full upsert + SLA computation in < 30 s

**Constraints**: Jira credentials (email, token) must never appear in logs, error messages, or API responses; locally-resolved tickets must never have their local state overwritten by a polling cycle

**Scale/Scope**: Single Jira project per polling call, up to 500 tickets; no pagination beyond 500 in v1

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| # | Principle | Requirement | Plan Compliance | Status |
|---|-----------|-------------|-----------------|--------|
| I | Spec-First Development | All features must start with `spec.md` before any code | `spec.md` exists and checklist is fully signed off | ✅ PASS |
| II | Async-First | All I/O (Jira API calls, DB queries) must use `async`/`await`; no blocking calls | `poll_jira_tickets` is `async def`; `httpx.AsyncClient` used for all Jira calls; SQLAlchemy `AsyncSession` used for all DB operations | ✅ PASS |
| III | Security | Credentials must never appear in logs/responses; injected via env vars only | Credentials flow only through function parameters (not logged); `.env.example` documents env var names; `JiraConfig` schema excludes token from response serialization | ✅ PASS |
| IV | Resilience | Network/auth/permission errors must raise `RuntimeError` with descriptive messages; no silent swallowing | Validation steps (credential check, project check) raise `RuntimeError` on failure; HTTP errors from Jira are caught and re-raised with context; failed transitions are logged as warnings and retried next cycle | ✅ PASS |
| V | Data Integrity | Locally-resolved tickets must never have their resolution overwritten by a sync cycle | Upsert logic checks `local_state == "resolved"` before applying Jira-side field updates; protected tickets receive only metadata refreshes | ✅ PASS |
| VI | Simplicity | YAGNI — only what is needed for the current requirement | No event bus, no message queue, no repository pattern; direct service + router structure; scheduling is explicitly external | ✅ PASS |

**Gate Result**: All 6 principles satisfied. Proceeding to Phase 0.

---

## Project Structure

### Documentation (this feature)

```text
specs/001-jira-integration/
├── plan.md              ← this file  (Phase 1 output)
├── research.md          ← (Phase 0 output)
├── data-model.md        ← (Phase 1 output)
├── contracts/
│   └── jira-poll-api.md ← (Phase 1 output)
├── checklists/
│   └── requirements.md
└── tasks.md             ← (Phase 2 output — created by /speckit.tasks)
```

### Source Code (repository root)

```text
app.py                          ← existing; extend: include jira router
models/
├── __init__.py
├── ticket.py                   ← Ticket SQLAlchemy model (new)
└── workspace.py                ← WorkspaceSlaMapping SQLAlchemy model (new)
services/
├── __init__.py
└── jira_service.py             ← poll_jira_tickets, _extract_jira_description,
                                   transition_ticket (new)
routers/
├── __init__.py
└── jira.py                     ← FastAPI router: POST /api/jira/poll,
                                   GET /api/jira/tickets (new)
schemas/
├── __init__.py
├── ticket.py                   ← Pydantic output schemas for Ticket (new)
└── jira_config.py              ← Pydantic input schema for JiraConfig (new)
tests/
├── test_jira_service.py        ← unit tests: poll_jira_tickets,
                                   _extract_jira_description (new)
└── test_jira_router.py         ← integration tests: /api/jira/* (new)
.env.example                    ← JIRA_URL, JIRA_EMAIL, JIRA_TOKEN,
                                   JIRA_PROJECT (new)
```

**Structure Decision**: Single-project flat layout extending the existing `app.py` FastAPI app. The `models/`, `services/`, `routers/`, `schemas/` packages follow the FastAPI idiomatic project layout. No separate backend/frontend split is needed because the static UI already exists under `static/` and the integration is API-only.

---

## Implementation Phases

### Phase 0: Research

**Status**: Complete (all unknowns resolved before plan authoring)

**Research output**: [research.md](research.md)

| Question | Decision | Rationale |
|----------|----------|-----------|
| ADF extraction strategy | Recursive walk of `content` arrays, collecting all `text` node values | Jira Cloud ADF is a tree of typed nodes; recursion is the simplest correct approach; no external ADF library needed |
| httpx vs aiohttp | `httpx.AsyncClient` with Basic Auth | httpx has first-class async support, typed responses, and is already used in the FastAPI ecosystem; no additional dependency |
| Upsert strategy | SQLAlchemy `merge()` / `on_conflict_do_update` | Avoids separate SELECT+INSERT/UPDATE; atomic under concurrent workers |
| Retry for failed transitions | Pending-transition flag on Ticket row; checked at start of each `poll_jira_tickets` call | Simple, stateful, no external scheduler needed; aligns with FR-012 |
| SLA computation timing | After DB commit, in-memory over upserted tickets | Avoids extra round-trip; SLA logic is purely computational |
| Credential logging guard | Never pass credential fields to any logger; use structured error messages with workspace_id only | Satisfies Constitution Principle III |

---

### Phase 1: Design

**Status**: Complete

**Artifacts produced**: `data-model.md`, `contracts/jira-poll-api.md`

#### Service Layer — `services/jira_service.py`

```
poll_jira_tickets(workspace_id, jira_url, jira_email, jira_token, jira_project, db)
  │
  ├─ 1. validate_credentials()   → GET /rest/api/3/myself
  │      raise RuntimeError("credential validation failed") on 401/403
  │
  ├─ 2. validate_project()       → GET /rest/api/3/project/{jira_project}
  │      raise RuntimeError("project access denied: {jira_project}") on 403/404
  │
  ├─ 3. fetch_tickets()          → GET /rest/api/3/search/jql
  │      JQL: project = {jira_project} ORDER BY created DESC
  │      fields: summary,description,priority,status,assignee,
  │              created,resolutiondate,components,labels,issuetype
  │      maxResults: 500
  │
  ├─ 4. _extract_jira_description(desc)
  │      → plain str  if desc is str
  │      → recursive text extraction  if desc is dict (ADF)
  │      → ""  if desc is None
  │
  ├─ 5. upsert_tickets(tickets, db)
  │      for each ticket:
  │        existing = db.get(Ticket, jira_key)
  │        if existing and existing.local_state == "resolved":
  │          update metadata only (priority, assignee, labels, components)
  │        else:
  │          full upsert (all fields)
  │
  ├─ 6. compute_sla(tickets, sla_mappings)
  │      for each ticket: attach sla_compliant bool/str based on mapping
  │
  ├─ 7. db.commit()
  │
  └─ 8. apply_pending_transitions(tickets, jira_url, jira_email, jira_token, db)
         for each ticket with pending_transition is not None:
           transition_ticket(jira_key, transition_id, ...)
           clear pending_transition on success
           log warning + keep pending_transition on failure
```

#### Router Layer — `routers/jira.py`

```
POST /api/jira/poll
  Body: JiraConfig { jira_url, jira_email, jira_token, jira_project }
  → calls poll_jira_tickets(...)
  → returns { "synced": <count>, "protected": <count> }
  → HTTP 400 on RuntimeError (credential/project failure)
  → HTTP 500 on unexpected errors

GET /api/jira/tickets
  Query params: status (optional), limit (default 100, max 500)
  → returns List[TicketOut]
```

---

### Phase 2: Data Model

**Status**: Complete

**Artifact**: [data-model.md](data-model.md)

Key entities:
- `Ticket` — local mirror of a Jira issue; `jira_key` is the primary key
- `WorkspaceSlaMapping` — maps workspace + priority to SLA hours

See `data-model.md` for full field definitions, constraints, and relationships.

---

### Phase 3: API Contracts

**Status**: Complete

**Artifact**: [contracts/jira-poll-api.md](contracts/jira-poll-api.md)

Endpoints defined:
- `POST /api/jira/poll` — trigger polling cycle
- `GET /api/jira/tickets` — list synced tickets

See `contracts/jira-poll-api.md` for request/response schemas, status codes, and examples.

---

## Complexity Tracking

No constitution violations. No complexity justification required.

---
description: "Task list for 001-jira-integration"
---

# Tasks: Jira Integration

**Input**: Design documents from `/specs/001-jira-integration/`

**Prerequisites**: plan.md ✅, spec.md ✅, data-model.md ✅, contracts/jira-poll-api.md ✅

**Organization**: Tasks grouped by user story — US1 (P1 core polling service), US2 (P2 credential validation + API router), US3 (P3 bidirectional sync + tests)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 = P1 core polling, US2 = P2 credential validation, US3 = P3 bidirectional sync
- All paths are relative to repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create directory structure and configure dependencies before any feature code is written

- [x] T001 Create package directories models/, services/, routers/, schemas/, tests/ each with an empty `__init__.py` file, extending the repository root structure defined in plan.md
- [x] T002 [P] Update requirements.txt — add `httpx>=0.27`, `sqlalchemy>=2.0`, `python-dotenv>=1.0` on separate lines; preserve existing entries
- [x] T003 [P] Create .env.example at repository root with keys `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECT` and a comment per key explaining its purpose

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: SQLAlchemy models and Pydantic schemas that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] Create models/ticket.py — `Ticket` SQLAlchemy model using `DeclarativeBase`; table `tickets`; columns: `jira_key String(64) PK`, `workspace_id String(128) not-null indexed`, `summary String(512) not-null`, `description Text nullable`, `priority String(64) nullable`, `status String(64) not-null`, `assignee String(256) nullable`, `issue_type String(64) nullable`, `components JSON nullable`, `labels JSON nullable`, `jira_created_at DateTime(timezone=True) not-null`, `jira_resolved_at DateTime(timezone=True) nullable`, `local_state String(64) not-null default="open"`, `sla_compliant Boolean nullable`, `sla_target_hours Float nullable`, `pending_transition String(64) nullable`, `synced_at DateTime(timezone=True) not-null`; add indexes `ix_tickets_workspace_id`, `ix_tickets_status`, `ix_tickets_local_state`
- [x] T005 [P] Create models/workspace.py — `WorkspaceSlaMapping` SQLAlchemy model importing `Base` from models/ticket.py; table `workspace_sla_mappings`; composite PK `(workspace_id String(128), priority String(64))`; columns: `response_hours Float not-null`, `resolution_hours Float not-null`; use `PrimaryKeyConstraint` in `__table_args__`
- [x] T006 [P] Create schemas/jira_config.py — `JiraConfig` Pydantic model with fields: `workspace_id: str`, `jira_url: str` (validate HTTPS URL), `jira_email: str` (non-empty), `jira_token: str` (non-empty, excluded from serialization via `model_config` or `Field(exclude=True)`), `jira_project: str` (non-empty)
- [x] T007 [P] Create schemas/ticket.py — `TicketOut` Pydantic model mirroring all `Ticket` model fields for GET /api/jira/tickets response serialization; use `model_config = ConfigDict(from_attributes=True)` to enable ORM mode

**Checkpoint**: All model and schema files exist — user story implementation can now begin

---

## Phase 3: User Story 1 — Poll Jira and Sync Tickets (Priority: P1) 🎯 MVP

**Goal**: Implement the `poll_jira_tickets` async service function that fetches up to 500 tickets via JQL, extracts ADF descriptions as plain text, computes SLA compliance, upserts tickets into the local DB, and protects locally-resolved tickets from state overwrite.

**Independent Test**: Configure valid Jira credentials, call `poll_jira_tickets` directly, verify tickets appear in local DB with correct field values; confirm a pre-seeded resolved ticket retains its `local_state` after the poll.

### Implementation for User Story 1

- [x] T008 [US1] Create services/jira_service.py with all helper functions: `_adf_node_text(node: dict) -> str` (recursively extracts text from an ADF node and its children), `_extract_jira_description(field) -> str | None` (handles ADF dict → calls `_adf_node_text`, plain string → returns as-is, None → returns None), `_parse_jira_date(date_str: str | None) -> datetime | None` (parses ISO-8601 with timezone; returns None on null/parse error), `_map_jira_state(jira_status: str) -> str` (maps Jira status names to local state strings), `_map_jira_priority(jira_priority: str) -> str` (normalises Jira priority names)
- [x] T009 [US1] Implement `poll_jira_tickets(workspace_id, jira_url, jira_email, jira_token, jira_project, db: Session) -> int` body in services/jira_service.py — step 1: validate credentials via `GET /rest/api/3/myself` using `httpx.AsyncClient` with Basic Auth; raise `RuntimeError` on non-2xx; step 2: validate project via `GET /rest/api/3/project/{jira_project}`; raise `RuntimeError` on non-2xx; step 3: fetch issues via `GET /rest/api/3/search` with JQL `project={jira_project} ORDER BY created DESC` and `maxResults=500`, requesting fields `summary,description,priority,status,assignee,created,resolutiondate,components,labels,issuetype`; step 4: iterate issues, extract fields using helpers from T008, call upsert for each issue (depends on T008)
- [x] T010 [US1] Implement locally-resolved ticket protection in the upsert block inside services/jira_service.py — when an existing `Ticket` row is found: if `local_state == "resolved"`, update only `priority`, `assignee`, `labels`, `components`, `synced_at` and skip `status`, `jira_resolved_at`, `local_state`; if not resolved, perform a full field update; track a `protected` counter for tickets that are skipped (depends on T009)
- [x] T011 [US1] Implement SLA computation in the upsert block inside services/jira_service.py — after extracting `priority` for each ticket, query `WorkspaceSlaMapping` for `(workspace_id, priority)`; if mapping found: use `jira_resolved_at` if present, else use `datetime.now(tz=UTC)`; compute `sla_compliant = elapsed_hours <= mapping.resolution_hours`; set `sla_target_hours = mapping.resolution_hours`; if no mapping, leave both fields as `None` without raising an error (depends on T005, T010)
- [x] T012 [US1] Implement `transition_ticket` and pending-transition loop in services/jira_service.py — define `async def transition_ticket(jira_key, transition_id, jira_url, jira_email, jira_token)` that calls `POST /rest/api/3/issue/{jira_key}/transitions` with `{"transition": {"id": transition_id}}`; after the main DB commit in `poll_jira_tickets`, query all tickets with non-null `pending_transition` for the workspace; call `transition_ticket` for each; on success clear `pending_transition` and commit; on failure log a warning and retain `pending_transition` for retry next cycle; return the count of synced tickets (depends on T011)

**Checkpoint**: `poll_jira_tickets` is fully functional and can ingest Jira tickets end-to-end via direct function call

---

## Phase 4: User Story 2 — Credential Validation & API Router (Priority: P2)

**Goal**: Expose polling as `POST /api/jira/poll` and ticket listing as `GET /api/jira/tickets`; surface credential and project validation failures as HTTP 400 responses that reference only `workspace_id`, never Jira credentials.

**Independent Test**: POST /api/jira/poll with invalid credentials returns 400 with `workspace_id` in detail and no token; POST with valid credentials returns 200 `{"synced": N, "protected": M}`; GET /api/jira/tickets returns paginated list scoped to `workspace_id`.

### Implementation for User Story 2

- [x] T013 [US2] Create routers/jira.py — `APIRouter` with `POST /poll` endpoint: accept `JiraConfig` body, call `await poll_jira_tickets(...)`, return `{"synced": count, "protected": protected_count}`; catch `RuntimeError` raised by credential/project validation and re-raise as `HTTPException(status_code=400, detail=str(e))`; ensure `jira_token` never appears in `detail` strings; catch unexpected exceptions and raise `HTTPException(status_code=500, detail="internal server error")` (depends on T006, T012)
- [x] T014 [US2] Add `GET /tickets` endpoint to routers/jira.py — query parameters: `workspace_id: str` (required), `status: str | None = None`, `local_state: str | None = None`, `limit: int = 100` (max 500), `offset: int = 0`; build SQLAlchemy query against `Ticket` filtered by `workspace_id` and optional params; return `{"tickets": [TicketOut.model_validate(t) for t in rows]}` (depends on T007, T013)
- [x] T015 [US2] Register jira router in app.py — add `from routers.jira import router as jira_router` import and `app.include_router(jira_router, prefix="/api/jira", tags=["jira"])` call; preserve all existing app.py content (depends on T013)

**Checkpoint**: Both REST endpoints are reachable; credential failures return 400 without leaking credentials in response bodies or logs

---

## Phase 5: User Story 3 — Bidirectional Sync Tests (Priority: P3)

**Goal**: Verify `transition_ticket` pushes local state changes to Jira and that the full poll→transition loop works end-to-end; provide unit and integration test coverage for all acceptance scenarios across US1 and US2.

**Independent Test**: Seed a ticket with non-null `pending_transition`, trigger poll, assert `POST /rest/api/3/issue/{key}/transitions` was called and `pending_transition` is cleared on success; assert `pending_transition` is retained and warning is logged on failure.

### Implementation for User Story 3

- [x] T016 [P] [US3] Create tests/test_jira_service.py — pytest unit tests using `pytest-asyncio` and `unittest.mock.patch` / `respx` to mock `httpx.AsyncClient`: (a) `_extract_jira_description` with ADF dict input, plain string input, and None input; (b) `_map_jira_state` for known Jira status names and unknown fallback; (c) `_map_jira_priority` for known/unknown priority names; (d) `poll_jira_tickets` success path — mock `/myself` 200, `/project/PROJ` 200, `/search` 200 with 2-issue payload, assert return value equals 2 and tickets exist in in-memory SQLite; (e) locally-resolved protection — pre-seed a resolved ticket, run poll, assert `local_state` unchanged; (f) `transition_ticket` success — mock `/transitions` 204, assert `pending_transition` cleared; (g) `transition_ticket` failure — mock `/transitions` 400, assert `pending_transition` retained and `logger.warning` called (depends on T012)
- [x] T017 [P] [US3] Create tests/test_jira_router.py — pytest integration tests using `fastapi.testclient.TestClient` with in-memory SQLite DB override via `app.dependency_overrides`: (a) POST /api/jira/poll success returns 200 `{"synced": N, "protected": M}`; (b) POST /api/jira/poll with invalid credentials (mocked `/myself` 401) returns 400 with `workspace_id` in detail, token absent from response; (c) POST /api/jira/poll with valid credentials but inaccessible project (mocked `/project` 403) returns 400; (d) POST /api/jira/poll with missing `jira_project` field returns 422; (e) GET /api/jira/tickets with valid `workspace_id` returns 200 with ticket list; (f) GET /api/jira/tickets with `status` and `local_state` filters returns only matching tickets (depends on T014, T015)

**Checkpoint**: All acceptance scenarios from spec.md are covered by passing tests

---

## Dependencies

```
T001
├── T002 [P]  (requirements.txt — parallel with T003)
└── T003 [P]  (.env.example — parallel with T002)
    ↓
T004 [P] ──┐
T005 [P] ──┤  (all four parallel after T001)
T006 [P] ──┤
T007 [P] ──┘
    ↓
T008 → T009 → T010 → T011 → T012   (US1 service chain — sequential)
    ↓
T013 → T014 → T015                  (US2 router chain — sequential)
    ↓
T016 [P] ──┐  (parallel after T015)
T017 [P] ──┘
```

## Parallel Execution Examples

**Phase 2** (all four tasks after T001 completes):
```
T004 (models/ticket.py) ‖ T005 (models/workspace.py) ‖ T006 (schemas/jira_config.py) ‖ T007 (schemas/ticket.py)
```

**Phase 1 partial** (after T001):
```
T002 (requirements.txt) ‖ T003 (.env.example)
```

**Phase 5** (both after T015 completes):
```
T016 (tests/test_jira_service.py) ‖ T017 (tests/test_jira_router.py)
```

## Implementation Strategy

**MVP Scope** (deliver first): Phase 1 + Phase 2 + Phase 3 — `poll_jira_tickets` works end-to-end from a Python REPL or script; no HTTP endpoints required to validate the core ingestion loop.

**Increment 2**: Phase 4 — REST API exposed; operators can trigger polls via `curl POST /api/jira/poll`.

**Increment 3**: Phase 5 — full test coverage of all acceptance scenarios including bidirectional sync.

**Suggested start sequence**: T001 → T002+T003 (parallel) → T004+T005+T006+T007 (parallel) → T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016+T017 (parallel)

# API Contract: Jira Integration Endpoints

**Feature**: 001-jira-integration | **Date**: 2026-05-14  
**Router file**: `routers/jira.py`  
**Base path**: `/api/jira`

---

## Endpoint 1 — Trigger Poll Cycle

### `POST /api/jira/poll`

Triggers a single Jira polling cycle for the supplied credentials and project. Validates credentials, fetches up to 500 tickets, upserts them into the local DB, computes SLA compliance, and applies any pending Jira status transitions.

---

#### Request

**Content-Type**: `application/json`

**Body** (`JiraConfig`):

```json
{
  "jira_url":     "https://your-org.atlassian.net",
  "jira_email":   "operator@example.com",
  "jira_token":   "ATATT3x...",
  "jira_project": "PROJ",
  "workspace_id": "ws-abc123"
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `jira_url` | `string` | ✅ | Must be a valid HTTPS URL | Base URL of the Jira Cloud instance |
| `jira_email` | `string` | ✅ | Must be non-empty | Jira account email (used as Basic Auth username) |
| `jira_token` | `string` | ✅ | Must be non-empty | Jira API token (used as Basic Auth password) |
| `jira_project` | `string` | ✅ | Must be non-empty | Jira project key (e.g. `PROJ`) |
| `workspace_id` | `string` | ✅ | Must be non-empty | SpecKit workspace identifier |

**Security note**: `jira_token` is accepted in the request body but is **never** echoed back in any response, logged, or included in error messages. The field is excluded from all response serializers.

---

#### Responses

**`200 OK`** — Poll completed successfully.

```json
{
  "synced": 42,
  "protected": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `synced` | `integer` | Total tickets upserted (new + updated) |
| `protected` | `integer` | Tickets skipped for full sync because `local_state == "resolved"` |

---

**`400 Bad Request`** — Credential or project validation failed.

```json
{
  "detail": "credential validation failed for workspace ws-abc123"
}
```

```json
{
  "detail": "project access denied: PROJ"
}
```

```json
{
  "detail": "missing or empty jira_project for workspace ws-abc123"
}
```

**Note**: Error messages reference `workspace_id` only. Credentials (email, token) are never included in error detail strings.

---

**`422 Unprocessable Entity`** — Request body fails Pydantic validation (missing required field, wrong type, etc.).

```json
{
  "detail": [
    {
      "loc": ["body", "jira_url"],
      "msg": "field required",
      "type": "missing"
    }
  ]
}
```

---

**`500 Internal Server Error`** — Unexpected error during poll (e.g. DB unavailable).

```json
{
  "detail": "internal server error"
}
```

---

#### Behaviour Notes

- Polling is synchronous within the request lifecycle; the HTTP response is returned only after the full poll cycle completes.
- If credential or project validation fails, **no** tickets are fetched or written to the DB.
- If fewer than 500 tickets match the JQL, only those are returned; no error is raised.
- Transition failures (bidirectional sync) do not cause a 500; they are logged as warnings and the endpoint still returns 200 with counts.

---

## Endpoint 2 — List Synced Tickets

### `GET /api/jira/tickets`

Returns tickets that have been synced into the local database for a given workspace.

---

#### Request

**Query Parameters**:

| Parameter | Type | Required | Default | Constraints | Description |
|-----------|------|----------|---------|-------------|-------------|
| `workspace_id` | `string` | ✅ | — | Non-empty | Scope results to this workspace |
| `status` | `string` | ❌ | `null` | Any non-empty string | Filter by Jira status name (exact match) |
| `local_state` | `string` | ❌ | `null` | `"open"` or `"resolved"` | Filter by local workflow state |
| `limit` | `integer` | ❌ | `100` | 1 – 500 | Maximum number of tickets to return |
| `offset` | `integer` | ❌ | `0` | ≥ 0 | Pagination offset |

---

#### Responses

**`200 OK`** — Returns a (possibly empty) list of tickets.

```json
{
  "tickets": [
    {
      "jira_key": "PROJ-42",
      "workspace_id": "ws-abc123",
      "summary": "Login page throws 500 on empty password",
      "description": "When a user submits the login form with an empty password field the server returns HTTP 500.",
      "priority": "High",
      "status": "In Progress",
      "assignee": "Jane Smith",
      "issue_type": "Bug",
      "components": ["auth", "frontend"],
      "labels": ["regression", "security"],
      "jira_created_at": "2026-05-01T09:00:00Z",
      "jira_resolved_at": null,
      "local_state": "open",
      "sla_compliant": true,
      "sla_target_hours": 24.0,
      "synced_at": "2026-05-14T10:30:00Z"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

**`TicketOut` schema**:

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `jira_key` | `string` | No | Jira issue key |
| `workspace_id` | `string` | No | Owning workspace |
| `summary` | `string` | No | Issue summary |
| `description` | `string` | Yes | Plain-text description |
| `priority` | `string` | Yes | Jira priority name |
| `status` | `string` | No | Jira status name |
| `assignee` | `string` | Yes | Assignee display name |
| `issue_type` | `string` | Yes | Jira issue type |
| `components` | `array[string]` | Yes | Component names |
| `labels` | `array[string]` | Yes | Label strings |
| `jira_created_at` | `string (ISO 8601)` | No | Jira creation timestamp |
| `jira_resolved_at` | `string (ISO 8601)` | Yes | Jira resolution timestamp |
| `local_state` | `string` | No | `"open"` or `"resolved"` |
| `sla_compliant` | `boolean` | Yes | SLA compliance result; null if no mapping |
| `sla_target_hours` | `number` | Yes | SLA resolution target in hours |
| `synced_at` | `string (ISO 8601)` | No | Last successful sync timestamp |

**Note**: `pending_transition` is intentionally excluded from `TicketOut` — it is an internal implementation detail.

---

**`400 Bad Request`** — Missing or invalid `workspace_id`.

```json
{
  "detail": "workspace_id is required"
}
```

---

**`422 Unprocessable Entity`** — Invalid query parameter type (e.g. `limit` is not an integer).

---

## Pydantic Schema Definitions

### `JiraConfig` (input)

```python
# schemas/jira_config.py
from pydantic import BaseModel, AnyHttpUrl

class JiraConfig(BaseModel):
    jira_url: AnyHttpUrl
    jira_email: str
    jira_token: str          # excluded from all response models via model_config
    jira_project: str
    workspace_id: str

    model_config = {"json_schema_extra": {"examples": [...]}}
```

### `TicketOut` (output)

```python
# schemas/ticket.py
from datetime import datetime
from pydantic import BaseModel

class TicketOut(BaseModel):
    jira_key: str
    workspace_id: str
    summary: str
    description: str | None
    priority: str | None
    status: str
    assignee: str | None
    issue_type: str | None
    components: list[str] | None
    labels: list[str] | None
    jira_created_at: datetime
    jira_resolved_at: datetime | None
    local_state: str
    sla_compliant: bool | None
    sla_target_hours: float | None
    synced_at: datetime

    model_config = {"from_attributes": True}
```

### `PollResponse` (output)

```python
# schemas/ticket.py  (continued)
class PollResponse(BaseModel):
    synced: int
    protected: int
```

### `TicketListResponse` (output)

```python
# schemas/ticket.py  (continued)
class TicketListResponse(BaseModel):
    tickets: list[TicketOut]
    total: int
    limit: int
    offset: int
```

---

## Jira REST API Calls (internal — not exposed)

| Call | Method + URL | Purpose |
|------|-------------|---------|
| Credential validation | `GET {jira_url}/rest/api/3/myself` | Verify email + token are valid |
| Project validation | `GET {jira_url}/rest/api/3/project/{jira_project}` | Verify project exists and is accessible |
| Ticket fetch | `GET {jira_url}/rest/api/3/search/jql?jql=project+%3D+{jira_project}+ORDER+BY+created+DESC&maxResults=500&fields=summary,description,priority,status,assignee,created,resolutiondate,components,labels,issuetype` | Fetch up to 500 tickets |
| Status transition | `POST {jira_url}/rest/api/3/issue/{issueKey}/transitions` | Transition ticket status (bidirectional sync) |

All calls use **HTTP Basic Authentication** with `jira_email` as username and `jira_token` as password via `httpx.AsyncClient`.

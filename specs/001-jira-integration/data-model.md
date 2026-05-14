# Data Model: Jira Integration

**Feature**: 001-jira-integration | **Date**: 2026-05-14

---

## Overview

Two new SQLAlchemy ORM models are introduced. Both reside under `models/` and use the project's shared async SQLAlchemy engine. No raw SQL is used; all access goes through `AsyncSession`.

---

## Entity: `Ticket`

**File**: `models/ticket.py`  
**Table name**: `tickets`  
**Primary key**: `jira_key` (natural key — the Jira issue key, e.g. `PROJ-42`)

### Fields

| Column | SQLAlchemy Type | Constraints | Description |
|--------|----------------|-------------|-------------|
| `jira_key` | `String(64)` | PK, not null | Jira issue key; stable identifier across syncs |
| `workspace_id` | `String(128)` | not null, indexed | Owning workspace; scopes all queries |
| `summary` | `String(512)` | not null | Issue summary/title from Jira |
| `description` | `Text` | nullable | Plain-text description extracted from Jira (ADF or raw string) |
| `priority` | `String(64)` | nullable | Jira priority name (e.g. `High`, `Medium`) |
| `status` | `String(64)` | not null | Jira status name (e.g. `To Do`, `In Progress`, `Done`) |
| `assignee` | `String(256)` | nullable | Display name of the Jira assignee |
| `issue_type` | `String(64)` | nullable | Jira issue type (e.g. `Bug`, `Story`, `Task`) |
| `components` | `JSON` | nullable | List of component names as JSON array |
| `labels` | `JSON` | nullable | List of label strings as JSON array |
| `jira_created_at` | `DateTime(timezone=True)` | not null | `created` timestamp from Jira |
| `jira_resolved_at` | `DateTime(timezone=True)` | nullable | `resolutiondate` from Jira; null if not set |
| `local_state` | `String(64)` | not null, default `"open"` | Local workflow state; `"resolved"` marks protected tickets |
| `sla_compliant` | `Boolean` | nullable | `True`/`False` after SLA computation; null if no SLA mapping |
| `sla_target_hours` | `Float` | nullable | SLA target in hours derived from `WorkspaceSlaMapping` |
| `pending_transition` | `String(64)` | nullable | Jira transition ID to apply on next poll; null when no transition pending |
| `synced_at` | `DateTime(timezone=True)` | not null, server default `now()` | Last successful sync timestamp |

### Invariants

- `local_state == "resolved"` is a protection flag: when set, `poll_jira_tickets` MUST NOT overwrite `local_state`, `status`, or `jira_resolved_at` — only `priority`, `assignee`, `labels`, `components`, and `synced_at` are updated.
- `pending_transition` is set by the local workflow when a state change needs to be propagated back to Jira. It is cleared by `transition_ticket` on success. On failure it is retained for retry on the next polling cycle (FR-012).
- `jira_key` + `workspace_id` combination is unique in practice; `jira_key` alone is the PK because a Jira key is globally unique per Jira instance.

### Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| `ix_tickets_workspace_id` | `workspace_id` | Scoped queries per workspace |
| `ix_tickets_status` | `status` | Filter by Jira status |
| `ix_tickets_local_state` | `local_state` | Quickly locate resolved/protected tickets |

### SQLAlchemy Model Sketch

```python
# models/ticket.py
from __future__ import annotations
from datetime import datetime
from sqlalchemy import Boolean, DateTime, Float, JSON, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Ticket(Base):
    __tablename__ = "tickets"

    jira_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    summary: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(64), nullable=False)
    assignee: Mapped[str | None] = mapped_column(String(256), nullable=True)
    issue_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    components: Mapped[list | None] = mapped_column(JSON, nullable=True)
    labels: Mapped[list | None] = mapped_column(JSON, nullable=True)
    jira_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    jira_resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    local_state: Mapped[str] = mapped_column(String(64), nullable=False, default="open")
    sla_compliant: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sla_target_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    pending_transition: Mapped[str | None] = mapped_column(String(64), nullable=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
```

---

## Entity: `WorkspaceSlaMapping`

**File**: `models/workspace.py`  
**Table name**: `workspace_sla_mappings`  
**Primary key**: composite (`workspace_id`, `priority`)

### Fields

| Column | SQLAlchemy Type | Constraints | Description |
|--------|----------------|-------------|-------------|
| `workspace_id` | `String(128)` | PK component, not null | Workspace this mapping belongs to |
| `priority` | `String(64)` | PK component, not null | Jira priority name this rule applies to (e.g. `High`) |
| `response_hours` | `Float` | not null | Maximum hours from creation to first response |
| `resolution_hours` | `Float` | not null | Maximum hours from creation to resolution |

### Invariants

- This table is **read-only** from the perspective of this feature (FR-009, Assumptions). The Jira integration reads SLA mappings but never writes or modifies them.
- If no row exists for a `(workspace_id, priority)` pair, SLA compliance is not computed for that ticket — `Ticket.sla_compliant` remains `null`.

### SLA Compliance Logic

```
sla_compliant = True  if  (now - jira_created_at).total_seconds() / 3600  <=  resolution_hours
sla_compliant = False otherwise
```

When `jira_resolved_at` is available:

```
sla_compliant = True  if  (jira_resolved_at - jira_created_at).total_seconds() / 3600  <=  resolution_hours
```

### SQLAlchemy Model Sketch

```python
# models/workspace.py
from __future__ import annotations
from sqlalchemy import Float, PrimaryKeyConstraint, String
from sqlalchemy.orm import Mapped, mapped_column
from models.ticket import Base

class WorkspaceSlaMapping(Base):
    __tablename__ = "workspace_sla_mappings"
    __table_args__ = (PrimaryKeyConstraint("workspace_id", "priority"),)

    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    priority: Mapped[str] = mapped_column(String(64), nullable=False)
    response_hours: Mapped[float] = mapped_column(Float, nullable=False)
    resolution_hours: Mapped[float] = mapped_column(Float, nullable=False)
```

---

## Entity Relationships

```
WorkspaceSlaMapping (workspace_id, priority)
        │
        │ read-only lookup during SLA computation
        ▼
Ticket  (jira_key)
  ├── workspace_id     ← scoping key
  ├── priority         ← join key to WorkspaceSlaMapping
  ├── local_state      ← protection flag ("resolved" = protected)
  ├── pending_transition ← retry queue for bidirectional sync
  └── sla_compliant    ← computed result stored on ticket
```

No foreign key constraint is enforced between `Ticket.workspace_id` + `Ticket.priority` and `WorkspaceSlaMapping` — SLA mappings may be absent, and tickets without a matching mapping are stored without SLA data.

---

## State Transitions for `local_state`

```
        poll (new ticket)
             │
             ▼
          "open"  ──── local workflow resolves ──── "resolved"
             │                                          │
             │  poll (not resolved locally)             │  poll (resolved locally)
             │  full sync                               │  metadata-only sync
             ▼                                          │
          updated                                       ▼
                                                  protected (no state overwrite)
```

Valid values for `local_state`: `"open"`, `"resolved"`. Other values may be added in future specs but are not used by this feature's upsert logic.

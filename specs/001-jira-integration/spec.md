# Feature Specification: Jira Integration

**Feature Branch**: `001-jira-integration`

**Created**: 2026-05-14

**Status**: Draft

**Input**: User description: "Connect Jira with the existing FastAPI app. When a ticket is raised on Jira, fetch its description and resolve tickets automatically using SpecKit's spec-driven workflow."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Poll Jira and Sync Tickets to Local DB (Priority: P1)

A workspace operator configures Jira credentials and project key for their workspace. The system periodically polls the Jira project using a JQL query, fetches ticket details (summary, description, priority, status, assignee, dates, components, labels, issue type), and upserts those tickets into the local database. Tickets that have already been resolved locally are protected — only their metadata is refreshed, not their local state or resolution.

**Why this priority**: This is the foundational capability. Without ticket ingestion there is nothing to act on. All other stories depend on tickets being present in the local DB.

**Independent Test**: Can be fully tested by configuring valid Jira credentials, triggering `poll_jira_tickets`, and verifying that new Jira tickets appear in the local DB with accurate field values. No bidirectional sync or UI is required.

**Acceptance Scenarios**:

1. **Given** a workspace with valid Jira credentials and a project key configured, **When** `poll_jira_tickets` runs, **Then** all open tickets (up to 500) from the Jira project are upserted into the local DB with correct field values.
2. **Given** a ticket already exists in the local DB and its local state is "resolved", **When** `poll_jira_tickets` runs, **Then** only metadata fields (priority, assignee, labels, components) are updated — local state and resolution are preserved.
3. **Given** a ticket already exists in the local DB and is not locally resolved, **When** `poll_jira_tickets` runs, **Then** all fields including state and resolution are fully synced from Jira.
4. **Given** a Jira ticket whose description is in Atlassian Document Format (ADF), **When** the ticket is ingested, **Then** the plain-text content is extracted and stored (not raw ADF JSON).
5. **Given** a Jira ticket whose description is a plain string, **When** the ticket is ingested, **Then** the description is stored as-is.
6. **Given** a closed Jira ticket with no `resolutiondate` field, **When** the ticket is ingested, **Then** the ticket is stored without a resolution date (null/absent) and no error is raised.
7. **Given** the workspace has SLA mappings defined, **When** tickets are upserted, **Then** SLA compliance is computed and stored alongside each ticket.

---

### User Story 2 - Credential and Project Validation Before Polling (Priority: P2)

Before any polling begins, the system validates that the supplied Jira credentials are working and that the configured project key is accessible. If either check fails, polling is aborted with a clear error recorded in the workspace audit log, so operators know exactly why sync did not proceed.

**Why this priority**: Polling with bad credentials causes noise (repeated 401/403 failures) and wastes resources. Validating upfront provides fast, actionable feedback without cluttering logs with repeated auth errors.

**Independent Test**: Can be fully tested by calling the validation logic with intentionally bad credentials or an inaccessible project key and asserting that the appropriate error is surfaced and polling does not proceed.

**Acceptance Scenarios**:

1. **Given** a workspace configured with invalid Jira credentials (wrong email or token), **When** `poll_jira_tickets` is called, **Then** a credential validation error is recorded and no ticket fetch is attempted.
2. **Given** valid Jira credentials but a project key that does not exist or is inaccessible, **When** `poll_jira_tickets` is called, **Then** a project access error is recorded and no ticket fetch is attempted.
3. **Given** valid credentials and a valid, accessible project key, **When** `poll_jira_tickets` is called, **Then** validation passes and ticket fetching proceeds.
4. **Given** an empty or missing Jira project key configured for the workspace, **When** `poll_jira_tickets` is called, **Then** validation fails with a clear "missing project" error before any network request is made.

---

### User Story 3 - Bidirectional Sync: Transition Jira Ticket Status on Local State Change (Priority: P3)

When a ticket's local state changes (e.g., a spec-driven workflow resolves it), the system transitions the corresponding Jira ticket to the matching status so that the two systems stay in sync. This ensures Jira remains the source of truth visible to the broader team, even when resolution happens inside the FastAPI app.

**Why this priority**: Bidirectional sync closes the loop and prevents stale Jira tickets from confusing the team. It is a valuable but separable enhancement — the system still delivers value with unidirectional ingestion (P1) and safe validation (P2).

**Independent Test**: Can be fully tested by resolving a ticket locally and verifying that the corresponding Jira ticket's status is transitioned via the Jira REST API. No UI changes are required.

**Acceptance Scenarios**:

1. **Given** a ticket exists in both the local DB and Jira, **When** the local state is changed to "resolved", **Then** the system transitions the Jira ticket to the corresponding resolved status via the Jira Transitions API.
2. **Given** a ticket exists in both systems, **When** the local state change has no matching Jira transition available, **Then** the transition attempt is logged as a warning and the local state change is persisted regardless.
3. **Given** Jira is unreachable at the time of a local state change, **When** the transition attempt fails, **Then** the failure is logged, the local state is preserved, and the transition is retried on the next polling cycle.
4. **Given** a ticket that was resolved locally before bidirectional sync was enabled, **When** `poll_jira_tickets` runs, **Then** the system identifies the discrepancy and triggers a transition to align Jira with local state.

---

### Edge Cases

- What happens when the Jira project has **no tickets** matching the JQL query? → The upsert loop runs zero iterations and completes without error; no existing local tickets are removed.
- What happens when **authentication fails** (401/403 from `/rest/api/3/myself`)? → Polling is aborted immediately; the workspace error log records the credential failure; no partial state is written.
- What happens when a ticket's **description is in ADF format** (nested JSON document)? → `_extract_jira_description` recursively extracts all text nodes and concatenates them into plain text before storage.
- What happens when a **locally-resolved ticket** reappears in the Jira poll with an "open" status (e.g., ticket reopened in Jira)? → Local resolution is preserved; only metadata is updated. A flag or audit entry notes the discrepancy for manual review.
- What happens when a **closed Jira ticket has no `resolutiondate`**? → The field is stored as null/absent; no error is raised and SLA compliance is computed without a resolution date.
- What happens when the **JQL query returns more than 500 results**? → Only the first 500 results (ordered by created DESC) are processed in this polling cycle; no pagination beyond 500 is attempted in v1.
- What happens when **SLA mappings are absent** for a workspace? → Tickets are stored without SLA compliance data; no error is raised.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST poll the configured Jira project using the JQL query `project = {jira_project} ORDER BY created DESC`, fetching up to 500 results per cycle.
- **FR-002**: The system MUST fetch the following fields for each ticket: summary, description, priority, status, assignee, created, resolutiondate, components, labels, issuetype.
- **FR-003**: The system MUST extract plain text from ticket descriptions regardless of whether they are plain strings or Atlassian Document Format (ADF).
- **FR-004**: The system MUST upsert tickets into the local database — inserting new tickets and updating existing ones.
- **FR-005**: The system MUST protect locally-resolved tickets: if a ticket is already marked resolved in the local DB, only metadata fields are updated on subsequent polls.
- **FR-006**: The system MUST validate Jira credentials against `/rest/api/3/myself` before any ticket fetch is attempted.
- **FR-007**: The system MUST validate project access against `/rest/api/3/project/{jira_project}` before any ticket fetch is attempted.
- **FR-008**: The system MUST abort polling and record a structured error if credential or project validation fails.
- **FR-009**: The system MUST compute SLA compliance for each ticket using the workspace's SLA mappings when they are present.
- **FR-010**: The system MUST transition the corresponding Jira ticket status when the local ticket state changes, using the Jira Transitions API.
- **FR-011**: The system MUST log a warning and preserve local state if no matching Jira transition is available for the new local state.
- **FR-012**: The system MUST retry failed Jira status transitions on the next polling cycle.
- **FR-013**: Polling MUST be driven by the `poll_jira_tickets(workspace_id, jira_url, jira_email, jira_token, jira_project, db)` async function.

### Key Entities

- **Workspace**: Represents a SpecKit workspace; holds Jira connection configuration (URL, email, token, project key) and SLA mappings.
- **Jira Ticket (local)**: A local copy of a Jira issue; key fields include ticket ID, summary, plain-text description, priority, status, assignee, created date, resolution date, components, labels, issue type, local state, and SLA compliance.
- **SLA Mapping**: Workspace-scoped configuration that maps ticket attributes (e.g., priority) to SLA targets (e.g., response/resolution time windows).
- **Audit / Error Log Entry**: A structured record of validation failures, transition warnings, and retry events associated with a workspace polling cycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a polling cycle completes, 100% of open Jira tickets (up to 500) are present and accurate in the local DB within one polling interval.
- **SC-002**: Locally-resolved tickets retain their local state in 100% of cases across subsequent polling cycles, regardless of Jira-side status.
- **SC-003**: Credential and project validation failures are surfaced to operators within one polling cycle — no silent failures.
- **SC-004**: Plain-text description extraction succeeds for 100% of ingested tickets, whether the source format is plain text or ADF.
- **SC-005**: When a local state change triggers a Jira transition, the Jira ticket status is updated within one polling interval in the success path.
- **SC-006**: SLA compliance is computed and stored for every ticket in workspaces that have SLA mappings defined, with zero missed calculations.

## Assumptions

- Jira credentials (email + API token) are stored securely in the workspace configuration and are not exposed in logs.
- The Jira instance uses the Jira Cloud REST API v3 (Atlassian Document Format for descriptions).
- Polling interval is managed externally (e.g., a scheduler or background task runner) and is not defined by this feature.
- Pagination beyond 500 results is out of scope for v1; the JQL ordering (created DESC) ensures the most recent tickets are always ingested.
- SLA mapping configuration is managed through an existing workspace settings mechanism; this feature only reads, not writes, SLA mappings.
- Mobile or browser-based UI for viewing synced tickets is out of scope for this feature.
- The local database schema for tickets already exists or is extended by a separate migration task; this spec does not define the migration.
- Bidirectional sync (P3) assumes that Jira workflow transitions are configured in the Jira project to allow programmatic status changes.

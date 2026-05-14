import uuid
import logging
from datetime import datetime, timezone
from base64 import b64encode

import httpx
from sqlalchemy.orm import Session
from sqlalchemy import select

logger = logging.getLogger(__name__)


def _adf_node_text(node: dict) -> str:
    """Recursively extract text from an Atlassian Document Format node."""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = []
    for child in node.get("content", []):
        parts.append(_adf_node_text(child))
    return " ".join(filter(None, parts))


def _extract_jira_description(desc_field) -> str:
    """Extract plain text from Jira description (Atlassian Document Format or plain string)."""
    if not desc_field:
        return ""
    if isinstance(desc_field, str):
        return desc_field
    if isinstance(desc_field, dict):
        parts = []
        for node in desc_field.get("content", []):
            parts.append(_adf_node_text(node))
        return "\n".join(parts).strip()
    return str(desc_field)


def _parse_jira_date(date_str: str | None) -> datetime | None:
    """Parse an ISO-8601 date string from Jira into a timezone-aware datetime."""
    if not date_str:
        return None
    try:
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except ValueError:
        return None


def _map_jira_state(jira_status: str) -> str:
    """Map a Jira status name to the internal state string."""
    status_lower = jira_status.lower()
    if status_lower in ("done", "closed", "resolved", "complete", "completed"):
        return "Closed"
    if status_lower in ("in progress", "in-progress", "in_progress"):
        return "In Progress"
    return "Open"


def _map_jira_priority(jira_priority: str) -> str:
    """Map a Jira priority name to the internal priority string."""
    priority_map = {
        "highest": "Critical",
        "high": "High",
        "medium": "Medium",
        "low": "Low",
        "lowest": "Low",
        "critical": "Critical",
        "blocker": "Critical",
    }
    return priority_map.get(jira_priority.lower(), "Medium")


def _local_state_to_transition_key(state: str) -> str | None:
    """Return the Jira transition key for a given local state, or None if no transition needed."""
    mapping = {
        "Closed": "done",
        "In Progress": "in_progress",
        "Open": "open",
    }
    return mapping.get(state)


def _jira_status_matches_transition(jira_status: str, transition_key: str) -> bool:
    """Return True if the current Jira status already matches the desired transition key."""
    jira_lower = jira_status.lower()
    if transition_key == "done":
        return jira_lower in ("done", "closed", "resolved", "complete", "completed")
    if transition_key == "in_progress":
        return jira_lower in ("in progress", "in-progress", "in_progress")
    if transition_key == "open":
        return jira_lower in ("open", "to do", "todo", "backlog", "new")
    return False


async def transition_ticket(
    jira_url: str,
    jira_email: str,
    jira_token: str,
    ticket_id: str,
    target_status: str,
) -> bool:
    """Attempt to transition a Jira ticket to the given status. Returns True if successful."""
    auth_str = b64encode(f"{jira_email}:{jira_token}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth_str}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    base_url = jira_url.rstrip("/")

    async with httpx.AsyncClient(timeout=30) as client:
        transitions_resp = await client.get(
            f"{base_url}/rest/api/3/issue/{ticket_id}/transitions",
            headers=headers,
        )
        if transitions_resp.status_code != 200:
            return False
        transitions = transitions_resp.json().get("transitions", [])
        transition_id = None
        for t in transitions:
            if t.get("name", "").lower().replace(" ", "_") == target_status.lower().replace(" ", "_"):
                transition_id = t["id"]
                break
            to_name = (t.get("to") or {}).get("name", "").lower()
            if target_status.lower() in to_name or to_name in target_status.lower():
                transition_id = t["id"]
                break
        if not transition_id:
            return False
        do_resp = await client.post(
            f"{base_url}/rest/api/3/issue/{ticket_id}/transitions",
            headers=headers,
            json={"transition": {"id": transition_id}},
        )
        return do_resp.status_code in (200, 204)


async def poll_jira_tickets(
    workspace_id: uuid.UUID,
    jira_url: str,
    jira_email: str,
    jira_token: str,
    jira_project: str,
    db: Session,
) -> int:
    """Poll Jira for tickets and upsert into the tickets table with source='jira'."""
    from models.ticket import Ticket
    from models.workspace import WorkspaceSlaMapping

    auth_str = b64encode(f"{jira_email}:{jira_token}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth_str}",
        "Accept": "application/json",
    }
    base_url = jira_url.rstrip("/")

    async with httpx.AsyncClient(timeout=30) as client:
        me_resp = await client.get(f"{base_url}/rest/api/3/myself", headers=headers)
        if me_resp.status_code != 200:
            raise RuntimeError(
                "Jira authentication failed. Verify jira_email and jira_api_token for this workspace."
            )

        project_resp = await client.get(
            f"{base_url}/rest/api/3/project/{jira_project}",
            headers=headers,
        )
        if project_resp.status_code != 200:
            raise RuntimeError(
                f"Jira project access failed for '{jira_project}'. Ensure project key is correct and account has Browse Projects permission."
            )

    jql = f"project = {jira_project} ORDER BY created DESC"
    url = f"{base_url}/rest/api/3/search/jql"
    params = {
        "jql": jql,
        "maxResults": 500,
        "fields": "summary,description,priority,status,assignee,created,resolutiondate,components,labels,issuetype",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=headers, params=params)
        if response.status_code != 200:
            raise RuntimeError(
                f"Jira API returned HTTP {response.status_code}: {response.text}"
            )
        data = response.json()

    issues = data.get("issues", [])
    logger.info(f"[JIRA] Fetched {len(issues)} issues from project {jira_project}")

    synced_count = 0
    pending_transitions: list[dict[str, str]] = []
    for issue in issues:
        fields = issue.get("fields", {})
        ticket_id = issue.get("key", "")

        jira_summary = fields.get("summary") or ""
        jira_description = _extract_jira_description(fields.get("description"))

        created_on = _parse_jira_date(fields.get("created"))
        resolved_on = _parse_jira_date(fields.get("resolutiondate"))

        jira_status = (fields.get("status") or {}).get("name", "open")
        state = _map_jira_state(jira_status)

        jira_priority = (fields.get("priority") or {}).get("name", "medium")
        priority = _map_jira_priority(jira_priority)

        resolution_hrs = None
        if created_on and resolved_on:
            delta = resolved_on - created_on
            resolution_hrs = round(delta.total_seconds() / 3600, 2)
        elif created_on and state == "Closed" and not resolved_on:
            resolved_on = datetime.now(timezone.utc)
            delta = resolved_on - created_on
            resolution_hrs = round(delta.total_seconds() / 3600, 2)

        sla_hrs = None
        sla_met = None
        sla_breached = None
        sla_row = db.execute(
            select(WorkspaceSlaMapping).where(
                WorkspaceSlaMapping.workspace_id == workspace_id,
                WorkspaceSlaMapping.priority == priority,
            )
        ).scalar_one_or_none()
        if sla_row and resolution_hrs is not None:
            sla_hrs = sla_row.sla_hours
            sla_met = "Yes" if resolution_hrs <= sla_row.sla_hours else "No"
            sla_breached = "No" if resolution_hrs <= sla_row.sla_hours else "Yes"

        assignee_info = fields.get("assignee") or {}
        assign_to = assignee_info.get("displayName") or None

        components = fields.get("components") or []
        application = components[0]["name"] if components else jira_project

        labels = fields.get("labels") or []
        category = labels[0] if labels else "General"

        issuetype_info = fields.get("issuetype") or {}
        assignment_group = issuetype_info.get("name") or None

        existing = db.execute(
            select(Ticket).where(
                Ticket.workspace_id == workspace_id,
                Ticket.ticket_id == ticket_id,
                Ticket.source == "jira",
            )
        ).scalar_one_or_none()
        if existing:
            locally_resolved = (
                existing.state == "Closed"
                or existing.closure_notes
                or existing.resolution_notes
                or (existing.resolved_on is not None and existing.resolution_hrs is not None)
            )
            if locally_resolved:
                existing.summary = jira_summary if jira_summary else existing.summary
                existing.description = jira_description if jira_description else existing.description
                existing.priority = priority if priority is not None else existing.priority
                existing.application = application if application is not None else existing.application
                existing.category = category if category is not None else existing.category
                existing.assignment_group = assignment_group if assignment_group is not None else existing.assignment_group
                existing.assign_to = assign_to if assign_to is not None else existing.assign_to
                if existing.resolution_hrs is None and resolution_hrs is not None:
                    existing.resolved_on = resolved_on or existing.resolved_on
                    existing.resolution_hrs = resolution_hrs
                if existing.sla_hrs is None and sla_hrs is not None:
                    existing.sla_hrs = sla_hrs
                    existing.sla_met = sla_met
                    existing.sla_breached = sla_breached
            else:
                existing.summary = jira_summary
                existing.description = jira_description
                existing.state = state
                existing.priority = priority
                existing.application = application
                existing.category = category
                existing.assignment_group = assignment_group
                existing.assign_to = assign_to
                existing.resolved_on = resolved_on
                existing.resolution_hrs = resolution_hrs
                existing.sla_hrs = sla_hrs if sla_hrs is not None else existing.sla_hrs
                existing.sla_met = sla_met if sla_met is not None else existing.sla_met
                existing.sla_breached = sla_breached if sla_breached is not None else existing.sla_breached
            effective_state = existing.state or state
        else:
            ticket = Ticket(
                id=uuid.uuid4(),
                ticket_id=ticket_id,
                summary=jira_summary,
                description=jira_description,
                priority=priority,
                state=state,
                application=application,
                assignment_group=assignment_group,
                assign_to=assign_to,
                category=category,
                created_on=created_on,
                resolved_on=resolved_on,
                resolution_hrs=resolution_hrs,
                sla_hrs=sla_hrs,
                sla_met=sla_met,
                sla_breached=sla_breached,
                source="jira",
                workspace_id=workspace_id,
            )
            db.add(ticket)
            effective_state = ticket.state or state

        transition_key = _local_state_to_transition_key(effective_state)
        if transition_key and not _jira_status_matches_transition(jira_status, transition_key):
            pending_transitions.append(
                {
                    "ticket_id": ticket_id,
                    "transition_key": transition_key,
                    "effective_state": effective_state,
                }
            )

        synced_count += 1

    db.commit()

    for item in pending_transitions:
        ticket_id = item.get("ticket_id", "")
        transition_key = item.get("transition_key", "")
        if not ticket_id:
            continue

        existing = db.execute(
            select(Ticket).where(
                Ticket.workspace_id == workspace_id,
                Ticket.ticket_id == ticket_id,
                Ticket.source == "jira",
            )
        ).scalar_one_or_none()
        if not existing:
            continue

        try:
            transitioned = await transition_ticket(
                jira_url=jira_url,
                jira_email=jira_email,
                jira_token=jira_token,
                ticket_id=ticket_id,
                target_status=transition_key,
            )
            if transitioned:
                state_after = item.get("effective_state", existing.state)
                if state_after:
                    existing.state = state_after
                    db.add(existing)
        except Exception as exc:
            logger.warning(f"[JIRA] Failed to transition {ticket_id} via '{transition_key}': {exc}")

    db.commit()
    logger.info(f"[JIRA] Synced {synced_count} tickets for workspace {workspace_id}")
    return synced_count

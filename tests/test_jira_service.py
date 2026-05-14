"""Unit tests for services/jira_service.py."""
import uuid
import pytest
import pytest_asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models.base import Base
from models.ticket import Ticket
from services.jira_service import (
    _adf_node_text,
    _extract_jira_description,
    _map_jira_state,
    _map_jira_priority,
    _jira_status_matches_transition,
    poll_jira_tickets,
)


# ---------------------------------------------------------------------------
# In-memory SQLite fixture
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    engine.dispose()


# ---------------------------------------------------------------------------
# _extract_jira_description
# ---------------------------------------------------------------------------

class TestExtractJiraDescription:
    def test_none_returns_empty(self):
        assert _extract_jira_description(None) == ""

    def test_plain_string_returned_as_is(self):
        assert _extract_jira_description("Hello world") == "Hello world"

    def test_empty_string_returns_empty(self):
        assert _extract_jira_description("") == ""

    def test_adf_dict_extracts_text(self):
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Hello"},
                        {"type": "text", "text": "world"},
                    ],
                }
            ],
        }
        result = _extract_jira_description(adf)
        assert "Hello" in result
        assert "world" in result

    def test_adf_nested_nodes(self):
        adf = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Item one"}],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        result = _extract_jira_description(adf)
        assert "Item one" in result


# ---------------------------------------------------------------------------
# _map_jira_state
# ---------------------------------------------------------------------------

class TestMapJiraState:
    def test_done_maps_to_closed(self):
        assert _map_jira_state("Done") == "Closed"

    def test_closed_maps_to_closed(self):
        assert _map_jira_state("closed") == "Closed"

    def test_resolved_maps_to_closed(self):
        assert _map_jira_state("Resolved") == "Closed"

    def test_in_progress_maps_correctly(self):
        assert _map_jira_state("In Progress") == "In Progress"

    def test_in_progress_hyphen(self):
        assert _map_jira_state("in-progress") == "In Progress"

    def test_to_do_maps_to_open(self):
        assert _map_jira_state("To Do") == "Open"

    def test_unknown_maps_to_open(self):
        assert _map_jira_state("Some Unknown Status") == "Open"


# ---------------------------------------------------------------------------
# _map_jira_priority
# ---------------------------------------------------------------------------

class TestMapJiraPriority:
    def test_high(self):
        assert _map_jira_priority("High") == "High"

    def test_blocker_maps_to_critical(self):
        assert _map_jira_priority("Blocker") == "Critical"

    def test_highest_maps_to_critical(self):
        assert _map_jira_priority("Highest") == "Critical"

    def test_medium(self):
        assert _map_jira_priority("Medium") == "Medium"

    def test_low(self):
        assert _map_jira_priority("Low") == "Low"

    def test_unknown_maps_to_medium(self):
        assert _map_jira_priority("unknown") == "Medium"


# ---------------------------------------------------------------------------
# _jira_status_matches_transition
# ---------------------------------------------------------------------------

class TestJiraStatusMatchesTransition:
    def test_done_matches_done(self):
        assert _jira_status_matches_transition("Done", "done") is True

    def test_resolved_matches_done(self):
        assert _jira_status_matches_transition("Resolved", "done") is True

    def test_open_does_not_match_done(self):
        assert _jira_status_matches_transition("Open", "done") is False

    def test_in_progress_matches_in_progress(self):
        assert _jira_status_matches_transition("In Progress", "in_progress") is True

    def test_todo_matches_open(self):
        assert _jira_status_matches_transition("To Do", "open") is True

    def test_done_does_not_match_in_progress(self):
        assert _jira_status_matches_transition("Done", "in_progress") is False

    def test_unknown_transition_key(self):
        assert _jira_status_matches_transition("Open", "unknown_key") is False


# ---------------------------------------------------------------------------
# poll_jira_tickets — success path
# ---------------------------------------------------------------------------

MOCK_ISSUES = [
    {
        "key": "PROJ-1",
        "fields": {
            "summary": "First ticket",
            "description": "Plain description",
            "priority": {"name": "High"},
            "status": {"name": "Open"},
            "assignee": {"displayName": "Alice"},
            "created": "2026-01-01T10:00:00.000+00:00",
            "resolutiondate": None,
            "components": [],
            "labels": ["backend"],
            "issuetype": {"name": "Bug"},
        },
    },
    {
        "key": "PROJ-2",
        "fields": {
            "summary": "Second ticket",
            "description": None,
            "priority": {"name": "Low"},
            "status": {"name": "Done"},
            "assignee": None,
            "created": "2026-01-02T10:00:00.000+00:00",
            "resolutiondate": "2026-01-03T10:00:00.000+00:00",
            "components": [{"name": "frontend"}],
            "labels": [],
            "issuetype": {"name": "Task"},
        },
    },
]


def _make_mock_response(status_code: int, json_data: dict):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.text = str(json_data)
    return resp


@pytest.mark.asyncio
async def test_poll_jira_tickets_success(db_session):
    workspace_id = uuid.uuid4()

    async def mock_get(url, **kwargs):
        if "/myself" in url:
            return _make_mock_response(200, {"accountId": "abc123"})
        if "/project/" in url:
            return _make_mock_response(200, {"key": "PROJ"})
        if "/search" in url:
            return _make_mock_response(200, {"issues": MOCK_ISSUES})
        return _make_mock_response(404, {})

    async def mock_post(url, **kwargs):
        if "/transitions" in url:
            return _make_mock_response(204, {})
        return _make_mock_response(404, {})

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(side_effect=mock_get)
    mock_client.post = AsyncMock(side_effect=mock_post)

    with patch("httpx.AsyncClient", return_value=mock_client):
        count = await poll_jira_tickets(
            workspace_id=workspace_id,
            jira_url="https://example.atlassian.net",
            jira_email="user@example.com",
            jira_token="token123",
            jira_project="PROJ",
            db=db_session,
        )

    assert count == 2

    from sqlalchemy import select
    tickets = db_session.execute(select(Ticket)).scalars().all()
    assert len(tickets) == 2
    ticket_ids = {t.ticket_id for t in tickets}
    assert "PROJ-1" in ticket_ids
    assert "PROJ-2" in ticket_ids


@pytest.mark.asyncio
async def test_poll_jira_tickets_auth_failure(db_session):
    workspace_id = uuid.uuid4()

    async def mock_get(url, **kwargs):
        if "/myself" in url:
            return _make_mock_response(401, {"message": "Unauthorized"})
        return _make_mock_response(200, {})

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(side_effect=mock_get)

    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(RuntimeError, match="authentication failed"):
            await poll_jira_tickets(
                workspace_id=workspace_id,
                jira_url="https://example.atlassian.net",
                jira_email="bad@example.com",
                jira_token="badtoken",
                jira_project="PROJ",
                db=db_session,
            )

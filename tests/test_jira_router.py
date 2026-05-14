"""Integration tests for routers/jira.py endpoints."""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import app
from models.base import Base
from models.ticket import Ticket
from routers.jira import get_db


# ---------------------------------------------------------------------------
# Shared in-memory SQLite setup
# ---------------------------------------------------------------------------

def _make_engine():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return engine


@pytest.fixture()
def client():
    engine = _make_engine()
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c, engine
    app.dependency_overrides.clear()
    engine.dispose()


# ---------------------------------------------------------------------------
# POST /api/jira/poll — success
# ---------------------------------------------------------------------------

def test_poll_success(client):
    test_client, engine = client

    async def fake_poll(**kwargs):
        return 3

    with patch("routers.jira.poll_jira_tickets", new=AsyncMock(side_effect=fake_poll)):
        resp = test_client.post(
            "/api/jira/poll",
            json={
                "workspace_id": str(uuid.uuid4()),
                "jira_url": "https://example.atlassian.net",
                "jira_email": "user@example.com",
                "jira_token": "tok123",
                "jira_project": "PROJ",
            },
        )

    assert resp.status_code == 200
    assert resp.json()["synced"] == 3


# ---------------------------------------------------------------------------
# POST /api/jira/poll — auth failure → 400
# ---------------------------------------------------------------------------

def test_poll_auth_failure_returns_400(client):
    test_client, _ = client

    async def fake_poll(**kwargs):
        raise RuntimeError(
            "Jira authentication failed. Verify jira_email and jira_api_token for this workspace."
        )

    workspace_id = str(uuid.uuid4())

    with patch("routers.jira.poll_jira_tickets", new=AsyncMock(side_effect=fake_poll)):
        resp = test_client.post(
            "/api/jira/poll",
            json={
                "workspace_id": workspace_id,
                "jira_url": "https://example.atlassian.net",
                "jira_email": "bad@example.com",
                "jira_token": "supersecrettoken",
                "jira_project": "PROJ",
            },
        )

    assert resp.status_code == 400
    detail = resp.json()["detail"]
    # Token must never appear in the response
    assert "supersecrettoken" not in detail


# ---------------------------------------------------------------------------
# POST /api/jira/poll — project inaccessible → 400
# ---------------------------------------------------------------------------

def test_poll_project_failure_returns_400(client):
    test_client, _ = client

    async def fake_poll(**kwargs):
        raise RuntimeError(
            "Jira project access failed for 'BAD'. Ensure project key is correct."
        )

    with patch("routers.jira.poll_jira_tickets", new=AsyncMock(side_effect=fake_poll)):
        resp = test_client.post(
            "/api/jira/poll",
            json={
                "workspace_id": str(uuid.uuid4()),
                "jira_url": "https://example.atlassian.net",
                "jira_email": "user@example.com",
                "jira_token": "tok123",
                "jira_project": "BAD",
            },
        )

    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/jira/poll — missing jira_project → 422 validation error
# ---------------------------------------------------------------------------

def test_poll_missing_field_returns_422(client):
    test_client, _ = client

    resp = test_client.post(
        "/api/jira/poll",
        json={
            "workspace_id": str(uuid.uuid4()),
            "jira_url": "https://example.atlassian.net",
            "jira_email": "user@example.com",
            "jira_token": "tok123",
            # jira_project intentionally omitted
        },
    )

    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/jira/tickets — returns ticket list
# ---------------------------------------------------------------------------

def test_list_tickets_returns_tickets(client):
    test_client, engine = client
    workspace_id = uuid.uuid4()

    Session = sessionmaker(bind=engine)
    with Session() as db:
        ticket = Ticket(
            id=uuid.uuid4(),
            ticket_id="PROJ-99",
            summary="Test ticket",
            description="A description",
            priority="High",
            state="Open",
            application="TestApp",
            category="General",
            source="jira",
            workspace_id=workspace_id,
        )
        db.add(ticket)
        db.commit()

    resp = test_client.get(f"/api/jira/tickets?workspace_id={workspace_id}")

    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["ticket_id"] == "PROJ-99"


# ---------------------------------------------------------------------------
# GET /api/jira/tickets — different workspace returns no tickets
# ---------------------------------------------------------------------------

def test_list_tickets_scoped_to_workspace(client):
    test_client, engine = client
    workspace_a = uuid.uuid4()
    workspace_b = uuid.uuid4()

    Session = sessionmaker(bind=engine)
    with Session() as db:
        ticket = Ticket(
            id=uuid.uuid4(),
            ticket_id="PROJ-1",
            summary="Workspace A ticket",
            description="",
            priority="Low",
            state="Open",
            application="App",
            category="General",
            source="jira",
            workspace_id=workspace_a,
        )
        db.add(ticket)
        db.commit()

    resp = test_client.get(f"/api/jira/tickets?workspace_id={workspace_b}")

    assert resp.status_code == 200
    assert resp.json() == []

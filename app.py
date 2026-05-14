from __future__ import annotations

import ast
import asyncio
import logging
import operator as op
import os
from dataclasses import dataclass
from typing import Any

from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# Jira background poller
# -----------------------------------------------------------------------------
# Polls Jira every 15 s.  Any newly opened ticket that is not already being
# processed gets picked up, run through the full SpecKit pipeline, and
# transitioned to Done — automatically, without any manual trigger.

_POLL_INTERVAL = 15          # seconds between polls
_in_flight: set[str] = set() # ticket IDs currently being processed


async def _resolve_ticket_background(
    jira_url: str, email: str, token: str,
    ticket_id: str, summary: str, description_raw,
) -> None:
    """Run the full SpecKit pipeline for one ticket, then remove it from _in_flight."""
    from jira_resolver import extract_description, post_comment, speckit_resolve, transition_to_done
    try:
        description = extract_description(description_raw)
        pipeline = await speckit_resolve(summary, description)
        await post_comment(jira_url, email, token, ticket_id, pipeline["comment"])
        await transition_to_done(jira_url, email, token, ticket_id)
        logger.info(
            f"[POLLER] Resolved {ticket_id} | files changed: {pipeline.get('files_changed', [])}"
        )
    except Exception as exc:
        logger.error(f"[POLLER] Failed to resolve {ticket_id}: {exc}", exc_info=True)
    finally:
        _in_flight.discard(ticket_id)


async def _poll_jira() -> None:
    """Background loop: every 15 s fetch open Jira tickets and auto-resolve new ones."""
    from jira_resolver import fetch_open_tickets

    jira_url = os.environ.get("JIRA_BASE_URL", "")
    email    = os.environ.get("JIRA_EMAIL", "")
    token    = os.environ.get("JIRA_API_TOKEN", "")
    project  = os.environ.get("JIRA_PROJECT_KEY", "")

    if not all([jira_url, email, token, project]):
        logger.warning("[POLLER] Jira env vars not set — polling disabled.")
        return

    logger.info(f"[POLLER] Started — watching project '{project}' every {_POLL_INTERVAL}s")
    while True:
        await asyncio.sleep(_POLL_INTERVAL)
        try:
            tickets = await fetch_open_tickets(jira_url, email, token, project)
            new = [t for t in tickets if t["key"] not in _in_flight]
            if new:
                logger.info(f"[POLLER] {len(new)} new ticket(s): {[t['key'] for t in new]}")
            for issue in new:
                tid    = issue["key"]
                fields = issue.get("fields", {})
                _in_flight.add(tid)
                asyncio.create_task(
                    _resolve_ticket_background(
                        jira_url, email, token,
                        tid,
                        fields.get("summary") or "",
                        fields.get("description"),
                    )
                )
        except Exception as exc:
            logger.warning(f"[POLLER] Poll cycle error: {exc}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_poll_jira())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------

app = FastAPI(title="Jira Auto-Resolver + Calculator", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ---------------------------------------------------------------------------
# Jira endpoints
# ---------------------------------------------------------------------------


class JiraIssueOut(BaseModel):
    key: str
    summary: str
    description: str
    status: str


class JiraOpenResponse(BaseModel):
    project: str
    count: int
    issues: list[JiraIssueOut]


class ResolveResponse(BaseModel):
    project: str
    resolved: int
    errors: int
    results: list[dict]


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/jira/open", response_model=JiraOpenResponse)
async def jira_open_tickets(limit: int = 50):
    """Fetch open Jira tickets directly from Jira using `.env` settings.

    This is the quickest way to validate you are pointing at the right project.
    """

    from jira_resolver import extract_description, fetch_open_tickets

    jira_url = os.environ["JIRA_BASE_URL"]
    email = os.environ["JIRA_EMAIL"]
    token = os.environ["JIRA_API_TOKEN"]
    project = os.environ["JIRA_PROJECT_KEY"]

    try:
        issues = await fetch_open_tickets(
            jira_url=jira_url,
            email=email,
            token=token,
            project=project,
            max_results=limit,
        )
    except RuntimeError as exc:
        # 502 because the upstream (Jira) failed or rejected auth.
        raise HTTPException(status_code=502, detail=str(exc))

    out: list[JiraIssueOut] = []
    for issue in issues:
        fields = issue.get("fields", {})
        out.append(
            JiraIssueOut(
                key=issue.get("key", ""),
                summary=fields.get("summary") or "",
                description=extract_description(fields.get("description")),
                status=((fields.get("status") or {}).get("name") or ""),
            )
        )

    return JiraOpenResponse(project=project, count=len(out), issues=out)


@app.post("/api/jira/resolve", response_model=ResolveResponse)
async def resolve_jira_tickets():
    """Resolve all currently open Jira tickets.

    Where do you see progress (when it takes time)?
    - Watch the uvicorn terminal logs.
    - The resolver prints:
      - "[SPECKIT] Specify → ..."
      - "[SPECKIT] Plan → ..."
      - "[SPECKIT] Tasks → ..."
      - "[SPECKIT] Implement → ..."
      from [`speckit_resolve()`](jira_resolver.py:249).

    This endpoint returns only when all tickets have been processed.
    """

    from jira_resolver import resolve_all_open_tickets

    jira_url = os.environ["JIRA_BASE_URL"]
    email = os.environ["JIRA_EMAIL"]
    token = os.environ["JIRA_API_TOKEN"]
    project = os.environ["JIRA_PROJECT_KEY"]

    try:
        results = await resolve_all_open_tickets(jira_url, email, token, project)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    resolved = sum(1 for r in results if r.get("status") == "resolved")
    errors = sum(1 for r in results if r.get("status") == "error")

    return ResolveResponse(project=project, resolved=resolved, errors=errors, results=results)
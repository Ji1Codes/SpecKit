import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from models.base import Base
from models.ticket import Ticket
from schemas.jira_config import JiraConfig
from schemas.ticket import TicketOut
from services.jira_service import poll_jira_tickets

router = APIRouter()

# ---------------------------------------------------------------------------
# Database dependency (in-memory SQLite for now)
# ---------------------------------------------------------------------------

_engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
Base.metadata.create_all(bind=_engine)
_SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


def get_db():
    db = _SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/jira/poll")
async def poll(config: JiraConfig, db: Session = Depends(get_db)):
    """Poll Jira for tickets and upsert them into the local database."""
    try:
        synced = await poll_jira_tickets(
            workspace_id=config.workspace_id,
            jira_url=config.jira_url,
            jira_email=config.jira_email,
            jira_token=config.jira_token,
            jira_project=config.jira_project,
            db=db,
        )
        return {"synced": synced}
    except RuntimeError as exc:
        # Surface credential/project validation errors as 400; never leak the token.
        detail = str(exc)
        if config.jira_token and config.jira_token in detail:
            detail = detail.replace(config.jira_token, "***")
        raise HTTPException(status_code=400, detail=detail)
    except Exception:
        raise HTTPException(status_code=500, detail="internal server error")


@router.get("/jira/tickets", response_model=list[TicketOut])
def list_tickets(
    workspace_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
):
    """Return all tickets for the given workspace."""
    rows = db.execute(
        select(Ticket).where(Ticket.workspace_id == workspace_id)
    ).scalars().all()
    return [TicketOut.model_validate(t) for t in rows]

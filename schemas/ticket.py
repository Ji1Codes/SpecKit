from pydantic import BaseModel
import uuid
from datetime import datetime
from typing import Optional


class TicketOut(BaseModel):
    id: uuid.UUID
    ticket_id: str
    summary: str
    description: str
    priority: str
    state: str
    application: str
    assignment_group: Optional[str]
    assign_to: Optional[str]
    category: str
    created_on: Optional[datetime]
    resolved_on: Optional[datetime]
    resolution_hrs: Optional[float]
    sla_hrs: Optional[float]
    sla_met: Optional[str]
    sla_breached: Optional[str]
    source: str
    workspace_id: uuid.UUID

    class Config:
        from_attributes = True

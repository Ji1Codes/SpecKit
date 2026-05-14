import uuid

from sqlalchemy import Column, String, Text, Float, DateTime
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy import types

from models.base import Base


class UUID(types.TypeDecorator):
    """Platform-independent UUID type. Uses PostgreSQL's UUID type when available,
    otherwise stores as CHAR(36)."""

    impl = types.CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID())
        return dialect.type_descriptor(types.CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        return uuid.UUID(value)


class Ticket(Base):
    __tablename__ = "tickets"

    id = Column(UUID(), primary_key=True, default=uuid.uuid4)
    ticket_id = Column(String(64), nullable=False)
    summary = Column(String(512), nullable=False, default="")
    description = Column(Text, nullable=True)
    priority = Column(String(64), nullable=True)
    state = Column(String(64), nullable=True)
    application = Column(String(256), nullable=True)
    assignment_group = Column(String(256), nullable=True)
    assign_to = Column(String(256), nullable=True)
    category = Column(String(256), nullable=True)
    created_on = Column(DateTime(timezone=True), nullable=True)
    resolved_on = Column(DateTime(timezone=True), nullable=True)
    resolution_hrs = Column(Float, nullable=True)
    sla_hrs = Column(Float, nullable=True)
    sla_met = Column(String(8), nullable=True)
    sla_breached = Column(String(8), nullable=True)
    source = Column(String(64), nullable=False, default="jira")
    workspace_id = Column(UUID(), nullable=False)
    closure_notes = Column(Text, nullable=True)
    resolution_notes = Column(Text, nullable=True)

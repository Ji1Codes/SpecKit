import uuid

from sqlalchemy import Column, String, Float, types

from models.base import Base


class UUID(types.TypeDecorator):
    """Platform-independent UUID type."""

    impl = types.CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import UUID as PG_UUID
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


class WorkspaceSlaMapping(Base):
    __tablename__ = "workspace_sla_mappings"

    id = Column(UUID(), primary_key=True, default=uuid.uuid4)
    workspace_id = Column(UUID(), nullable=False)
    priority = Column(String(64), nullable=False)
    sla_hours = Column(Float, nullable=False)

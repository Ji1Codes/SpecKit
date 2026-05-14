from pydantic import BaseModel, HttpUrl
import uuid


class JiraConfig(BaseModel):
    workspace_id: uuid.UUID
    jira_url: str  # e.g. https://yourcompany.atlassian.net
    jira_email: str
    jira_token: str  # never returned in responses
    jira_project: str  # Jira project key e.g. PROJ

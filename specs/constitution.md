# SpecKit Constitution

<!-- Sync Impact Report
Version change: N/A → 1.0.0 (initial ratification)
Added sections: Core Principles (I–VI), Governance
Templates updated: N/A (initial creation)
Deferred TODOs: None
-->

## Core Principles

### I. Spec-First Development
All features MUST start with a `spec.md` before any code is written. No implementation
may begin without an approved spec. This ensures intent is captured, reviewed, and
agreed upon before resources are spent on code.

### II. Async-First
All I/O operations — including Jira API calls and database queries — MUST use
`async`/`await`. Blocking calls on the event loop are forbidden. This guarantees the
FastAPI application remains responsive under concurrent load.

### III. Security
Jira credentials (email address, API token) MUST never appear in logs, error messages,
stack traces, or API responses. All external API calls MUST validate credentials before
fetching data. Secrets are injected via environment variables only; they are never
hard-coded or committed to version control.

### IV. Resilience
Jira polling MUST handle failures gracefully. Network errors, authentication failures,
and project-permission errors MUST raise meaningful `RuntimeError` exceptions with
descriptive messages. Errors MUST never be silently swallowed. Callers must always
be informed when an operation fails.

### V. Data Integrity
Tickets resolved locally by the SRE workflow MUST have their resolution state preserved.
A Jira sync cycle MUST NOT overwrite a locally resolved state. Local resolution takes
precedence over remote Jira state at all times.

### VI. Simplicity
Only add what is needed for the current requirement. No speculative abstractions,
no premature generalization. YAGNI (You Aren't Gonna Need It) is a first-class
constraint, not a suggestion.

## Governance

- This constitution supersedes all other practices, guidelines, and conventions in the
  project. In any conflict, the constitution wins.
- All pull requests MUST include a compliance check confirming no principle is violated.
- Amendments require a written rationale, a version bump following semantic versioning,
  and updated `Last Amended` date.
- MAJOR bump: removal or redefinition of a principle (backward-incompatible governance change).
- MINOR bump: new principle or material expansion of existing guidance.
- PATCH bump: clarifications, wording improvements, non-semantic refinements.

**Version**: 1.0.0 | **Ratified**: 2026-05-14 | **Last Amended**: 2026-05-14

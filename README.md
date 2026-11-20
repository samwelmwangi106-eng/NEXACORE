# NexaCore

NexaCore is a multi-tenant SaaS platform for independent organisations in **School, SACCO, Clinic, and Rental** industries. It is being built as a modular monolith: shared identity, tenancy, permissions, audit, and notification foundations support industry-specific modules without forcing otherwise independent organisations into a Company Group.

## Product vision

Provide organisations with a secure, auditable platform that can support their operational workflows while keeping each tenant's data and administration isolated. Industry capabilities will be built incrementally after the relevant workflows, permissions, data requirements, and operational policies are approved.

## Current capabilities

- Shared accounts, email verification, password recovery, rotating refresh sessions, and live access-token revocation checks.
- Independent organisations with tenant-scoped membership, roles, and permission enforcement.
- Separate platform-administration permissions and audited administration APIs.
- Single-use organisation invitations and a durable encrypted email outbox.
- Append-oriented audit events for sensitive platform and organisation actions.
- An initial School foundation for school settings, academic years and terms, grade levels, and class sections. It does not yet store learner or guardian records.

These capabilities are an actively developing foundation, not a production-readiness or regulatory-compliance claim. SACCO, Clinic, and Rental domain workflows, frontend, payment integrations, and AI tooling are not implemented.

## High-level architecture

```text
Browser client (not implemented)
       │ HTTPS / JSON API
       ▼
Express modular monolith
 ├── Shared identity and sessions
 ├── Organisation membership and RBAC
 ├── Separate platform administration
 ├── Audit and encrypted email outbox
 └── Industry modules (built only after scope approval)
       │ Prisma / PostgreSQL
       ▼
Tenant-scoped relational data and constraints
```

The authenticated user and active membership establish tenant access. A client-supplied organisation ID is only a selector; backend authorization and tenant-scoped queries remain mandatory. Platform grants are independent from organisation roles. No mandatory Company Group entity is used.

## Repository structure

- [`backend/`](backend/README.md) — Express API, Prisma schema and SQL migrations, workers, and tests.
- [`docker-compose.yml`](docker-compose.yml) — local PostgreSQL development service.

## Development status and safeguards

Phase 3 shared-platform foundation work and the first limited School foundation are present in the workspace. The implementation still needs broader security, concurrency, operational, and deployment review. Neon pooled-connection compatibility and production hosting are not yet verified or selected. Do not use real student, patient, financial, or other sensitive production data. No Kenyan legal or regulatory compliance has been certified.

For backend setup and its current limitations, see [`backend/README.md`](backend/README.md). Decisions that affect product behavior must be confirmed rather than inferred; see its **Open decisions and deferred risks** section.

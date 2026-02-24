# 07 — Delivery Roadmap

## Phase 0 (4 weeks): Foundation
- Auth, org model, RBAC, audit trail
- Core data model skeleton
- CI/CD + infra baseline

## Phase 1 (8 weeks): Fundraising Core
- Constituents/households/orgs
- Donations, pledges, campaigns, receipts
- Stripe/Mollie integration
- Basic finance handoff exports

## Phase 2 (8 weeks): Program & Case
- Programs, beneficiaries, enrollments
- Case notes, service delivery
- Impact indicators v1

## Phase 3 (6 weeks): Grants & Volunteer
- Grant pipeline, deliverables, reports
- Volunteer opportunities, shifts, hours

## Phase 4 (6 weeks): Migration & Hardening
- Salesforce migration toolkit
- Performance hardening, observability
- Security review + GDPR controls completion

## Acceptance gates
- < 2 weeks onboarding for pilot org
- 95%+ migration field mapping coverage for pilot NPSP org
- Monthly close export reproducible with audit trail


## Parallel stream: AI UX Research (all phases)
- Phase 0: define AI interaction principles + safety constraints
- Phase 1: test AI copilots for fundraising workflows
- Phase 2: test AI copilots for case/program workflows
- Phase 3: test AI copilots for grants/volunteer workflows
- Phase 4: harden governance, telemetry, and model fallback strategy

Deliverable each phase: validated UX findings + go/no-go for AI feature rollout.

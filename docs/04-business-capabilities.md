# 04 — Business Capabilities

> Last updated: 2026-02-24

This document maps business capabilities to platform modules, API surfaces, user roles, and underlying data entities. It is the bridge between the product scope (01) and the technical implementation.

---

## 1. Capability map

```
Libero NPO Platform
├── Party Management
│   ├── Constituent 360
│   ├── Household Management
│   ├── Organisation Management
│   └── Duplicate Detection & Merge
├── Fundraising
│   ├── Donation Processing
│   ├── Pledge & Recurring Giving
│   ├── Campaign Management
│   └── Gift Acknowledgement & Receipting
├── Grant Lifecycle
│   ├── Funder Relationship Management
│   ├── Grant Pipeline
│   └── Grant Compliance & Reporting
├── Program Delivery
│   ├── Program Catalogue
│   ├── Beneficiary Enrollment & Case Management
│   └── Service Delivery Recording
├── Volunteer Management
│   ├── Volunteer Profile & Compliance
│   ├── Shift Scheduling
│   └── Hours & Value Reporting
├── Impact Measurement
│   ├── Indicator Management
│   ├── Data Collection
│   └── Impact Dashboards
├── Finance Handoff
│   ├── Fund Accounting
│   ├── GL Export
│   └── Tax Reclaim
├── Communications
│   ├── Transactional Messaging
│   └── Bulk Email & Suppression
├── Compliance & Governance
│   ├── GDPR Tooling
│   ├── Audit Log
│   └── Data Retention
└── Platform Operations
    ├── Org Provisioning
    ├── User & Role Management
    ├── Custom Fields
    └── Integrations & Webhooks
```

---

## 2. Capability detail cards

### 2.1 Constituent 360

**Purpose**: Single source of truth for every person and organisation the NPO interacts with.

| Attribute | Detail |
|---|---|
| Primary module | `internal/constituents` |
| Key tables | `constituents`, `households`, `household_members`, `constituent_relationships`, `gdpr_consent_log` |
| API prefix | `GET/POST /v1/constituents`, `GET/POST /v1/households` |
| Roles | All authenticated roles (read); `fundraising_manager`, `data_entry`, `org_admin` (write) |
| Domain events emitted | `constituent.created`, `constituent.updated`, `constituent.merged`, `constituent.gdpr_erased` |

**Key flows**:

1. **Create constituent** — POST with deduplication check (exact email match + fuzzy name); if match found, return conflict with merge option.
2. **View 360 timeline** — single endpoint returning chronological feed of: donations, enrollments, volunteer hours, communications, notes, consent changes.
3. **Merge duplicates** — staff selects primary record; secondary's transactions re-pointed to primary; secondary soft-deleted with merge metadata.
4. **GDPR Subject Access Request** — `GET /v1/constituents/{id}/sar` returns full data export (JSON/PDF) within seconds.

**Business rules**:
- A constituent must belong to one org only (no cross-org sharing).
- `do_not_contact` flag suppresses constituent from ALL bulk sends regardless of campaign.
- Lifecycle stage auto-recalculates weekly: no donations in 18+ months → `lapsed`; total gifts > €5,000 in last 12 months → `major_donor`.

---

### 2.2 Donation Processing

**Purpose**: Accurate, auditable recording of all financial gifts.

| Attribute | Detail |
|---|---|
| Primary module | `internal/donations` |
| Key tables | `donations`, `donation_allocations`, `soft_credits`, `funds`, `receipts` |
| API prefix | `GET/POST /v1/donations`, `GET /v1/donations/{id}` |
| Roles | `fundraising_manager`, `data_entry` (write); `finance_viewer` (read) |
| Domain events emitted | `donation.created`, `donation.refunded`, `donation.gift_aid_claimed` |

**Key flows**:

1. **Manual entry** — POST with constituent_id, amount, date, campaign, fund allocation(s).
2. **Online donation (webhook)** — Stripe/Mollie sends payment webhook → API validates → creates donation + receipt + sends acknowledgement email.
3. **Batch import** — CSV upload processed async; validation report returned before commit.
4. **Refund** — PATCH status to `refunded`; original receipt voided; new credit note generated; GL line reversed.

**Business rules**:
- Fund allocations must sum to donation amount exactly.
- Anonymous donations: constituent stored (for deduplication) but `is_anonymous = true` suppresses name from all outputs.
- Gift Aid: only applicable where `constituent.addr_country = 'GB'` and `is_gift_aided = true` and constituent has provided valid declaration.
- Batch close is irreversible: once a GL batch is `posted`, donations in it cannot be modified (create correcting entry instead).

---

### 2.3 Pledge & Recurring Giving

**Purpose**: Manage multi-period giving commitments with automated payment collection.

| Attribute | Detail |
|---|---|
| Key tables | `pledges`, `pledge_installments` |
| API prefix | `GET/POST /v1/pledges` |
| Scheduled job | `process_pledge_installments` — daily 06:00 UTC |

**Installment lifecycle**:
```
scheduled → [due_date reached] → payment initiated → paid / failed
                                                            ↓ (retry ×3)
                                                          cancelled
```

**SEPA direct debit flow**:
1. Constituent signs SEPA mandate (captured via Stripe/Mollie hosted page).
2. Mandate ref stored on pledge.
3. Daily job creates installment records for due dates, initiates charge via gateway API.
4. Webhook confirms/fails; donation record created on success.
5. Failed payment: retry D+3, D+7; then pause pledge and notify fundraiser.

---

### 2.4 Campaign Management

**Purpose**: Plan, track, and measure fundraising campaigns.

| Attribute | Detail |
|---|---|
| Primary module | `internal/campaigns` |
| Key tables | `campaigns` |
| Computed metrics | From donations: `raised_total`, `donor_count`, `avg_gift`, `response_rate` (donors/mailed) |

**Campaign hierarchy example**:
```
Annual Giving 2026 (parent, goal €250,000)
├── Spring Appeal (email, goal €80,000)
├── Summer Event (event, goal €60,000)
└── Year-End Direct Mail (postal, goal €110,000)
```

ROI calculation: `(raised_total - expected_cost) / expected_cost * 100`

---

### 2.5 Grant Pipeline

**Purpose**: Track grant applications from prospect to closure with compliance dates.

| Attribute | Detail |
|---|---|
| Primary module | `internal/grants` |
| Key tables | `grants`, `grant_tranches`, `grant_deliverables` |
| API prefix | `GET/POST /v1/grants` |

**Status workflow**:
```
prospecting → applied → [awarded / rejected]
                              ↓
                           active → reporting → closed
```

**Compliance reminders** (via `send_grant_reminders` job):
- 30, 14, and 7 days before `next_report_due`
- Email to assigned grant manager + org admin
- Overdue: daily reminder until resolved

**Restricted fund tracking**: Grant award creates a restricted fund (or links to existing one). Spend against the fund tracked via `donation_allocations` and `gl_export_lines`. Restricted fund balance report shows remaining balance per grant.

---

### 2.6 Beneficiary Enrollment & Case Management

**Purpose**: Track individuals receiving services with privacy-respecting case records.

| Attribute | Detail |
|---|---|
| Primary module | `internal/programs`, `internal/beneficiaries` |
| Key tables | `enrollments`, `service_deliveries`, `case_notes` |
| Roles | `program_manager` (rw); `data_entry` (create service_deliveries, case_notes); `beneficiary` (read own, non-sensitive) |

**Sensitive data handling**:
- `case_notes.is_sensitive = true`: visible only to `program_manager`, `org_admin`; hidden from data entry and self-service portal.
- Notes locked 24 hours after creation (append-only after lock).
- Beneficiary self-service portal shows: enrolled programs, service delivery dates, non-sensitive notes only.

**Caseload view**: `GET /v1/users/{worker_id}/caseload` returns all active enrollments assigned to a worker with overdue service indicators.

---

### 2.7 Volunteer Management

**Purpose**: End-to-end volunteer lifecycle from recruitment to recognition.

**Compliance gate** (for roles requiring DBS):
```
Volunteer assigned to shift
    → Check: volunteer_profiles.dbs_expiry_date > shift.start_at
    → If expired/missing AND opportunity.requires_dbs = true → block assignment, notify coordinator
```

**Hour valuation**: `GET /v1/reports/volunteer-value?period=2025` returns total hours × NCVO standard hourly rate (£20.41 UK / configurable per org).

**Self-service portal flows**:
- Volunteer logs in via magic link (Keycloak magic link flow)
- Views upcoming shifts, confirms attendance
- Logs hours after shift (subject to coordinator approval)

---

### 2.8 Impact Measurement

**Purpose**: Move beyond outputs (what was done) to outcomes (what changed) and demonstrate social value.

**Theory of Change builder** (v2):
```
Inputs (resources, funding) → Activities (programs) → Outputs (service deliveries) → Outcomes (indicators) → Impact
```

**Dashboard export**: `GET /v1/reports/impact-dashboard?format=pdf` generates a formatted PDF suitable for annual reports and funder submissions.

**SROI helper** (v2 / NICE priority): Guided questionnaire maps indicator values to monetised proxy values from HACT UK Social Value Bank.

---

### 2.9 Finance Handoff

**Purpose**: Get donation and fund data into external accounting systems accurately.

**GL export flow**:
```
1. Finance viewer opens a GL batch (groups donations by period)
2. Reviews export preview: nominal code, amount, fund
3. Confirms batch → status: closed
4. Downloads CSV/JSON (or pushes to Xero via API)
5. Marks batch posted → donations locked
```

**Tax reclaim formats**:
| Country | Format | Schedule |
|---|---|---|
| UK | HMRC Gift Aid claim (XML) | Quarterly |
| France | Reçu fiscal (PDF per donor per year) | Annual |
| Germany | Zuwendungsbescheinigung (PDF) | Annual |
| Netherlands | ANBI-compliant donation statement | Annual |

---

### 2.10 GDPR Tooling

**Purpose**: Native compliance with EU data protection law without bespoke customisation.

**Subject Access Request (SAR) flow**:
```
1. Constituent submits SAR request (or staff creates on their behalf)
2. Request logged with 30-day deadline
3. Automated: compile all data for constituent_id across all tables
4. Generate PDF or JSON export
5. Deliver via secure download link (expires 7 days) or email
6. Log fulfillment in audit_log
```

**Erasure flow**:
```
1. Request verified (identity check documented)
2. Erasure queued (processed by daily job)
3. PII fields overwritten with '[ERASED]' / NULL
4. Consent log deleted
5. Financial records retained (legal obligation)
6. Audit record of erasure created
7. Constituent marked erased_at; excluded from all queries/exports
```

**Data retention schedule**:
| Data type | Retention | Basis |
|---|---|---|
| Donor PII | Until erasure request or 7 years from last transaction | Legitimate interest / legal |
| Donation records | 7 years minimum | Financial / legal obligation |
| Case notes | 7 years from case closure | Professional / statutory |
| Volunteer DBS records | Duration of volunteering + 3 years | Safeguarding |
| Audit logs | 7 years | Legal |
| Email sends | 2 years | Legitimate interest |
| Session data | 90 days | Session management |
| Export files | 7 days | Operational |

---

## 3. API surface summary

| Resource | Methods | Notes |
|---|---|---|
| `/v1/constituents` | GET, POST | Includes search, filter, pagination |
| `/v1/constituents/{id}` | GET, PATCH, DELETE (soft) | |
| `/v1/constituents/{id}/timeline` | GET | Chronological activity feed |
| `/v1/constituents/{id}/sar` | GET | Subject access report |
| `/v1/constituents/{id}/erasure` | POST | Queues erasure |
| `/v1/households` | GET, POST | |
| `/v1/donations` | GET, POST | |
| `/v1/donations/{id}` | GET, PATCH | |
| `/v1/donations/{id}/refund` | POST | |
| `/v1/pledges` | GET, POST | |
| `/v1/campaigns` | GET, POST | |
| `/v1/grants` | GET, POST | |
| `/v1/programs` | GET, POST | |
| `/v1/enrollments` | GET, POST | |
| `/v1/service-deliveries` | GET, POST | |
| `/v1/volunteers` | GET, POST | |
| `/v1/shifts` | GET, POST | |
| `/v1/hour-logs` | GET, POST | |
| `/v1/impact/indicators` | GET, POST | |
| `/v1/impact/readings` | GET, POST | |
| `/v1/finance/funds` | GET, POST | |
| `/v1/finance/batches` | GET, POST | |
| `/v1/reports/{report_id}` | GET | Parameterised standard reports |
| `/v1/exports` | POST | Async bulk export |
| `/v1/imports` | POST | Async bulk import |
| `/v1/webhooks` | GET, POST, DELETE | Outbound webhook registrations |
| `/v1/admin/users` | GET, POST | Org user management |
| `/v1/admin/custom-fields` | GET, POST | Custom field schema management |

---

## 4. Feature flags

Feature flags are stored in Redis (loaded from DB on startup, refreshed every 60 seconds):

| Flag | Default | Description |
|---|---|---|
| `ff.sepa_direct_debit` | off | Enable SEPA DD collection via Mollie |
| `ff.xero_integration` | off | Enable Xero GL push |
| `ff.sms_notifications` | off | Enable SMS via Twilio |
| `ff.volunteer_portal` | off | Enable volunteer self-service login |
| `ff.beneficiary_portal` | off | Enable beneficiary self-service login |
| `ff.impact_toc_builder` | off | Enable Theory of Change visual builder |
| `ff.sroi_calculator` | off | Enable SROI calculation helper |
| `ff.ai_segment_builder` | off | Enable AI-assisted constituent segmentation (v3) |

Flags settable per org by `super_admin`; some flags unlocked by plan tier.


## AI copilots by capability (UX-first)

| Capability | AI assistance opportunity | Human checkpoint | UX research metric |
|---|---|---|---|
| Constituent management | Auto-dedupe suggestions, profile enrichment hints | Merge approval | duplicate resolution time |
| Donations & pledges | Suggested coding, anomaly detection, failed payment recovery draft actions | Finance review for exceptions | reconciliation effort reduction |
| Campaigns | Draft campaign briefs/segments/messages | Campaign owner approval | time-to-launch |
| Grants | Draft grant narrative, deadline risk alerts, deliverable completeness checks | Program lead approval | on-time submission rate |
| Programs & cases | Suggested next best action, case summary generation | Case worker approval | case documentation time |
| Volunteers | Shift matching + no-show risk prediction | Coordinator approval | fill rate / no-show rate |
| Impact reporting | Auto-generate indicator narratives + outlier explanation | M&E owner approval | reporting cycle time |
| Finance handoff | Suggested GL mappings + mismatch detection | Finance sign-off | export error rate |

### UX research backlog per feature
For each capability above, define:
- Top 3 user jobs-to-be-done
- Top 3 pain points today
- AI intervention hypothesis
- Prototype test scenario
- Success criteria (time, errors, trust score)


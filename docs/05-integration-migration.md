# 05 — Integrations & Migration

> Last updated: 2026-02-24

---

## 1. Integration philosophy

Libero integrates selectively — only where the integration genuinely replaces manual work or where the external system is the authoritative source (payments, identity). All integrations are:

- **Additive**: Libero never requires an integration to function (payment can be manual; email can be SMTP)
- **Auditable**: Every inbound webhook and outbound push is logged
- **Replaceable**: integrations are behind adaptor interfaces; swapping Stripe for Mollie requires config change, not code change

---

## 2. Payment integrations

### 2.1 Stripe

**Purpose**: Credit/debit card processing, SEPA Direct Debit (EU), recurring subscriptions.

**Configuration** (per org):
```yaml
stripe:
  publishable_key: pk_live_...
  secret_key: sk_live_...        # stored encrypted in Vault / env secret
  webhook_secret: whsec_...
  sepa_enabled: true
```

**Inbound webhook events handled**:

| Stripe Event | Libero Action |
|---|---|
| `payment_intent.succeeded` | Create donation, generate receipt, enqueue acknowledgement email |
| `payment_intent.payment_failed` | Update pledge installment status to `failed`, trigger retry logic |
| `customer.subscription.created` | Confirm pledge; store `stripe_sub_id` |
| `customer.subscription.deleted` | Cancel pledge |
| `mandate.updated` | Update SEPA mandate ref on pledge |
| `charge.refunded` | Mark donation as refunded, void receipt, create GL reversal |

**Outbound API calls**:
- `POST /v1/customers` — create customer on first donation
- `POST /v1/payment_intents` — initiate one-time payment
- `POST /v1/subscriptions` — create recurring donation subscription
- `POST /v1/refunds` — process refund from Libero UI

**SEPA mandate flow**:
```
1. Fundraiser initiates mandate setup for constituent
2. Libero creates Stripe SetupIntent with payment_method_types: ['sepa_debit']
3. Constituent directed to hosted confirmation page (Stripe Elements / Payment Element)
4. Mandate confirmed → webhook → pledge.sepa_mandate_ref stored
5. Recurring charge runs automatically via Stripe Subscriptions
```

### 2.2 Mollie

**Purpose**: Alternative EU payment provider; preferred by Dutch/Belgian NPOs; native iDEAL, Bancontact, SEPA.

**Integration pattern**: identical adaptor interface to Stripe. Config selects provider:
```yaml
payment_gateway: mollie   # or: stripe
mollie:
  api_key: live_...
  webhook_url: https://api.libero.app/v1/webhooks/mollie/{org_id}
```

**Mollie-specific events handled**:

| Mollie Event | Libero Action |
|---|---|
| `payment.paid` | Create donation |
| `payment.failed` | Update installment status |
| `subscription.canceled` | Cancel pledge |
| `mandate.created` | Store mandate reference |

---

## 3. Email integrations

### 3.1 Resend (primary — transactional)

**Purpose**: Donation receipts, acknowledgement letters, grant reminders, GDPR notifications.

```go
// Adaptor interface — both Resend and Brevo implement this
type EmailSender interface {
    Send(ctx context.Context, msg EmailMessage) (providerMsgID string, err error)
    GetDeliveryStatus(ctx context.Context, msgID string) (DeliveryStatus, error)
}
```

**Features used**:
- `POST /emails` — send transactional email
- Webhooks: `email.delivered`, `email.bounced`, `email.opened`, `email.clicked`
- Domain verification: SPF, DKIM, DMARC records per org (Libero configures on org setup)

### 3.2 Brevo (bulk / marketing email)

**Purpose**: Newsletters, campaign appeals, segmented sends to constituents.

**Bulk send flow**:
```
1. Staff builds segment query in Libero (e.g., "active donors, last gift > 12 months")
2. Segment evaluated → constituent list with opt-in status checked
3. Suppression list applied (do_not_email, unsubscribed)
4. Email batch created in Brevo via API
5. Send scheduled or immediate
6. Delivery events streamed back via webhook → stored in email_sends
7. Open/click rates shown in campaign dashboard
```

**Unsubscribe handling**:
- One-click unsubscribe link in all bulk emails (RFC 8058 List-Unsubscribe header)
- Brevo unsubscribe webhook → `constituent.do_not_email = true` + consent log entry
- Manual suppression also available via Libero UI

---

## 4. Accounting integrations

### 4.1 Xero

**Purpose**: Push summarised GL journal entries from Libero donation batches into Xero.

**Auth**: OAuth 2.0 (Xero connection); access token stored encrypted per org.

**Push flow**:
```
1. GL batch closed in Libero (status: closed)
2. Finance viewer triggers "Push to Xero" action
3. Libero maps: fund → nominal_code → Xero account code
4. POST /api.xero.com/api.xro/2.0/Journals
   {
     "JournalLines": [
       {"AccountCode": "200", "Description": "General Fund donations Mar 2026", "LineAmount": 4250.00},
       {"AccountCode": "201", "Description": "Restricted Fund - EU Grant", "LineAmount": 1500.00}
     ]
   }
5. Xero journal reference stored on gl_batch
6. Reconciliation report available: Libero totals vs Xero totals
```

**Chart of accounts mapping** (per org, configured by org admin):
```
Libero Fund Code → Xero Account Code
GEN              → 200 (General Fundraising Income)
RESTRICTED-EU    → 201 (Restricted - EU Projects)
GRANT-UKRI       → 202 (Grant Income - Research)
```

### 4.2 QuickBooks Online

**Pattern**: Identical to Xero but using QBO OAuth 2.0 and `POST /v3/company/{realmId}/journalentry`.

---

## 5. Identity integration (Keycloak)

**Purpose**: Centralised authentication and authorisation for all user types.

**Realm configuration per deployment**:
```
Realm: libero-prod
  Clients:
    - libero-web (OIDC, confidential, redirect: https://app.libero.app/*)
    - libero-api (bearer-only)
    - libero-volunteer-portal (OIDC, public, magic link enabled)
  Authentication flows:
    - Standard: email + password (MFA optional by role)
    - Admin: MFA required
    - Volunteer: magic link (passwordless)
  Identity providers (optional):
    - Google Workspace SAML (for orgs with Google Workspace)
    - Azure AD SAML (for orgs with Microsoft 365)
```

**JWT claims used by Libero API**:
```json
{
  "sub": "uuid-keycloak-user-id",
  "org_id": "uuid-libero-org-id",
  "role": "fundraising_manager",
  "email": "user@example.org",
  "name": "Jane Smith"
}
```

`org_id` and `role` are custom claims mapped from Keycloak user attributes set during user provisioning.

---

## 6. Storage integration (S3-compatible)

**Supported backends**:
- AWS S3 (managed SaaS deployment)
- MinIO (self-hosted deployment)
- Cloudflare R2 (alternative managed)

**Bucket structure**:
```
libero-{org_id}/
├── receipts/          {year}/{month}/{donation_id}.pdf       -- 7-year retention
├── exports/           {export_id}.{csv|xlsx|json}             -- 7-day TTL
├── imports/           {import_id}.csv                         -- 30-day retention
├── attachments/       {entity_type}/{entity_id}/{filename}    -- 7-year retention
└── audit-archive/     {year}/{month}/audit_log_{batch}.gz     -- Glacier after 12 months
```

**Access pattern**: All S3 access via presigned URLs generated by Libero API. No direct S3 credentials exposed to frontend clients.

---

## 7. Salesforce NPSP migration

### 7.1 Migration overview

The `libero-migrate` tool performs a structured extract-transform-load (ETL) from Salesforce NPSP to Libero.

```
See: /diagrams/migration-flow.mmd
```

**Migration phases**:

| Phase | Duration | Description |
|---|---|---|
| 0. Audit | 1–2 weeks | Analyse SF org: object counts, data quality, custom objects |
| 1. Extract | 1–3 days | Export all SF data to S3 via bulk export API |
| 2. Transform | 2–5 days | Map SF schema to Libero schema; handle custom fields |
| 3. Load dry-run | 1 day | Load to staging environment; validate counts and samples |
| 4. Reconcile | 1–2 days | Fix transform errors; sign-off from NPO |
| 5. Cutover | 1 day | Load to production; final delta from SF |
| 6. Parallel run | 2–4 weeks | Both systems live; verify data; train staff |
| 7. Decommission | 1 week | Freeze SF; archive SF export; Libero goes primary |

### 7.2 Salesforce object → Libero table mapping

| Salesforce Object | Libero Table | Notes |
|---|---|---|
| `Contact` | `constituents` (type=individual) | Map standard + custom fields |
| `Account` (Org) | `constituents` (type=organisation) | |
| `Account` (Household) | `households` + `household_members` | NPSP household model |
| `Opportunity` (donation) | `donations` | Stage = Closed Won only |
| `Opportunity` (pledge) | `pledges` + `pledge_installments` | RecordType = Pledge |
| `Campaign` | `campaigns` | |
| `CampaignMember` | `email_sends` (partial) | Used for campaign response tracking |
| `npe03__Recurring_Donation__c` | `pledges` | NPSP recurring donation object |
| `Grant__c` (if using NPSP Grants) | `grants` | Custom object — requires mapping |
| `npsp__Account_Soft_Credit__c` | `soft_credits` | |
| `Task` / `Activity` | Partial: `case_notes` or `audit_log` | Filtered by relevant record types |
| `Attachment` / `File` | `attachments` (S3) | Binary files migrated to S3 |

### 7.3 Extract

```bash
# Using Salesforce Bulk API 2.0
./libero-migrate extract \
  --sf-instance https://example.my.salesforce.com \
  --sf-client-id ... \
  --sf-client-secret ... \
  --objects Contact,Account,Opportunity,Campaign,npe03__Recurring_Donation__c \
  --output s3://libero-migration-bucket/org-greenpeace-de/extract/

# Output: one JSONL file per SF object, e.g. Contact.jsonl (1 record per line)
```

### 7.4 Transform

The transform step is a Go program that:
1. Reads SF JSONL files
2. Applies field mapping rules (configured in `migration-config.yaml`)
3. Deduplicates by email (fuzzy match + exact match pass)
4. Resolves relationships (Contact.AccountId → constituent.org_id)
5. Validates against Libero data model constraints
6. Outputs Libero-ready JSONL + a `transform-report.json`

**`migration-config.yaml` excerpt**:
```yaml
org_id: "018e1234-abcd-7000-8000-000000000001"
country_code: "DE"
currency_code: "EUR"
default_fund: "GEN"

field_mappings:
  Contact:
    FirstName: constituent.first_name
    LastName: constituent.last_name
    Email: constituent.email_primary
    Phone: constituent.phone_primary
    npe01__PreferredPhone__c: constituent.phone_mobile
    npsp__Do_Not_Contact__c: constituent.do_not_contact
    npsp__Opt_Out__c: constituent.do_not_email
    # Custom fields → JSONB
    My_Custom_Field__c: constituent.custom_fields.legacy_id

  Opportunity:
    Amount: donation.amount
    CloseDate: donation.received_date
    npe01__Payment_Method__c: donation.payment_method
    CampaignId: donation.campaign_id  # resolved to new campaign UUID
    Fund__c: donation.fund_id         # custom field → fund code lookup

deduplicate:
  Contact:
    strategy: email_then_fuzzy_name
    fuzzy_threshold: 0.85
    on_conflict: flag_for_review      # flag_for_review | auto_merge | skip_secondary
```

### 7.5 Load (dry-run and production)

```bash
# Dry-run: load to staging DB, produce validation report
./libero-migrate load \
  --env staging \
  --input s3://libero-migration-bucket/org-greenpeace-de/transform/ \
  --dry-run \
  --report-output ./migration-report.html

# Production load (after NPO sign-off on dry-run report)
./libero-migrate load \
  --env production \
  --input s3://libero-migration-bucket/org-greenpeace-de/transform/ \
  --confirm

# Delta load (catches donations/contacts created during parallel run)
./libero-migrate delta \
  --sf-since 2026-02-01T00:00:00Z \
  --env production
```

### 7.6 Data quality checks (automated)

| Check | Pass criteria |
|---|---|
| Constituent count match | Libero count ≥ SF count − known_duplicates_merged |
| Donation total match | SUM(libero.donations.amount) = SUM(sf.Opportunity.Amount) ± 0.01% |
| Pledge count match | Exact match on active recurring donations |
| Orphan donations | 0 donations with missing constituent_id |
| Email uniqueness | 0 duplicate email_primary per org |
| Fund allocation integrity | 0 donations where SUM(allocations) ≠ amount |
| No future receipts | 0 donations with received_date > migration date |

### 7.7 Rollback

If production load fails or critical data quality issue discovered:

```bash
# Rollback: truncate all tenant data for org and restore pre-load snapshot
./libero-migrate rollback --org-id 018e1234-abcd-7000-8000-000000000001

# Libero takes a DB snapshot immediately before every production load
# Snapshot retained for 30 days post-migration
```

---

## 8. Inbound donation forms (Stripe/Mollie hosted)

For NPOs who want a web donation form before building a bespoke integration:

```
1. NPO creates a "Donation Page" in Libero (campaign, fund, suggested amounts)
2. Libero generates a hosted Stripe Payment Link or Mollie Checkout Link
3. Link embedded on NPO website or sent in email
4. Donor completes payment on hosted page
5. Webhook → Libero creates donation, constituent (if new), receipt
6. Confirmation email sent to donor
```

This is a stopgap until the NPO integrates Libero's `/v1/donations` API with their own website.

---

## 9. Webhooks (outbound from Libero)

NPO admins can register endpoints for domain events:

```
POST /v1/webhooks
{
  "url": "https://example.org/libero-events",
  "events": ["donation.created", "constituent.created", "grant.deadline_approaching"],
  "secret": "whsec_generated_by_libero"
}
```

**Delivery guarantees**: At-least-once. Retry schedule: 1s, 5s, 30s, 5m, 30m, 2h, 8h (7 attempts). After 50 consecutive failures → webhook disabled.

**Payload format** (CloudEvents 1.0):
```json
{
  "specversion": "1.0",
  "type": "org.libero.donation.created",
  "source": "https://api.libero.app/v1/orgs/{org_id}",
  "id": "uuid-v7",
  "time": "2026-03-15T14:30:00Z",
  "datacontenttype": "application/json",
  "data": {
    "donation_id": "...",
    "constituent_id": "...",
    "amount": 150.00,
    "currency": "EUR",
    "campaign_id": "...",
    "received_date": "2026-03-15"
  }
}
```

---

## 10. Third-party integrations roadmap

| Integration | Priority | Status | Notes |
|---|---|---|---|
| Stripe | P0 | v1 | Card + SEPA |
| Mollie | P0 | v1 | iDEAL, Bancontact, SEPA |
| Resend | P0 | v1 | Transactional email |
| Brevo | P0 | v1 | Bulk email |
| Keycloak | P0 | v1 | Auth |
| Xero | P1 | v1 (SHOULD) | GL push |
| QuickBooks | P1 | v2 | GL push |
| Twilio | P2 | v2 | SMS notifications |
| Eventbrite | P2 | v2 | Event attendees as constituents |
| Mailchimp | P3 | v3 | Email list sync (for orgs already using Mailchimp) |
| HubSpot | P3 | v3 | CRM sync for fundraising consultants |
| Microsoft 365 | P2 | v2 | SAML SSO |
| Google Workspace | P2 | v2 | SAML SSO |
| Zapier | P2 | v2 | No-code automation |

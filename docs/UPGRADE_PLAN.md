# Operations upgrade: architecture, gaps and staged plan

Status legend: **Done** (implemented and covered by automated tests) · **Partial** · **Pending** · **Unverified** (code exists, needs a live provider to prove).

## 1. Current architecture (inspected, not assumed)

Single Next.js 16 app (route handlers via `route()` in `server/http.ts`), MongoDB/Mongoose, JWT httpOnly cookie sessions, roles `owner | admin | staff`, tenant scoping by `businessId` in every query, `AuditLog`, in-memory per-IP rate limits, Twilio webhook calling (`callFlow.ts`) plus a flag-gated telephony core (SIP gateway, numbers, outbound, concurrency). Tool-based agent (`RuleBrain`/`OpenAiBrain`) with idempotent turns; manual payment approvals (no card data); knowledge/FAQ editor; evals.

| Requirement | State before this stage | Now |
|---|---|---|
| 1 Takeover buffer | Human-first ring (`ringSeconds` 5–60) then AI on busy/no-answer/after-hours; transfer attempts recorded | **Pending**: fixed 25–30 s admin setting, countdown states, live-call view |
| 2 Unique IDs / recordings | Mongo `_id` only; raw Twilio recording URL stored on the Call | **Done** (below) except export |
| 3 Agent config / prompt versions | Prompt built in code from business data; knowledge editor | **Pending** (draft/test/publish/rollback, templates, voice) |
| 4 Security | bcrypt, cookie sessions, tenant scoping, rate limits, audit | **Partial**: MFA, lockout, login history, security page done; staff permission matrix, legal-request process, DB-level isolation, backups pending |
| 5 Card payment handoff | Manual payment approvals, never takes card data | **Pending**: human transfer + provider payment links + webhooks |
| 6 Voice selection | Voice setting exists in call flow | **Pending** UI/preview |
| 7 Conversation access | Calls, transcripts, follow-ups | **Partial** (recordings + transcripts view); notes/flag on calls pending |
| 8 Confirmations (SMS/WhatsApp/email) | Email via Resend only | **Pending**: durable queue, per-channel status, SMS/WhatsApp providers |
| 9 Testing & QA Center | `npm run eval` (simulated), concurrency tests | **Pending** dashboard |
| 10 Market research | none | **Pending** |
| 11 Dashboard sections | Overview, Calls, Follow-ups, Opportunities, Knowledge, Routing, Telephony, Test agent, Settings | + Recordings, Security & privacy; others pending |

### Risks found
- Recording URLs were stored raw and could have been returned by the call API (fixed: `select:false`, never returned, host-allow-listed).
- Audit writes were best-effort; for sensitive access this is now fail-closed (`auditRequired`).
- No second factor and no per-account lockout (fixed).
- Rate limits are in-memory per instance (not shared across servers) and blocks are not stored.
- Staff roles are coarse; "manager" and "platform admin" roles do not exist yet (`admin` ≈ manager).
- Tenant isolation is enforced in application code only; no database-level enforcement.

## 2. Staged plan

1. **Security + recordings foundation (this stage, done).**
2. Call takeover: `Business`/`PhoneConfiguration.takeoverSeconds` (25–30), routing-event timeline on `Call`, live-calls API/UI with countdown states, failed-transfer fallbacks.
3. Durable job queue (`Job` collection: idempotency key, attempts, backoff, dead-letter) and notification pipeline (per-channel status, consent, history).
4. Agent configuration: versioned prompts (draft → test → publish → rollback), industry templates, voice settings.
5. Payments: human-payment handoff, provider payment links, signed webhooks, state machine.
6. Staff permission matrix, human-assistance queue, notes, data-subject requests and legal-request workflow.
7. Testing & QA Center, Market Research, System Health, Overview metrics.

Each stage keeps existing behaviour behind unchanged defaults and ships with tests.

## 3. Stage 1 delivered

**Identity / recordings** — `Call.callUuid` (UUIDv4); `Recording` collection with `recordingId` (UUIDv4), tenant, call, duration, status, consent-announced flag, flag, retention date, storage reference (never returned). Webhook registration is idempotent and only accepts `api.twilio.com`. Search by Recording ID, Call ID, phone (permissioned) and date; filters completed/missed/transferred/failed/flagged. Playback is two-step: an audited, permission-checked request issues a 5-minute HMAC link bound to the requesting user; the stream endpoint re-checks session, tenant and permission, writes the audit entry *before* sending audio (no audit → no audio), and supports Range. Only owners delete; provider-side deletion result is recorded honestly. Retention purge runs with the existing periodic job.

**Sign-in security** — per-email lockout (5 failures/15 min, also for unknown emails), login history, TOTP two-step (RFC 6238, replay-proof, encrypted secret, 10 single-use recovery codes), business policy "require two-step for owners/admins" enforced server-side, owner-controlled staff permissions (listen, see full phone), Security & privacy page (users/roles/MFA, sign-ins, recording and sensitive-data access, retention, integrations, alerts). Backup status is reported as **unknown**, never healthy by assumption.

**Not covered by this stage:** recording export (metadata/CSV), an independent security audit, legal review of recording-consent wording per state, live Twilio recording playback (tested with a fake provider only), shared (multi-instance) rate limiting.

## 4. Environment

`TELEPHONY_SECRET_KEY` (32+ chars; required for MFA and provider credentials), `JWT_SECRET` (also signs recording links), `COOKIE_SECURE=true` in production, optional `LOGIN_LOCK_THRESHOLD`, `LOGIN_LOCK_WINDOW_MS`, `RECORDING_LINK_TTL_MS`. Twilio credentials are needed to play real recordings.

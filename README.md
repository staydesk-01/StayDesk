# StayDesk AI

**Human staff answer when available. When they're busy or unavailable, StayDesk takes over the live call, so important customer calls never go to voicemail.**

One full-stack **Next.js** application: dashboard UI, API routes, Twilio webhooks, AI agent tools and MongoDB, all served from **http://localhost:3000** by a single `npm run dev`.

```
Browser ─► http://localhost:3000 (Next.js)
              ├── UI (app/…)                 dashboard, test agent, onboarding
              ├── API (app/api/…)            Route Handlers → server/controllers
              ├── Twilio webhooks (app/api/twilio/…)
              ├── AI agent + tools (server/tools, server/services/ai)
              └── MongoDB (Mongoose, one cached connection)
```

## Quick start

```bash
npm install
cp .env.example .env.local     # optional: .env.local already exists with local defaults
docker compose up -d           # only if you don't already run MongoDB on :27017
npm run seed                   # demo business: Sunrise Boutique Hotel
npm run dev
```

Open **http://localhost:3000** → "Try the demo" (owner `owner@sunrisehotel.demo` / `Demo1234!`).
Health check: **http://localhost:3000/api/health** → `{"status":"ok","service":"StayDesk AI","database":"connected"}`

Expected terminal output: `Ready`, `Local: http://localhost:3000`, `MongoDB connected`.
No other port is used. With **no API keys** everything works: a built-in rule agent answers when `OPENAI_API_KEY` is empty.

| Command | |
|---|---|
| `npm run dev` | dev server on :3000 |
| `npm run build` / `npm start` | production build / server on :3000 |
| `npm run seed` | wipe & recreate the demo business |
| `npm test` | unit + scenario + evaluation regression tests (needs MongoDB; uses `staydesk_test`, which it wipes) |
| `npm run eval` | simulated evaluation (~400 scripted conversations) in a throwaway DB → `evals/reports/latest.md` |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |

## Project structure

```
app/                     Next.js App Router
  (auth)/login, signup   onboarding/   (app)/overview, calls, follow-ups, opportunities,
  (app)/business-knowledge, call-routing, test-agent, settings
  api/                   Route Handlers (thin: each maps a URL to a controller)
    health  dashboard  calls  follow-ups  opportunities  service-requests  business  knowledge  team
    routing  notifications  test-agent  auth
    agent/{chat, business-info, create-lead, create-request, follow-up, transfer, …}
    twilio/{incoming, status, recording, gather, dial-result, transfer-result}
    voice/[provider]
components/  hooks/  lib/  types/    UI code (lib/mongodb.ts = cached MongoDB connection)
server/                  all server-side logic (never imported by client components)
  http.ts                adapts Route Handlers to controllers: DB connect, rate limit, auth, roles, errors
  models/                User, Business, BusinessKnowledge, PhoneConfiguration, Call, CallTranscript, CallSummary,
                         FollowUp, Opportunity, ServiceRequest, Notification, AuditLog
  controllers/  middleware/  validators/  utils/
  tools/                 the 10 agent tools + registry (tenant check, permissions, validation, audit trail)
  services/              ai/ (agent engine, OpenAI + rule brains), calls/, telephony/, notifications/, business/
  seed/                  demo data
instrumentation.ts       connects MongoDB at boot   proxy.ts   redirects signed-out visitors to /login
tests/                   vitest: calls the real route handlers
```

## Environment variables

Local development needs only `MONGODB_URI` and `NEXT_PUBLIC_APP_URL` (already in `.env.local`). Full documented list: `.env.example`.

| Variable | When | Purpose |
|---|---|---|
| `MONGODB_URI` | always | MongoDB / Atlas connection string |
| `NEXT_PUBLIC_APP_URL` | always | This app's public URL (email links, Twilio callbacks) |
| `JWT_SECRET` | **production** | ≥32 random chars, signs session cookies |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | optional | LLM agent + AI summaries (else built-in rule agent) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | real calls | Webhook verification, REST calls; seed attaches the number to the demo business |
| `PUBLIC_BASE_URL` | rarely | Override if Twilio reaches a different URL than `NEXT_PUBLIC_APP_URL` |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | Email alerts |
| `AGENT_TOOL_SECRET`, `VOICE_*`, `RETELL_API_KEY`, `VAPI_WEBHOOK_SECRET` | optional | External voice agents (experimental) |

Secrets are read server-side only; only `NEXT_PUBLIC_*` values reach the browser. MongoDB is only touched from server code.

## Using the app

1. **Test your agent** (`/test-agent`): text conversation with live transcript, detected intent, tool actions and summary. No phone needed. Also an API: `POST /api/agent/chat {"message": "I need an appointment tomorrow", "sessionId"?}` → `{response, intent, action, sessionId}`.
2. **Business knowledge**: everything the agent may say (hours, services, prices, FAQs, policies, escalation number). Saved to MongoDB; the agent answers only from it.
3. **Call routing**: Mode A (new Twilio number) / Mode B (existing number + carrier forwarding), human-first, ring seconds, no-answer/busy/after-hours/overflow → AI, AI-only, transfer destination.
4. **Call activity, Follow-ups, Opportunities**: every call with transcript/summary/actions; tasks for staff; *Potential Opportunity Value* vs *Verified Revenue* (only staff-confirmed).
5. The dashboard refreshes itself every ~10 s (polling; a single Next app has no persistent WebSocket server).

## Twilio (after the test agent works)

1. Buy a voice-capable Twilio number; put SID/token in `.env.local`.
2. **Call routing** page → enter the number → Save (calls are matched to the business by it).
3. Expose the app: `ngrok http 3000`, set `NEXT_PUBLIC_APP_URL=https://<id>.ngrok-free.app`, restart `npm run dev`. (Keep browsing the dashboard on localhost:3000.)
4. Twilio Console → number → Voice: **A call comes in** → `POST https://<id>.ngrok-free.app/api/twilio/incoming`; **Call status changes** → `POST …/api/twilio/status`.
5. Call the number. Scenarios: AI-only mode; human-first with no answer (→ `no_answer`); decline (→ `busy`); mark today closed (→ `after_hours`); ask the AI for "a real person" (rings your mobile; if unanswered the AI resumes and a follow-up is created).

Existing business number (Mode B): keep your number, forward **busy/no-answer** to the Twilio number (GSM codes `**67*NUMBER#` busy, `**61*NUMBER#` no-answer, `##002#` cancel; they vary by carrier). Every call arriving on the Twilio number is then treated as overflow. The Call routing page explains this with a diagram.

> Honest status: webhook, TwiML and signature logic are covered by automated tests that sign requests exactly like Twilio, and the full flow works in the test console. A live PSTN call needs your Twilio credentials, so it has not been exercised here.

## The AI never touches the database directly

Every action goes through `runTool()` (`server/tools/registry.ts`): tenant check (the call must belong to that business), state/permission checks, Zod validation, backend logic, structured JSON result, and an audit trail on the call. Tools: `get_business_info`, `check_availability`, `create_booking_or_lead`, `create_service_request`, `lookup_existing_customer`, `request_human_transfer`, `create_follow_up`, `send_confirmation`, `save_call_summary`, `send_owner_alert`. External agents reach the same code at `POST /api/agent/*` with header `x-agent-secret`; the tenant always comes from the `callId`'s Call record, never the request body.

Voice: default is built in (Twilio speech-to-text → agent → Polly voice). Retell/Vapi adapters (`server/services/ai/voice`) are experimental and unverified against live accounts; OpenAI Realtime can be added as another provider.

## API summary

`/api/health` · `/api/auth/{signup,login,logout,me}` · `/api/dashboard` · `/api/payment-approvals` (+`/:id`) · `/api/reservations` · `/api/inventory` · `/api/evaluation` · `/api/calls` (+`/:id`, `/:id/transcript`) · `/api/follow-ups` (+`/:id`) · `/api/opportunities` · `/api/service-requests` · `/api/business` · `/api/knowledge` · `/api/team` · `/api/routing` · `/api/notifications` · `/api/test-agent/*` · `/api/agent/chat` · `/api/agent/{business-info,check-availability,create-lead,create-request,lookup-customer,follow-up,transfer,send-confirmation,save-summary,owner-alert}` · `/api/twilio/{incoming,status,recording,gather,dial-result,transfer-result}` · `/api/voice/[provider]`.
Dashboard routes require the session cookie and are scoped to the caller's `businessId`; settings, routing, team and deletions need `owner`/`admin`.

## Security & privacy

httpOnly session cookie + bcrypt; roles; every query scoped by `businessId` (cross-tenant ids return 404); Twilio signatures verified (`403` otherwise); zod validation; generic error responses; secrets redacted from logs; per-IP rate limits (in-memory); security headers via `next.config.ts`; recording **off by default** with consent message; transcript retention purge; delete a call or transcript.

## Deployment (later)

Vercel (or any Node host) runs this single app; use MongoDB Atlas. Set `MONGODB_URI`, `JWT_SECRET`, `NEXT_PUBLIC_APP_URL=https://app.yourdomain.com`, `TWILIO_*`, `OPENAI_API_KEY`, `RESEND_API_KEY`, then point Twilio webhooks at `https://app.yourdomain.com/api/twilio/*`. In-memory rate limits are per instance.

## Update notifications

When a newer deployment goes live, signed-in users see a small bottom-right notice ("StayDesk Update Available") with **Update & Restart**, **Later** and a close button.

- **Detection is real.** Each build is stamped with a deployment id at build time: `APP_BUILD_ID`, else `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_DEPLOYMENT_ID` or `SOURCE_VERSION`, else a unique per-build stamp. It is baked into both the browser bundle and the server. `GET /api/app-version` (public, uncached, no database) returns `{ version, buildId }`. A tab compares the build it loaded with the server's every 60 s and when it regains focus (never more than once per 15 s); failed checks are ignored.
- **Update & Restart** reloads the current page (same route, same session cookie). It never restarts a server. It is blocked while a call is live (test console), and asks for confirmation when a form has unsaved edits.
- **Later** hides the notice for that build for the rest of the browser session; a newer build or a new session shows it again.
- No service worker or PWA is used, so there is no competing update logic. Next.js itself also does a full page load if you click a link after a new deploy; that is its built-in version-skew protection.

## Autonomous reservations, payments and safety

The same agent (no second agent) can now finish work, not just take messages:

- **Reservations (hotels).** `check_availability` reads live inventory; `create_reservation`, `modify_reservation`, `cancel_reservation` and `lookup_reservation` go through a `BookingProvider` (built-in MongoDB provider with atomic per-night room counts, so two callers can never take the last room). The agent says "confirmed" only after reading the reservation back from the booking system, and reads out the real code (`SD-XXXXXX`). Changes and cancellations require the caller to match the reservation (phone or last name). If the booking system fails, the agent says so and creates a follow-up instead of pretending.
- **Payments need a human.** Payments, refunds and price adjustments become a **payment approval** (Follow-ups page; owners/admins only). The AI cannot approve, and never says a payment is done until staff mark it paid with a reference from your own payment system. Card numbers, CVV and SSNs are never requested or stored: they are redacted from transcripts and the approval schema rejects card fields. If nobody is available the request stays pending and a high-priority follow-up is created.
- **Rooms & availability** are edited in Business knowledge; the agent quotes only those rates.
- **Healthcare / privacy rules:** no clinical advice, 911 guidance for emergencies, no disclosure of appointment or patient details without verification, transcript content withheld for medical businesses.
- **AI disclosure:** the greeting identifies the agent as an AI assistant, and it answers honestly if asked.
- **Fallbacks:** unsupported requests, unclear audio (asks to repeat, then takes a callback), unavailable integrations and unexpected errors all end in an honest callback follow-up, never an invented answer.
- **Languages:** set in Business knowledge → Business. Non-English calls use the OpenAI agent (needs `OPENAI_API_KEY`); the built-in rule agent is English only.
- **Dashboard:** Overview shows an "Autonomy & reliability · live calls only" section. It counts real phone calls only; test-console and demo calls are excluded, and it shows an empty state rather than estimates.

### Evaluation (how accuracy is measured)

`npm run eval` runs ~400 scripted scenarios (information, reservations, unavailable rooms, modify/cancel, identity, payments, card data, interruptions, noisy transcripts, disconnects, tool failures, healthcare, AI disclosure, human requests) through the real agent, tools and database, and writes `evals/reports/latest.{json,md}`. Every metric has a stated numerator, denominator and pass rule (see the report), with Wilson 95% intervals. `tests/eval.test.ts` runs the same suite as a regression gate. Results also show on the Test Agent page, labelled **simulated**.

Latest run (rule agent, simulated, 276 conversations): business information 91/91, intent 120/120, tool-call correctness 153/153, reservations 79/80, invented answers 0/276, escalation correctness 192/195, call completion 276/276, failed transactions 0/382, interruption recovery 15/15, safety 101/101; agent compute latency p95 13 ms.

**This does not show 99.9% accuracy, and the project does not claim it.** Showing a failure rate below 0.1% at 95% confidence needs about 2,995 independent, representative samples per metric even with zero failures; these scenarios are synthetic, written by the developers, text-only and fewer than that. Reaching a defensible figure requires reviewing real production calls.

## Phase 1: memory, completion tracking, reliability (feature-flagged)

Flags are in `.env.example`; every one can be switched off to return to the previous behaviour.

- **Caller memory** (`FEATURE_CUSTOMER_MEMORY`): after a call, StayDesk stores a per-business profile keyed by the caller's number (call count, last intents/outcomes, a redacted first request). A phone number is not proof of identity, so the agent only learns "this number has called before": no name or past details are read back, and reservation details still need the code + last name. `FEATURE_RETURNING_GREETING` (off by default) adds "Welcome back". Medical businesses store no free text, no name and never get the greeting. Owners/admins can list (`GET /api/customers`) and erase (`DELETE /api/customers/:id`, add `?optOut=true` to stop remembering that number). Profiles never cross businesses.
- **Call-to-completion tracking** (`FEATURE_COMPLETION_TRACKING`): each call gets a record of the original request, every tool attempt (success / failed / incomplete), the real records created (reservation, payment approval, follow-up, service request, opportunity, transfer), failures, next steps, and a status (completed, answered, needs follow-up, handed to staff, abandoned, failed). It is built from stored data, not from what the agent said. Shown on the call page ("Request to result") and counted in the Overview reliability section.
- **Turn reliability** (`FEATURE_RESILIENT_TURNS`): an unexpected error in a turn now gets "could you say that again?" instead of a dropped call; after three errors the caller is told a human will call back and a high-priority follow-up is created. Each turn's full server time is recorded.
- **Speech timing** (`FEATURE_VOICE_TUNING`, off): lets you set `VOICE_SPEECH_TIMEOUT` (`auto` or 1-10 s of silence) and `VOICE_NO_INPUT_SECONDS`. Whether a value feels better can only be judged on a real call.

Measured here (local, simulated calls): server time per turn averaged about 13 ms (agent compute about 8 ms). Real call latency is dominated by speech-to-text, text-to-speech, the network and any LLM, none of which was measured.

### Conversation reliability (retries, interruptions, memory)
- **Message ids and idempotency.** Every caller message has an id and every reply a response id, stored on the transcript and used as the React key. A resent message (same id) returns the stored reply and runs nothing again; the same id arriving twice at once is processed once; turns for one call run one at a time. Different ids with identical text are separate messages, so a real repeated question is still answered. Twilio's `I-Twilio-Idempotency-Token` is honoured the same way. If Twilio sends no token, a duplicate webhook cannot be told apart from a real repeat and is processed normally.
- **Interruptions.** If the agent is waiting for a name (or other detail) and the caller asks something instead, it answers every question in the message from verified knowledge, keeps the booking, and returns with a short, differently-worded prompt. Details with no verified answer are said to be unverified; one follow-up is queued per call and it is only mentioned if it was really created.
- **Conversation state.** `agentState.facts` (name, room, dates, guests, booking status, pending question) is kept separate from the active workflow step. Booking statuses: collecting, awaiting confirmation, inquiry received, reservation confirmed, approval pending, follow-up created, failed.
- **Retried backend actions** (reservation, inquiry, follow-up, payment approval, notification) return the existing record. The Test Agent page restores an unfinished test call after a reload.

### Telephony core, SIP gateway control plane and outbound calling (feature-flagged, off by default)
New **Telephony** page (owners/admins). Provider-independent adapters (Twilio, Vapi, self-managed SIP gateway), verified number onboarding, per-tenant circuit breakers and failover, health checks and alerts, recovery callbacks, and consent/do-not-call/calling-hours enforced outbound calling. Existing Twilio inbound calling is unchanged when the flags are off. **Read [docs/TELEPHONY.md](docs/TELEPHONY.md) first:** it lists exactly what was and was not tested. No real SIP gateway, carrier, Vapi account or phone call has been exercised, the LiveKit voice worker in `staydesk-voice-agent/` is still the unmodified starter, and carrier-level failover is not provided.

### Remaining roadmap (not built yet)
Phase 2: automatic overflow/missed-call recovery (outbound callbacks) and technical fallback routing. Phase 3: reusable PMS / POS / CRM / scheduling adapter interfaces (the booking provider interface already exists). Phase 4: missed-opportunity recovery automation, appointment execution for non-hotel businesses. Phase 5: multi-location businesses. Phase 6: multilingual testing on real audio. Voice barge-in and turn-taking improvements need live-call testing.

## Known limitations

- **Live voice is unverified.** Speech-to-text, text-to-speech, barge-in, accents and noise were not exercised: that needs real calls through your Twilio account. The evaluation feeds text only.
- The OpenAI brain is non-deterministic and has not been evaluated; only the built-in rule agent was.
- Bookings run against StayDesk's built-in inventory, not a third-party PMS. Payments are manual (staff process them in their own system); no payment processor is integrated.
- Four simulated scenarios still fail (a parking question escalating unnecessarily, one noisy-audio booking, and two escalation edge cases); they are listed in the report.
- Built-in auth (JWT), not Clerk; the swap point is `server/middleware/auth.ts`. No password reset yet.
- No push updates (polling). SMS alerts not exposed. Telnyx is a stub. Call recording stores a reference only.

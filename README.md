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
| `npm test` | 59 tests (needs MongoDB; uses `staydesk_test`, which it wipes) |
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

`/api/health` · `/api/auth/{signup,login,logout,me}` · `/api/dashboard` · `/api/calls` (+`/:id`, `/:id/transcript`) · `/api/follow-ups` (+`/:id`) · `/api/opportunities` · `/api/service-requests` · `/api/business` · `/api/knowledge` · `/api/team` · `/api/routing` · `/api/notifications` · `/api/test-agent/*` · `/api/agent/chat` · `/api/agent/{business-info,check-availability,create-lead,create-request,lookup-customer,follow-up,transfer,send-confirmation,save-summary,owner-alert}` · `/api/twilio/{incoming,status,recording,gather,dial-result,transfer-result}` · `/api/voice/[provider]`.
Dashboard routes require the session cookie and are scoped to the caller's `businessId`; settings, routing, team and deletions need `owner`/`admin`.

## Security & privacy

httpOnly session cookie + bcrypt; roles; every query scoped by `businessId` (cross-tenant ids return 404); Twilio signatures verified (`403` otherwise); zod validation; generic error responses; secrets redacted from logs; per-IP rate limits (in-memory); security headers via `next.config.ts`; recording **off by default** with consent message; transcript retention purge; delete a call or transcript.

## Deployment (later)

Vercel (or any Node host) runs this single app; use MongoDB Atlas. Set `MONGODB_URI`, `JWT_SECRET`, `NEXT_PUBLIC_APP_URL=https://app.yourdomain.com`, `TWILIO_*`, `OPENAI_API_KEY`, `RESEND_API_KEY`, then point Twilio webhooks at `https://app.yourdomain.com/api/twilio/*`. In-memory rate limits are per instance.

## Known limitations

- Built-in auth (JWT), not Clerk; the swap point is `server/middleware/auth.ts`. No password reset yet.
- No live availability (no PMS/calendar): bookings are inquiries staff confirm.
- No push updates (polling). SMS alerts not exposed. Telnyx is a stub. Call recording stores a reference only.

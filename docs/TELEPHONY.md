# StayDesk telephony: inspection report, architecture, and status

Everything here describes what exists **in this repository**. "Tested" means an automated test in `tests/telephony.test.ts`
(or the earlier suites) ran it against a fake provider or the real application code. **Nothing in this document has been run
against a real carrier, a real SIP gateway, Vapi or a live phone call.**

## Phase 1: what was already in the project

| Area | What exists | State |
|---|---|---|
| Twilio | `server/services/telephony/twilio.ts`, `calls/callFlow.ts`, `app/api/twilio/*` (incoming, gather, status, dial-result, transfer-result, recording) | The only working call path. Twilio does speech-to-text and Polly text-to-speech (`<Gather>` loop). Signature checks and flows are covered by tests; a live PSTN call was never made. |
| Telnyx | `telephony/telnyx.ts` | A stub that inherits Twilio's TwiML. Not usable. |
| Vapi / Retell | `server/services/ai/voice/{vapi,retell}.ts`, `app/api/voice/[provider]` | Webhook parsers for tool calls and end-of-call reports. "Experimental, not verified against a live account" in the code itself. SDK/keys not present. |
| LiveKit | `staydesk-voice-agent/` (added 2026-10-18) | The unmodified LiveKit Agents **starter template**: generic prompt, no StayDesk tools or knowledge, `npm install` never run, uses LiveKit Inference models. Not connected to StayDesk. Excluded from the root TypeScript/ESLint runs. |
| SIP / Asterisk | nothing | |
| Agent brain | `server/services/ai/*`: rule brain, OpenAI brain, workflows, guardrails, memory, idempotent turns | Reusable as-is. |
| Business data | MongoDB models: Business, BusinessKnowledge, PhoneConfiguration, Call, CallTranscript, FollowUp, Opportunity, Reservation, PaymentApproval, CustomerProfile | Reused. |

Reusable unchanged: the agent engine and tools, knowledge, reservations, payment approvals, follow-ups, notifications, auth, audit log.
New services required: a SIP/media gateway, a voice worker that talks to the StayDesk agent, and a scheduler for outbound dispatch.

## Phase 2: telephony core (built, tested with fakes)

`server/services/telephony/core/`: provider-independent types (`TelephonyEvent`, `TelephonyAdapter`), adapters, registry, health, circuit breaker, number mapping, sessions.

| Adapter | Control plane | Notes |
|---|---|---|
| `sip_gateway` | Signed HTTPS commands out (health, outbound call, hang-up); signed events in (`/api/telephony/sip/events`) | Needs an actual gateway to exist. |
| `twilio` | Health (account fetch), outbound call create, hang-up via Twilio REST | Existing inbound flow untouched. |
| `vapi` | Health, outbound call create | REST shapes follow Vapi's docs, **unverified live**. |
| `livekit` (direct) | none | Not implemented (needs `livekit-server-sdk`). LiveKit is used **through** the SIP gateway adapter. |

Carrier routing (which connection carries a call) is separate from AI model selection (`AgentProviderConfig`, model only; no UI yet).

## Phase 3: SIP gateway decision

**Choice: self-hosted LiveKit SIP** (LiveKit server + LiveKit SIP service + Redis + the voice worker).

Why not Asterisk first: the repo already contains a LiveKit Agents worker, which brings streaming STT/LLM/TTS orchestration,
adaptive interruption handling and telephony noise cancellation. LiveKit SIP bridges a SIP call straight into the room that worker joins. With Asterisk
we would also have to write and operate an ARI/AudioSocket bridge to a voice engine, one more hop and one more thing to get wrong.
Trade-off: LiveKit adds Redis and its own operational surface, and the starter's models run on LiveKit Inference (a hosted service) unless you swap in your own providers.

Separate deployables (none are in this repo's Next.js app, which stays the dashboard at its existing URL):
1. **SIP signalling + RTP**: LiveKit SIP service. Needs a public IP or correct NAT mapping, signalling ports (TLS preferred), and a UDP range for RTP. Follow LiveKit's SIP deployment guide for the exact ports and settings; restrict carrier traffic to your carrier's IP ranges.
2. **Media/room server**: LiveKit server (+ Redis).
3. **AI worker**: `staydesk-voice-agent`, changed to ask StayDesk for each reply (see below).
4. **Management interfaces** (LiveKit API, Redis, StayDesk gateway control API): private network only, HTTPS, never exposed to the internet. StayDesk refuses plain-HTTP control URLs except loopback.

What StayDesk implements for this gateway (tested with signed fake events):
- HMAC-signed events with 5-minute replay window; per-connection secret stored encrypted.
- Number → business mapping by **verified** numbers only; tenant guard (a connection can only deliver its own business's numbers).
- Per-trunk concurrency limit; rejected calls capture an emergency callback.
- Call state, termination reasons, DTMF (sequences are never stored, only masked), quality (jitter/loss/MOS) and latency fields.
- Stale-session cleanup, recovery tasks, health events and alerts.

**Not built or not testable here:** the gateway itself (LiveKit deployment, trunk credentials/IP allow-lists on the gateway, firewall/NAT rules), the worker-side events publisher, call-quality measurement (fields exist, nothing produces them yet), SIP call setup, DTMF capture, graceful drain of the worker on shutdown.

### Voice worker contract (`POST /api/voice/turn`)
Headers `x-staydesk-connection`, `x-staydesk-timestamp`, `x-staydesk-signature = HMAC-SHA256(secret, "<timestamp>.<raw body>")`.
Body `{ callId, messageId, text, turnMs? }` → `{ reply, end, transfer, late, responseId }`.
`messageId` makes retries safe; `late: true` is a holding line when the engine exceeds `VOICE_TURN_TIMEOUT_MS`, and asking again with the same `messageId` returns the stored real answer.
The worker must replace its generic LLM with a call to this endpoint. **That change to `staydesk-voice-agent` has not been made** (dependencies are not installed and could not be tested).

## Phase 4: voice orchestrator
`server/services/voice/orchestrator.ts` defines `SpeechToText`, `ConversationEngine`, `TextToSpeech` contracts. Only the conversation engine is implemented (the existing StayDesk agent, with timeouts, idempotency, redaction, measurement). STT and TTS implementations live in the worker and are not in this repo's tested code.

## Phase 5: inbound
Number onboarding with verification (code sent by SMS when an SMS provider is configured, stored hashed, 5 attempts, 15 minutes) is built and tested. Modes recorded: forwarding, direct SIP, ported, provider number; "answer all calls" vs "overflow". The carrier-side arrangement (call forwarding set-up, SIP trunking contract, number port) is yours to make: StayDesk can only record it and verify ownership. Porting is a regulated carrier process that this software does not perform.

## Phase 6: outbound
`server/services/outbound/`. Off by default at three levels: `FEATURE_OUTBOUND_CALLING`, the business switch, and per-purpose approval. Rules enforced and tested: consent or the customer's own request, do-not-call (permanent, includes opt-out spoken on the call), calling hours in the recipient's time zone (clamped to 08:00-21:00), verified caller ID, attempt limits and retries, idempotency, AI disclosure and opt-out line at the start of every call, audit trail per request, dial-time re-check of every rule.
These are conservative defaults, **not legal advice**: telemarketing, automated-voice and consent laws differ by country and state, and the business is responsible for complying. Campaign-style bulk calling is not provided.
Dispatch is by `POST /api/outbound/dispatch` with `Authorization: Bearer $CRON_SECRET` from a scheduler.

## Phase 7: reliability
Built and tested: per-tenant circuit breakers, ordered provider failover for outbound calls, health checks with offline alerts, duplicate-action prevention (idempotent bookings, follow-ups, approvals, turns), recovery tasks and emergency callback capture, stale-session cleanup, turn time-boxing.
**Not provided:** carrier-level failover. Calls only reach StayDesk if your carrier delivers them; if StayDesk or the gateway is unreachable the carrier must route elsewhere. That needs an upstream arrangement (secondary SIP destination, forwarding on failure) that must be set up and independently tested with your carrier.

## Feature flags and environment
`FEATURE_TELEPHONY_CORE`, `FEATURE_SIP_GATEWAY`, `FEATURE_OUTBOUND_CALLING` (all default off), `TELEPHONY_SECRET_KEY` (32+ chars, required to store credentials), `CRON_SECRET` (24+ chars), `VOICE_TURN_TIMEOUT_MS`, `TELEPHONY_BREAKER_THRESHOLD`, `TELEPHONY_BREAKER_COOLDOWN_MS`, `TELEPHONY_MAX_SESSION_MS`. No phone numbers or provider credentials are hard-coded.

## Test status against the requested list
| # | Scenario | Status |
|---|---|---|
| 1 | Inbound SIP | Signed event routing tested with a fake gateway. **No real SIP call.** |
| 2 | Outbound to an authorised number | Placement, answer greeting, opt-out tested with a fake Twilio client. **No real call.** |
| 3 | Simultaneous calls | Tested (parallel events, concurrency limit). |
| 4 | Number → business mapping | Tested. |
| 5 | Vapi unavailable | Failover/circuit breaker tested with fakes. |
| 6 | Voice worker unavailable | Holding reply and timeout tested; worker itself does not exist yet. |
| 7 | SIP trunk failure | Failure events → one recovery task tested. |
| 8 | Database failure | **Not tested** (no way to stop MongoDB inside the suite). Existing behaviour: webhook errors return a spoken apology rather than a drop. |
| 9 | Caller interrupts the AI | Agent-level interruptions tested earlier; **audio barge-in is the worker's job and untested.** |
| 10 | Disconnection | Tested (status events, finalisation, callback). |
| 11 | Duplicate reservation/payment attempts | Tested. |
| 12 | Secure payment handoff | No card data collected or stored; DTMF masked; tested. |
| 13 | Session cleanup / resource limits | Tested. |
| 14 | Graceful shutdown | **Not tested / not built** for gateway and worker. |

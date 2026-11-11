# Concurrent calling

One business number can carry many simultaneous, independent AI calls. This document says what is built, what was
measured, and what is **not** proven.

## How a call is admitted (`routeIncoming`)

1. Dialled number → verified business (`BusinessPhoneNumber`); a connection can only deliver its own business's numbers.
2. The unique `(connectionKind, providerCallId)` row is the claim. Duplicate or simultaneous deliveries get the first one's decision.
3. **Concurrency slot** (`ConcurrencyGate`): one atomic conditional increment. Effective limit = the lower of the business setting
   (`Business.concurrency.maxConcurrentCalls`) and the carrier trunk's `maxConcurrentCalls`.
4. **Worker slot** (`VoiceWorker`, per business): atomic claim on the least-loaded live worker. If a business has registered no
   workers the gateway is assumed to run the AI itself and this step is skipped.
5. A `Call` and an opaque `sessionKey` (`ses_…`) are created; the media room is `call-<sessionKey>` (no phone number in names or logs).

Decision returned to the gateway: `answer` (with `callId`, `sessionKey`, `room`, `workerId`), `reject`, or `transfer`.

## Lifecycle

`incoming → initializing → active → completing → completed | failed`, forward-only and atomic. Each session stores timings
(`setupMs`), duration, agent latency, `failureCause` and `workerId`. Slots are released exactly once; `reconcileGates()` repairs
counters after a crash. `reapStaleSessions()` (run from the existing cron) fails sessions on dead workers or past max age.

## Overflow policy (per business, Overview page)

Beyond the limit, or with no free worker, a call is never dropped silently: it is recorded (`failureCause: overflow:<policy>`),
and per policy: `callback` (caller told we will call back; callback task + follow-up), `voicemail` (same, gateway plays voicemail),
`transfer` (gateway dials the team number; falls back to callback if none is set).

## Workers and scaling

Workers announce `{ workerId, capacity, cpuPct, memMb, draining }` in signed `heartbeat` events. A worker silent for
`VOICE_WORKER_STALE_MS` (30 s) is marked down and its calls are failed with a callback. **This app cannot start servers.**
It computes a recommended worker count (active calls + 25 % headroom, +1 when average CPU ≥ 75 %) and shows it; the operator or
orchestrator must act on it.

## Dashboard / API

`GET /api/telephony/concurrency` (live, per business): active/peak/limit, lifecycle counts, 24 h completed/failed/overflowed,
failure causes, setup avg/p95, agent time per turn, worker capacity/CPU. `PUT` changes limit and overflow policy.

## LiveKit SIP (deployment specification — not implemented or tested here)

`adapters/livekit.ts` remains "not implemented". A LiveKit deployment should use:

- an **inbound trunk** with `auth_username`/`auth_password` and `allowed_addresses` set to the carrier;
- a dispatch rule of type **`dispatchRuleIndividual`** with `roomPrefix: "call-"`, so every caller gets a new room;
- an agent dispatched per room (explicit dispatch), whose gateway bridge posts `incoming`/`status`/`heartbeat` events here;
- the `sessionKey` returned by `routeIncoming` as the room-name suffix / participant attribute, never a phone number.

## Measured (local, single machine, `CONCURRENCY_BENCH=1 npx vitest run tests/concurrency.bench.test.ts`)

Control plane + rule-based agent against local MongoDB. **No audio, STT, TTS, LLM, carrier or network.**

| simultaneous | admit all | one agent turn each |
|---|---|---|
| 10 | 50 ms | 105 ms |
| 25 | 67 ms | 80 ms |
| 100 | 249 ms | 704 ms |
| 250 | 769 ms | 1.5 s |

Admission grows roughly linearly (~3 ms/call): per-business counters are single documents, so arrivals serialize there; the
Node event loop and one MongoDB are the next limits. These numbers say the **control plane is not the limit at 25 calls**. They
do **not** measure real call capacity, which will be set by worker CPU for speech/TTS, LLM latency and rate limits, and the
carrier's channel limit. Measure those with a controlled test number before promising any figure. Unlimited calling is not claimed.

## Not done / not verified

Real LiveKit/SIP/carrier calls; audio isolation (verified by room-per-session design and data isolation tests, not by audio);
running worker processes and autoscaling actions; multi-region; MongoDB outage beyond setup-time failure (admission fails
closed and gives back its slot, the gateway must fail over); voicemail playback (gateway side).


---

# Twilio webhook path (one forwarded number, many simultaneous callers)

## Existing architecture (inspected)

Callers dial the business's own number, which is forwarded (busy / no answer / always, set at the carrier) to the **one** TrulyHello Twilio number. Twilio posts every call to `/api/twilio/incoming`; the app answers with TwiML. Speech recognition and text-to-speech are done **by Twilio** inside `<Gather input="speech">` / `<Say>`; the AI runs in the app on each webhook. There is no Media Streams / WebSocket audio in this app. Because every webhook carries the call's own id and state lives on that call's database record, many calls run in parallel on any number of server instances without shared conversation state.

```
Business number ──forward──▶ ONE Twilio number ──webhook──▶ /api/twilio/incoming   (signature verified)
        │                                                        │
        │                                   findBusinessByNumber → routing (human first? after hours? overflow?)
        │                                                        │
        │                          createCallSession (Call: callUuid, CallSid)  +  openSession (CallSession: sessionKey)
        │                                                        │
        │                                admitAi: atomic slot  ──full──▶ fallback (callback task + message, or transfer)
        │                                                        │ admitted
        ▼                                                        ▼
  each caller ◀── TwiML <Say>/<Gather> ◀── agentEngine.respond(callId) ◀── <Gather> result webhook (per call, idempotent)
                                                  │ tools (scoped to businessId + callId)
  /api/twilio/status ──▶ finalizeCall + endSession (slot released exactly once)
```

## What was added for this path

- `CallSession` row per Twilio call (unique on the CallSid): opaque `sessionKey`, `lifecycle` (incoming → initializing → active → completing → completed | failed), `stage` (incoming, initializing, processing, executing tool, speaking/listening, waiting for human, transferring, completed, failed), timings, `admission`, `configRef` (a snapshot reference of the business configuration; published-prompt versioning is **not** built), failure cause.
- Capacity: atomic per-business slot (`Business.concurrency.maxConcurrentCalls`, default 10) taken when the **AI** takes the call (human-ring time does not use a slot). At the limit the caller hears a callback message and a high-priority follow-up is created (or the call is transferred to the team number once, then falls back to the callback message). `voicemail` currently behaves as `callback` on this path (`<Record>` is not rendered).
- Duplicate webhooks: same CallSid → same Call, same session, same slot; repeated turns with the same `I-Twilio-Idempotency-Token` return the first answer; repeated status events free the slot once. Sessions whose end event never arrives are reaped (`reapStaleSessions`).
- `GET /api/calls/live` (sessions + capacity + measured latency), `GET /api/telephony/twilio-check` (account type/status, number's voice webhook and status callback, trial warning), `GET/PUT /api/qa/concurrency[/:id]`. Pages: **Live calls**, **Concurrent testing**.

## Twilio configuration required

Voice webhook of the number: `POST {PUBLIC_BASE_URL}/api/twilio/incoming`; status callback: `{PUBLIC_BASE_URL}/api/twilio/status` (with events completed/busy/failed/no-answer/canceled — without it slots are only freed by the clean-up job); recording callback is set per call by the app. Env: `PUBLIC_BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (signature checks and REST), `TWILIO_PHONE_NUMBER`, `JWT_SECRET`, `MONGODB_URI`; optional `OPENAI_API_KEY` (LLM brain; otherwise the built-in rule agent). Call forwarding from the business number is configured with the carrier, not by this app.

## Tests and what they prove

`tests/live-sessions.test.ts` (17 tests) drives the **real webhook route handlers** with correctly signed simulated Twilio requests against a local database: 1, 2, 5 and 10 simultaneous full conversations (no transcript, email, caller or business crossover), ten different requests across two businesses, ten recordings/transcripts/requests with every webhook delivered twice, human transfer while others continue, a failing session, a database error on one call, capacity overflow and recovery, transfer-overflow without a loop, duplicate events, lost end events, carrier failure, Live Calls API masking and tenant scoping, the Twilio account check, and the test-record rules. `CONCURRENCY_REPORT=1 npx vitest run tests/live-sessions.test.ts` writes `evals/reports/concurrency.json`, which the Concurrent testing page shows labelled **simulated**.

## Verified concurrency

**Live-verified: none.** Nothing here was run with real Twilio calls, real speech recognition or text-to-speech, so 10 simultaneous callers is a **configured target**, not a proven capacity. The dashboard shows verified capacity only after a person records a passing live test with at least that many callers on real phones.

## Limitations / before the first live demo

1. Place a controlled test with 2, 5 then 10 real phones (team members) against the real number; record each in Concurrent testing.
2. Confirm your Twilio account is not Trial and the voice webhook/status callback point at `PUBLIC_BASE_URL` (Check Twilio now); confirm account concurrency limits with Twilio.
3. Speech-recognition, text-to-speech and end-to-end latency are inside Twilio and are not measured; only TrulyHello's own webhook time is.
4. No Media Streams / barge-in: Twilio `<Gather>` listens after speaking. The `staydesk-voice-agent` realtime path is not wired.
5. Heavy load on a serverless host depends on that host's own concurrency and cold-start limits and on MongoDB connection limits; test on the real deployment.
6. Outbound calls are not counted against the concurrency limit.
7. No Redis: session state is in MongoDB with atomic operations, which avoids another service; revisit if measured database load becomes the bottleneck.

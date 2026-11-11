# Voice: ElevenLabs speaking over Twilio

TrulyHello keeps **Twilio as the phone line and listener** and uses **ElevenLabs only to speak**. No LiveKit, no
second voice server: it all runs inside the existing Next.js app.

## How a reply is spoken

```
caller speaks ─► Twilio <Gather input="speech"> (Twilio speech-to-text)
              ─► POST /api/twilio/gather ─► agent engine ─► reply text
              ─► applyVoice(): business voice (gender, voice id)
                   ├─ ElevenLabs configured + chosen: text ─► MP3 ─► VoiceClip (kept 2 h) ─► signed URL
                   └─ otherwise / on any problem: no URL
              ─► TwiML: <Gather><Play>signed URL</Play></Gather>      (ElevenLabs)
                        <Gather><Say voice="Polly.Matthew">…</Say></Gather>   (fallback)
Twilio ─► GET /api/voice/audio/<clipId>?exp=…&sig=…  (signature + expiry checked, 404 otherwise)
```

`<Play>` sits inside `<Gather>`, so the caller can still talk over the agent.

## What was added

| File | Purpose |
|---|---|
| `server/services/voice/tts.ts` | ElevenLabs client (fakeable in tests), per-business cache, signed links, timeout, circuit breaker |
| `server/services/voice/voices.ts` | Curated voices (3 female, 3 male), defaults, Polly fallback voice per language and gender |
| `server/services/voice/applyVoice.ts` | Adds the business's voice to each instruction that speaks |
| `server/models/VoiceClip.ts` | Short-lived audio (TTL index), tenant-scoped, text not stored |
| `server/controllers/voiceAudioController.ts`, `app/api/voice/audio/[id]` | Signed audio endpoint Twilio fetches |
| `server/controllers/voiceSettingsController.ts`, `app/api/voice-settings*` | Voice list and Preview (owners/admins) |
| `components/settings/voice-card.tsx` | Settings → Voice: type, gender, voice, Preview |
| `Business.voice` | `{ provider: elevenlabs\|polly, gender, voiceId }`, default ElevenLabs + female |
| `tests/voice-elevenlabs.test.ts` | Tests with a fake ElevenLabs |

## Set up

1. Create an ElevenLabs API key and put it in `.env.local` as `ELEVENLABS_API_KEY`. Restart `npm run dev`.
2. The app must be reachable by Twilio at `PUBLIC_BASE_URL` (ngrok in development): Twilio downloads the audio from there.
3. **Settings → Voice**: choose Female/Male, pick a voice, press **Preview voice**, then **Save settings**.
4. Call the number.

The voice list is in `server/services/voice/voices.ts`. The ids are ElevenLabs default voices (from their documentation at the time of writing); if a Preview fails for one of them, swap its id there. `ELEVENLABS_MODEL` defaults to `eleven_flash_v2_5` (low latency).

## Failure behaviour (a call must never get worse)

- No key, `FEATURE_ELEVENLABS_VOICE=false`, or the business chose Standard: the standard Polly voice speaks (male or female as chosen).
- ElevenLabs slower than `ELEVENLABS_TTS_TIMEOUT_MS` (3 s) or returns an error: that reply uses the standard voice.
- 3 failures in a row: ElevenLabs is skipped for 60 s so later callers do not each wait for a timeout.
- Text longer than 1200 characters is not sent to ElevenLabs.
- Any error while choosing the voice leaves the instruction unchanged.

## Privacy and cost

- Audio is generated from the agent's own reply text, which can include a caller's name or a confirmation code. Clips are stored for `ELEVENLABS_CLIP_TTL_MINUTES` (default 120) and then deleted; they are only reachable through a link that expires after 15 minutes and is bound to one clip. The text itself is not stored (only a hash for the cache).
- The cache is per business; one business never reuses another's audio.
- ElevenLabs bills by characters. Repeated sentences (greeting, common answers) are generated once per business and reused. Previews are limited to 20 per hour per business.
- Review ElevenLabs' terms and data handling before using it for calls that include health or payment details.

## Tested and not tested

Tested (automated, fake ElevenLabs, simulated Twilio): TwiML uses `<Play>` inside `<Gather>`, falls back to `<Say>` of the right gender on failure, timeout and circuit breaker, signed link checks (tampered, expired, unknown), cache reuse and tenant separation, settings API (save, validation, gender/voice consistency, previews, rate limit, role checks).

**Not tested:** the real ElevenLabs API, a real Twilio call, how long each reply takes on a live call (ElevenLabs generation time is added to every turn, so replies are slower than with the standard voice), voice quality over a phone line, and the Settings page in a browser.

## Not included (possible later: real-time streaming)

Real-time streaming (Twilio Media Streams over a WebSocket, streaming speech-to-text, streaming ElevenLabs audio) would cut latency and give natural interruptions, but needs a separate always-on server because this Next.js app cannot hold WebSockets. It is deliberately not part of this change.

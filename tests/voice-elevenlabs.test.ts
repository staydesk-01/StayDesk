import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../server/config/env";
import { Business, Call, VoiceClip } from "../server/models";
import { __resetPreviewLimitForTest } from "../server/controllers/voiceSettingsController";
import { __setTtsClientForTest, signClipUrl, verifyClipSignature, type TtsClient } from "../server/services/voice/tts";
import { DEFAULT_VOICE, VOICE_CATALOG, pollyVoice } from "../server/services/voice/voices";
import { login, makeBusiness, newCallSid, request, twilioPost } from "./helpers";

const INCOMING = "/api/twilio/incoming";
const SARAH = DEFAULT_VOICE.female;
const BRIAN = DEFAULT_VOICE.male;

/** A fake ElevenLabs. The real API is never called from tests. */
function fakeTts(mode: "ok" | "fail" | "hang" = "ok") {
  const calls: { text: string; voiceId: string; model: string }[] = [];
  const client: TtsClient = {
    async synthesize({ text, voiceId, model, signal }) {
      calls.push({ text, voiceId, model });
      if (mode === "fail") throw new Error("ElevenLabs responded 500");
      if (mode === "hang") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return { audio: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]), contentType: "audio/mpeg" };
    },
  };
  return { client, calls };
}

const incomingParams = (biz: { config: { twilioNumber?: string | null } }) => ({ CallSid: newCallSid(), From: "+15551230000", To: biz.config.twilioNumber!, CallStatus: "ringing" });
const playUrl = (xml: string) => xml.match(/<Play>([^<]+)<\/Play>/)?.[1]?.replace(/&amp;/g, "&");
const pathOf = (url: string) => url.replace("https://staydesk.test", "");

beforeEach(() => __resetPreviewLimitForTest());
afterEach(() => __setTtsClientForTest(null));

describe("ElevenLabs voice on calls", () => {
  it("is off by default: the standard female voice speaks and nothing is generated", async () => {
    const biz = await makeBusiness({ aiOnly: true });
    const res = await twilioPost(INCOMING, incomingParams(biz));
    expect(res.status).toBe(200);
    expect(res.text).toContain('voice="Polly.Joanna"');
    expect(res.text).not.toContain("<Play");
    expect(await VoiceClip.countDocuments()).toBe(0);
  });

  it("plays ElevenLabs audio instead of saying the greeting, and still listens (barge-in)", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    const res = await twilioPost(INCOMING, incomingParams(biz));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Gather[^>]*>\s*<Play>https:\/\/staydesk\.test\/api\/voice\/audio\/[a-f0-9]{24}\?exp=\d+&amp;sig=[\w-]+<\/Play>\s*<\/Gather>/);
    expect(res.text).not.toContain("<Say");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ voiceId: SARAH, model: env.ELEVENLABS_MODEL });
    expect(calls[0].text).toContain(biz.business.name);
  });

  it("speaks later replies with ElevenLabs too", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    const p = incomingParams(biz);
    await twilioPost(INCOMING, p);
    const call = await Call.findOne({ providerCallId: p.CallSid });
    const res = await twilioPost(`/api/twilio/gather?callId=${call!._id}`, { CallSid: p.CallSid, SpeechResult: "Do you have parking?" });
    expect(playUrl(res.text)).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)!.text).toMatch(/parking|\$20/i);
  });

  it("serves the audio at the signed link", async () => {
    __setTtsClientForTest(fakeTts().client);
    const biz = await makeBusiness({ aiOnly: true });
    const url = playUrl((await twilioPost(INCOMING, incomingParams(biz))).text)!;
    const audio = await request().get(pathOf(url));
    expect(audio.status).toBe(200);
    expect(audio.type).toBe("audio/mpeg");
    expect(audio.text.length).toBeGreaterThan(0);
  });

  it("refuses a tampered link, an expired link and an unknown clip with the same 404", async () => {
    __setTtsClientForTest(fakeTts().client);
    const biz = await makeBusiness({ aiOnly: true });
    const url = playUrl((await twilioPost(INCOMING, incomingParams(biz))).text)!;
    const path = pathOf(url);
    expect((await request().get(path.replace(/sig=.{4}/, "sig=AAAA"))).status).toBe(404);
    expect((await request().get(path.replace(/exp=\d+/, "exp=1"))).status).toBe(404);
    expect((await request().get(pathOf(signClipUrl(String(new Types.ObjectId()))))).status).toBe(404);

    const id = path.split("/").pop()!.split("?")[0];
    const exp = Number(/exp=(\d+)/.exec(path)![1]);
    const sig = /sig=([\w-]+)/.exec(path)![1];
    expect(verifyClipSignature(id, exp, sig)).toBe(true);
    expect(verifyClipSignature(id, exp, sig, exp + 1)).toBe(false); // after it expires
    expect(verifyClipSignature(String(new Types.ObjectId()), exp, sig)).toBe(false); // signature is bound to one clip
  });

  it("generates the same sentence once and reuses it", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    await twilioPost(INCOMING, incomingParams(biz));
    await twilioPost(INCOMING, incomingParams(biz));
    expect(calls).toHaveLength(1);
    expect(await VoiceClip.countDocuments()).toBe(1);
  });

  it("never reuses audio across businesses", async () => {
    const { client } = fakeTts();
    __setTtsClientForTest(client);
    const a = await makeBusiness({ aiOnly: true, name: "Same Name Hotel" });
    const b = await makeBusiness({ aiOnly: true, name: "Same Name Hotel" });
    await twilioPost(INCOMING, incomingParams(a));
    await twilioPost(INCOMING, incomingParams(b));
    const clips = await VoiceClip.find().select("businessId");
    expect(new Set(clips.map((c) => String(c.businessId))).size).toBe(2);
  });

  it("falls back to the standard voice when ElevenLabs fails, and the call carries on", async () => {
    __setTtsClientForTest(fakeTts("fail").client);
    const biz = await makeBusiness({ aiOnly: true });
    const res = await twilioPost(INCOMING, incomingParams(biz));
    expect(res.status).toBe(200);
    expect(res.text).toContain('voice="Polly.Joanna"');
    expect(res.text).not.toContain("<Play");
    expect(res.text).toContain("<Gather");
  });

  it("falls back when ElevenLabs is too slow", async () => {
    __setTtsClientForTest(fakeTts("hang").client);
    const before = env.ELEVENLABS_TTS_TIMEOUT_MS;
    env.ELEVENLABS_TTS_TIMEOUT_MS = 50;
    try {
      const biz = await makeBusiness({ aiOnly: true });
      const res = await twilioPost(INCOMING, incomingParams(biz));
      expect(res.text).toContain("<Say");
      expect(res.text).not.toContain("<Play");
    } finally {
      env.ELEVENLABS_TTS_TIMEOUT_MS = before;
    }
  });

  it("pauses ElevenLabs after three failures so later callers don't each wait", async () => {
    const { client, calls } = fakeTts("fail");
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    for (let i = 0; i < 5; i++) {
      const res = await twilioPost(INCOMING, incomingParams(biz));
      expect(res.text).toContain("<Say");
    }
    expect(calls).toHaveLength(3);
  });

  it("uses the male voice when chosen: ElevenLabs male default, Polly.Matthew as the fallback", async () => {
    const ok = fakeTts();
    __setTtsClientForTest(ok.client);
    const biz = await makeBusiness({ aiOnly: true });
    await Business.updateOne({ _id: biz.business._id }, { $set: { "voice.gender": "male" } });
    await twilioPost(INCOMING, incomingParams(biz));
    expect(ok.calls[0].voiceId).toBe(BRIAN);

    __setTtsClientForTest(fakeTts("fail").client);
    await VoiceClip.deleteMany({}); // the ok call above cached a clip; clear it so the forced failure actually exercises the Polly fallback
    const res = await twilioPost(INCOMING, incomingParams(biz));
    expect(res.text).toContain('voice="Polly.Matthew"');
  });

  it("uses the chosen catalog voice", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    const george = VOICE_CATALOG.find((v) => v.name === "George")!;
    await Business.updateOne({ _id: biz.business._id }, { $set: { "voice.gender": "male", "voice.voiceId": george.id } });
    await twilioPost(INCOMING, incomingParams(biz));
    expect(calls[0].voiceId).toBe(george.id);
  });

  it("a business that chose the standard voice never calls ElevenLabs", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const biz = await makeBusiness({ aiOnly: true });
    await Business.updateOne({ _id: biz.business._id }, { $set: { "voice.provider": "polly", "voice.gender": "male" } });
    const res = await twilioPost(INCOMING, incomingParams(biz));
    expect(calls).toHaveLength(0);
    expect(res.text).toContain('voice="Polly.Matthew"');
  });

  it("the standard voice follows the gender in every supported language", () => {
    for (const lang of ["en-US", "es-US", "fr-FR", "de-DE", "pt-BR"]) {
      expect(pollyVoice(lang, "female").voice).not.toBe(pollyVoice(lang, "male").voice);
    }
    expect(pollyVoice("xx-XX", "male")).toEqual({ voice: "Polly.Matthew", language: "en-US" });
  });
});

describe("voice settings API", () => {
  async function owner(opts: Parameters<typeof makeBusiness>[0] = {}) {
    const biz = await makeBusiness(opts);
    return { biz, agent: await login(biz.email) };
  }

  it("lists the curated voices and the saved choice", async () => {
    __setTtsClientForTest(fakeTts().client);
    const { agent } = await owner();
    const res = await agent.get("/api/voice-settings");
    expect(res.status).toBe(200);
    expect(res.body.elevenlabs.configured).toBe(true);
    expect(res.body.voices).toHaveLength(VOICE_CATALOG.length);
    expect(res.body.voices.some((v: { gender: string }) => v.gender === "male")).toBe(true);
    expect(res.body.voices.some((v: { gender: string }) => v.gender === "female")).toBe(true);
    expect(res.body.voice).toMatchObject({ provider: "elevenlabs", gender: "female", voiceId: SARAH });
  });

  it("saves a male voice, and the gender follows the voice", async () => {
    const { biz, agent } = await owner();
    const res = await agent.patch("/api/business").send({ voice: { provider: "elevenlabs", gender: "female", voiceId: BRIAN } });
    expect(res.status).toBe(200);
    expect(res.body.business.voice).toMatchObject({ gender: "male", voiceId: BRIAN });
    expect((await Business.findById(biz.business._id))!.voice).toMatchObject({ gender: "male", voiceId: BRIAN });
  });

  it("switching gender without picking a voice drops the old voice", async () => {
    const { agent } = await owner();
    await agent.patch("/api/business").send({ voice: { gender: "male", voiceId: BRIAN } });
    const res = await agent.patch("/api/business").send({ voice: { gender: "female", voiceId: "" } });
    expect(res.body.business.voice).toMatchObject({ gender: "female", voiceId: "" });
    const only = await agent.patch("/api/business").send({ voice: { gender: "male" } });
    expect(only.body.business.voice.gender).toBe("male");
    const back = await agent.patch("/api/business").send({ voice: { gender: "female" } });
    expect(back.body.business.voice).toMatchObject({ gender: "female", voiceId: "" });
  });

  it("rejects a voice that is not in the catalog", async () => {
    const { agent } = await owner();
    expect((await agent.patch("/api/business").send({ voice: { voiceId: "not-a-real-voice" } })).status).toBe(400);
    expect((await agent.patch("/api/business").send({ voice: { gender: "robot" } })).status).toBe(400);
  });

  it("previews a voice with a fixed sentence", async () => {
    const { client, calls } = fakeTts();
    __setTtsClientForTest(client);
    const { biz, agent } = await owner();
    const res = await agent.post("/api/voice-settings/preview").send({ voiceId: BRIAN });
    expect(res.status).toBe(200);
    expect(res.type).toBe("audio/mpeg");
    expect(calls[0].voiceId).toBe(BRIAN);
    expect(calls[0].text).toContain(biz.business.name);
    expect(calls[0].text).toContain("AI assistant");
  });

  it("says plainly when ElevenLabs isn't set up, and rejects unknown voices and outsiders", async () => {
    const { agent } = await owner();
    const none = await agent.post("/api/voice-settings/preview").send({});
    expect(none.status).toBe(503);
    expect(none.body.error.message).toMatch(/ELEVENLABS_API_KEY/);

    __setTtsClientForTest(fakeTts().client);
    expect((await agent.post("/api/voice-settings/preview").send({ voiceId: "nope" })).status).toBe(400);
    expect((await request().post("/api/voice-settings/preview").send({})).status).toBe(401);
    expect((await request().get("/api/voice-settings")).status).toBe(401);
  });

  it("limits previews per business, and staff cannot use them", async () => {
    __setTtsClientForTest(fakeTts().client);
    const { agent } = await owner();
    for (let i = 0; i < 20; i++) expect((await agent.post("/api/voice-settings/preview").send({})).status).toBe(200);
    expect((await agent.post("/api/voice-settings/preview").send({})).status).toBe(429);

    __resetPreviewLimitForTest();
    await agent.post("/api/team").send({ name: "Sam Staff", email: "sam.staff@test.dev", password: "Password123!", role: "staff" });
    const staff = await login("sam.staff@test.dev");
    expect((await staff.post("/api/voice-settings/preview").send({})).status).toBe(403);
    expect((await staff.get("/api/voice-settings")).status).toBe(403);
  });

  it("a failed preview is a clear error, not a crash", async () => {
    __setTtsClientForTest(fakeTts("fail").client);
    const { agent } = await owner();
    const res = await agent.post("/api/voice-settings/preview").send({});
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/ElevenLabs could not create the preview/);
  });
});

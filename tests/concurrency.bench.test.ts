import { describe, it } from "vitest";
import { Business, BusinessPhoneNumber } from "../server/models";
import { routeIncoming } from "../server/services/telephony/core/sessions";
import { runVoiceTurn } from "../server/services/voice/orchestrator";
import { makeBusiness } from "./helpers";

/** Measurement only: `CONCURRENCY_BENCH=1 npx vitest run tests/concurrency.bench.test.ts`. Control plane + rule-based agent against local MongoDB; no audio, STT, TTS, LLM or carrier. */
describe.skipIf(!process.env.CONCURRENCY_BENCH)("concurrency benchmark", () => {
  it.each([10, 25, 100, 250])("%i simultaneous calls", async (n) => {
    process.env.FEATURE_TELEPHONY_CORE = "true";
    const biz = await makeBusiness();
    await BusinessPhoneNumber.create({ businessId: biz.business._id, e164: "+14155550100", role: "inbound", mode: "forwarding", verification: { status: "verified", verifiedAt: new Date() } });
    await Business.updateOne({ _id: biz.business._id }, { $set: { "concurrency.maxConcurrentCalls": 1000 } });
    const lat: number[] = [];
    const t0 = performance.now();
    const ds = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const s = performance.now();
      const d = await routeIncoming(biz.business._id, "sip_gateway", { type: "incoming", providerCallId: `b-${n}-${i}`, from: `+1415556${String(i).padStart(4, "0")}`, to: "+14155550100" });
      lat.push(performance.now() - s);
      return d;
    }));
    const admitMs = performance.now() - t0;
    lat.sort((a, b) => a - b);
    const t1 = performance.now();
    const tl: number[] = [];
    await Promise.all(ds.map(async (d, i) => { const s = performance.now(); await runVoiceTurn({ callId: d.callId!, messageId: `m${i}`, text: "What time is check-out?" }); tl.push(performance.now() - s); }));
    tl.sort((a, b) => a - b);
    const q = (a: number[], p: number) => Math.round(a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]);
    console.log(`[bench] n=${n} admit total=${Math.round(admitMs)}ms p50=${q(lat, .5)}ms p95=${q(lat, .95)}ms | one agent turn each, total=${Math.round(performance.now() - t1)}ms p50=${q(tl, .5)}ms p95=${q(tl, .95)}ms`);
  }, 120_000);
});

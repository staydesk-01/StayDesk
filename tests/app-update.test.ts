import { describe, expect, it } from "vitest";
import { CURRENT_BUILD, fetchLatestBuild, getBlockers, registerGuard, shouldNotify } from "../lib/app-update";
import { makeClient } from "./client";

const info = (buildId: string, version = "1.2.3") => ({ buildId, version });
const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("shouldNotify", () => {
  it("is quiet when the deployed build matches the one loaded", () => {
    expect(shouldNotify("abc", info("abc"), null)).toBe(false);
  });
  it("notifies for a genuinely different build", () => {
    expect(shouldNotify("abc", info("def"), null)).toBe(true);
  });
  it("stays quiet for a build the user postponed, but returns for the next build", () => {
    expect(shouldNotify("abc", info("def"), "def")).toBe(false);
    expect(shouldNotify("abc", info("ghi"), "def")).toBe(true);
  });
  it("never notifies without a usable server answer", () => {
    expect(shouldNotify("abc", null, null)).toBe(false);
    expect(shouldNotify("abc", info(""), null)).toBe(false);
  });
});

describe("fetchLatestBuild", () => {
  it("returns the deployed build", async () => {
    expect(await fetchLatestBuild(json({ buildId: "xyz", version: "2.0.0" }))).toEqual({ buildId: "xyz", version: "2.0.0" });
  });
  it("swallows every kind of failure (never throws, never interrupts the app)", async () => {
    expect(await fetchLatestBuild(json({}, 500))).toBeNull();
    expect(await fetchLatestBuild(json({ nope: true }))).toBeNull();
    expect(await fetchLatestBuild((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchLatestBuild((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
  it("gives up on a hung request instead of waiting forever", async () => {
    const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await fetchLatestBuild(hang, 30)).toBeNull();
  });
});

describe("update guards (what blocks a reload)", () => {
  it("reports an active call and unsaved work, and clears them when released", () => {
    expect(getBlockers()).toEqual({ call: false, unsaved: false });
    const endCall = registerGuard("call");
    const discard = registerGuard("unsaved");
    expect(getBlockers()).toEqual({ call: true, unsaved: true });
    endCall();
    expect(getBlockers()).toEqual({ call: false, unsaved: true });
    discard();
    expect(getBlockers()).toEqual({ call: false, unsaved: false });
  });
  it("supports several guards at once without one releasing the other", () => {
    const a = registerGuard("unsaved");
    const b = registerGuard("unsaved");
    a();
    expect(getBlockers().unsaved).toBe(true);
    b();
    expect(getBlockers().unsaved).toBe(false);
  });
});

describe("GET /api/app-version", () => {
  it("is public (no session), uncacheable, and reports this build", async () => {
    const res = await makeClient().get("/api/app-version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CURRENT_BUILD);
    expect(res.body.buildId).toBeTruthy();
    expect(String(res.headers["cache-control"])).toMatch(/no-store/);
  });
});

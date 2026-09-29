import twilio from "twilio";
import { makeClient } from "./client";
import { BusinessKnowledge, PhoneConfiguration } from "../server/models";
import { createBusinessWithOwner } from "../server/services/business/businessService";

export const request = () => makeClient();

const OPEN_ALL_DAY = { closed: false, open: "00:00", close: "24:00" };
const CLOSED = { closed: true, open: "09:00", close: "17:00" };
const week = (d: typeof OPEN_ALL_DAY) => ({ mon: d, tue: d, wed: d, thu: d, fri: d, sat: d, sun: d });

let seq = 0;
export async function makeBusiness(opts: {
  name?: string;
  open?: boolean;
  twilioNumber?: string;
  humanNumber?: string;
  humanFirst?: boolean;
  aiOnly?: boolean;
  mode?: "new_twilio" | "existing_number";
  maxConcurrentHumanCalls?: number;
  noAnswerToAi?: boolean;
  role?: "owner" | "staff";
} = {}) {
  seq += 1;
  const { business, user } = await createBusinessWithOwner({
    businessName: opts.name ?? `Test Hotel ${seq}`,
    name: "Owner",
    email: `owner${seq}@test.dev`,
    password: "Password123!",
    businessType: "hotel",
  });
  business.timezone = "America/New_York";
  business.escalationPhone = opts.humanNumber ?? "+15550001111";
  business.ownerEmail = user.email;
  business.address = "1 Test Street";
  await business.save();

  await BusinessKnowledge.updateOne(
    { businessId: business._id },
    {
      $set: {
        description: "A test hotel.",
        hours: week(opts.open === false ? CLOSED : OPEN_ALL_DAY),
        services: [{ name: "Deluxe King Room", description: "King bed", price: "From $200 per night" }],
        faqs: [{ question: "Do you have parking?", answer: "Parking is $20 per night." }],
        pricingInfo: "Rooms from $200.",
      },
    },
  );
  const config = await PhoneConfiguration.findOneAndUpdate(
    { businessId: business._id },
    {
      $set: {
        twilioNumber: opts.twilioNumber ?? `+1555000${String(2000 + seq)}`,
        humanNumber: opts.humanNumber ?? "+15550001111",
        humanFirst: opts.humanFirst ?? true,
        aiOnly: opts.aiOnly ?? false,
        mode: opts.mode ?? "new_twilio",
        maxConcurrentHumanCalls: opts.maxConcurrentHumanCalls ?? 1,
        noAnswerToAi: opts.noAnswerToAi ?? true,
      },
    },
    { returnDocument: "after" },
  );
  return { business, user, config: config!, email: user.email, password: "Password123!" };
}

/** Signs in and returns a supertest agent that carries the session cookie. */
export async function login(email: string, password = "Password123!") {
  const agent = makeClient();
  const res = await agent.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** POSTs to a Twilio webhook with a valid X-Twilio-Signature computed exactly as Twilio does. */
export function twilioPost(path: string, params: Record<string, string>, opts: { signature?: string } = {}) {
  const url = `https://staydesk.test${path}`;
  const signature = opts.signature ?? twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, url, params);
  return makeClient().post(path).set("X-Twilio-Signature", signature).type("form").send(params);
}

let sid = 0;
export const newCallSid = () => `CA${String(++sid).padStart(32, "0")}`;

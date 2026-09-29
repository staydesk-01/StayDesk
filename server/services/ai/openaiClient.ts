import OpenAI from "openai";
import { env } from "../../config/env";

let client: OpenAI | null | undefined;

/** Returns null when OPENAI_API_KEY is not configured – callers fall back to the built-in rule engine / templates. */
export function getOpenAI(): OpenAI | null {
  if (client === undefined) client = env.OPENAI_API_KEY && !env.isTest ? new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 12_000, maxRetries: 1 }) : null;
  return client;
}

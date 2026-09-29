import type { Types } from "mongoose";
import type { ZodType } from "zod";
import type { BusinessDoc, CallDoc, KnowledgeDoc, PhoneConfigDoc } from "../models";

/** Tenant context. Always derived server-side from the Call record – never from model or request input. */
export interface ToolContext {
  businessId: Types.ObjectId;
  callId: Types.ObjectId;
}

export interface LoadedToolContext extends ToolContext {
  call: CallDoc;
  business: BusinessDoc;
  knowledge: KnowledgeDoc | null;
  config: PhoneConfigDoc | null;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  handler: (ctx: LoadedToolContext, input: I) => Promise<unknown>;
}

export const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });
export const fail = (code: string, message: string): ToolResult<never> => ({ ok: false, error: { code, message } });

/** Helper so each tool file gets full inference on its handler's `input`. */
export function defineTool<I>(def: ToolDefinition<I>): ToolDefinition<I> {
  return def;
}

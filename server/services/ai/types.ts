import type { BusinessDoc, CallDoc, KnowledgeDoc, PhoneConfigDoc } from "../../models";

export interface AgentTurnResult {
  reply: string;
  /** Hang up after speaking the reply. */
  end: boolean;
  /** Bridge the caller to a human after speaking the reply (real calls). */
  transfer: boolean;
}

export interface BrainInput {
  call: CallDoc;
  business: BusinessDoc;
  knowledge: KnowledgeDoc | null;
  config: PhoneConfigDoc | null;
  history: { role: "caller" | "agent"; text: string }[];
  userText: string;
}

export interface AgentBrain {
  respond(input: BrainInput): Promise<AgentTurnResult>;
}

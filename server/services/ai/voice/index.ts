import type { VoiceProvider } from "./provider";
import { retellProvider } from "./retell";
import { vapiProvider } from "./vapi";

const providers: Record<string, VoiceProvider> = { retell: retellProvider, vapi: vapiProvider };
export const getVoiceProvider = (name: string) => providers[name];
export type { VoiceEvent, VoiceProvider } from "./provider";

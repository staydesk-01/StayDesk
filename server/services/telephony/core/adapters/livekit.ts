import type { TelephonyAdapter } from "../types";
import { TelephonyError } from "../types";

/**
 * LiveKit as a media/agent runtime is reached through the SIP gateway adapter (the gateway is LiveKit SIP + the voice
 * worker). A direct LiveKit adapter needs `livekit-server-sdk`, which is not installed, so nothing here pretends to work.
 */
export const livekitAdapter: TelephonyAdapter = {
  kind: "livekit",
  capabilities: { inbound: false, outbound: false, dtmf: false, audioStreaming: false, healthCheck: false },
  validate: () => ["The direct LiveKit adapter is not implemented. Use the SIP gateway connection for LiveKit SIP."],
  async checkHealth() { throw new TelephonyError("not_supported", "Direct LiveKit adapter is not implemented."); },
  async startOutbound() { throw new TelephonyError("not_supported", "Direct LiveKit adapter is not implemented."); },
  async hangup() { throw new TelephonyError("not_supported", "Direct LiveKit adapter is not implemented."); },
};

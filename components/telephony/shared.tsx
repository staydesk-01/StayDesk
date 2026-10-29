import { Badge, type BadgeTone } from "@/components/ui/badge";

export type Status = "not_configured" | "testing" | "connected" | "degraded" | "offline";
export const statusLabel: Record<Status, [string, BadgeTone]> = {
  not_configured: ["Not configured", "neutral"],
  testing: ["Testing", "info"],
  connected: ["Connected", "success"],
  degraded: ["Degraded", "warning"],
  offline: ["Offline", "danger"],
};
export const StatusPill = ({ status }: { status: Status }) => <Badge tone={statusLabel[status][1]}>{statusLabel[status][0]}</Badge>;

export interface Connection { id: string; kind: string; label: string; status: Status; reason: string; lastCheckedAt?: string; lastOkAt?: string; settings: Record<string, string>; secrets: Record<string, string>; capabilities: { inbound: boolean; outbound: boolean; dtmf: boolean; audioStreaming: boolean } }
export interface PhoneNumber { _id: string; e164: string; mode: string; role: string; answerMode: string; verification?: { status: string }; callerIdAuthorized: boolean }
export interface Trunk { _id: string; name: string; host: string; transport: string; srtp: boolean; allowedIps: string[]; maxConcurrentCalls: number; status: Status }
export interface Session { _id: string; direction: string; fromNumber?: string; toNumber?: string; status: string; startedAt: string; connectionKind: string }
export interface OutboundReq { _id: string; purpose: string; toNumber: string; status: string; blockedReason?: string; attempts: number; maxAttempts: number; nextAttemptAt?: string; lastError?: string }
export interface Overview {
  enabled: boolean;
  flags: { telephonyCore: boolean; sipGateway: boolean; outboundCalling: boolean; secretsConfigured: boolean };
  connections?: Connection[];
  available?: { kind: string; capabilities: Connection["capabilities"] }[];
  numbers?: PhoneNumber[];
  trunks?: Trunk[];
  activeCalls?: Session[];
  outbound?: OutboundReq[];
  outboundSettings?: { enabled: boolean; purposes: string[]; windowStart: string; windowEnd: string; maxAttempts: number; retryMinutes: number; jurisdictionNote: string };
  openRecoveryTasks?: number;
  health?: { _id: string; provider: string; kind: string; detail: string; at: string }[];
  quality?: { sessions24h: number; latencyMeasuredCalls: number; avgTurnLatencyMs: number | null; maxTurnLatencyMs: number | null; qualityMeasuredCalls: number; avgJitterMs: number | null; avgPacketLossPct: number | null; avgMos: number | null };
}
export const kindLabel: Record<string, string> = { sip_gateway: "Self-managed SIP gateway", twilio: "Twilio", vapi: "Vapi", livekit: "LiveKit (direct)" };
export const fmt = (v: number | null | undefined, unit = "") => (v == null ? "Not measured" : `${v}${unit}`);

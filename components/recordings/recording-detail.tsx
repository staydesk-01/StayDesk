"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi } from "@/hooks/use-api";
import { useSession } from "@/hooks/use-session";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";

interface Detail {
  recording: { recordingId: string; callUuid?: string; status: string; flagged: boolean; durationSeconds?: number; retentionUntil?: string; consentAnnounced: boolean; providerDeletion: string };
  call?: { startedAt: string; status: string; outcome: string; callerNumber: string };
  transcriptStatus: "available" | "none";
  transcript?: { speaker: string; text: string }[];
  canListen: boolean;
}

export function RecordingDetail({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const { session } = useSession();
  const { data, error, refetch } = useApi<Detail>(`/recordings/${id}`);
  const [src, setSrc] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState("");

  async function link(purpose: "play" | "download") {
    setMsg("");
    try {
      const { url } = await api<{ url: string; expiresAt: string }>(`/recordings/${id}/link`, { method: "POST", body: { purpose } });
      if (purpose === "play") setSrc(`/api${url.replace(/^\/api/, "")}`);
      else { const a = document.createElement("a"); a.href = `/api${url.replace(/^\/api/, "")}`; a.download = ""; a.click(); }
    } catch (e) { setMsg(errorMessage(e)); }
  }
  async function flag(flagged: boolean) {
    try { await api(`/recordings/${id}`, { method: "PATCH", body: { flagged, reason: flagged ? "Flagged for review" : undefined } }); refetch(); onChanged(); } catch (e) { setMsg(errorMessage(e)); }
  }
  async function remove() {
    if (!window.confirm("Delete this recording permanently? This cannot be undone.")) return;
    try { await api(`/recordings/${id}`, { method: "DELETE" }); setSrc(null); refetch(); onChanged(); } catch (e) { setMsg(errorMessage(e)); }
  }

  const r = data?.recording;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recording</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <p className="text-danger">{error}</p>}
        {r && data && (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs">
              <dt className="text-muted">Recording ID</dt><dd className="break-all"><code>{r.recordingId}</code></dd>
              <dt className="text-muted">Call ID</dt><dd className="break-all"><code>{r.callUuid ?? "—"}</code></dd>
              <dt className="text-muted">Caller</dt><dd>{data.call?.callerNumber ?? "—"}</dd>
              <dt className="text-muted">Started</dt><dd>{formatDateTime(data.call?.startedAt)}</dd>
              <dt className="text-muted">Length</dt><dd>{formatDuration(r.durationSeconds)}</dd>
              <dt className="text-muted">Recording notice</dt><dd>{r.consentAnnounced ? "Included in the greeting" : "Not announced"}</dd>
              <dt className="text-muted">Delete after</dt><dd>{formatDateTime(r.retentionUntil)}</dd>
              <dt className="text-muted">Transcript</dt><dd><Badge tone={data.transcriptStatus === "available" ? "success" : "neutral"}>{data.transcriptStatus}</Badge></dd>
            </dl>
            {r.status === "deleted" ? (
              <p className="rounded-lg bg-brand-50 p-3 text-xs text-muted">Deleted. Provider copy: {r.providerDeletion.replace(/_/g, " ")}.</p>
            ) : (
              <>
                {data.canListen ? (
                  <div className="space-y-2">
                    {src ? <audio controls autoPlay src={src} className="w-full" /> : <Button onClick={() => link("play")}>Play recording</Button>}
                    <Button variant="outline" onClick={() => link("download")}>Download</Button>
                  </div>
                ) : <p className="rounded-lg bg-warning-soft p-3 text-xs text-warning">You do not have permission to listen to recordings. Ask the owner.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => flag(!r.flagged)}>{r.flagged ? "Remove flag" : "Flag for review"}</Button>
                  {session.user.role === "owner" && <Button variant="outline" size="sm" onClick={remove}>Delete</Button>}
                </div>
              </>
            )}
            {msg && <p className="text-xs text-danger">{msg}</p>}
            {data.transcript && (
              <div className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-border p-3">
                {data.transcript.map((s, i) => <p key={i}><strong className="capitalize">{s.speaker}:</strong> {s.text}</p>)}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

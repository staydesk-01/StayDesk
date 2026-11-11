"use client";
import * as React from "react";
import { AlertTriangle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/hooks/use-api";
import { errorMessage } from "@/lib/api";
import type { Business } from "@/types";

type Gender = "female" | "male";
type VoiceValue = NonNullable<Business["voice"]>;
interface CatalogVoice { id: string; name: string; gender: Gender; description: string }
interface VoiceSettings { elevenlabs: { configured: boolean; model: string }; voices: CatalogVoice[]; voice: VoiceValue }

/** Choose how the AI sounds on calls: male or female, a specific ElevenLabs voice, and hear a sample before saving. */
export function VoiceCard({ value, onChange, disabled }: { value: Business["voice"]; onChange: (v: VoiceValue) => void; disabled?: boolean }) {
  const { toast } = useToast();
  const settings = useApi<VoiceSettings>("/voice-settings");
  const [playing, setPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  React.useEffect(() => () => audioRef.current?.pause(), []);

  if (settings.error && !settings.data) return <Card><CardContent className="pt-6 text-sm text-muted">Couldn’t load voice options: {settings.error}</CardContent></Card>;
  if (!settings.data) return <Skeleton className="h-64" />;

  const { voices, elevenlabs } = settings.data;
  const current: VoiceValue = value ?? settings.data.voice;
  const gender: Gender = current.gender === "male" ? "male" : "female";
  const list = voices.filter((v) => v.gender === gender);
  const effectiveId = list.some((v) => v.id === current.voiceId) ? current.voiceId : list[0]?.id ?? "";
  const natural = current.provider !== "polly";

  async function preview() {
    setPlaying(true);
    try {
      const res = await fetch("/api/voice-settings/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gender, voiceId: effectiveId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? `Preview failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlaying(false); toast("Couldn’t play the preview", "error"); };
      await audio.play();
    } catch (e) {
      setPlaying(false);
      toast(errorMessage(e), "error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent voice</CardTitle>
        <CardDescription>How TrulyHello sounds when it answers your calls. Preview plays a short sample; remember to save to apply it to live calls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!elevenlabs.configured && (
          <div className="flex gap-3 rounded-xl border border-border bg-brand-50 p-3.5 text-sm" role="note">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brand-700" />
            <p>ElevenLabs isn’t set up on this server yet (no <code>ELEVENLABS_API_KEY</code>). Calls use the standard voice of the gender you choose until it is. Previews are unavailable.</p>
          </div>
        )}
        <Field label="Voice type" hint="Natural voices come from ElevenLabs. The standard voice is the built-in fallback and is also used if ElevenLabs is slow or unavailable.">
          <Segmented<"elevenlabs" | "polly"> label="Voice type" value={natural ? "elevenlabs" : "polly"} onChange={(provider) => onChange({ ...current, provider })} options={[{ value: "elevenlabs", label: "Natural (ElevenLabs)" }, { value: "polly", label: "Standard" }]} />
        </Field>
        <Field label="Gender">
          <Segmented<Gender> label="Voice gender" value={gender} onChange={(g) => onChange({ ...current, gender: g, voiceId: "" })} options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }]} />
        </Field>
        {natural && (
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Voice" htmlFor="voice-select">
              <Select aria-label="Voice" value={effectiveId} onValueChange={(id) => onChange({ ...current, voiceId: id })} disabled={disabled} options={list.map((v) => ({ value: v.id, label: `${v.name}: ${v.description}` }))} />
            </Field>
            <Button type="button" variant="outline" onClick={() => void preview()} loading={playing} disabled={disabled || !elevenlabs.configured}><Play /> Preview voice</Button>
          </div>
        )}
        {!natural && <p className="text-sm text-muted">Calls will use the standard {gender} voice. Switch to Natural to pick an ElevenLabs voice.</p>}
      </CardContent>
    </Card>
  );
}

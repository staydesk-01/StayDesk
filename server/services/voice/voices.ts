/**
 * Voices a business can choose from. Curated on purpose: a short, predictable list for the settings page.
 * Ids are ElevenLabs "default voices" (available to every ElevenLabs account). Verify or swap them with the Preview
 * button / https://elevenlabs.io/docs/voices/default-voices : this list is the only place they are defined.
 */
export type VoiceGender = "female" | "male";

export interface CatalogVoice {
  id: string;
  name: string;
  gender: VoiceGender;
  description: string;
}

export const VOICE_CATALOG: CatalogVoice[] = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "female", description: "Warm and professional" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "female", description: "Clear and friendly" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "female", description: "Bright and conversational" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", gender: "male", description: "Calm and reassuring" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "male", description: "Steady and polished" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", gender: "male", description: "Warm and approachable" },
];

export const DEFAULT_VOICE: Record<VoiceGender, string> = { female: VOICE_CATALOG[0].id, male: VOICE_CATALOG[3].id };

export const findCatalogVoice = (id: string | undefined | null) => VOICE_CATALOG.find((v) => v.id === id);

/** The voice id to use: the chosen catalog voice if there is one, otherwise the default for the gender. */
export function resolveVoiceId(gender: VoiceGender = "female", voiceId?: string | null): string {
  return findCatalogVoice(voiceId)?.id ?? DEFAULT_VOICE[gender];
}

/** Amazon Polly voices Twilio can speak: the fallback when ElevenLabs is off or unavailable. Same gender, same language. */
const POLLY: Record<string, Record<VoiceGender, string>> = {
  "en-US": { female: "Polly.Joanna", male: "Polly.Matthew" },
  "es-US": { female: "Polly.Lupe", male: "Polly.Miguel" },
  "fr-FR": { female: "Polly.Lea", male: "Polly.Mathieu" },
  "de-DE": { female: "Polly.Vicki", male: "Polly.Hans" },
  "pt-BR": { female: "Polly.Camila", male: "Polly.Ricardo" },
};

export function pollyVoice(language = "en-US", gender: VoiceGender = "female") {
  const known = !!POLLY[language];
  return { voice: POLLY[known ? language : "en-US"][gender], language: known ? language : "en-US" };
}

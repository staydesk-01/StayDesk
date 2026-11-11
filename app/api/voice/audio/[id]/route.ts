import { route } from "@/server/http";
import * as c from "@/server/controllers/voiceAudioController";

// Public on purpose (Twilio fetches it without a login); protected by a short-lived signature in the URL.
export const GET = route(c.streamClip, { limit: "webhook" });

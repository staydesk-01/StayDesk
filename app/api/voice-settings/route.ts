import { route } from "@/server/http";
import * as c from "@/server/controllers/voiceSettingsController";

export const GET = route(c.getVoiceSettings, { auth: true, roles: ["owner", "admin"] });

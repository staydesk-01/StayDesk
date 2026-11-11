import { route } from "@/server/http";
import * as c from "@/server/controllers/voiceSettingsController";

export const POST = route(c.previewVoice, { auth: true, roles: ["owner", "admin"] });

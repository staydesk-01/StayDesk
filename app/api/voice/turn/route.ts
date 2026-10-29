import { route } from "@/server/http";
import * as voiceTurnController from "@/server/controllers/voiceTurnController";

export const POST = route(voiceTurnController.voiceTurn, { limit: "webhook" });

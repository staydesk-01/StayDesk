import { route } from "@/server/http";
import * as callsController from "@/server/controllers/callsController";

export const DELETE = route(callsController.deleteTranscript, { auth: true, roles: ["owner", "admin"] });

import { route } from "@/server/http";
import * as c from "@/server/controllers/recordingsController";

export const GET = route(c.getRecording, { auth: true });
export const PATCH = route(c.flagRecording, { auth: true });
export const DELETE = route(c.removeRecording, { auth: true });

import { route } from "@/server/http";
import * as c from "@/server/controllers/recordingsController";

export const GET = route(c.listRecordings, { auth: true });

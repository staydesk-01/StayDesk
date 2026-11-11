import { route } from "@/server/http";
import * as c from "@/server/controllers/recordingsController";

export const POST = route(c.issueLink, { auth: true });

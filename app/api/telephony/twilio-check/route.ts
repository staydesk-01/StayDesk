import { route } from "@/server/http";
import * as c from "@/server/controllers/liveCallsController";

export const GET = route(c.twilioCheck, { auth: true, roles: ["owner", "admin"] });

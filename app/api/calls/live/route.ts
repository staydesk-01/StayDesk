import { route } from "@/server/http";
import * as c from "@/server/controllers/liveCallsController";

export const GET = route(c.liveCalls, { auth: true });

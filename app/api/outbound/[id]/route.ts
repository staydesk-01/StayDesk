import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const DELETE = route(c.cancelOutboundRequest, { auth: true, roles: ["owner", "admin"] });

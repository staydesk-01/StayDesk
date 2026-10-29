import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const PUT = route(c.saveOutboundSettings, { auth: true, roles: ["owner", "admin"] });

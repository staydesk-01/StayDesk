import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const DELETE = route(c.revokeConsent, { auth: true, roles: ["owner", "admin"] });

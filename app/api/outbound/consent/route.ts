import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const POST = route(c.addConsent, { auth: true, roles: ["owner", "admin"] });

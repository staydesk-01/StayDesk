import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const DELETE = route(c.removePhoneNumber, { auth: true, roles: ["owner", "admin"] });

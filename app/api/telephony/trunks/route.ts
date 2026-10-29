import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const POST = route(c.saveTrunk, { auth: true, roles: ["owner", "admin"] });

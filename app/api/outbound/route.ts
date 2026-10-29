import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const GET = route(c.listOutbound, { auth: true, roles: ["owner", "admin"] });
export const POST = route(c.createOutbound, { auth: true, roles: ["owner", "admin"] });

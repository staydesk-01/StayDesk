import { route } from "@/server/http";
import * as c from "@/server/controllers/telephonyController";

export const GET = route(c.overview, { auth: true, roles: ["owner", "admin"] });

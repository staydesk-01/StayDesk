import { route } from "@/server/http";
import * as c from "@/server/controllers/securityController";

export const GET = route(c.overview, { auth: true, roles: ["owner", "admin"] });

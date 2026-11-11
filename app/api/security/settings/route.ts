import { route } from "@/server/http";
import * as c from "@/server/controllers/securityController";

export const PUT = route(c.updateSettings, { auth: true, roles: ["owner"] });

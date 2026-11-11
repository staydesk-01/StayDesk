import { route } from "@/server/http";
import * as c from "@/server/controllers/qaController";

export const PUT = route(c.recordConcurrencyResult, { auth: true, roles: ["owner", "admin"] });

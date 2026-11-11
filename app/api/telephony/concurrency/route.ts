import { route } from "@/server/http";
import * as c from "@/server/controllers/concurrencyController";

export const GET = route(c.getConcurrency, { auth: true, roles: ["owner", "admin", "staff"] });
export const PUT = route(c.putConcurrency, { auth: true, roles: ["owner", "admin"] });

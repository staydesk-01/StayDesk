import { route } from "@/server/http";
import * as c from "@/server/controllers/qaController";

export const GET = route(c.concurrencyTests, { auth: true, roles: ["owner", "admin"] });

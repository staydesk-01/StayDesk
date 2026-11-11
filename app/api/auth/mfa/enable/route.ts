import { route } from "@/server/http";
import * as c from "@/server/controllers/authController";

export const POST = route(c.mfaEnable, { auth: true, limit: "auth" });

import { route } from "@/server/http";
import * as authController from "@/server/controllers/authController";

export const POST = route(authController.login, { limit: "auth" });

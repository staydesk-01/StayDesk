import { route } from "@/server/http";
import * as authController from "@/server/controllers/authController";

export const GET = route(authController.me, { auth: true });

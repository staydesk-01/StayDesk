import { route } from "@/server/http";
import * as notificationsController from "@/server/controllers/notificationsController";

export const POST = route(notificationsController.markAllRead, { auth: true });

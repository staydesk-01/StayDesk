import { route } from "@/server/http";
import * as notificationsController from "@/server/controllers/notificationsController";

export const GET = route(notificationsController.listNotifications, { auth: true });

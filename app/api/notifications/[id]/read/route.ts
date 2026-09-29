import { route } from "@/server/http";
import * as notificationsController from "@/server/controllers/notificationsController";

export const PATCH = route(notificationsController.markRead, { auth: true });

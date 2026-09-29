import { route } from "@/server/http";
import * as callsController from "@/server/controllers/callsController";

export const GET = route(callsController.getCall, { auth: true });
export const DELETE = route(callsController.deleteCall, { auth: true, roles: ["owner", "admin"] });

import { route } from "@/server/http";
import * as callsController from "@/server/controllers/callsController";

export const GET = route(callsController.listCalls, { auth: true });

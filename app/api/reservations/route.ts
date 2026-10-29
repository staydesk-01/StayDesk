import { route } from "@/server/http";
import * as operationsController from "@/server/controllers/operationsController";

export const GET = route(operationsController.listReservations, { auth: true });

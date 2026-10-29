import { route } from "@/server/http";
import * as operationsController from "@/server/controllers/operationsController";

export const GET = route(operationsController.getInventory, { auth: true });
export const PUT = route(operationsController.putInventory, { auth: true, roles: ["owner", "admin"] });

import { route } from "@/server/http";
import * as operationsController from "@/server/controllers/operationsController";

export const GET = route(operationsController.listPaymentApprovals, { auth: true });

import { route } from "@/server/http";
import * as operationsController from "@/server/controllers/operationsController";

// Owners and admins only: staff cannot approve payments, and the AI agent has no route here at all.
export const POST = route(operationsController.decidePaymentApproval, { auth: true, roles: ["owner", "admin"] });

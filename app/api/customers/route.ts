import { route } from "@/server/http";
import * as customersController from "@/server/controllers/customersController";

export const GET = route(customersController.listCustomers, { auth: true, roles: ["owner", "admin"] });

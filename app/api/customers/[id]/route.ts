import { route } from "@/server/http";
import * as customersController from "@/server/controllers/customersController";

export const DELETE = route(customersController.deleteCustomer, { auth: true, roles: ["owner", "admin"] });

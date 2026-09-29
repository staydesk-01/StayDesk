import { route } from "@/server/http";
import * as businessController from "@/server/controllers/businessController";

export const GET = route(businessController.getBusiness, { auth: true });
export const PATCH = route(businessController.patchBusiness, { auth: true, roles: ["owner", "admin"] });

import { route } from "@/server/http";
import * as businessController from "@/server/controllers/businessController";

export const GET = route(businessController.getBusinessKnowledge, { auth: true });
export const PATCH = route(businessController.patchBusinessKnowledge, { auth: true, roles: ["owner", "admin"] });

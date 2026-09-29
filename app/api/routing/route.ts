import { route } from "@/server/http";
import * as businessController from "@/server/controllers/businessController";

export const GET = route(businessController.getRouting, { auth: true });
export const PATCH = route(businessController.patchRouting, { auth: true, roles: ["owner", "admin"] });

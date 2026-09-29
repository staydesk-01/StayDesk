import { route } from "@/server/http";
import * as businessController from "@/server/controllers/businessController";

export const PATCH = route(businessController.updateTeamMember, { auth: true, roles: ["owner", "admin"] });

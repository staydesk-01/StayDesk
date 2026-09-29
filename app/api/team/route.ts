import { route } from "@/server/http";
import * as businessController from "@/server/controllers/businessController";

export const GET = route(businessController.listTeam, { auth: true });
export const POST = route(businessController.createTeamMember, { auth: true, roles: ["owner", "admin"] });

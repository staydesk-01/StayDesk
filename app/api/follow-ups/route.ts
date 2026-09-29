import { route } from "@/server/http";
import * as followUpsController from "@/server/controllers/followUpsController";

export const GET = route(followUpsController.listFollowUps, { auth: true });
export const POST = route(followUpsController.createFollowUp, { auth: true });

import { route } from "@/server/http";
import * as followUpsController from "@/server/controllers/followUpsController";

export const PATCH = route(followUpsController.patchFollowUp, { auth: true });

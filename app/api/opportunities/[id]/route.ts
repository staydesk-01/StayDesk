import { route } from "@/server/http";
import * as opportunitiesController from "@/server/controllers/opportunitiesController";

export const PATCH = route(opportunitiesController.patchOpportunity, { auth: true });

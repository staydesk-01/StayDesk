import { route } from "@/server/http";
import * as opportunitiesController from "@/server/controllers/opportunitiesController";

export const GET = route(opportunitiesController.listOpportunities, { auth: true });

import { route } from "@/server/http";
import * as dashboardController from "@/server/controllers/dashboardController";

export const GET = route(dashboardController.getMetrics, { auth: true });

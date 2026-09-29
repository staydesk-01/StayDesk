import { route } from "@/server/http";
import * as testAgentController from "@/server/controllers/testAgentController";

export const GET = route(testAgentController.testAgentStatus, { auth: true });

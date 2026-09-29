import { route } from "@/server/http";
import * as testAgentController from "@/server/controllers/testAgentController";

export const POST = route(testAgentController.startSession, { auth: true });

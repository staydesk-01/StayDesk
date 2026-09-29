import { route } from "@/server/http";
import * as agentToolController from "@/server/controllers/agentToolController";

export const POST = route(agentToolController.createRequest, { agent: true });

import { route } from "@/server/http";
import * as webhookController from "@/server/controllers/webhookController";

export const POST = route(webhookController.transferResult, { twilio: true });

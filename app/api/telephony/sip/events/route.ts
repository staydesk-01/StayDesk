import { route } from "@/server/http";
import * as sipGatewayController from "@/server/controllers/sipGatewayController";

// Authentication is the HMAC signature checked inside the controller (no session cookie, no shared secret in the URL).
export const POST = route(sipGatewayController.sipEvents, { limit: "webhook" });

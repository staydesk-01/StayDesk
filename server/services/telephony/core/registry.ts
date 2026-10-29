import type { Types } from "mongoose";
import { TelephonyConnection } from "../../../models";
import type { ConnectionKind } from "../../../models";
import { decryptSecret } from "../../../utils/secrets";
import { livekitAdapter } from "./adapters/livekit";
import { sipGatewayAdapter } from "./adapters/sipGateway";
import { twilioAdapter } from "./adapters/twilio";
import { vapiAdapter } from "./adapters/vapi";
import type { ConnectionContext, TelephonyAdapter } from "./types";

const adapters: Record<ConnectionKind, TelephonyAdapter> = { twilio: twilioAdapter, vapi: vapiAdapter, sip_gateway: sipGatewayAdapter, livekit: livekitAdapter };
export const getAdapter = (kind: ConnectionKind) => adapters[kind];

/** Builds the per-call view of a connection. Secrets are decrypted lazily and only for the adapter call that needs them. */
export async function loadContext(businessId: Types.ObjectId, kind: ConnectionKind): Promise<{ ctx: ConnectionContext; connectionId?: Types.ObjectId }> {
  const conn = await TelephonyConnection.findOne({ businessId, kind });
  const secrets = conn?.secrets as Map<string, { cipher?: string }> | undefined;
  return {
    connectionId: conn?._id,
    ctx: {
      businessId,
      connectionId: conn?._id,
      settings: (conn?.settings ?? {}) as Record<string, unknown>,
      secret: (name) => {
        const c = secrets?.get(name)?.cipher;
        return c ? decryptSecret(c) : undefined;
      },
    },
  };
}

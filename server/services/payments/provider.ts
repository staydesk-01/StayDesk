import type { PaymentApprovalDoc } from "../../models";

/**
 * The system that actually moves money (Stripe, Square, a hotel's POS, …). StayDesk never charges anything itself:
 * a human approves, then an authorized payment system carries it out, and only ITS confirmation marks a payment "paid".
 */
export interface PaymentProvider {
  readonly id: string;
  /** true: StayDesk calls `process` right after approval. false: staff complete it in their own system and record the reference. */
  readonly automatic: boolean;
  process(approval: PaymentApprovalDoc): Promise<{ ok: true; reference: string } | { ok: false; error: string }>;
}

/** Default: staff process the payment in their existing POS/processor and record the reference in StayDesk. */
export const manualPaymentProvider: PaymentProvider = {
  id: "manual",
  automatic: false,
  async process() {
    return { ok: false, error: "Manual provider: payments are completed by staff in their payment system." };
  },
};

let active: PaymentProvider = manualPaymentProvider;
export const getPaymentProvider = () => active;
/** Plug in a real processor adapter (or a stub in tests). */
export function setPaymentProvider(p: PaymentProvider | null) {
  active = p ?? manualPaymentProvider;
}

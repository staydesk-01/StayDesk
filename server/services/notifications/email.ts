import { Resend } from "resend";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { escapeHtml } from "../../utils/html";

let client: Resend | null | undefined;
function getClient() {
  if (client === undefined) client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  return client;
}

export type EmailResult = "sent" | "skipped" | "failed";

export async function sendEmail(opts: { to: string; subject: string; text: string; link?: string }): Promise<EmailResult> {
  const resend = getClient();
  if (!resend || env.isTest) {
    logger.info(`[email skipped] ${opts.subject} -> ${opts.to} (set RESEND_API_KEY to enable)`);
    return "skipped";
  }
  const linkHtml = opts.link
    ? `<p><a href="${escapeHtml(opts.link)}" style="background:#6d4bd1;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open in StayDesk</a></p>`
    : "";
  try {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="color:#3b1d78">${escapeHtml(opts.subject)}</h2><p style="white-space:pre-line">${escapeHtml(opts.text)}</p>${linkHtml}<p style="color:#888;font-size:12px">Sent by StayDesk AI</p></div>`,
      text: opts.text,
    });
    if (error) {
      logger.error("Resend error", { message: error.message });
      return "failed";
    }
    return "sent";
  } catch (e) {
    logger.error("Email send failed", { message: (e as Error).message });
    return "failed";
  }
}

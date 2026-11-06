export interface MailEnv {
  BREVO_API_KEY?: string;
  MAIL_FROM: string;
}

/** Auth links are sensitive: never log the body, credentials, or upstream response. */
export async function sendAuthMail(env: MailEnv, to: string, url: string, subject: string) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) throw new Error("EMAIL_NOT_CONFIGURED");
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: "TaskRelay", email: env.MAIL_FROM },
        to: [{ email: to }],
        subject,
        textContent: `${subject}\n\n请打开以下链接：\n${url}\n\n如果不是你本人操作，请忽略此邮件。`,
      }),
    });
    if (response.status !== 201) throw new Error("EMAIL_DELIVERY_FAILED");
    const result = (await response.json()) as { messageId?: string };
    if (!result.messageId) throw new Error("EMAIL_DELIVERY_FAILED");
  } catch {
    // An uncertain send is not automatically replayed; the user can request a fresh link.
    throw new Error("EMAIL_DELIVERY_FAILED");
  }
}

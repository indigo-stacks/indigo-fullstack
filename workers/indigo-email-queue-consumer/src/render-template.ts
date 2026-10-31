import type {ReactElement} from "react";
import {render} from "@react-email/render";
import type {EmailTemplate} from "@app/lib/email-queue";

import EmailVerification from "@app/components/email/EmailVerification";
import PasswordReset from "@app/components/email/PasswordReset";
import AccountDeleted from "@app/components/email/AccountDeleted";
import WelcomeEmail from "@app/components/email/WelcomeEmail";
import CustomEmail from "@app/components/email/CustomEmail";

function templateElement(
  template: EmailTemplate,
  locale: string
): ReactElement {
  switch (template.type) {
    case "email-verification":
      return EmailVerification({...template.props, locale});
    case "password-reset":
      return PasswordReset({...template.props, locale});
    case "account-deleted":
      return AccountDeleted({...template.props, locale});
    case "welcome":
      return WelcomeEmail({...template.props, locale});
    case "custom":
      return CustomEmail({...template.props, locale});
    default: {
      const _exhaustive: never = template;
      throw new Error(`Unknown template type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Render an email template to an HTML body plus a plain-text alternative.
 * The text part is sent alongside the HTML body and improves deliverability
 * (some receivers spam-folder or reject HTML-only mail).
 */
export async function renderEmailTemplate(
  template: EmailTemplate,
  locale: string
): Promise<{html: string; text: string}> {
  const element = templateElement(template, locale);

  const [html, text] = await Promise.all([
    render(element),
    render(element, {plainText: true})
  ]);

  return {html, text};
}

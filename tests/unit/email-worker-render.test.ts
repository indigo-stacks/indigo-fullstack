import {describe, expect, it} from "vitest";
import type {EmailTemplate} from "@/lib/email-queue";
import {renderEmailTemplate} from "../../workers/indigo-email-queue-consumer/src/render-template";

const templates: Array<{
  name: string;
  template: Exclude<EmailTemplate, {type: "custom"}>;
  expected: {en: string; ja: string};
}> = [
  {
    name: "email verification",
    template: {
      type: "email-verification",
      props: {name: "Alex", url: "https://example.com/verify"}
    },
    expected: {
      en: "Thanks for signing up! Please verify your email address to complete your registration.",
      ja: "ご登録ありがとうございます！登録を完了するには、メールアドレスを確認してください。"
    }
  },
  {
    name: "password reset",
    template: {
      type: "password-reset",
      props: {name: "Alex", resetLink: "https://example.com/reset"}
    },
    expected: {
      en: "We received a request to reset your password.",
      ja: "パスワードのリセットのリクエストを受け付けました。"
    }
  },
  {
    name: "account deleted",
    template: {
      type: "account-deleted",
      props: {name: "Alex"}
    },
    expected: {
      en: "Your account has been successfully deleted.",
      ja: "アカウントが正常に削除されました。"
    }
  },
  {
    name: "welcome",
    template: {
      type: "welcome",
      props: {name: "Alex"}
    },
    expected: {
      en: "Thank you for joining us.",
      ja: "ご参加いただきありがとうございます。"
    }
  }
];

describe("email worker rendering", () => {
  for (const locale of ["en", "ja"] as const) {
    describe(locale, () => {
      for (const {name, template, expected} of templates) {
        it(`renders ${name} with localized content`, async () => {
          const {html, text} = await renderEmailTemplate(template, locale);

          expect(html).toMatch(/^<!DOCTYPE html\b/);
          expect(html).toContain(expected[locale]);
          expect(html).not.toContain("Mock Email Content");
          expect(text).toContain(expected[locale]);
          expect(text).not.toContain("<!DOCTYPE");
          expect(text).not.toContain("Mock Email Content");
        });
      }

      it("renders custom content", async () => {
        const {html, text} = await renderEmailTemplate(
          {
            type: "custom",
            props: {
              html: "<p>Custom content</p>",
              title: "Custom title"
            }
          },
          locale
        );

        expect(html).toMatch(/^<!DOCTYPE html\b/);
        expect(html).toContain("Custom content");
        expect(html).toContain("Custom title");
        expect(html).not.toContain("Mock Email Content");
        expect(text).toContain("Custom content");
        expect(text.toLowerCase()).toContain("custom title");
        expect(text).not.toContain("<!DOCTYPE");
        expect(text).not.toContain("Mock Email Content");
      });
    });
  }
});

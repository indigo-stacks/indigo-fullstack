import {beforeEach, describe, expect, it, vi} from "vitest";
import type {EmailQueueMessage} from "@/lib/email-queue";
import worker, {
  type Env
} from "../../workers/indigo-email-queue-consumer/src/index";
import {
  classifyEmailSendError,
  isEmailAddress,
  parseFromAddress
} from "../../workers/indigo-email-queue-consumer/src/send-email";

function sendError(code: string): Error {
  return Object.assign(new Error(code), {code});
}

function queueMessage(attempts = 1) {
  return {
    body: {
      to: "alex@example.com",
      subject: "Verify your email",
      template: {
        type: "email-verification",
        props: {name: "Alex", url: "https://example.com/verify"}
      },
      locale: "en",
      queuedAt: "2026-10-30T00:00:00.000Z"
    } satisfies EmailQueueMessage,
    attempts,
    ack: vi.fn(),
    retry: vi.fn()
  };
}

async function consume(
  message: ReturnType<typeof queueMessage>,
  send: SendEmail["send"],
  sendEmailFrom = "Indigo Stack <noreply@indigostack.org>"
) {
  const env = {
    EMAIL: {send},
    SEND_EMAIL_FROM: sendEmailFrom
  } as Env;
  const batch = {
    messages: [message]
  } as unknown as MessageBatch<EmailQueueMessage>;

  await worker.queue(batch, env);
}

describe("classifyEmailSendError", () => {
  it.each([
    "E_VALIDATION_ERROR",
    "E_RECIPIENT_SUPPRESSED",
    "E_RECIPIENT_NOT_ALLOWED",
    "E_CONTENT_TOO_LARGE",
    "E_HEADER_VALUE_INVALID"
  ])("acks the message-specific error %s", (code) => {
    expect(classifyEmailSendError(sendError(code))).toBe("ack");
  });

  // These hit every message alike and clear once the account is fixed, so the
  // messages must reach the dead letter queue for a replay, not be dropped.
  it.each([
    "E_SENDER_NOT_VERIFIED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_ACCOUNT_SUSPENDED",
    "E_DAILY_LIMIT_EXCEEDED"
  ])("retries the account-wide error %s", (code) => {
    expect(classifyEmailSendError(sendError(code))).toBe("retry");
  });

  it.each([
    ["a transient code", sendError("E_RATE_LIMIT_EXCEEDED")],
    ["an error without a code", new Error("network down")],
    ["a non-error value", null]
  ])("retries %s", (_, error) => {
    expect(classifyEmailSendError(error)).toBe("retry");
  });
});

describe("parseFromAddress", () => {
  it("splits a display name from the address", () => {
    expect(parseFromAddress("Indigo Stack <noreply@indigostack.org>")).toEqual({
      name: "Indigo Stack",
      email: "noreply@indigostack.org"
    });
  });

  it("accepts a bare address", () => {
    expect(parseFromAddress("noreply@indigostack.org")).toEqual({
      name: "Indigo Stack",
      email: "noreply@indigostack.org"
    });
  });
});

describe("isEmailAddress", () => {
  it("accepts a plain address", () => {
    expect(isEmailAddress("noreply@indigostack.org")).toBe(true);
  });

  it.each([
    "noreply",
    "noreply@indigostack",
    "Indigo Stack noreply@indigostack.org",
    "<noreply@indigostack.org>"
  ])("rejects %s", (value) => {
    expect(isEmailAddress(value)).toBe(false);
  });
});

describe("email queue consumer", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends the rendered email and acks", async () => {
    const message = queueMessage();
    const send = vi.fn().mockResolvedValue({messageId: "id"});

    await consume(message, send);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alex@example.com",
        from: {name: "Indigo Stack", email: "noreply@indigostack.org"},
        subject: "Verify your email",
        html: expect.stringMatching(/^<!DOCTYPE html\b/),
        text: expect.any(String)
      })
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acks a suppressed recipient without retrying", async () => {
    const message = queueMessage();

    await consume(
      message,
      vi.fn().mockRejectedValue(sendError("E_RECIPIENT_SUPPRESSED"))
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([
    [1, 60],
    [2, 120],
    [3, 240]
  ])(
    "retries an unverified sender on attempt %i after %is",
    async (attempts, delaySeconds) => {
      const message = queueMessage(attempts);

      await consume(
        message,
        vi.fn().mockRejectedValue(sendError("E_SENDER_NOT_VERIFIED"))
      );

      expect(message.retry).toHaveBeenCalledWith({delaySeconds});
      expect(message.ack).not.toHaveBeenCalled();
    }
  );

  // The binding would reject the sender as E_VALIDATION_ERROR, which acks.
  it("retries without sending when SEND_EMAIL_FROM is malformed", async () => {
    const message = queueMessage();
    const send = vi.fn();

    await consume(message, send, "Indigo Stack <noreply>");

    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({delaySeconds: 60});
    expect(message.ack).not.toHaveBeenCalled();
  });
});

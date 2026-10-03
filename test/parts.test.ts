import { describe, expect, it } from "vitest";

import { localeOf, render } from "../src/messages.ts";
import { isPlaceholderEmail, placeholderEmail, toE164 } from "../src/phone.ts";
import { resend, smsoffice } from "../src/senders.ts";

describe("phone numbers", () => {
  it("are E.164, a Georgian mobile however it is typed", () => {
    expect(toE164("555 12 34 56")).toBe("+995555123456");
    expect(toE164("+995 555-12-34-56")).toBe("+995555123456");
    expect(toE164("995555123456")).toBe("+995555123456");
    expect(toE164("+14155550123")).toBe("+14155550123");
    expect(toE164("12345")).toBeNull();
    expect(isPlaceholderEmail(placeholderEmail("+995555123456"))).toBe(true);
  });
});

describe("letters", () => {
  it("escape what they carry", () => {
    const letter = render({ body: "<b>hi</b>", button: { label: "Go", url: 'https://x.test/?a="1"' }, subject: "S" }, "a@b.test");
    expect(letter.html).toContain("&#60;b&#62;hi&#60;/b&#62;");
    expect(letter.html).toContain("https://x.test/?a=&#34;1&#34;");
    expect(letter.text).toBe('<b>hi</b>\n\nhttps://x.test/?a="1"');
  });

  it("are in the person's language", () => {
    const ask = (headers: Record<string, string>) => localeOf(new Request("https://x.test", { headers }));
    expect(ask({})).toBe("ka");
    expect(ask({ "accept-language": "en-US,en;q=0.9" })).toBe("en");
    expect(ask({ "accept-language": "en", cookie: "lang=ka" })).toBe("ka");
  });
});

describe("senders", () => {
  it("text through smsoffice.ge with the number as 995…", async () => {
    let sent: URLSearchParams | null = null;
    const send = smsoffice({
      apiKey: "k",
      fetcher: (async (_url: string, init: RequestInit) => {
        sent = init.body as URLSearchParams;
        return Response.json({ Success: true });
      }) as typeof fetch,
      sender: "Shop",
    });
    await send("+995555123456", "hi");
    expect(Object.fromEntries(sent!)).toEqual({ content: "hi", destination: "995555123456", key: "k", sender: "Shop", urgent: "true" });
  });

  it("say when smsoffice.ge or Resend refuses", async () => {
    const refuse = (async () => Response.json({ ErrorCode: 20, Message: "no balance", Success: false })) as unknown as typeof fetch;
    await expect(smsoffice({ apiKey: "k", fetcher: refuse, sender: "S" })("+995555123456", "x")).rejects.toThrow("smsoffice: 20 no balance");
    const bad = (async () => new Response("bad from", { status: 422 })) as unknown as typeof fetch;
    await expect(resend({ apiKey: "k", fetcher: bad, from: "x" })({ html: "", subject: "", text: "", to: "a@b.test" })).rejects.toThrow("resend: 422 bad from");
  });
});

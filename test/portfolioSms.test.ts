import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/messaging/Messenger";
import { MessagingEndpoints } from "../src/messaging/endpoints";
import type { InboundMessage } from "../src/messaging/inbound";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { MessagingConversations } from "../src/visitor/messagingRouter";
import { NOTHING_BOOKED_CANCEL } from "../src/core/TourCore";
import { smsStopAck } from "../src/visitor/smsConsent";
import { pickerMiss, placeAliases, propertyPickerText, propertyShortName, resolveNamedPlace, STREET_MISS } from "../src/visitor/portfolioPick";
import { SMS_KEYWORD_PROMPT, smsDisclosure } from "../src/visitor/smsConsent";
import { publicBaseUrl } from "../src/messaging/publicUrl";
import { effectiveEnv } from "../src/install/settings";
import { VerificationLinks } from "../src/visitor/verificationLinks";
import { grokHarness, type GrokHarness } from "./grokHarness";

/**
 * One touring number covers every published property. Critiquito strings are
 * the literals below.
 */

const LINE = "+15555550100";

describe("property picker copy", () => {
  it("uses the public name, or the street when there is no public name", () => {
    expect(propertyShortName({ address: "88 Pine St, Teaneck, NJ 07666", displayName: "The Pines", canonicalAddress: { street: "88 Pine St" } })).toBe("The Pines");
    expect(propertyShortName({ address: "88 Pine St, Teaneck, NJ 07666", canonicalAddress: { street: "88 Pine St" } })).toBe("88 Pine St");
    expect(propertyShortName({ address: "88 Pine St, Teaneck, NJ 07666", displayName: "88 Pine St", canonicalAddress: { street: "88 Pine St" } })).toBe("88 Pine St");
  });

  it("lists two or three places and the exact reply line", () => {
    expect(propertyPickerText(["Scratch House", "88 Pine St"], false)).toBe(
      ["Which place are you touring?", "1. Scratch House", "2. 88 Pine St", "Reply 1 or 2."].join("\n"),
    );
    expect(propertyPickerText(["Scratch House", "88 Pine St", "4 Oak Ave"], false)).toBe(
      ["Which place are you touring?", "1. Scratch House", "2. 88 Pine St", "3. 4 Oak Ave", "Reply 1, 2, or 3."].join("\n"),
    );
    expect(pickerMiss(2)).toBe("I didn't catch that. Reply 1 or 2 for which place.");
    expect(pickerMiss(3)).toBe("I didn't catch that. Reply 1, 2, or 3 for which place.");
    expect(propertyPickerText(["Scratch House", "88 Pine St", "4 Oak Ave"], true)).toBe(
      ["Which place are you touring?", "1. Scratch House", "2. 88 Pine St", "3. 4 Oak Ave", "Reply 1, 2, or 3.", "Or text the street name."].join("\n"),
    );
    expect(STREET_MISS).toBe("I couldn't find that one. Reply 1, 2, or 3, or text the street name.");
  });

  it("a named street or a listing link picks one property, and a bare Tour does not", () => {
    const pine = { id: "prop_pine", aliases: placeAliases({ address: "88 Pine St, Teaneck, NJ", canonicalAddress: { street: "88 Pine St" } }) };
    const scratch = { id: "prop_scratch", aliases: placeAliases({ address: "12 Scratch Lane, Teaneck, NJ", displayName: "Scratch House", canonicalAddress: { street: "12 Scratch Lane" } }) };
    expect(resolveNamedPlace({ text: "Tour" }, [pine, scratch])).toBeUndefined();
    expect(resolveNamedPlace({ text: "Tour 88 Pine" }, [pine, scratch])).toBe("prop_pine");
    expect(resolveNamedPlace({ text: "Tour Scratch House" }, [pine, scratch])).toBe("prop_scratch");
    expect(resolveNamedPlace({ text: "Tour", listingProperty: "prop_pine" }, [pine, scratch])).toBe("prop_pine");
    expect(resolveNamedPlace({ text: "Tour https://listings.example/tour?property=prop_scratch" }, [pine, scratch])).toBe("prop_scratch");
  });
});

describe("shared portfolio line", () => {
  let h: GrokHarness;
  let scratch: string;
  let pine: string;
  let text: (from: string, body: string, extra?: Partial<InboundMessage>) => Promise<string[]>;

  beforeAll(async () => {
    const built = await buildPublished([
      { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" },
      { address: "88 Pine St, Teaneck, NJ 07666" },
    ]);
    h = built.h;
    scratch = built.ids[0]!;
    pine = built.ids[1]!;
    text = built.text;
  }, 120_000);

  afterAll(() => h?.cleanup());

  it("asks which place on an ambiguous first text, then 1 is that property's welcome", async () => {
    const phone = "+15555550111";
    const asked = await text(phone, "Tour");
    // Newest published first: pine was published after Scratch House.
    expect(asked).toEqual([
      ["Which place are you touring?", `1. ${short(h, pine)}`, `2. ${short(h, scratch)}`, "Reply 1 or 2."].join("\n"),
    ]);
    const opened = await text(phone, "1");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("Hi! Welcome to the self-guided tour for 88 Pine St");
    expect(opened[0]).toContain("Which day works for you?");
    expect(opened[0]).not.toMatch(/got it|which place|I didn't catch/i);
    expect(h.visitors.latestForPhone(pine, phone, "messaging")?.propertyId).toBe(pine);
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")).toBeUndefined();
  });

  it("a bad reply uses the miss line and still waits for a pick", async () => {
    const phone = "+15555550112";
    await text(phone, "Tour");
    const missed = await text(phone, "blue");
    expect(missed).toEqual(["I didn't catch that. Reply 1 or 2 for which place."]);
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")).toBeUndefined();
    expect(h.visitors.latestForPhone(pine, phone, "messaging")).toBeUndefined();
    const opened = await text(phone, "2");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("Scratch House");
    expect(opened[0]).toContain("Which day works for you?");
    expect(opened[0]).not.toMatch(/got it|which place/i);
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")?.propertyId).toBe(scratch);
    expect(h.visitors.latestForPhone(pine, phone, "messaging")).toBeUndefined();
  });

  it("a named first text starts that property with no picker", async () => {
    const phone = "+15555550113";
    const opened = await text(phone, "Tour 88 Pine");
    expect(opened.join("\n")).not.toContain("Which place are you touring?");
    expect(opened.join("\n")).toContain("88 Pine St");
    expect(opened.join("\n")).toContain("Hi! Welcome");
    expect(h.visitors.latestForPhone(pine, phone, "messaging")?.propertyId).toBe(pine);
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")).toBeUndefined();
  });

  it("a listing deep link starts that property with no picker", async () => {
    const phone = "+15555550114";
    const opened = await text(phone, "Tour", { listingProperty: pine });
    expect(opened.join("\n")).not.toContain("Which place are you touring?");
    expect(opened.join("\n")).toContain("88 Pine St");
    expect(h.visitors.latestForPhone(pine, phone, "messaging")?.propertyId).toBe(pine);

    const other = "+15555550115";
    const linked = await text(other, `Tour https://listings.example/tour?property=${encodeURIComponent(scratch)}`);
    expect(linked.join("\n")).not.toContain("Which place are you touring?");
    expect(linked.join("\n")).toContain("Scratch House");
    expect(h.visitors.latestForPhone(scratch, other, "messaging")?.propertyId).toBe(scratch);
  });

  it("cancel at the property picker stops, then the next text asks which place again", async () => {
    const phone = "+15555550117";
    const asked = await text(phone, "Hi");
    expect(asked[0]).toContain("Which place are you touring?");
    const stopped = await text(phone, "Actually cancel that");
    expect(stopped).toEqual([NOTHING_BOOKED_CANCEL]);
    expect(stopped[0]).not.toContain("didn't catch that");
    expect(stopped[0]).not.toContain("Which place");
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")).toBeUndefined();
    expect(h.visitors.latestForPhone(pine, phone, "messaging")).toBeUndefined();
    const again = await text(phone, "hi");
    expect(again[0]).toContain("Which place are you touring?");
    expect(again[0]).not.toContain("didn't catch that");

    const dayPhone = "+15555550146";
    await text(dayPhone, "Hi");
    const stoppedDay = await text(dayPhone, "Actually cancel that");
    expect(stoppedDay).toEqual([NOTHING_BOOKED_CANCEL]);
    const thursday = await text(dayPhone, "Thursday");
    expect(thursday[0]).toContain("Which place are you touring?");
    expect(thursday[0]).not.toBe(NOTHING_BOOKED_CANCEL);
    expect(thursday[0]).not.toContain("didn't catch that");
  });

  it("nevermind at the picker uses the same stop line, and bare cancel still opts out", async () => {
    const phone = "+15555550118";
    await text(phone, "Tour");
    const stopped = await text(phone, "nevermind");
    expect(stopped).toEqual([NOTHING_BOOKED_CANCEL]);
    const opted = await text("+15555550119", "Tour");
    expect(opted[0]).toContain("Which place are you touring?");
    const out = await text("+15555550119", "cancel");
    expect(out.join("\n")).toBe(smsStopAck());
    expect(out.join("\n")).not.toContain("nothing's booked");
  });

  it("after a pick, a follow-up stays on the chosen property", async () => {
    const phone = "+15555550116";
    await text(phone, "Tour");
    // 1 is the newer place (88 Pine). 2 locks Scratch House for the rest of the tour.
    await text(phone, "2");
    const day = await text(phone, "1");
    expect(day.join("\n")).toContain("I have these times available");
    expect(day.join("\n")).not.toContain("Which place are you touring?");
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")?.propertyId).toBe(scratch);
    const namedOther = await text(phone, "Tour 88 Pine");
    expect(namedOther.join("\n")).not.toContain("Which place are you touring?");
    expect(namedOther.join("\n")).not.toContain("88 Pine St, Teaneck");
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")?.propertyId).toBe(scratch);
    expect(h.visitors.latestForPhone(pine, phone, "messaging")).toBeUndefined();
  });
});

describe("one published property skips the picker", () => {
  let h: GrokHarness;
  let text: (from: string, body: string) => Promise<string[]>;

  beforeAll(async () => {
    const built = await buildPublished([{ address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" }], {
      draft: { address: "88 Pine St, Teaneck, NJ 07666" },
    });
    h = built.h;
    text = built.text;
  }, 120_000);

  afterAll(() => h?.cleanup());

  it("a bare Tour starts the only published property", async () => {
    const opened = await text("+15555550121", "Tour");
    expect(opened.join("\n")).not.toContain("Which place are you touring?");
    expect(opened.join("\n")).toContain("Scratch House");
    expect(opened.join("\n")).toContain("Which day works for you?");
  });
});

describe("four published properties", () => {
  let h: GrokHarness;
  let ids: string[];
  let text: (from: string, body: string) => Promise<string[]>;

  beforeAll(async () => {
    const built = await buildPublished([
      { address: "9 Birch Rd, Teaneck, NJ 07666" },
      { address: "4 Oak Ave, Teaneck, NJ 07666" },
      { address: "88 Pine St, Teaneck, NJ 07666" },
      { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" },
    ]);
    h = built.h;
    ids = built.ids;
    text = built.text;
  }, 180_000);

  afterAll(() => h?.cleanup());

  it("shows the three most recently published, then a street name locks any of them", async () => {
    const newest = [...ids].sort((a, b) => publishedAt(h, b).localeCompare(publishedAt(h, a)));
    const phone = "+15555550131";
    const asked = await text(phone, "Tour");
    const shown = newest.slice(0, 3).map((id) => short(h, id));
    expect(asked).toEqual([["Which place are you touring?", ...shown.map((name, i) => `${i + 1}. ${name}`), "Reply 1, 2, or 3.", "Or text the street name."].join("\n")]);
    expect(asked[0]).not.toContain(short(h, newest[3]!));

    const missedNumber = await text(phone, "9");
    expect(missedNumber).toEqual(["I didn't catch that. Reply 1, 2, or 3 for which place."]);
    const missedStreet = await text(phone, "999 Nowhere");
    expect(missedStreet).toEqual(["I couldn't find that one. Reply 1, 2, or 3, or text the street name."]);
    expect(ids.every((id) => !h.visitors.latestForPhone(id, phone, "messaging"))).toBe(true);

    const oldest = newest[3]!;
    const opened = await text(phone, short(h, oldest));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("Hi! Welcome");
    expect(opened[0]).toContain(short(h, oldest));
    expect(opened[0]).not.toMatch(/got it|which place|couldn't find/i);
    expect(h.visitors.latestForPhone(oldest, phone, "messaging")?.propertyId).toBe(oldest);
  });
});

describe("a property pick is the texting opt-in", () => {
  let h: GrokHarness;
  let pine: string;
  let scratch: string;
  let text: (from: string, body: string) => Promise<string[]>;
  const disclosure = () => smsDisclosure(publicBaseUrl(effectiveEnv()));

  beforeAll(async () => {
    const built = await buildPublished(
      [
        { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" },
        { address: "88 Pine St, Teaneck, NJ 07666" },
      ],
      { consentMode: "keyword_confirm" },
    );
    h = built.h;
    scratch = built.ids[0]!;
    pine = built.ids[1]!;
    text = built.text;
  }, 120_000);

  afterAll(() => h?.cleanup());

  it("Hi then 1 sends the same disclosure as texting TOUR, never the keyword prompt", async () => {
    const phone = "+15555550141";
    const asked = await text(phone, "Hi");
    expect(asked[0]).toContain("Which place are you touring?");
    expect(asked.join("\n")).not.toContain(SMS_KEYWORD_PROMPT);

    const picked = await text(phone, "1");
    expect(picked).toEqual([disclosure()]);
    expect(picked.join("\n")).not.toContain(SMS_KEYWORD_PROMPT);
    expect(picked.join("\n")).not.toContain("Text TOUR");
    expect(h.visitors.latestForPhone(pine, phone, "messaging")?.propertyId).toBe(pine);
    expect(h.visitors.latestForPhone(scratch, phone, "messaging")).toBeUndefined();
  });

  it("a street-name pick in the 4+ list is the same opt-in", async () => {
    const more = await buildPublished(
      [
        { address: "9 Birch Rd, Teaneck, NJ 07666" },
        { address: "4 Oak Ave, Teaneck, NJ 07666" },
        { address: "88 Pine St, Teaneck, NJ 07666" },
        { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" },
      ],
      { consentMode: "keyword_confirm" },
    );
    const newest = [...more.ids].sort((a, b) => publishedAt(more.h, b).localeCompare(publishedAt(more.h, a)));
    const oldest = newest[3]!;
    const phone = "+15555550144";
    await more.text(phone, "Hi");
    const picked = await more.text(phone, short(more.h, oldest));
    expect(picked).toEqual([smsDisclosure(publicBaseUrl(effectiveEnv()))]);
    expect(picked.join("\n")).not.toContain(SMS_KEYWORD_PROMPT);
    expect(more.h.visitors.latestForPhone(oldest, phone, "messaging")?.propertyId).toBe(oldest);
    more.h.cleanup();
  });

  it("keeps the welcome on reply 1 when texting consent is off", async () => {
    expect(scratch).toBeTruthy();
    const off = await buildPublished(
      [
        { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House" },
        { address: "88 Pine St, Teaneck, NJ 07666" },
      ],
      { consentMode: "disabled" },
    );
    const phone = "+15555550145";
    await off.text(phone, "Hi");
    const opened = await off.text(phone, "1");
    expect(opened[0]).toContain("Hi! Welcome");
    expect(opened.join("\n")).not.toContain(SMS_KEYWORD_PROMPT);
    expect(opened.join("\n")).not.toContain("Reply YES to continue");
    off.h.cleanup();
  });
});

function short(h: GrokHarness, id: string): string {
  return propertyShortName(h.workspace.load(id).config.property);
}

function publishedAt(h: GrokHarness, id: string): string {
  return h.workspace.load(id).state.publishedAt ?? "";
}

async function buildPublished(
  homes: { address: string; name?: string }[],
  options: { draft?: { address: string }; consentMode?: "keyword_confirm" | "disabled" } = {},
) {
  const h = grokHarness();
  const ids: string[] = [];
  for (const home of homes) ids.push(await publishHome(h, home.address, home.name));
  const draftIds: string[] = [];
  if (options.draft) draftIds.push(await draftHome(h, options.draft.address));
  const runtime = new MemoryRuntimeStore();
  const endpoints = new MessagingEndpoints(runtime);
  for (const id of [...ids, ...draftIds]) endpoints.attach({ address: LINE, provider: "demo", propertyId: id });
  const sent: string[] = [];
  const transport = {
    provider: "demo",
    presentation: "MESSAGING" as const,
    async send(message: OutgoingMessage) {
      sent.push(message.body);
      return { provider: "demo", channel: "DEMO" as const, status: "SENT" as const, sentAt: new Date().toISOString() };
    },
  };
  const router = new MessagingConversations({
    workspace: h.workspace,
    registry: h.visitors,
    runtime,
    endpoints,
    transport: () => transport,
    links: new VerificationLinks({ baseUrl: () => undefined }),
    realNow: () => h.now(),
    now: () => new Date(h.now()),
    defaultLine: () => LINE,
    consentMode: () => options.consentMode ?? "disabled",
  });
  let n = 0;
  const text = async (from: string, body: string, extra: Partial<InboundMessage> = {}) => {
    const before = sent.length;
    await router.receive({
      provider: "demo",
      providerMessageId: `m_${++n}`,
      from,
      to: LINE,
      text: body,
      channel: "SMS",
      receivedAt: new Date(h.now()).toISOString(),
      ...extra,
    });
    return sent.slice(before);
  };
  return { h, ids, text };
}

async function publishHome(h: GrokHarness, address: string, name?: string): Promise<string> {
  h.setClock(h.now() + 60_000);
  const created = await h.ok("create_property_setup", { address, ...(name ? { name } : {}), propertyType: "SINGLE_FAMILY" });
  const id = created.setup.propertyId as string;
  await finishHome(h, id);
  await h.ok("run_readiness_check", { property: id });
  h.workspace.recordDryTour(id, { passed: true, ranAt: new Date(h.now()).toISOString(), checks: [], audit: [] });
  await h.approve("publish_demo_property", { property: id });
  return id;
}

async function draftHome(h: GrokHarness, address: string): Promise<string> {
  const created = await h.ok("create_property_setup", { address, propertyType: "SINGLE_FAMILY" });
  const id = created.setup.propertyId as string;
  await finishHome(h, id);
  return id;
}

async function finishHome(h: GrokHarness, id: string): Promise<void> {
  const at = { property: id };
  await h.ok("add_unit", at);
  await h.ok("set_unit_details", { ...at, units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
  await h.ok("set_tour_hours", { ...at, days: "weekdays", start: "9am", end: "5pm" });
  await h.ok("set_verification_policy", { ...at, level: "basic-form" });
  await h.ok("update_property_details", { ...at, skipVisitorHelp: true });
}

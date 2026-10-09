import { afterEach, describe, expect, it } from "vitest";
import { toursUnavailableText } from "../src/sms/templates";
import { smsDisclosure } from "../src/visitor/smsConsent";
import { PUBLIC } from "./fakeSendblue";
import { liveApp, PHONE } from "./liveApp";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const PROPERTY = "prop_100_alfred_way";
const OTHER = "+15550102099";
const UNAVAILABLE = toursUnavailableText("100 Alfred Way", "property team");

describe("unpublished properties do not take a new visitor text", () => {
  it("a published property sends the campaign disclosure, and the same property back in draft refuses a new visitor", async () => {
    const app = await liveApp({ cleanups });
    expect(app.ws.load(PROPERTY).state.status).toBe("PUBLISHED_FOR_DEMO");

    const before = await app.text("TOUR");
    expect(before).toEqual([smsDisclosure(PUBLIC)]);
    expect(app.visitors.latestForPhone(PROPERTY, PHONE, "messaging")).toBeTruthy();

    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    expect(app.ws.load(PROPERTY).state.readiness?.passed).toBe(true);
    const after = await app.textFrom(OTHER, "TOUR");
    expect(after).toEqual([UNAVAILABLE]);
    expect(app.visitors.latestForPhone(PROPERTY, OTHER, "messaging")).toBeUndefined();
  });

  it("keeps a tour that was booked before the property went back to draft", async () => {
    const app = await liveApp({ cleanups });
    await app.book();
    const booked = app.visitors.latestForPhone(PROPERTY, PHONE, "messaging");
    expect(booked).toBeTruthy();
    app.ws.patchState(PROPERTY, { status: "DRAFT" });
    const replies = await app.text("Is there a gym?");
    expect(replies.join("\n")).not.toBe(UNAVAILABLE);
    expect(app.visitors.latestForPhone(PROPERTY, PHONE, "messaging")?.id).toBe(booked!.id);
  });
});

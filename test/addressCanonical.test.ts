import { describe, expect, it } from "vitest";
import { addressConfirmQuestion, canonicalizeStreet, parseUsAddress } from "../src/setup/address";

describe("address canonicalization", () => {
  it("expands only the final street type and keeps the landlord's casing", () => {
    expect(canonicalizeStreet("12 St. Marks Place")).toBe("12 St. Marks Place");
    expect(canonicalizeStreet("12 St. Marks Place")).not.toContain("Street Marks");
    expect(canonicalizeStreet("400 Dr Martin Luther King Jr Blvd")).toBe("400 Dr Martin Luther King Jr Boulevard");
    expect(canonicalizeStreet("1 Rue St Louis")).toBe("1 Rue St Louis");
    expect(canonicalizeStreet("910 QA Gate Rd")).toBe("910 QA Gate Road");
    expect(canonicalizeStreet("NE 2nd Ave")).toBe("NE 2nd Avenue");
    expect(canonicalizeStreet("12 NE Main St")).toBe("12 NE Main Street");
    expect(canonicalizeStreet("5 McArthur Blvd")).toBe("5 McArthur Boulevard");
    expect(canonicalizeStreet("5 McDonald Ave")).toBe("5 McDonald Avenue");
    expect(canonicalizeStreet("18 maple st.")).toBe("18 Maple Street");
    expect(canonicalizeStreet("8 O'Neil Ct")).toBe("8 O'Neil Court");
    expect(canonicalizeStreet("12 Oak Ave Apt 2")).toBe("12 Oak Avenue Apt 2");
    expect(canonicalizeStreet("Ave S")).toBe("Avenue S");
    expect(canonicalizeStreet("St NW")).toBe("Street NW");
  });

  it("stores one form for the same address said in different case", () => {
    const forms = ["18 Maple Street, Teaneck, NJ 07666", "18 maple street, teaneck, nj 07666", "18 MAPLE STREET, TEANECK, NJ 07666", "18 Maple St., Teaneck, NJ 07666"];
    const stored = forms.map((raw) => parseUsAddress(raw)?.address.formatted);
    expect(stored).toEqual([
      "18 Maple Street, Teaneck, NJ 07666",
      "18 Maple Street, Teaneck, NJ 07666",
      "18 Maple Street, Teaneck, NJ 07666",
      "18 Maple Street, Teaneck, NJ 07666",
    ]);
    expect(parseUsAddress("18 Maple Street, Teaneck, NJ 07666")?.address).not.toHaveProperty("unit");
  });

  it("reads a condo unit back between the street and the city", () => {
    const parsed = parseUsAddress("300 Main Street, Unit 4B, Hackensack, NJ 07601");
    expect(parsed?.address).toEqual({
      street: "300 Main Street",
      unit: "Unit 4B",
      city: "Hackensack",
      state: "NJ",
      postalCode: "07601",
      formatted: "300 Main Street, Unit 4B, Hackensack, NJ 07601",
    });
    expect(addressConfirmQuestion(parsed?.address)).toBe("Did I get that right: 300 Main Street, Unit 4B, Hackensack, NJ 07601?");
  });

  it("does not read an address back when the city is blank", () => {
    const parsed = parseUsAddress("300 Main Street, Unit 4B, NJ 07601");
    expect(parsed?.address).toMatchObject({ street: "300 Main Street", unit: "Unit 4B", city: "", state: "NJ", postalCode: "07601" });
    expect(parsed?.missing).toContain("city");
    expect(addressConfirmQuestion(parsed?.address)).toBeUndefined();
  });
});

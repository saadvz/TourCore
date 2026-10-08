import { describe, expect, it } from "vitest";
import { canonicalizeStreet, parseUsAddress } from "../src/setup/address";

describe("address canonicalization", () => {
  it("expands only the final street type and keeps the landlord's casing", () => {
    expect(canonicalizeStreet("12 St. Marks Place")).toBe("12 St Marks Place");
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
  });
});

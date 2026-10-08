import { describe, expect, it } from "vitest";
import { unitScopeDetail } from "../src/operator/availability";
import { describeTourDays, settingsSentence } from "../src/operator/milestones";

describe("milestone landlord copy", () => {
  it("groups touring days and speaks the clock", () => {
    expect(describeTourDays(["MON", "TUE", "WED", "THU", "FRI"])).toBe("Monday to Friday");
    expect(describeTourDays(["MON", "WED", "FRI"])).toBe("Monday, Wednesday and Friday");
    expect(describeTourDays(["MON", "TUE", "WED", "THU", "FRI", "SUN"])).toBe("Monday to Friday and Sunday");
    expect(`Tours run ${describeTourDays(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])}, 9 AM to 5 PM.`).toBe("Tours run every day, 9 AM to 5 PM.");
  });

  it("says the identity check and tour updates as one sentence", () => {
    expect(settingsSentence("basic-form", true)).toBe("Visitors will fill out a basic identity form, and tour updates are off for now.");
    expect(settingsSentence("basic-form", false)).toBe("Visitors will fill out a basic identity form, and tour updates stay as they are.");
    expect(settingsSentence("mock", true)).toBe("Visitors will pass the identity check automatically, and tour updates are off for now.");
    expect(settingsSentence("mock", false)).toBe("Visitors will pass the identity check automatically, and tour updates stay as they are.");
    expect(settingsSentence("document-check", true)).toBe("Visitors will complete a full ID check, and tour updates are off for now.");
    expect(settingsSentence("document-check", false)).toBe("Visitors will complete a full ID check, and tour updates stay as they are.");
  });

  it("does not say unit twice", () => {
    expect(unitScopeDetail("Unit 1A")).toBe("Unit 1A");
    expect(unitScopeDetail("1A")).toBe("unit 1A");
  });
});

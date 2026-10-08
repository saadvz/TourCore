import { describe, expect, it } from "vitest";
import { unitScopeDetail } from "../src/operator/availability";
import { describeTourDays, settingsSentence } from "../src/operator/milestones";

describe("milestone landlord copy", () => {
  it("groups touring days and speaks the clock", () => {
    expect(describeTourDays(["SAT", "SUN"])).toBe("Saturday and Sunday");
    expect(describeTourDays(["MON", "TUE", "WED", "THU", "FRI"])).toBe("Monday to Friday");
    expect(describeTourDays(["MON", "WED", "FRI"])).toBe("Monday, Wednesday and Friday");
    expect(describeTourDays(["MON", "TUE", "WED", "THU", "FRI", "SUN"])).toBe("Sunday to Friday");
    expect(`Tours run ${describeTourDays(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])}, 9 AM to 5 PM.`).toBe("Tours run every day, 9 AM to 5 PM.");
  });

  it("says the identity check and tour updates as one sentence", () => {
    expect(settingsSentence("basic-form", true)).toBe("Visitors will fill out a basic identity form, and tour updates are off for now.");
    expect(settingsSentence("basic-form", false)).toBe("Visitors will fill out a basic identity form, and tour updates stay as they are.");
    expect(settingsSentence("none", true)).toBe("Visitors won't fill out an identity form, and tour updates are off for now.");
    expect(settingsSentence("none", false)).toBe("Visitors won't fill out an identity form, and tour updates stay as they are.");
  });

  it("does not say unit twice", () => {
    expect(unitScopeDetail("Unit 1A")).toBe("Unit 1A");
    expect(unitScopeDetail("1A")).toBe("unit 1A");
  });
});

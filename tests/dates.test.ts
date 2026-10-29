import { describe, expect, it } from "vitest";
import { addDays, diffDays, extractNights, isValidDateKey, nightsBetween, parseStay, speakDate, weekday } from "../server/services/ai/dates";

// Fixed "today": Friday 2026-10-16
const T = "2026-10-16";

describe("date helpers", () => {
  it("does calendar arithmetic across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(diffDays("2026-10-16", "2026-10-19")).toBe(3);
    expect(weekday(T)).toBe(5);
    expect(nightsBetween("2026-10-16", "2026-10-19")).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(isValidDateKey("2026-02-30")).toBe(false);
  });
  it("speaks dates", () => expect(speakDate("2026-10-23")).toBe("Friday, October 23"));
});

describe("parseStay", () => {
  it.each([
    ["tonight for two nights", { checkIn: "2026-10-16", checkOut: "2026-10-18", nights: 2 }],
    ["tomorrow for 3 nights", { checkIn: "2026-10-17", checkOut: "2026-10-20", nights: 3 }],
    ["day after tomorrow, one night", { checkIn: "2026-10-18", checkOut: "2026-10-19", nights: 1 }],
    ["from Saturday to Monday", { checkIn: "2026-10-17", checkOut: "2026-10-19", nights: 2 }],
    ["Friday to Sunday", { checkIn: "2026-10-16", checkOut: "2026-10-18", nights: 2 }],
    ["next Friday for two nights", { checkIn: "2026-10-23", checkOut: "2026-10-25", nights: 2 }],
    ["October 25 to October 28", { checkIn: "2026-10-25", checkOut: "2026-10-28", nights: 3 }],
    ["the 25th of october for 2 nights", { checkIn: "2026-10-25", checkOut: "2026-10-27", nights: 2 }],
    ["10/30 to 11/2", { checkIn: "2026-10-30", checkOut: "2026-11-02", nights: 3 }],
    ["2026-12-24 for a week", { checkIn: "2026-12-24", checkOut: "2026-12-31", nights: 7 }],
    ["march 3rd for two nights", { checkIn: "2027-03-03", checkOut: "2027-03-05", nights: 2 }], // rolls to next year
    ["from the 20th to the 22nd", { checkIn: "2026-10-20", checkOut: "2026-10-22", nights: 2 }],
  ])("%s", (text, expected) => {
    expect(parseStay(text, T)).toMatchObject(expected);
  });

  it("flags vague timing instead of guessing", () => {
    expect(parseStay("sometime next week", T)).toMatchObject({ ambiguous: true });
    expect(parseStay("this weekend", T)).toMatchObject({ ambiguous: true });
    expect(parseStay("hello there", T)).toEqual({ ambiguous: false });
  });

  it("flags dates in the past", () => {
    expect(parseStay("2026-10-01 for 2 nights", T).inPast).toBe(true);
  });

  it("reads a night count without dates", () => {
    expect(parseStay("we need three nights", T)).toMatchObject({ nights: 3 });
    expect(extractNights("a night")).toBe(1);
  });

  it("does not take a checkout before the check-in", () => {
    const r = parseStay("2026-10-25 to 2026-10-22", T);
    expect(r.checkOut).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });
});

import { extractCode } from "../server/services/ai/extract";
describe("extractCode", () => {
  it("reads real codes but not letters spanning ordinary words", () => {
    expect(extractCode("my code is SD-PZ5BHS")).toBe("SD-PZ5BHS");
    expect(extractCode("S D, P Z 5 B H S")).toBe("SD-PZ5BHS");
    expect(extractCode("My name is Dana Reed")).toBeUndefined();
  });
});

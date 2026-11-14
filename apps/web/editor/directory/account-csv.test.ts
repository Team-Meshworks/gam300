import { describe, expect, it } from "vitest";
import { importAccounts } from "./account-csv";

describe("account CSV", () => {
  it("handles quoted names, dates and secure unique passwords", () => {
    const accounts = importAccounts(
      'Name,DOB\r\n"Tan, Mei",2008-02-29\r\nAli Ahmad,01/12/2009',
      "Creator",
    );
    expect(accounts.map((account) => account.userName)).toEqual([
      "tanmei29022008",
      "aliahmad01122009",
    ]);
    expect(accounts[0]?.displayName).toBe("Tan, Mei");
    expect(accounts[0]?.initialPassword).toHaveLength(52);
    expect(accounts[0]?.initialPassword).not.toBe(accounts[1]?.initialPassword);
    expect(accounts.every((account) => account.role === "Creator")).toBe(true);
  });
  it("accepts separators, extra columns, reordered headers and common date spellings", () => {
    for (const separator of [",", ";", "\t", "|"]) {
      for (const date of [
        "2008-3-15",
        "15/3/2008",
        "15.03.2008",
        "03/15/2008",
        "15 March 2008",
        "March 15th 2008",
        "2008 Mar 15",
      ]) {
        const text = `\uFEFFDate_of_Birth${separator}Email${separator}FULL NAME\r\n${date}${separator}demo@example.test${separator}Demo Learner`;
        expect(importAccounts(text, "Educator")[0]?.userName).toBe("demolearner15032008");
      }
    }
    expect(
      importAccounts('sep=;\r\n"D.O.B.";" Name "\r\n"15/3/2008"; "Demo Learner" ', "Creator")[0]
        ?.userName,
    ).toBe("demolearner15032008");
  });
  it("uses optional account types and falls back to the selected type", () => {
    const accounts = importAccounts(
      "Name,DOB,Account Type\nAli,2008-01-01,Creator\nMei,2008-01-02,Facilitator\nTan,2008-01-03,",
      "Educator",
    );
    expect(accounts.map((account) => account.role)).toEqual(["Creator", "Educator", "Educator"]);
    expect(() => importAccounts("Name,DOB,Role\nAli,2008-01-01,Administrator", "Creator")).toThrow(
      "Account Type must be Creator or Facilitator",
    );
    expect(() =>
      importAccounts("Name,DOB,Role,Account Type\nAli,2008-01-01,Creator,Creator", "Creator"),
    ).toThrow("only one Account Type");
  });
  it("rejects invalid dates, duplicates and malformed files before creation", () => {
    for (const text of [
      "Name,DOB\nAli,2023-02-29",
      "Name,DOB\nAli,2008-01-01\nAli,01/01/2008",
      'Name,DOB\n"Ali,2008-01-01',
      "Name,DOB\nAli,2008-01-01,extra",
      "Name\nAli",
    ]) {
      expect(() => importAccounts(text, "Educator")).toThrow();
    }
  });
});

import { describe, expect, it } from "vitest";
import { eastmoneyQuoteUrl } from "../src/quote";

describe("Eastmoney quote links", () => {
  it("maps Shanghai, Shenzhen, and Beijing stock codes", () => {
    expect(eastmoneyQuoteUrl("600629")).toBe("https://quote.eastmoney.com/sh600629.html");
    expect(eastmoneyQuoteUrl("000001")).toBe("https://quote.eastmoney.com/sz000001.html");
    expect(eastmoneyQuoteUrl("920198")).toBe("https://quote.eastmoney.com/bj/920198.html");
    expect(eastmoneyQuoteUrl("430047")).toBe("https://quote.eastmoney.com/bj/430047.html");
    expect(eastmoneyQuoteUrl("not-a-code")).toBeNull();
  });
});

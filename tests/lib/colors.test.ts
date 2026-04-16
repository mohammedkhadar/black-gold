import { describe, it, expect } from "vitest";
import { C, col } from "../../src/lib/colors.js";

describe("colors", () => {
  it("C contains expected ANSI codes", () => {
    expect(C.reset).toBe("\x1b[0m");
    expect(C.bold).toBe("\x1b[1m");
    expect(C.red).toBe("\x1b[91m");
    expect(C.green).toBe("\x1b[92m");
    expect(C.yellow).toBe("\x1b[93m");
  });

  it("col wraps string with colour code and reset", () => {
    const result = col(C.green, "hello");
    expect(result).toBe(`${C.green}hello${C.reset}`);
  });

  it("col with empty string still wraps", () => {
    const result = col(C.red, "");
    expect(result).toBe(`${C.red}${C.reset}`);
  });
});

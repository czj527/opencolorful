import { describe, expect, it } from "vitest";

import { PLATFORM_NAME } from "../../src/index.js";

describe("project", () => {
  it("exports the platform identity", () => {
    expect(PLATFORM_NAME).toBe("opencolorful");
  });
});

import { describe, expect, it } from "vitest";

import { checkBashPreflight } from "../../src/sandbox/preflight.js";

describe("checkBashPreflight", () => {
  // ── 危险命令被拦截 ──────────────────────────────────────────────

  it("blocks sudo commands", () => {
    const result = checkBashPreflight("sudo rm -rf /tmp");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("sudo");
    }
  });

  it("blocks chmod 777", () => {
    const result = checkBashPreflight("chmod 777 /var/www");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("chmod");
    }
  });

  it("blocks rm -rf /", () => {
    const result = checkBashPreflight("rm -rf / --no-preserve-root");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("rm");
    }
  });

  it("blocks reg delete (Windows)", () => {
    const result = checkBashPreflight("reg delete HKLM\\Software\\Foo /f");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("reg");
    }
  });

  it("blocks net user (Windows)", () => {
    const result = checkBashPreflight("net user admin /add");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.pattern).toContain("net");
    }
  });

  // ── 安全命令通过 ─────────────────────────────────────────────────

  it("allows ls -la", () => {
    const result = checkBashPreflight("ls -la");
    expect(result.allowed).toBe(true);
  });

  it("allows echo hello", () => {
    const result = checkBashPreflight("echo hello");
    expect(result.allowed).toBe(true);
  });

  it("allows npm test", () => {
    const result = checkBashPreflight("npm test");
    expect(result.allowed).toBe(true);
  });

  it("allows npm install", () => {
    const result = checkBashPreflight("npm install express");
    expect(result.allowed).toBe(true);
  });

  // ── 边界情况 ──────────────────────────────────────────────────────

  it("does NOT block pseudo (sudo as substring should not match)", () => {
    const result = checkBashPreflight("pseudo-terminal setup");
    expect(result.allowed).toBe(true);
  });

  it("does NOT block words containing 'su' as substring", () => {
    const result = checkBashPreflight("ensure directory exists");
    expect(result.allowed).toBe(true);
  });

  it("returns correct pattern field when blocked", () => {
    const result = checkBashPreflight("sudo reboot");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // The pattern should be the source of the regex that matched
      expect(typeof result.pattern).toBe("string");
      expect(result.pattern.length).toBeGreaterThan(0);
      // The matching regex for sudo has word boundaries: \\bsudo\\b
      expect(result.pattern).toContain("sudo");
    }
  });
});

import { describe, expect, it } from "vitest";

import { stripCredentialEnv } from "../e2e/fixtures/backend.js";

/**
 * 隔离红线单测（PR #45 评审要求）：凭据环境变量剥离必须覆盖 PI 已知的
 * 凭据命名与命名约定后缀；未来 PI 扩展凭据名导致漂移时，这里先红。
 */
describe("stripCredentialEnv", () => {
  it("strips provider API keys by suffix", () => {
    const cleaned = stripCredentialEnv({
      DEEPSEEK_API_KEY: "sk-real",
      OPENAI_API_KEY: "sk-real",
      DASHSCOPE_API_KEY: "sk-real",
      ANTHROPIC_API_KEY: "sk-real",
      ZHIPUAI_API_KEY: "sk-real",
      PATH: "/usr/bin",
    });
    expect(cleaned.DEEPSEEK_API_KEY).toBeUndefined();
    expect(cleaned.OPENAI_API_KEY).toBeUndefined();
    expect(cleaned.DASHSCOPE_API_KEY).toBeUndefined();
    expect(cleaned.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cleaned.ZHIPUAI_API_KEY).toBeUndefined();
    expect(cleaned.PATH).toBe("/usr/bin");
  });

  it("strips exact credential variables PI/brokers recognize (review list)", () => {
    const cleaned = stripCredentialEnv({
      HF_TOKEN: "hf-real",
      COPILOT_GITHUB_TOKEN: "ghp-real",
      ANTHROPIC_OAUTH_TOKEN: "oauth-real",
      AWS_ACCESS_KEY_ID: "AKIA-real",
      AWS_SECRET_ACCESS_KEY: "secret-real",
      AWS_SESSION_TOKEN: "session-real",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
      GITHUB_TOKEN: "ghp-real",
      HOME: "/home/tester",
    });
    expect(cleaned.HF_TOKEN).toBeUndefined();
    expect(cleaned.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(cleaned.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(cleaned.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(cleaned.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(cleaned.AWS_SESSION_TOKEN).toBeUndefined();
    expect(cleaned.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(cleaned.GITHUB_TOKEN).toBeUndefined();
    expect(cleaned.HOME).toBe("/home/tester");
  });

  it("keeps non-credential variables including OC_E2E_* test settings", () => {
    const cleaned = stripCredentialEnv({
      OC_E2E_LOG: "/tmp/bootstrap.log",
      NODE_ENV: "test",
      ELECTRON_ENABLE_LOGGING: "1",
      SYSTEMROOT: "C:\\Windows",
    });
    expect(cleaned.OC_E2E_LOG).toBe("/tmp/bootstrap.log");
    expect(cleaned.NODE_ENV).toBe("test");
    expect(cleaned.ELECTRON_ENABLE_LOGGING).toBe("1");
    expect(cleaned.SYSTEMROOT).toBe("C:\\Windows");
  });
});

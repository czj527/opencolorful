import fs from "node:fs";
import path from "node:path";

import {
  defaultPreferences,
  normalizePreferences,
  type PreferencesDocument,
} from "../contracts/preferences.js";

export type PreferencesPatch = Partial<
  Pick<PreferencesDocument, "defaults"> &
    Pick<PreferencesDocument, "layout"> &
    Pick<PreferencesDocument, "appearance"> &
    Pick<PreferencesDocument, "memory"> &
    Pick<PreferencesDocument, "observability"> &
    Pick<PreferencesDocument, "subagents">
>;

/**
 * 全局偏好持久化。读取时对损坏/未知字段做归一化并回退默认值；
 * 写入使用临时文件 + rename 原子替换，避免半写文件阻塞 Supervisor。
 */
export class PreferencesStore {
  constructor(private readonly filePath: string) {}

  get(): PreferencesDocument {
    if (!fs.existsSync(this.filePath)) {
      const defaults = defaultPreferences();
      this.write(defaults);
      return defaults;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      const defaults = defaultPreferences();
      console.warn("偏好文件损坏，已恢复默认设置");
      this.write(defaults);
      return defaults;
    }

    const normalized = normalizePreferences(raw);
    const migrated = normalized.defaults.toolMode === "all"
      ? {
          ...normalized,
          defaults: { ...normalized.defaults, toolMode: "read-only" as const },
        }
      : normalized;
    if (normalized.defaults.toolMode === "all") {
      console.warn("全局默认完整工具权限缺少会话工作区确认，已恢复为 read-only");
    }
    if (JSON.stringify(raw) !== JSON.stringify(migrated)) {
      this.write(migrated);
    }
    return migrated;
  }

  update(patch: PreferencesPatch): PreferencesDocument {
    const current = this.get();
    const next: PreferencesDocument = {
      version: 2,
      defaults: patch.defaults ?? current.defaults,
      layout: patch.layout ?? current.layout,
      appearance: patch.appearance ?? current.appearance,
      ...(patch.observability !== undefined
        ? { observability: patch.observability }
        : current.observability !== undefined
          ? { observability: current.observability }
          : {}),
      ...(patch.memory !== undefined
        ? { memory: patch.memory }
        : current.memory !== undefined
          ? { memory: current.memory }
          : {}),
    };
    const normalized = normalizePreferences(next);
    this.write(normalized);
    return normalized;
  }

  private write(document: PreferencesDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }
}

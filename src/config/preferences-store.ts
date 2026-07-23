import fs from "node:fs";
import path from "node:path";

import {
  defaultPreferences,
  normalizePreferences,
  type PreferencesDocument,
} from "../contracts/preferences.js";

export type PreferencesPatch = Partial<
  Pick<PreferencesDocument, "defaults"> & Pick<PreferencesDocument, "layout">
>;

/**
 * 全局偏好持久化。读取时对损坏/未知字段做归一化并回退默认值；
 * 写入使用临时文件 + rename 原子替换，避免半写文件阻塞 Supervisor。
 */
export class PreferencesStore {
  constructor(private readonly filePath: string) {}

  get(): PreferencesDocument {
    if (!fs.existsSync(this.filePath)) {
      return defaultPreferences();
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizePreferences(raw);
    } catch {
      // 损坏 JSON：回退默认值，不抛出，避免阻塞 Server 启动。
      return defaultPreferences();
    }
  }

  update(patch: PreferencesPatch): PreferencesDocument {
    const current = this.get();
    const next: PreferencesDocument = {
      version: 1,
      defaults: patch.defaults ?? current.defaults,
      layout: patch.layout ?? current.layout,
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
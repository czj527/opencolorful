import fs from "node:fs";
import path from "node:path";

import {
  parseProviderInput,
  parseProviderSettingsDocument,
  type ProviderInput,
  type ProviderSetting,
  type ProviderSettingsDocument,
} from "../contracts/provider-settings.js";

const EMPTY_DOCUMENT: ProviderSettingsDocument = { version: 1, providers: [] };

export class ProviderStore {
  constructor(private readonly filePath: string) {}

  list(): ProviderSetting[] {
    return [...this.read().providers];
  }

  get(providerId: string): ProviderSetting | undefined {
    return this.read().providers.find((provider) => provider.providerId === providerId);
  }

  upsert(input: ProviderInput): ProviderSetting {
    const provider = parseProviderInput(input);
    const setting: ProviderSetting = {
      ...provider,
      credentialRef: `provider:${provider.providerId}`,
    };
    const document = this.read();
    const providers = document.providers.filter((entry) => entry.providerId !== provider.providerId);
    providers.push(setting);
    providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
    this.write({ version: 1, providers });
    return setting;
  }

  private read(): ProviderSettingsDocument {
    if (!fs.existsSync(this.filePath)) {
      return EMPTY_DOCUMENT;
    }
    return parseProviderSettingsDocument(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  private write(document: ProviderSettingsDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }
}

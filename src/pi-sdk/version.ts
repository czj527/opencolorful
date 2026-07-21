import { VERSION } from "@earendil-works/pi-coding-agent";

export const EXPECTED_PI_SDK_VERSION = "0.80.10" as const;

export function getPiSdkVersion(): string {
  return VERSION;
}

export function assertPiSdkVersion(): void {
  if (getPiSdkVersion() !== EXPECTED_PI_SDK_VERSION) {
    throw new Error(
      `PI SDK 版本不兼容: expected ${EXPECTED_PI_SDK_VERSION}, received ${getPiSdkVersion()}`,
    );
  }
}

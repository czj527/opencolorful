import { X } from "lucide-react";
import { useState } from "react";

import "./UpdateBanner.css";

const DISMISS_KEY_PREFIX = "oc-update-dismissed:";

function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_KEY_PREFIX}${version}`) === "1";
  } catch {
    return false;
  }
}

/**
 * G2 T2：下载完成横幅——status "downloaded" 时提醒重启安装。
 * 关闭按版本记忆（localStorage oc-update-dismissed:<newVersion>），同版本不再显示。
 * 挂载由 App.tsx 的更新状态订阅驱动（与 MockBanner 同层级）；无桥（浏览器 dev）不渲染。
 */
export function UpdateBanner({ version }: { readonly version: string }) {
  const [dismissed, setDismissed] = useState(() => isDismissed(version));
  if (dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <span>新版本 v{version} 已就绪</span>
      <button type="button" className="update-banner-install" onClick={() => window.desktopUpdate?.install()}>
        重启安装
      </button>
      <button
        type="button"
        className="update-banner-close"
        aria-label="关闭更新提示"
        onClick={() => {
          try {
            localStorage.setItem(`${DISMISS_KEY_PREFIX}${version}`, "1");
          } catch {
            // localStorage 不可用（如沙箱受限）时仅本次会话内关闭
          }
          setDismissed(true);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
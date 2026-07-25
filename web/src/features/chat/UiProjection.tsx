import { AlertTriangle, Paperclip } from "lucide-react";
import type { Attachment } from "./chat-state.js";
import { isSafeUrl } from "./chat-state.js";
import styles from "./UiProjection.module.css";

interface UiProjectionProps {
  readonly attachments: readonly Attachment[];
}

/**
 * 附件投影：仅展示服务端已脱敏的附件元信息。
 */
export function UiProjection({ attachments }: UiProjectionProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={styles.attachments ?? ""} data-testid="ui-projection">
      {attachments.map((attachment) => (
        <div key={attachment.attachmentId} className={styles.attachment ?? ""}>
          <Paperclip size={12} aria-hidden="true" />
          <span>{attachment.name}</span>
          {attachment.mimeType && (
            <span className={styles.mimeType ?? ""}>({attachment.mimeType})</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface UnsafePayloadNoticeProps {
  readonly reason: string;
}

export function UnsafePayloadNotice({ reason }: UnsafePayloadNoticeProps) {
  return (
    <div className={styles.unsafeNotice ?? ""} role="alert">
      <AlertTriangle size={12} color="var(--danger)" aria-hidden="true" />
      <span>已阻止不安全的 UI 内容：{reason}</span>
    </div>
  );
}

// --- A2UI v0.9.1 安全投影 ---

export interface A2uiComponentData {
  readonly id: string;
  readonly component: string;
  readonly [property: string]: unknown;
}

export interface A2uiEnvelope {
  readonly version: "v0.9.1";
  readonly createSurface?: { readonly surfaceId: string; readonly catalogId: string };
  readonly updateComponents?: { readonly surfaceId: string; readonly components: readonly A2uiComponentData[] };
  readonly updateDataModel?: { readonly surfaceId: string; readonly path?: string; readonly value?: unknown };
  readonly deleteSurface?: { readonly surfaceId: string };
}

/** 本地固定 Catalog：只允许声明式展示组件，禁止任意交互/脚本组件 */
const ALLOWED_COMPONENTS = new Set(["Text", "Card", "Divider", "Badge"]);

interface A2uiProjectionProps {
  readonly messages: readonly A2uiEnvelope[];
}

interface SurfaceState {
  readonly catalogId: string;
  readonly components: Map<string, A2uiComponentData>;
}

function buildSurfaces(messages: readonly A2uiEnvelope[]): {
  surfaces: Map<string, SurfaceState>;
  rejected: string[];
} {
  const surfaces = new Map<string, SurfaceState>();
  const rejected: string[] = [];

  for (const message of messages) {
    if (message.version !== "v0.9.1") {
      rejected.push(`不支持的 A2UI 版本: ${String(message.version)}`);
      continue;
    }
    if (message.createSurface) {
      surfaces.set(message.createSurface.surfaceId, {
        catalogId: message.createSurface.catalogId,
        components: new Map(),
      });
      continue;
    }
    if (message.updateComponents) {
      const surface = surfaces.get(message.updateComponents.surfaceId);
      if (!surface) {
        rejected.push(`未知 Surface: ${message.updateComponents.surfaceId}`);
        continue;
      }
      for (const component of message.updateComponents.components) {
        if (!ALLOWED_COMPONENTS.has(component.component)) {
          rejected.push(`非白名单组件: ${component.component}`);
          continue;
        }
        surface.components.set(component.id, component);
      }
      continue;
    }
    if (message.deleteSurface) {
      surfaces.delete(message.deleteSurface.surfaceId);
    }
  }
  return { surfaces, rejected };
}

function renderA2uiComponent(component: A2uiComponentData): React.ReactNode {
  switch (component.component) {
    case "Text": {
      const text = typeof component["text"] === "string" ? component["text"] : "";
      return <span key={component.id}>{text}</span>;
    }
    case "Card": {
      const title = typeof component["title"] === "string" ? component["title"] : "";
      const body = typeof component["body"] === "string" ? component["body"] : "";
      return (
        <div key={component.id} className={styles.a2uiCard ?? ""}>
          {title && <div className={styles.a2uiCardTitle ?? ""}>{title}</div>}
          {body && <div className={styles.a2uiCardBody ?? ""}>{body}</div>}
        </div>
      );
    }
    case "Badge": {
      const text = typeof component["text"] === "string" ? component["text"] : "";
      return (
        <span key={component.id} className={styles.a2uiBadge ?? ""}>
          {text}
        </span>
      );
    }
    case "Divider":
      return <hr key={component.id} className={styles.a2uiDivider ?? ""} />;
    default:
      return null;
  }
}

/**
 * A2UI v0.9.1 安全投影：
 * - 只接受本地固定 Catalog 的白名单展示组件（Text/Card/Badge/Divider）；
 * - 组件属性只取字符串标量，绝不执行 Handler/脚本/raw HTML；
 * - 未知 Surface、非白名单组件、非法版本都降级为安全错误提示。
 */
export function A2uiProjection({ messages }: A2uiProjectionProps) {
  const { surfaces, rejected } = buildSurfaces(messages);

  return (
    <div className={styles.a2uiProjection ?? ""} data-testid="a2ui-projection">
      {Array.from(surfaces.entries()).map(([surfaceId, surface]) => (
        <div key={surfaceId} className={styles.a2uiSurface ?? ""}>
          {Array.from(surface.components.values()).map((component) => renderA2uiComponent(component))}
        </div>
      ))}
      {rejected.map((reason, i) => (
        <UnsafePayloadNotice key={`rejected-${i}`} reason={reason} />
      ))}
    </div>
  );
}

// --- TokUI 安全投影 ---

interface TokuiProjectionProps {
  readonly chunk: string;
}

/**
 * TokUI 投影占位：TokUI chunk 只按纯文本展示。
 * 不解释 HTML/脚本/自定义标签；白名单组件渲染在后续阶段接入。
 */
export function TokuiProjection({ chunk }: TokuiProjectionProps) {
  // 拒绝 chunk 中的可执行内容：一律按纯文本展示
  const looksUnsafe = /<\s*script|javascript:|on\w+\s*=/i.test(chunk);
  if (looksUnsafe) {
    return <UnsafePayloadNotice reason="TokUI chunk 包含可执行内容" />;
  }
  return (
    <div
      className={styles.tokuiProjection ?? ""}
      data-testid="tokui-projection"
    >
      {chunk}
    </div>
  );
}

export { isSafeUrl };

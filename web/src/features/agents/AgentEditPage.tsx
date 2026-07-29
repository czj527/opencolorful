import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import {
  initializeAgentFormHistory,
  leaveAgentFormForSettings,
  pushAgentFormDirtyHistory,
} from "../../app/page-router.js";
import { AgentForm, ConfirmDiscard, type AgentFormDraft } from "./index.js";
import styles from "./AgentEditPage.module.css";

function extractAgentId(): string {
  const clean = window.location.pathname.split("#")[0]?.split("?")[0] ?? "";
  // /agents/<id> → take last segment
  const segments = clean.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function baseColorFromAgent(agent: {
  baseColor: { persona: string; personality: readonly string[]; replyStyle: string; innerSetting: string };
  settings: { defaultCwd: string | null; sandbox?: { extraReadPaths?: string[]; protectedPaths?: string[] } };
}): Omit<AgentFormDraft, "name" | "selectedTemplateKey" | "templateAdjusted"> {
  return {
    persona: agent.baseColor.persona,
    personality: [...agent.baseColor.personality],
    replyStyle: agent.baseColor.replyStyle,
    innerSetting: agent.baseColor.innerSetting,
    defaultCwd: agent.settings.defaultCwd,
    sandbox: agent.settings.sandbox
      ? {
          extraReadPaths: agent.settings.sandbox.extraReadPaths ?? [],
          protectedPaths: agent.settings.sandbox.protectedPaths ?? [],
        }
      : { extraReadPaths: [], protectedPaths: [] },
  };
}

export interface AgentEditPageProps {
  readonly api: ApiClient;
}

export function AgentEditPage(props: AgentEditPageProps) {
  const agentId = extractAgentId();
  const [draft, setDraft] = useState<AgentFormDraft | null>(null);
  const [original, setOriginal] = useState<AgentFormDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => initializeAgentFormHistory(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const agent = await props.api.getAgent(agentId);
        if (cancelled) return;
        const formDraft: AgentFormDraft = {
          name: agent.identity.name,
          ...baseColorFromAgent(agent),
          selectedTemplateKey: "",
          templateAdjusted: false,
        };
        setDraft(formDraft);
        setOriginal(formDraft);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "加载失败";
          const is404 = (err as { status?: number }).status === 404;
          setLoadError(is404 ? "Agent 不存在或已归档" : msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, props.api]);

  const dirty = original !== null && draft !== null && (
    draft.name !== original.name
    || draft.persona !== original.persona
    || JSON.stringify(draft.personality) !== JSON.stringify(original.personality)
    || draft.replyStyle !== original.replyStyle
    || draft.innerSetting !== original.innerSetting
    || draft.defaultCwd !== original.defaultCwd
    || JSON.stringify(draft.sandbox?.extraReadPaths) !== JSON.stringify(original.sandbox?.extraReadPaths)
    || JSON.stringify(draft.sandbox?.protectedPaths) !== JSON.stringify(original.sandbox?.protectedPaths)
  );

  // beforeunload
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // History trap: when dirty, intercept browser back
  const dirtyRef = useRef(false);
  const discardingRef = useRef(false);
  useEffect(() => {
    const wasDirty = dirtyRef.current;
    dirtyRef.current = dirty;

    if (!dirty) return;

    if (!wasDirty) {
      // Just became dirty — push intercept entry
      pushAgentFormDirtyHistory();
    }

    const handler = () => {
      if (discardingRef.current) return;
      setShowDiscard(true);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [dirty]);

  const handleChange = useCallback((patch: Partial<AgentFormDraft>) => {
    setDraft((prev) => prev === null ? prev : { ...prev, ...patch });
    setSaved(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const current = draftRef.current;
    if (!current || !original) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    const errors: string[] = [];

    // Update name if changed
    if (current.name.trim() !== original.name) {
      try {
        await props.api.updateAgent(agentId, current.name.trim());
      } catch (err) {
        errors.push("名称: " + (err instanceof Error ? err.message : "保存失败"));
      }
    }

    // Update baseColor if any field changed
    const bcChanged = current.persona !== original.persona
      || JSON.stringify(current.personality) !== JSON.stringify(original.personality)
      || current.replyStyle !== original.replyStyle
      || current.innerSetting !== original.innerSetting;
    if (bcChanged) {
      try {
        await props.api.updateAgentBaseColor(agentId, {
          persona: current.persona,
          personality: current.personality,
          replyStyle: current.replyStyle,
          innerSetting: current.innerSetting,
        });
      } catch (err) {
        errors.push("底色: " + (err instanceof Error ? err.message : "保存失败"));
      }
    }

    // Update settings if cwd or sandbox changed
    const cwdChanged = current.defaultCwd !== original.defaultCwd;
    const sandboxChanged =
      JSON.stringify(current.sandbox?.extraReadPaths) !== JSON.stringify(original.sandbox?.extraReadPaths)
      || JSON.stringify(current.sandbox?.protectedPaths) !== JSON.stringify(original.sandbox?.protectedPaths);
    if (cwdChanged || sandboxChanged) {
      try {
        await props.api.updateAgentSettings(agentId, {
          ...(cwdChanged ? { defaultCwd: current.defaultCwd } : {}),
          ...(sandboxChanged && current.sandbox
            ? { extraReadPaths: current.sandbox.extraReadPaths, protectedPaths: current.sandbox.protectedPaths }
            : {}),
        });
      } catch (err) {
        errors.push("设置: " + (err instanceof Error ? err.message : "保存失败"));
      }
    }

    if (errors.length > 0) {
      setError(errors.join("；"));
    } else {
      setSaved(true);
      setOriginal({ ...current });
    }
    setSubmitting(false);
  }, [original, agentId, props.api]);

  const handleCancel = useCallback(() => {
    if (dirty) {
      setShowDiscard(true);
    } else {
      discardingRef.current = true;
      leaveAgentFormForSettings("agents");
    }
  }, [dirty]);

  const handleDiscard = useCallback(() => {
    discardingRef.current = true;
    setShowDiscard(false);
    leaveAgentFormForSettings("agents");
  }, []);

  const handleStay = useCallback(() => {
    setShowDiscard(false);
    // Push another dummy entry to restore the trap
    pushAgentFormDirtyHistory();
  }, []);

  // Loading state
  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.center}>
          <p className={styles.loading}>加载中…</p>
        </div>
      </div>
    );
  }

  // Error state (404 or network)
  if (loadError !== null) {
    return (
      <div className={styles.page}>
        <div className={styles.center}>
          <div className={styles.errorCard}>
            <p className={styles.errorText}>{loadError}</p>
            <button
              type="button"
              className={styles.errorLink}
              onClick={() => leaveAgentFormForSettings("agents")}
            >
              返回 Agent 管理
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (draft === null) return null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={handleCancel}
          aria-label="返回 Agent 管理"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <h1 className={styles.title}>编辑 {draft.name}</h1>
      </header>

      <AgentForm
        api={props.api}
        mode="edit"
        draft={draft}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        submitting={submitting}
        error={error}
        dirty={dirty}
        saved={saved}
      />

      <ConfirmDiscard
        open={showDiscard}
        mode="edit"
        onStay={handleStay}
        onDiscard={handleDiscard}
      />
    </div>
  );
}

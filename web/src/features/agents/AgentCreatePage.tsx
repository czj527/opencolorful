import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import {
  initializeAgentFormHistory,
  leaveAgentFormForSettings,
  pushAgentFormDirtyHistory,
} from "../../app/page-router.js";
import { AgentForm, ConfirmDiscard, type AgentFormDraft } from "./index.js";
import styles from "./AgentCreatePage.module.css";

const INITIAL_DRAFT: AgentFormDraft = {
  name: "",
  persona: "",
  personality: [],
  replyStyle: "",
  innerSetting: "",
  defaultCwd: null,
  sandbox: {
    extraReadPaths: [],
    protectedPaths: [],
  },
  selectedTemplateKey: "blank",
  templateAdjusted: false,
};

export interface AgentCreatePageProps {
  readonly api: ApiClient;
}

export function AgentCreatePage(props: AgentCreatePageProps) {
  const [draft, setDraft] = useState<AgentFormDraft>(INITIAL_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiscard, setShowDiscard] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => initializeAgentFormHistory(), []);

  const dirty = draft.name.trim().length > 0
    || draft.persona.length > 0
    || draft.personality.length > 0
    || draft.replyStyle.length > 0
    || draft.innerSetting.length > 0
    || draft.defaultCwd !== null;

  // beforeunload protection
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
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const current = draftRef.current;
    try {
      const agent = await props.api.createAgent(
        current.name.trim(),
        {
          persona: current.persona,
          personality: current.personality,
          replyStyle: current.replyStyle,
          innerSetting: current.innerSetting,
        },
        current.defaultCwd,
        current.sandbox ? {
          extraReadPaths: current.sandbox.extraReadPaths ?? [],
          protectedPaths: current.sandbox.protectedPaths ?? [],
        } : undefined,
      );
      discardingRef.current = true;
      leaveAgentFormForSettings(`agents&highlight=${agent.identity.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
      setSubmitting(false);
    }
  }, [props.api]);

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
        <h1 className={styles.title}>新建 Agent</h1>
      </header>

      <AgentForm
        api={props.api}
        mode="create"
        draft={draft}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        submitting={submitting}
        error={error}
        dirty={dirty}
      />

      <ConfirmDiscard
        open={showDiscard}
        mode="create"
        onStay={handleStay}
        onDiscard={handleDiscard}
      />
    </div>
  );
}

import "./OnboardingPage.css";

export const ONBOARDING_STEPS = [
  { id: "assistant", label: "创建助理", hint: "名字与底色" },
  { id: "provider", label: "配置模型", hint: "Provider 与 API Key" },
  { id: "directory", label: "工作目录", hint: "助理读写文件的位置" },
  { id: "permissions", label: "权限说明", hint: "工具能做什么" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

interface OnboardingPageProps {
  /** 退出引导（稍后再说 / 完成后关闭）；首启场景下退出后回到空态 */
  readonly onExit: () => void;
}

/**
 * T0 骨架：步骤栏 + 欢迎页 + 退出入口，验证首启自动进入与空态入口。
 * T1 在此填充四步向导（创建助理 → 配置模型 → 工作目录 → 权限说明），
 * 步骤内容组件与本文件样式由 lane A 接续实现。
 */
export function OnboardingPage({ onExit }: OnboardingPageProps) {
  return (
    <div className="onboarding">
      <aside className="onboarding-rail">
        <span className="onboarding-brand">初次设置</span>
        <ol className="onboarding-steps">
          {ONBOARDING_STEPS.map((step, index) => (
            <li key={step.id} className={index === 0 ? "is-current" : ""}>
              <span className="onboarding-step-no" aria-hidden="true">{index + 1}</span>
              <span className="onboarding-step-copy">
                <strong>{step.label}</strong>
                <small>{step.hint}</small>
              </span>
            </li>
          ))}
        </ol>
      </aside>
      <main className="onboarding-main">
        <div className="onboarding-card">
          <h1>欢迎使用 OpenColorful</h1>
          <p>花两分钟完成初次设置：创建你的助理、接入模型、选定工作目录，然后开始第一次对话。</p>
          <p className="onboarding-note">引导表单将在下一步（T1）实现；当前为路由与首启检测骨架。</p>
          <div className="onboarding-actions">
            <button type="button" className="btn" onClick={onExit}>稍后再说</button>
          </div>
        </div>
      </main>
    </div>
  );
}

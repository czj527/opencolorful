import "./MockBanner.css";

/**
 * T9：mock 模式醒目横幅——后端未连接时数据源静默回退 mock，
 * 必须在首屏明确告知"这是演示数据"，避免误以为在操作真实链路。
 */
export function MockBanner() {
  return (
    <div className="mock-banner" role="status">
      当前为演示数据（后端未连接），功能仅供预览
    </div>
  );
}

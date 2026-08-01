const bodyOnly = "只输出正文，不要输出标题、解释或代码围栏。";

export function buildDailyPrompt(input: { date: string; yesterday: string; summaries: string }): { systemPrompt: string; prompt: string } {
  return { systemPrompt: `你是中文记忆编译器。${bodyOnly} 保留可验证事实和时间线，最多3句话、60字。`, prompt: `日期：${input.date}\n昨天草稿：\n${input.yesterday}\n会话摘要：\n${input.summaries}` };
}
export function buildTodayPrompt(summaries: string): { systemPrompt: string; prompt: string } {
  return { systemPrompt: `你是中文记忆编译器。${bodyOnly} 汇总今天会话，最多5条粗事件、300字。`, prompt: `请编译今天的摘要：\n${summaries}` };
}
export function buildLongtermPrompt(existing: string, daily: string): { systemPrompt: string; prompt: string } {
  return { systemPrompt: `你是中文记忆编译器。${bodyOnly} 折叠长期背景，最多400字，只保留稳定信息。`, prompt: `已有长期背景：\n${existing}\n待折叠日记：\n${daily}` };
}
export function buildFactsPrompt(summaries: string): { systemPrompt: string; prompt: string } {
  return { systemPrompt: `你是中文记忆编译器。${bodyOnly} 提取重要事实，最多200字，使用简短项目符号。`, prompt: `从以下摘要提取重要事实：\n${summaries}` };
}

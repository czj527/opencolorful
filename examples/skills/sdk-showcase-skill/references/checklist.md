# 本地健康度检查清单

按需读取。不要一次性把所有 references 注入上下文；只读取当前任务需要的小节。

## 检查项

1. 仓库状态：`git status --porcelain`（未提交改动数量与文件清单摘要）。
2. 当前提交：`git log -1 --format=%h`。
3. 最近提交信息：`git log -3 --oneline`（只取标题行，不读取正文）。
4. 大文件提示：列出工作区中大于 10MB 的文件路径（只列路径与大小，不读取内容）。
5. 是否处于 merge/rebase 中：`git status` 输出中是否出现 `You have unmerged paths`。

## 注意事项

- 所有命令都必须通过既有 Sandbox/工具入口执行；不得直接在宿主进程运行。
- 任何命令失败都记录失败原因，标记该检查项为「未检查」，不要静默跳过。
- 不读取 `~/.gitconfig`、凭据文件、环境变量中的 Secret。
- 不修改仓库（不 commit、不 checkout、不 clean）。

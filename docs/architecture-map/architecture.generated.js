/* This file is generated. Edit architecture.manifest.json and run npm run architecture:map. */
window.__OPENCOLORFUL_ARCHITECTURE__ = {
  "version": 1,
  "title": "OpenColorful / Architecture Atlas",
  "subtitle": "A living map of the local-first assistant platform",
  "sourceOfTruth": "This manifest owns semantic module responsibilities, invariants, critical flows, and the files that anchor each boundary. Generated file inventory and import evidence are derived from the repository.",
  "status": {
    "label": "P1 Wave B in progress",
    "tone": "active",
    "summary": "The repository is on the conversation workbench closeout lane. B0-B5b are implemented; B6 recorded bounded defects and deferred true-chain evidence.",
    "source": "docs/project-status.md",
    "sourceLabel": "Open current project status"
  },
  "layers": [
    {
      "id": "surfaces",
      "label": "Product surfaces",
      "description": "Where a person or operator enters the platform.",
      "tone": "cyan"
    },
    {
      "id": "boundary",
      "label": "Process and protocol boundary",
      "description": "Stable cross-process vocabulary and transport adapters.",
      "tone": "violet"
    },
    {
      "id": "runtime",
      "label": "Agent runtime",
      "description": "Session execution, memory, skills, plugins, subagents, and observability.",
      "tone": "green"
    },
    {
      "id": "persistence",
      "label": "Persistence and host services",
      "description": "Durable facts, credentials, process lifecycle, and local safety boundaries.",
      "tone": "amber"
    },
    {
      "id": "extension",
      "label": "Extension packages",
      "description": "Public plugin protocol and runtime packages used by external integrations.",
      "tone": "coral"
    }
  ],
  "nodes": [
    {
      "id": "desktop-shell",
      "label": "Desktop Electron shell",
      "shortLabel": "Desktop shell",
      "layer": "surfaces",
      "status": "active",
      "roots": [
        "desktop/electron/",
        "desktop/scripts/"
      ],
      "purpose": "Owns the native window, preload capability boundary, supervisor proxy, SSE proxy, update flow, and packaged application lifecycle.",
      "owns": [
        "Electron main process and window lifecycle",
        "Preload-exposed shell operations",
        "Local server proxy and restart-aware connection",
        "Packaged release staging and verification"
      ],
      "invariants": [
        "Renderer never receives runtime credentials, arbitrary filesystem access, or direct Agent APIs.",
        "The packaged server and plugin workspace dependencies must be verified before release.",
        "Supervisor identity is checked before a proxy adopts a process."
      ],
      "docs": [
        {
          "label": "Desktop layout and isolation",
          "path": "docs/repository-layout.md"
        },
        {
          "label": "Release train",
          "path": "docs/release.md"
        }
      ],
      "keyFiles": [
        {
          "path": "desktop/electron/main.cjs",
          "label": "Electron entry"
        },
        {
          "path": "desktop/electron/preload.cjs",
          "label": "Preload boundary"
        },
        {
          "path": "desktop/electron/api-proxy.cjs",
          "label": "HTTP proxy"
        },
        {
          "path": "desktop/scripts/verify-pack.mjs",
          "label": "Package verifier"
        }
      ],
      "layout": {
        "x": 30,
        "y": 70,
        "w": 190,
        "h": 86
      },
      "files": [
        {
          "path": "desktop/electron/api-proxy.cjs",
          "lines": 95
        },
        {
          "path": "desktop/electron/auto-update.cjs",
          "lines": 124
        },
        {
          "path": "desktop/electron/main.cjs",
          "lines": 209
        },
        {
          "path": "desktop/electron/preload.cjs",
          "lines": 43
        },
        {
          "path": "desktop/electron/sse-proxy.cjs",
          "lines": 134
        },
        {
          "path": "desktop/electron/token-source.cjs",
          "lines": 46
        },
        {
          "path": "desktop/scripts/dev.mjs",
          "lines": 54
        },
        {
          "path": "desktop/scripts/rebuild-native.mjs",
          "lines": 28
        },
        {
          "path": "desktop/scripts/stage-release.mjs",
          "lines": 130
        },
        {
          "path": "desktop/scripts/verify-pack.mjs",
          "lines": 90
        }
      ],
      "fileCount": 10,
      "totalLines": 953
    },
    {
      "id": "desktop-renderer",
      "label": "Desktop React workbench",
      "shortLabel": "Desktop UI",
      "layer": "surfaces",
      "status": "active",
      "roots": [
        "desktop/src/"
      ],
      "purpose": "The product frontend: session-centric conversation, branch navigation, compaction and todo projections, memory, logs, usage, settings, and agent identity.",
      "owns": [
        "DesktopDataSource consumer model",
        "Renderer state and projector",
        "Conversation and workbench components",
        "Mock scenarios and renderer-level acceptance"
      ],
      "invariants": [
        "UI is read-only for session todo in Wave B; the first-party tool is the writer.",
        "Renderer talks to the backend through the data source and preload bridge.",
        "Live events and reload/restart state must converge to the same projection."
      ],
      "docs": [
        {
          "label": "Desktop design baseline",
          "path": "docs/design.md"
        },
        {
          "label": "Wave B semantics",
          "path": "docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md"
        }
      ],
      "keyFiles": [
        {
          "path": "desktop/src/App.tsx",
          "label": "Renderer root"
        },
        {
          "path": "desktop/src/data/projector.ts",
          "label": "Event projector"
        },
        {
          "path": "desktop/src/components/ChatView.tsx",
          "label": "Conversation surface"
        },
        {
          "path": "desktop/src/data/ipc-source.ts",
          "label": "Real data source"
        }
      ],
      "layout": {
        "x": 250,
        "y": 70,
        "w": 210,
        "h": 86
      },
      "files": [
        {
          "path": "desktop/src/App.tsx",
          "lines": 881
        },
        {
          "path": "desktop/src/components/AgentChip.tsx",
          "lines": 33
        },
        {
          "path": "desktop/src/components/AgentIdCard.tsx",
          "lines": 72
        },
        {
          "path": "desktop/src/components/BranchSwitcher.tsx",
          "lines": 238
        },
        {
          "path": "desktop/src/components/ChatView.tsx",
          "lines": 531
        },
        {
          "path": "desktop/src/components/CompactionCard.tsx",
          "lines": 67
        },
        {
          "path": "desktop/src/components/Composer.tsx",
          "lines": 218
        },
        {
          "path": "desktop/src/components/Dock.tsx",
          "lines": 125
        },
        {
          "path": "desktop/src/components/MockBanner.tsx",
          "lines": 14
        },
        {
          "path": "desktop/src/components/NewAgentDialog.tsx",
          "lines": 154
        },
        {
          "path": "desktop/src/components/NewSessionDialog.tsx",
          "lines": 268
        },
        {
          "path": "desktop/src/components/OnboardingPage.tsx",
          "lines": 386
        },
        {
          "path": "desktop/src/components/ProvidersSettings.tsx",
          "lines": 397
        },
        {
          "path": "desktop/src/components/SessionTodoCard.tsx",
          "lines": 59
        },
        {
          "path": "desktop/src/components/SettingsModal.tsx",
          "lines": 331
        },
        {
          "path": "desktop/src/components/Sidebar.tsx",
          "lines": 341
        },
        {
          "path": "desktop/src/components/SubagentDock.tsx",
          "lines": 216
        },
        {
          "path": "desktop/src/components/TimelineNav.tsx",
          "lines": 68
        },
        {
          "path": "desktop/src/components/Titlebar.tsx",
          "lines": 59
        },
        {
          "path": "desktop/src/components/UpdateBanner.tsx",
          "lines": 47
        },
        {
          "path": "desktop/src/components/UsageBadge.tsx",
          "lines": 34
        },
        {
          "path": "desktop/src/components/WorkspaceBanner.tsx",
          "lines": 26
        },
        {
          "path": "desktop/src/components/timeline-scroll.ts",
          "lines": 83
        },
        {
          "path": "desktop/src/data/ipc-source.ts",
          "lines": 1296
        },
        {
          "path": "desktop/src/data/local-prefs.ts",
          "lines": 66
        },
        {
          "path": "desktop/src/data/mock-source.ts",
          "lines": 1016
        },
        {
          "path": "desktop/src/data/pick-directory.ts",
          "lines": 11
        },
        {
          "path": "desktop/src/data/projector.ts",
          "lines": 609
        },
        {
          "path": "desktop/src/data/source.ts",
          "lines": 483
        },
        {
          "path": "desktop/src/env.d.ts",
          "lines": 54
        },
        {
          "path": "desktop/src/errors.ts",
          "lines": 228
        },
        {
          "path": "desktop/src/main.tsx",
          "lines": 15
        },
        {
          "path": "desktop/src/mock-data.ts",
          "lines": 547
        },
        {
          "path": "desktop/src/pages/AgentProfilePage.tsx",
          "lines": 412
        },
        {
          "path": "desktop/src/pages/LogsPage.tsx",
          "lines": 458
        },
        {
          "path": "desktop/src/pages/MemoryPage.tsx",
          "lines": 336
        },
        {
          "path": "desktop/src/pages/UsagePage.tsx",
          "lines": 282
        },
        {
          "path": "desktop/src/theme.ts",
          "lines": 53
        },
        {
          "path": "desktop/src/use-first-run.ts",
          "lines": 44
        }
      ],
      "fileCount": 39,
      "totalLines": 10558
    },
    {
      "id": "web-client",
      "label": "Web operator and test client",
      "shortLabel": "Web client",
      "layer": "surfaces",
      "status": "operator",
      "roots": [
        "web/src/"
      ],
      "purpose": "Browser-facing operational and protocol client. It is not the primary product frontend after G1.",
      "owns": [
        "HTTP/SSE/WS client adapters",
        "Web workspace, settings, plugin, skill, memory, logs, and subagent views",
        "Browser E2E-compatible client surface"
      ],
      "invariants": [
        "Web remains a client of the Server API; it does not import PI SDK internals.",
        "New SSE event types must be admitted by the known-event registry.",
        "User-facing changes need Web component coverage and browser evidence when in scope."
      ],
      "docs": [
        {
          "label": "Repository convergence",
          "path": "plans/g1-repo-convergence.md"
        },
        {
          "label": "Architecture boundary",
          "path": "docs/architecture.md"
        }
      ],
      "keyFiles": [
        {
          "path": "web/src/lib/api-client.ts",
          "label": "HTTP client"
        },
        {
          "path": "web/src/lib/sse-client.ts",
          "label": "SSE client"
        },
        {
          "path": "web/src/app/WorkspaceApp.tsx",
          "label": "Workspace root"
        }
      ],
      "layout": {
        "x": 490,
        "y": 70,
        "w": 210,
        "h": 86
      },
      "files": [
        {
          "path": "web/src/app/App.tsx",
          "lines": 158
        },
        {
          "path": "web/src/app/WorkspaceApp.tsx",
          "lines": 571
        },
        {
          "path": "web/src/app/page-router.ts",
          "lines": 200
        },
        {
          "path": "web/src/app/state.ts",
          "lines": 99
        },
        {
          "path": "web/src/components/AppShell.tsx",
          "lines": 99
        },
        {
          "path": "web/src/components/ChatPane.tsx",
          "lines": 208
        },
        {
          "path": "web/src/components/InspectorSidebar.tsx",
          "lines": 46
        },
        {
          "path": "web/src/components/Modal.tsx",
          "lines": 76
        },
        {
          "path": "web/src/components/ServerStatusBar.tsx",
          "lines": 109
        },
        {
          "path": "web/src/components/SessionSidebar.tsx",
          "lines": 189
        },
        {
          "path": "web/src/components/ui/Badge.tsx",
          "lines": 26
        },
        {
          "path": "web/src/components/ui/Button.tsx",
          "lines": 93
        },
        {
          "path": "web/src/components/ui/Card.tsx",
          "lines": 28
        },
        {
          "path": "web/src/components/ui/EmptyState.tsx",
          "lines": 25
        },
        {
          "path": "web/src/components/ui/Field.tsx",
          "lines": 55
        },
        {
          "path": "web/src/components/ui/IconButton.tsx",
          "lines": 70
        },
        {
          "path": "web/src/components/ui/Select.tsx",
          "lines": 42
        },
        {
          "path": "web/src/components/ui/Skeleton.tsx",
          "lines": 35
        },
        {
          "path": "web/src/components/ui/Spinner.tsx",
          "lines": 23
        },
        {
          "path": "web/src/components/ui/TextField.tsx",
          "lines": 133
        },
        {
          "path": "web/src/components/ui/Toggle.tsx",
          "lines": 43
        },
        {
          "path": "web/src/components/ui/Tooltip.tsx",
          "lines": 45
        },
        {
          "path": "web/src/components/ui/index.ts",
          "lines": 36
        },
        {
          "path": "web/src/css-modules.d.ts",
          "lines": 5
        },
        {
          "path": "web/src/features/agents/AgentAvatar.tsx",
          "lines": 35
        },
        {
          "path": "web/src/features/agents/AgentCreatePage.tsx",
          "lines": 170
        },
        {
          "path": "web/src/features/agents/AgentEditPage.tsx",
          "lines": 297
        },
        {
          "path": "web/src/features/agents/AgentForm.tsx",
          "lines": 312
        },
        {
          "path": "web/src/features/agents/AgentPluginsSection.tsx",
          "lines": 275
        },
        {
          "path": "web/src/features/agents/BaseColorTemplatePicker.tsx",
          "lines": 122
        },
        {
          "path": "web/src/features/agents/ConfirmDiscard.tsx",
          "lines": 44
        },
        {
          "path": "web/src/features/agents/DirectoryPicker.tsx",
          "lines": 121
        },
        {
          "path": "web/src/features/agents/TagInput.tsx",
          "lines": 115
        },
        {
          "path": "web/src/features/agents/decor-color.ts",
          "lines": 53
        },
        {
          "path": "web/src/features/agents/index.ts",
          "lines": 24
        },
        {
          "path": "web/src/features/chat/AgentSelector.tsx",
          "lines": 34
        },
        {
          "path": "web/src/features/chat/ChatTimelineNav.tsx",
          "lines": 97
        },
        {
          "path": "web/src/features/chat/ContextUsageRing.tsx",
          "lines": 120
        },
        {
          "path": "web/src/features/chat/MessageComposer.tsx",
          "lines": 286
        },
        {
          "path": "web/src/features/chat/MessageList.tsx",
          "lines": 315
        },
        {
          "path": "web/src/features/chat/PlanItem.tsx",
          "lines": 26
        },
        {
          "path": "web/src/features/chat/ToolCallItem.tsx",
          "lines": 71
        },
        {
          "path": "web/src/features/chat/UiProjection.tsx",
          "lines": 194
        },
        {
          "path": "web/src/features/chat/chat-state.ts",
          "lines": 707
        },
        {
          "path": "web/src/features/chat/commands.ts",
          "lines": 96
        },
        {
          "path": "web/src/features/chat/safe-markdown.tsx",
          "lines": 213
        },
        {
          "path": "web/src/features/chat/stream-buffer.ts",
          "lines": 69
        },
        {
          "path": "web/src/features/chat/timeline-turns.ts",
          "lines": 86
        },
        {
          "path": "web/src/features/chat/use-chat-scroll.ts",
          "lines": 155
        },
        {
          "path": "web/src/features/layout/layout-preferences.ts",
          "lines": 90
        },
        {
          "path": "web/src/features/layout/use-panel-resize.ts",
          "lines": 111
        },
        {
          "path": "web/src/features/layout/useLayoutState.ts",
          "lines": 257
        },
        {
          "path": "web/src/features/logs/LogsPage.tsx",
          "lines": 136
        },
        {
          "path": "web/src/features/logs/activity-view.tsx",
          "lines": 571
        },
        {
          "path": "web/src/features/logs/audit-view.tsx",
          "lines": 238
        },
        {
          "path": "web/src/features/logs/errors-view.tsx",
          "lines": 148
        },
        {
          "path": "web/src/features/logs/export-view.tsx",
          "lines": 108
        },
        {
          "path": "web/src/features/logs/logs-format.ts",
          "lines": 65
        },
        {
          "path": "web/src/features/logs/performance-view.tsx",
          "lines": 95
        },
        {
          "path": "web/src/features/logs/raw-logs-view.tsx",
          "lines": 124
        },
        {
          "path": "web/src/features/memory/MemoryPage.tsx",
          "lines": 280
        },
        {
          "path": "web/src/features/plugins/DevelopmentView.tsx",
          "lines": 216
        },
        {
          "path": "web/src/features/plugins/DiscoverView.tsx",
          "lines": 345
        },
        {
          "path": "web/src/features/plugins/InstalledView.tsx",
          "lines": 164
        },
        {
          "path": "web/src/features/plugins/PermissionsView.tsx",
          "lines": 128
        },
        {
          "path": "web/src/features/plugins/PluginDetailView.tsx",
          "lines": 393
        },
        {
          "path": "web/src/features/plugins/PluginsPage.tsx",
          "lines": 110
        },
        {
          "path": "web/src/features/plugins/PluginsSettingsSection.tsx",
          "lines": 25
        },
        {
          "path": "web/src/features/plugins/SourcesView.tsx",
          "lines": 79
        },
        {
          "path": "web/src/features/plugins/index.ts",
          "lines": 26
        },
        {
          "path": "web/src/features/plugins/plugin-format.ts",
          "lines": 164
        },
        {
          "path": "web/src/features/plugins/plugin-ui.tsx",
          "lines": 86
        },
        {
          "path": "web/src/features/providers/ProviderSettings.tsx",
          "lines": 205
        },
        {
          "path": "web/src/features/providers/provider-form.ts",
          "lines": 78
        },
        {
          "path": "web/src/features/sessions/NewSessionPage.tsx",
          "lines": 266
        },
        {
          "path": "web/src/features/sessions/SessionSettingsPanel.tsx",
          "lines": 127
        },
        {
          "path": "web/src/features/sessions/session-settings.ts",
          "lines": 88
        },
        {
          "path": "web/src/features/settings/SettingsNav.tsx",
          "lines": 78
        },
        {
          "path": "web/src/features/settings/SettingsPage.tsx",
          "lines": 449
        },
        {
          "path": "web/src/features/settings/sections/AgentsSection.tsx",
          "lines": 135
        },
        {
          "path": "web/src/features/settings/sections/DefaultsSection.tsx",
          "lines": 113
        },
        {
          "path": "web/src/features/settings/sections/LayoutSection.tsx",
          "lines": 191
        },
        {
          "path": "web/src/features/settings/sections/LogsSection.tsx",
          "lines": 263
        },
        {
          "path": "web/src/features/settings/sections/ProvidersSection.tsx",
          "lines": 180
        },
        {
          "path": "web/src/features/settings/sections/RuntimeSection.tsx",
          "lines": 36
        },
        {
          "path": "web/src/features/settings/sections/SkillsSettingsSection.tsx",
          "lines": 25
        },
        {
          "path": "web/src/features/settings/sections/SubagentDefaultsSection.tsx",
          "lines": 90
        },
        {
          "path": "web/src/features/settings/sections/UnavailableSection.tsx",
          "lines": 10
        },
        {
          "path": "web/src/features/settings/sections/UsageSection.tsx",
          "lines": 196
        },
        {
          "path": "web/src/features/settings/settings-state.ts",
          "lines": 75
        },
        {
          "path": "web/src/features/settings/widgets/ComboInput.tsx",
          "lines": 93
        },
        {
          "path": "web/src/features/settings/widgets/SettingsRow.tsx",
          "lines": 105
        },
        {
          "path": "web/src/features/settings/widgets/SettingsSection.tsx",
          "lines": 43
        },
        {
          "path": "web/src/features/settings/widgets/StepSlider.tsx",
          "lines": 56
        },
        {
          "path": "web/src/features/settings/widgets/index.ts",
          "lines": 16
        },
        {
          "path": "web/src/features/skills/AgentSkillsSection.tsx",
          "lines": 307
        },
        {
          "path": "web/src/features/skills/DiscoverSkillsView.tsx",
          "lines": 164
        },
        {
          "path": "web/src/features/skills/InstalledSkillsView.tsx",
          "lines": 131
        },
        {
          "path": "web/src/features/skills/SkillBundlesView.tsx",
          "lines": 157
        },
        {
          "path": "web/src/features/skills/SkillDetailView.tsx",
          "lines": 206
        },
        {
          "path": "web/src/features/skills/SkillDevView.tsx",
          "lines": 86
        },
        {
          "path": "web/src/features/skills/SkillDiagnosticsView.tsx",
          "lines": 157
        },
        {
          "path": "web/src/features/skills/SkillInstallFlowCard.tsx",
          "lines": 320
        },
        {
          "path": "web/src/features/skills/SkillInstallToolCard.tsx",
          "lines": 190
        },
        {
          "path": "web/src/features/skills/SkillSourcesView.tsx",
          "lines": 139
        },
        {
          "path": "web/src/features/skills/SkillsPage.tsx",
          "lines": 117
        },
        {
          "path": "web/src/features/skills/index.ts",
          "lines": 23
        },
        {
          "path": "web/src/features/skills/skill-format.ts",
          "lines": 82
        },
        {
          "path": "web/src/features/skills/skill-ui.tsx",
          "lines": 63
        },
        {
          "path": "web/src/features/subagents/SubagentCard.tsx",
          "lines": 246
        },
        {
          "path": "web/src/features/subagents/SubagentPanel.tsx",
          "lines": 294
        },
        {
          "path": "web/src/features/subagents/SubagentTimeline.tsx",
          "lines": 389
        },
        {
          "path": "web/src/features/subagents/subagent-format.ts",
          "lines": 181
        },
        {
          "path": "web/src/features/subagents/subagent-stream.ts",
          "lines": 230
        },
        {
          "path": "web/src/features/subagents/use-subagent-panel.ts",
          "lines": 252
        },
        {
          "path": "web/src/features/subagents/use-subagent-threads.ts",
          "lines": 253
        },
        {
          "path": "web/src/lib/api-client.ts",
          "lines": 447
        },
        {
          "path": "web/src/lib/plugin-api.ts",
          "lines": 203
        },
        {
          "path": "web/src/lib/plugin-types.ts",
          "lines": 529
        },
        {
          "path": "web/src/lib/skill-api.ts",
          "lines": 212
        },
        {
          "path": "web/src/lib/skill-types.ts",
          "lines": 283
        },
        {
          "path": "web/src/lib/sse-client.ts",
          "lines": 171
        },
        {
          "path": "web/src/lib/types.ts",
          "lines": 804
        },
        {
          "path": "web/src/lib/ws-client.ts",
          "lines": 173
        },
        {
          "path": "web/src/main.tsx",
          "lines": 10
        }
      ],
      "fileCount": 125,
      "totalLines": 20147
    },
    {
      "id": "tui-client",
      "label": "TUI protocol client",
      "shortLabel": "TUI",
      "layer": "surfaces",
      "status": "stable",
      "roots": [
        "src/tui/"
      ],
      "purpose": "Terminal client that consumes Server protocols and remains independent from PI SDK imports.",
      "owns": [
        "HTTP/SSE/WS client protocol",
        "Terminal event rendering",
        "Structured summaries for non-Web clients"
      ],
      "invariants": [
        "TUI never bypasses Server to mutate Session state.",
        "TUI does not import PI packages or src/pi-sdk."
      ],
      "docs": [
        {
          "label": "Server-first architecture",
          "path": "docs/architecture.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/tui/event-client.ts",
          "label": "TUI event client"
        },
        {
          "path": "src/tui/render-event.ts",
          "label": "TUI renderer"
        }
      ],
      "layout": {
        "x": 730,
        "y": 70,
        "w": 180,
        "h": 86
      },
      "files": [
        {
          "path": "src/tui/api-client.ts",
          "lines": 170
        },
        {
          "path": "src/tui/app.ts",
          "lines": 416
        },
        {
          "path": "src/tui/event-client.ts",
          "lines": 156
        },
        {
          "path": "src/tui/render-event.ts",
          "lines": 76
        }
      ],
      "fileCount": 4,
      "totalLines": 818
    },
    {
      "id": "contracts",
      "label": "Platform contracts",
      "shortLabel": "Contracts",
      "layer": "boundary",
      "status": "stable",
      "roots": [
        "src/contracts/"
      ],
      "purpose": "The cross-module and cross-process vocabulary: API inputs, events, session branches, memory, plugins, skills, subagents, observability, usage, and UI messages.",
      "owns": [
        "TypeBox schemas and platform types",
        "PlatformEventEnvelope",
        "Stable error and command vocabulary",
        "Plugin protocol re-exports used by the host"
      ],
      "invariants": [
        "Cross-process inputs are parsed, not trusted through type assertions.",
        "Protocol version stays explicit and compatible.",
        "Platform interfaces do not expose PI private types."
      ],
      "docs": [
        {
          "label": "Architecture and event protocol",
          "path": "docs/architecture.md"
        },
        {
          "label": "Document governance",
          "path": "docs/document-governance.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/contracts/events.ts",
          "label": "Event envelope"
        },
        {
          "path": "src/contracts/session-branch.ts",
          "label": "Wave B branch contract"
        },
        {
          "path": "src/contracts/plugin-protocol.ts",
          "label": "Plugin host vocabulary"
        },
        {
          "path": "src/contracts/usage.ts",
          "label": "Usage contract"
        }
      ],
      "layout": {
        "x": 30,
        "y": 244,
        "w": 210,
        "h": 86
      },
      "files": [
        {
          "path": "src/contracts/agent-identity.ts",
          "lines": 108
        },
        {
          "path": "src/contracts/agent-settings.ts",
          "lines": 53
        },
        {
          "path": "src/contracts/api-error.ts",
          "lines": 56
        },
        {
          "path": "src/contracts/base-color-templates.ts",
          "lines": 100
        },
        {
          "path": "src/contracts/commands.ts",
          "lines": 55
        },
        {
          "path": "src/contracts/events.ts",
          "lines": 186
        },
        {
          "path": "src/contracts/memory.ts",
          "lines": 629
        },
        {
          "path": "src/contracts/model-policy.ts",
          "lines": 140
        },
        {
          "path": "src/contracts/observability.ts",
          "lines": 468
        },
        {
          "path": "src/contracts/plugin-protocol.ts",
          "lines": 4
        },
        {
          "path": "src/contracts/preferences.ts",
          "lines": 308
        },
        {
          "path": "src/contracts/provider-settings.ts",
          "lines": 187
        },
        {
          "path": "src/contracts/sandbox.ts",
          "lines": 100
        },
        {
          "path": "src/contracts/session-branch.ts",
          "lines": 69
        },
        {
          "path": "src/contracts/session-settings.ts",
          "lines": 49
        },
        {
          "path": "src/contracts/skill-protocol.ts",
          "lines": 360
        },
        {
          "path": "src/contracts/subagents.ts",
          "lines": 700
        },
        {
          "path": "src/contracts/ui-message.ts",
          "lines": 100
        },
        {
          "path": "src/contracts/usage.ts",
          "lines": 61
        },
        {
          "path": "src/contracts/validation.ts",
          "lines": 73
        }
      ],
      "fileCount": 20,
      "totalLines": 3806
    },
    {
      "id": "server",
      "label": "HTTP / SSE / WS server",
      "shortLabel": "Server boundary",
      "layer": "boundary",
      "status": "stable",
      "roots": [
        "src/server/"
      ],
      "purpose": "Owns authentication boundary, input validation, route composition, event streams, WebSocket sessions, and transport projection.",
      "owns": [
        "Hono application and route registration",
        "Session, message, branch, agent, memory, plugin, skill, subagent and usage routes",
        "SSE replay subscription and WebSocket control",
        "Runtime bootstrap composition root"
      ],
      "invariants": [
        "Routes parse and delegate; Agent business logic lives in Runtime and Services.",
        "Events are written to Replay Store before broadcast.",
        "Loopback binding and stable ApiError behavior remain the default boundary."
      ],
      "docs": [
        {
          "label": "Server-first and API boundary",
          "path": "docs/architecture.md"
        },
        {
          "label": "Development quality gates",
          "path": "docs/development.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/server/app.ts",
          "label": "Hono app"
        },
        {
          "path": "src/server/start.ts",
          "label": "Server composition"
        },
        {
          "path": "src/server/routes/messages.ts",
          "label": "Prompt route"
        },
        {
          "path": "src/server/sse/session-events.ts",
          "label": "SSE projection"
        }
      ],
      "layout": {
        "x": 270,
        "y": 244,
        "w": 220,
        "h": 86
      },
      "files": [
        {
          "path": "src/server/app.ts",
          "lines": 321
        },
        {
          "path": "src/server/observability/client-events.ts",
          "lines": 136
        },
        {
          "path": "src/server/routes/agent-events.ts",
          "lines": 63
        },
        {
          "path": "src/server/routes/agents.ts",
          "lines": 636
        },
        {
          "path": "src/server/routes/directories.ts",
          "lines": 25
        },
        {
          "path": "src/server/routes/events.ts",
          "lines": 28
        },
        {
          "path": "src/server/routes/memory.ts",
          "lines": 324
        },
        {
          "path": "src/server/routes/messages.ts",
          "lines": 157
        },
        {
          "path": "src/server/routes/models.ts",
          "lines": 8
        },
        {
          "path": "src/server/routes/observability.ts",
          "lines": 647
        },
        {
          "path": "src/server/routes/plugins.ts",
          "lines": 377
        },
        {
          "path": "src/server/routes/providers.ts",
          "lines": 24
        },
        {
          "path": "src/server/routes/runtime-bootstrap.ts",
          "lines": 861
        },
        {
          "path": "src/server/routes/sandbox.ts",
          "lines": 80
        },
        {
          "path": "src/server/routes/session-branches.ts",
          "lines": 187
        },
        {
          "path": "src/server/routes/sessions.ts",
          "lines": 450
        },
        {
          "path": "src/server/routes/settings.ts",
          "lines": 160
        },
        {
          "path": "src/server/routes/skill-admin.ts",
          "lines": 249
        },
        {
          "path": "src/server/routes/skills.ts",
          "lines": 352
        },
        {
          "path": "src/server/routes/subagent-ability-tools.ts",
          "lines": 489
        },
        {
          "path": "src/server/routes/subagents.ts",
          "lines": 328
        },
        {
          "path": "src/server/routes/usage.ts",
          "lines": 146
        },
        {
          "path": "src/server/runtime-state.ts",
          "lines": 94
        },
        {
          "path": "src/server/sse/session-events.ts",
          "lines": 148
        },
        {
          "path": "src/server/start.ts",
          "lines": 636
        },
        {
          "path": "src/server/trust-boundary.ts",
          "lines": 280
        },
        {
          "path": "src/server/ws/client-registry.ts",
          "lines": 81
        },
        {
          "path": "src/server/ws/protocol.ts",
          "lines": 30
        },
        {
          "path": "src/server/ws/session-handler.ts",
          "lines": 170
        }
      ],
      "fileCount": 29,
      "totalLines": 7487
    },
    {
      "id": "ui-projection",
      "label": "A2UI / TokUI projection",
      "shortLabel": "UI projection",
      "layer": "boundary",
      "status": "stable",
      "roots": [
        "src/ui-projection/"
      ],
      "purpose": "Projects structured platform events into bounded UI protocols. It is a one-way projection, never an alternate runtime.",
      "owns": [
        "A2UI catalog and action validation",
        "TokUI policy and streaming projection",
        "Safe structured UI message payloads"
      ],
      "invariants": [
        "Only the local fixed catalog and named handlers are accepted.",
        "Raw HTML, scripts, javascript URLs, and arbitrary executable widgets are rejected.",
        "Actions return to Server for validation."
      ],
      "docs": [
        {
          "label": "UI protocol section",
          "path": "docs/architecture.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/ui-projection/a2ui/project.ts",
          "label": "A2UI projector"
        },
        {
          "path": "src/ui-projection/a2ui/action.ts",
          "label": "A2UI action gate"
        },
        {
          "path": "src/ui-projection/tokui/policy.ts",
          "label": "TokUI policy"
        }
      ],
      "layout": {
        "x": 520,
        "y": 244,
        "w": 210,
        "h": 86
      },
      "files": [
        {
          "path": "src/ui-projection/a2ui/action.ts",
          "lines": 84
        },
        {
          "path": "src/ui-projection/a2ui/catalog.ts",
          "lines": 37
        },
        {
          "path": "src/ui-projection/a2ui/project.ts",
          "lines": 182
        },
        {
          "path": "src/ui-projection/tokui/policy.ts",
          "lines": 151
        },
        {
          "path": "src/ui-projection/tokui/project.ts",
          "lines": 133
        }
      ],
      "fileCount": 5,
      "totalLines": 587
    },
    {
      "id": "supervisor",
      "label": "Supervisor process host",
      "shortLabel": "Supervisor",
      "layer": "persistence",
      "status": "stable",
      "roots": [
        "src/supervisor/"
      ],
      "purpose": "Starts, monitors, health-checks, proxies, and stops the Agent Server while hosting the built client surface.",
      "owns": [
        "Agent Server lifecycle",
        "PID and identity verification",
        "Port selection and restart behavior",
        "Static Web asset hosting and transparent proxying"
      ],
      "invariants": [
        "A health response must identify the expected child process before adoption.",
        "Windows child process trees are cleaned up on stop.",
        "Desktop and CLI both use the same local lifecycle concepts."
      ],
      "docs": [
        {
          "label": "Desktop release and supervisor",
          "path": "docs/release.md"
        },
        {
          "label": "Phase 3 implementation",
          "path": "plans/phase-03.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/supervisor/start.ts",
          "label": "Supervisor start"
        },
        {
          "path": "src/supervisor/process-controller.ts",
          "label": "Process control"
        }
      ],
      "layout": {
        "x": 760,
        "y": 244,
        "w": 210,
        "h": 86
      },
      "files": [
        {
          "path": "src/supervisor/app.ts",
          "lines": 291
        },
        {
          "path": "src/supervisor/log-filter.ts",
          "lines": 131
        },
        {
          "path": "src/supervisor/process-controller.ts",
          "lines": 584
        },
        {
          "path": "src/supervisor/start.ts",
          "lines": 154
        },
        {
          "path": "src/supervisor/types.ts",
          "lines": 59
        }
      ],
      "fileCount": 5,
      "totalLines": 1219
    },
    {
      "id": "session-runtime",
      "label": "Session and execution runtime",
      "shortLabel": "Session runtime",
      "layer": "runtime",
      "status": "active",
      "roots": [
        "src/runtime/"
      ],
      "purpose": "The central orchestration layer: session lifecycle, prompt execution, model policy, tool policy, events, branches, usage, memory, plugins, skills, and subagent composition.",
      "owns": [
        "SessionRuntime and SessionService",
        "Prompt and abort/compact execution",
        "Branch regenerate, fork, switch, and current-head recovery",
        "Event mapping and replay publishing",
        "Runtime composition for memory, skills, plugins, and subagents"
      ],
      "invariants": [
        "Runtime owns Agent behavior; transport routes remain thin.",
        "Session identity is a stable ID, never a file path.",
        "The same runtime composition must be used after restart and branch actions.",
        "Wave B branch and todo semantics remain append-only JSONL plus SQLite metadata/state."
      ],
      "docs": [
        {
          "label": "Core architecture",
          "path": "docs/architecture.md"
        },
        {
          "label": "Conversation workbench semantics",
          "path": "docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md"
        },
        {
          "label": "Memory architecture",
          "path": "docs/memory-architecture.md"
        },
        {
          "label": "Logging architecture",
          "path": "docs/logging-architecture.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/runtime/session-runtime.ts",
          "label": "Session runtime"
        },
        {
          "path": "src/runtime/session-service.ts",
          "label": "Session service"
        },
        {
          "path": "src/runtime/prompt-service.ts",
          "label": "Prompt service"
        },
        {
          "path": "src/runtime/event-replay-store.ts",
          "label": "Replay store"
        },
        {
          "path": "src/runtime/event-mapper.ts",
          "label": "Event mapper"
        }
      ],
      "layout": {
        "x": 30,
        "y": 408,
        "w": 230,
        "h": 102
      },
      "files": [
        {
          "path": "src/runtime/event-mapper.ts",
          "lines": 196
        },
        {
          "path": "src/runtime/event-replay-store.ts",
          "lines": 122
        },
        {
          "path": "src/runtime/execution-registry.ts",
          "lines": 69
        },
        {
          "path": "src/runtime/model-policy.ts",
          "lines": 346
        },
        {
          "path": "src/runtime/model-service.ts",
          "lines": 93
        },
        {
          "path": "src/runtime/prompt-service.ts",
          "lines": 80
        },
        {
          "path": "src/runtime/provider-errors.ts",
          "lines": 42
        },
        {
          "path": "src/runtime/sanitize.ts",
          "lines": 34
        },
        {
          "path": "src/runtime/session-runtime.ts",
          "lines": 926
        },
        {
          "path": "src/runtime/session-service.ts",
          "lines": 536
        },
        {
          "path": "src/runtime/tool-policy.ts",
          "lines": 228
        },
        {
          "path": "src/runtime/usage-recorder.ts",
          "lines": 196
        }
      ],
      "fileCount": 12,
      "totalLines": 2868
    },
    {
      "id": "pi-adapter",
      "label": "PI SDK adapter boundary",
      "shortLabel": "PI adapter",
      "layer": "runtime",
      "status": "stable",
      "roots": [
        "src/pi-sdk/"
      ],
      "purpose": "The only direct import boundary to PI SDK. It turns PI sessions, models, tools, and events into OpenColorful platform interfaces.",
      "owns": [
        "AgentSession and SessionManager adapters",
        "ModelRuntime and provider integration",
        "Session tree and branch primitives",
        "First-party tool factories"
      ],
      "invariants": [
        "Only src/pi-sdk may import @earendil-works/pi-*.",
        "No PI private deep imports or duplicated Agent Loop implementation.",
        "Platform interfaces do not leak PI private types."
      ],
      "docs": [
        {
          "label": "PI boundary rule",
          "path": "AGENTS.md"
        },
        {
          "label": "Wave B adapter contract",
          "path": "plans/p1-conversation-workbench.en.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/pi-sdk/index.ts",
          "label": "Adapter exports"
        },
        {
          "path": "src/pi-sdk/agent-session.ts",
          "label": "Agent session adapter"
        },
        {
          "path": "src/pi-sdk/session-tree.ts",
          "label": "Branch adapter"
        },
        {
          "path": "src/pi-sdk/model-runtime.ts",
          "label": "Model runtime"
        }
      ],
      "layout": {
        "x": 300,
        "y": 408,
        "w": 220,
        "h": 102
      },
      "files": [
        {
          "path": "src/pi-sdk/agent-session.ts",
          "lines": 821
        },
        {
          "path": "src/pi-sdk/complete-text.ts",
          "lines": 138
        },
        {
          "path": "src/pi-sdk/index.ts",
          "lines": 256
        },
        {
          "path": "src/pi-sdk/memory-tools.ts",
          "lines": 328
        },
        {
          "path": "src/pi-sdk/model-runtime.ts",
          "lines": 94
        },
        {
          "path": "src/pi-sdk/sandbox-extension.ts",
          "lines": 333
        },
        {
          "path": "src/pi-sdk/session-manager-registry.ts",
          "lines": 21
        },
        {
          "path": "src/pi-sdk/session-tree.ts",
          "lines": 350
        },
        {
          "path": "src/pi-sdk/skill-loader.ts",
          "lines": 183
        },
        {
          "path": "src/pi-sdk/skill-tools.ts",
          "lines": 311
        },
        {
          "path": "src/pi-sdk/subagent-tools-context.ts",
          "lines": 227
        },
        {
          "path": "src/pi-sdk/subagent-tools.ts",
          "lines": 1040
        },
        {
          "path": "src/pi-sdk/todo-tools.ts",
          "lines": 248
        },
        {
          "path": "src/pi-sdk/types.ts",
          "lines": 278
        },
        {
          "path": "src/pi-sdk/version.ts",
          "lines": 16
        }
      ],
      "fileCount": 15,
      "totalLines": 4644
    },
    {
      "id": "memory",
      "label": "Memory subsystem",
      "shortLabel": "Memory",
      "layer": "runtime",
      "status": "active",
      "roots": [
        "src/runtime/memory/"
      ],
      "purpose": "Builds, injects, recalls, reviews, and applies memory with explicit policy and durable files/stores.",
      "owns": [
        "Memory agent and tool surface",
        "Recall and injection policy",
        "Background review and activation updates",
        "Compile, summary, scheduler, and branch-aware reads"
      ],
      "invariants": [
        "Memory is policy-governed and bounded; it is not an unconstrained self-modification loop.",
        "Background review is advisory and must remain observable.",
        "Memory content and operational logs have separate privacy boundaries."
      ],
      "docs": [
        {
          "label": "Memory architecture",
          "path": "docs/memory-architecture.md"
        },
        {
          "label": "Memory activation slice",
          "path": "docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/runtime/memory/recall-service.ts",
          "label": "Recall service"
        },
        {
          "path": "src/runtime/memory/memory-injection.ts",
          "label": "Prompt injection"
        },
        {
          "path": "src/runtime/memory/background-review.ts",
          "label": "Background review"
        },
        {
          "path": "src/runtime/memory/compile-pipeline.ts",
          "label": "Compile pipeline"
        }
      ],
      "layout": {
        "x": 560,
        "y": 408,
        "w": 210,
        "h": 102
      },
      "files": [
        {
          "path": "src/runtime/memory/activation-updater.ts",
          "lines": 46
        },
        {
          "path": "src/runtime/memory/agent/memory-agent-prompts.ts",
          "lines": 13
        },
        {
          "path": "src/runtime/memory/agent/memory-agent-runner.ts",
          "lines": 202
        },
        {
          "path": "src/runtime/memory/agent/memory-agent-tools.ts",
          "lines": 104
        },
        {
          "path": "src/runtime/memory/agent/run-report.ts",
          "lines": 46
        },
        {
          "path": "src/runtime/memory/background-review.ts",
          "lines": 314
        },
        {
          "path": "src/runtime/memory/compile-pipeline.ts",
          "lines": 184
        },
        {
          "path": "src/runtime/memory/compile-prompts.ts",
          "lines": 15
        },
        {
          "path": "src/runtime/memory/event-indexer.ts",
          "lines": 297
        },
        {
          "path": "src/runtime/memory/intensity-calculator.ts",
          "lines": 72
        },
        {
          "path": "src/runtime/memory/jsonl-branch-reader.ts",
          "lines": 221
        },
        {
          "path": "src/runtime/memory/memory-files.ts",
          "lines": 63
        },
        {
          "path": "src/runtime/memory/memory-injection.ts",
          "lines": 276
        },
        {
          "path": "src/runtime/memory/memory-policy.ts",
          "lines": 232
        },
        {
          "path": "src/runtime/memory/memory-ticker.ts",
          "lines": 327
        },
        {
          "path": "src/runtime/memory/proposal-application.ts",
          "lines": 484
        },
        {
          "path": "src/runtime/memory/recall-service.ts",
          "lines": 719
        },
        {
          "path": "src/runtime/memory/resolver.ts",
          "lines": 324
        },
        {
          "path": "src/runtime/memory/rolling-summary.ts",
          "lines": 339
        },
        {
          "path": "src/runtime/memory/scheduler.ts",
          "lines": 337
        },
        {
          "path": "src/runtime/memory/summary-format.ts",
          "lines": 83
        },
        {
          "path": "src/runtime/memory/summary-prompts.ts",
          "lines": 90
        }
      ],
      "fileCount": 22,
      "totalLines": 4788
    },
    {
      "id": "skills",
      "label": "Skills subsystem",
      "shortLabel": "Skills",
      "layer": "runtime",
      "status": "stable",
      "roots": [
        "src/runtime/skills/"
      ],
      "purpose": "Discovers, validates, trusts, installs, binds, snapshots, loads, and safely executes Skills from built-in, workspace, archive, Git, HTTP, plugin, OpenClaw, and Hermes sources.",
      "owns": [
        "Skill catalog and source adapters",
        "Manifest validation, readiness and risk assessment",
        "Agent/session binding, snapshots and activation grants",
        "Content loading, installation operations and script execution",
        "Plugin and ecosystem compatibility bridges"
      ],
      "invariants": [
        "A Skill is not executable merely because it was discovered; readiness, trust, risk and policy gates still apply.",
        "Turn and Subagent Skill visibility is snapshot-based and bounded.",
        "Plugin-provided Skills follow plugin lifecycle and fail closed when their source is disabled or removed.",
        "Session files and external paths are validated against ownership and trusted roots."
      ],
      "docs": [
        {
          "label": "Skill author guide",
          "path": "docs/plugin-development.md"
        },
        {
          "label": "Skill implementation history",
          "path": "plans/phase-13.md"
        },
        {
          "label": "Security policy",
          "path": "SECURITY.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/runtime/skills/composition.ts",
          "label": "Skills composition root"
        },
        {
          "path": "src/runtime/skills/catalog/skill-catalog.ts",
          "label": "Skill catalog"
        },
        {
          "path": "src/runtime/skills/validator.ts",
          "label": "Manifest validator"
        },
        {
          "path": "src/runtime/skills/snapshot/skill-snapshot.ts",
          "label": "Turn snapshot"
        },
        {
          "path": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "label": "Plugin bridge"
        },
        {
          "path": "src/runtime/skills/plugin/skill-script-runner.ts",
          "label": "Script runner"
        }
      ],
      "layout": {
        "x": 810,
        "y": 408,
        "w": 210,
        "h": 102
      },
      "files": [
        {
          "path": "src/runtime/skills/agent/agent-skill-config.ts",
          "lines": 210
        },
        {
          "path": "src/runtime/skills/binding/projection.ts",
          "lines": 114
        },
        {
          "path": "src/runtime/skills/binding/skill-binding-service.ts",
          "lines": 561
        },
        {
          "path": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "lines": 661
        },
        {
          "path": "src/runtime/skills/catalog/scan.ts",
          "lines": 147
        },
        {
          "path": "src/runtime/skills/catalog/skill-catalog.ts",
          "lines": 316
        },
        {
          "path": "src/runtime/skills/compat/ecosystem-migration.ts",
          "lines": 120
        },
        {
          "path": "src/runtime/skills/compat/hermes-skill-rewrite.ts",
          "lines": 505
        },
        {
          "path": "src/runtime/skills/composition.ts",
          "lines": 457
        },
        {
          "path": "src/runtime/skills/confirmation/confirmation-token.ts",
          "lines": 317
        },
        {
          "path": "src/runtime/skills/content/load-handle.ts",
          "lines": 189
        },
        {
          "path": "src/runtime/skills/content/skill-content-service.ts",
          "lines": 449
        },
        {
          "path": "src/runtime/skills/core/skill-admin-service.ts",
          "lines": 368
        },
        {
          "path": "src/runtime/skills/core/skill-core-service.ts",
          "lines": 2246
        },
        {
          "path": "src/runtime/skills/errors.ts",
          "lines": 43
        },
        {
          "path": "src/runtime/skills/frontmatter.ts",
          "lines": 617
        },
        {
          "path": "src/runtime/skills/hash.ts",
          "lines": 62
        },
        {
          "path": "src/runtime/skills/installer/index.ts",
          "lines": 41
        },
        {
          "path": "src/runtime/skills/installer/operation-store.ts",
          "lines": 139
        },
        {
          "path": "src/runtime/skills/installer/risk.ts",
          "lines": 50
        },
        {
          "path": "src/runtime/skills/installer/session-file-registry.ts",
          "lines": 127
        },
        {
          "path": "src/runtime/skills/installer/skill-installer.ts",
          "lines": 536
        },
        {
          "path": "src/runtime/skills/installer/stager.ts",
          "lines": 111
        },
        {
          "path": "src/runtime/skills/manifest.ts",
          "lines": 491
        },
        {
          "path": "src/runtime/skills/pack.ts",
          "lines": 72
        },
        {
          "path": "src/runtime/skills/path-safety.ts",
          "lines": 143
        },
        {
          "path": "src/runtime/skills/plugin/plugin-readiness.ts",
          "lines": 132
        },
        {
          "path": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "lines": 651
        },
        {
          "path": "src/runtime/skills/plugin/skill-script-runner.ts",
          "lines": 335
        },
        {
          "path": "src/runtime/skills/readiness.ts",
          "lines": 122
        },
        {
          "path": "src/runtime/skills/resolver.ts",
          "lines": 326
        },
        {
          "path": "src/runtime/skills/session/session-skill-service.ts",
          "lines": 365
        },
        {
          "path": "src/runtime/skills/snapshot/skill-snapshot.ts",
          "lines": 483
        },
        {
          "path": "src/runtime/skills/sources/archive-source.ts",
          "lines": 137
        },
        {
          "path": "src/runtime/skills/sources/builtin-source.ts",
          "lines": 77
        },
        {
          "path": "src/runtime/skills/sources/ecosystem-mirror.ts",
          "lines": 299
        },
        {
          "path": "src/runtime/skills/sources/external-local-source.ts",
          "lines": 76
        },
        {
          "path": "src/runtime/skills/sources/factory.ts",
          "lines": 59
        },
        {
          "path": "src/runtime/skills/sources/git-source.ts",
          "lines": 140
        },
        {
          "path": "src/runtime/skills/sources/hermes-skill-source.ts",
          "lines": 98
        },
        {
          "path": "src/runtime/skills/sources/http-source.ts",
          "lines": 220
        },
        {
          "path": "src/runtime/skills/sources/linked-source-registry.ts",
          "lines": 238
        },
        {
          "path": "src/runtime/skills/sources/managed-source.ts",
          "lines": 110
        },
        {
          "path": "src/runtime/skills/sources/openclaw-skill-source.ts",
          "lines": 94
        },
        {
          "path": "src/runtime/skills/sources/plugin-source.ts",
          "lines": 103
        },
        {
          "path": "src/runtime/skills/sources/skill-source-adapter.ts",
          "lines": 197
        },
        {
          "path": "src/runtime/skills/sources/stage-utils.ts",
          "lines": 154
        },
        {
          "path": "src/runtime/skills/sources/trust-config.ts",
          "lines": 140
        },
        {
          "path": "src/runtime/skills/sources/workspace-roots.ts",
          "lines": 43
        },
        {
          "path": "src/runtime/skills/sources/workspace-source.ts",
          "lines": 95
        },
        {
          "path": "src/runtime/skills/sources/zip-extract.ts",
          "lines": 187
        },
        {
          "path": "src/runtime/skills/validator.ts",
          "lines": 249
        },
        {
          "path": "src/runtime/skills/zip-builder.ts",
          "lines": 173
        }
      ],
      "fileCount": 53,
      "totalLines": 14395
    },
    {
      "id": "subagents",
      "label": "Subagent runtime",
      "shortLabel": "Subagents",
      "layer": "runtime",
      "status": "stable",
      "roots": [
        "src/runtime/subagents/"
      ],
      "purpose": "Runs delegated work with parent-session control, mailbox delivery, artifact/transcript stores, policy leases, recovery, and observability.",
      "owns": [
        "Subagent thread/run lifecycle",
        "Parent mailbox and result delivery",
        "Transcript replay and artifact files",
        "Workspace leases, recovery, and usage ingestion"
      ],
      "invariants": [
        "Parent and child identities remain explicit.",
        "Delivery and notification are separate concerns.",
        "Capability and workspace policy are revalidated at execution boundaries."
      ],
      "docs": [
        {
          "label": "Subagent architecture",
          "path": "plans/phase-14.md"
        },
        {
          "label": "Logging architecture",
          "path": "docs/logging-architecture.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/runtime/subagents/composition.ts",
          "label": "Subagent composition"
        },
        {
          "path": "src/runtime/subagents/runtime/runtime-host.ts",
          "label": "Runtime host"
        },
        {
          "path": "src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.ts",
          "label": "Mailbox delivery"
        },
        {
          "path": "src/runtime/subagents/transcript/replay-store.ts",
          "label": "Transcript replay"
        }
      ],
      "layout": {
        "x": 810,
        "y": 408,
        "w": 210,
        "h": 102
      },
      "files": [
        {
          "path": "src/runtime/subagents/composition.ts",
          "lines": 356
        },
        {
          "path": "src/runtime/subagents/context-resolver.ts",
          "lines": 373
        },
        {
          "path": "src/runtime/subagents/delegation-policy.ts",
          "lines": 540
        },
        {
          "path": "src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.ts",
          "lines": 558
        },
        {
          "path": "src/runtime/subagents/mailbox/parent-session-port.ts",
          "lines": 60
        },
        {
          "path": "src/runtime/subagents/observability/subagent-observability-projector.ts",
          "lines": 722
        },
        {
          "path": "src/runtime/subagents/protocol/protocol-dispatcher.ts",
          "lines": 384
        },
        {
          "path": "src/runtime/subagents/recovery/startup-recovery.ts",
          "lines": 268
        },
        {
          "path": "src/runtime/subagents/runtime/internal-tools.ts",
          "lines": 162
        },
        {
          "path": "src/runtime/subagents/runtime/parent-session-adapter.ts",
          "lines": 155
        },
        {
          "path": "src/runtime/subagents/runtime/pi-session-adapter.ts",
          "lines": 366
        },
        {
          "path": "src/runtime/subagents/runtime/runtime-host.ts",
          "lines": 963
        },
        {
          "path": "src/runtime/subagents/runtime/scheduler.ts",
          "lines": 127
        },
        {
          "path": "src/runtime/subagents/runtime/types.ts",
          "lines": 77
        },
        {
          "path": "src/runtime/subagents/runtime/usage-ingestion.ts",
          "lines": 107
        },
        {
          "path": "src/runtime/subagents/stores/artifact-store.ts",
          "lines": 260
        },
        {
          "path": "src/runtime/subagents/stores/errors.ts",
          "lines": 26
        },
        {
          "path": "src/runtime/subagents/stores/index.ts",
          "lines": 17
        },
        {
          "path": "src/runtime/subagents/stores/message-store.ts",
          "lines": 378
        },
        {
          "path": "src/runtime/subagents/stores/parent-mailbox-store.ts",
          "lines": 420
        },
        {
          "path": "src/runtime/subagents/stores/run-store.ts",
          "lines": 844
        },
        {
          "path": "src/runtime/subagents/stores/subagent-transactions.ts",
          "lines": 363
        },
        {
          "path": "src/runtime/subagents/stores/thread-store.ts",
          "lines": 395
        },
        {
          "path": "src/runtime/subagents/stores/types.ts",
          "lines": 21
        },
        {
          "path": "src/runtime/subagents/stores/workspace-lease-store.ts",
          "lines": 191
        },
        {
          "path": "src/runtime/subagents/task-renderer.ts",
          "lines": 249
        },
        {
          "path": "src/runtime/subagents/transcript/artifact-files.ts",
          "lines": 286
        },
        {
          "path": "src/runtime/subagents/transcript/replay-store.ts",
          "lines": 185
        },
        {
          "path": "src/runtime/subagents/transcript/tool-summary.ts",
          "lines": 369
        },
        {
          "path": "src/runtime/subagents/transcript/transcript-view.ts",
          "lines": 244
        },
        {
          "path": "src/runtime/subagents/workspace-lease-service.ts",
          "lines": 169
        }
      ],
      "fileCount": 31,
      "totalLines": 9635
    },
    {
      "id": "storage",
      "label": "SQLite metadata and state",
      "shortLabel": "SQLite",
      "layer": "persistence",
      "status": "active",
      "roots": [
        "src/storage/"
      ],
      "purpose": "Stores session metadata, branch heads, todo state, provider settings, plugin/skill registries, usage, observability, and platform state. It does not own message bodies.",
      "owns": [
        "SQLite connection and migrations",
        "Session index and branch metadata",
        "Session todos and durable event-related state",
        "Provider, plugin, skill, usage, and observability stores"
      ],
      "invariants": [
        "PI JSONL is the message and branch-history fact source.",
        "SQLite never becomes a second message-body store.",
        "Migrations are idempotent and recovery behavior is tested."
      ],
      "docs": [
        {
          "label": "Data ownership",
          "path": "docs/architecture.md"
        },
        {
          "label": "Migration conventions",
          "path": "docs/migrations/README.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/storage/database.ts",
          "label": "Database open"
        },
        {
          "path": "src/storage/migrations.ts",
          "label": "Schema migration"
        },
        {
          "path": "src/storage/session-index.ts",
          "label": "Session metadata"
        },
        {
          "path": "src/storage/session-todos.ts",
          "label": "Durable todos"
        }
      ],
      "layout": {
        "x": 30,
        "y": 590,
        "w": 230,
        "h": 102
      },
      "files": [
        {
          "path": "src/storage/agent-skill-binding-store.ts",
          "lines": 122
        },
        {
          "path": "src/storage/database.ts",
          "lines": 23
        },
        {
          "path": "src/storage/memory/batch-store.ts",
          "lines": 140
        },
        {
          "path": "src/storage/memory/cjk-ngram.ts",
          "lines": 10
        },
        {
          "path": "src/storage/memory/event-store.ts",
          "lines": 247
        },
        {
          "path": "src/storage/memory/fact-store.ts",
          "lines": 241
        },
        {
          "path": "src/storage/memory/journal-store.ts",
          "lines": 207
        },
        {
          "path": "src/storage/memory/pinned-store.ts",
          "lines": 68
        },
        {
          "path": "src/storage/memory/proposal-store.ts",
          "lines": 89
        },
        {
          "path": "src/storage/memory/recall-store.ts",
          "lines": 320
        },
        {
          "path": "src/storage/memory/recovery-store.ts",
          "lines": 224
        },
        {
          "path": "src/storage/memory/summary-store.ts",
          "lines": 162
        },
        {
          "path": "src/storage/migrations.ts",
          "lines": 1154
        },
        {
          "path": "src/storage/plugin-binding-store.ts",
          "lines": 116
        },
        {
          "path": "src/storage/plugin-config-store.ts",
          "lines": 115
        },
        {
          "path": "src/storage/plugin-grant-store.ts",
          "lines": 125
        },
        {
          "path": "src/storage/plugin-registry-store.ts",
          "lines": 317
        },
        {
          "path": "src/storage/search/cjk-ngram.ts",
          "lines": 92
        },
        {
          "path": "src/storage/session-index.ts",
          "lines": 215
        },
        {
          "path": "src/storage/session-skill-binding-store.ts",
          "lines": 94
        },
        {
          "path": "src/storage/session-todos.ts",
          "lines": 174
        },
        {
          "path": "src/storage/skill-activation-grant-store.ts",
          "lines": 99
        },
        {
          "path": "src/storage/skill-bundle-store.ts",
          "lines": 217
        },
        {
          "path": "src/storage/usage-store.ts",
          "lines": 364
        }
      ],
      "fileCount": 24,
      "totalLines": 4935
    },
    {
      "id": "host-safety",
      "label": "Config, sandbox and host safety",
      "shortLabel": "Host safety",
      "layer": "persistence",
      "status": "stable",
      "roots": [
        "src/config/",
        "src/sandbox/",
        "src/platform/"
      ],
      "purpose": "Defines local data paths, environment isolation, sandbox boundaries, directory selection, and host-level safety helpers.",
      "owns": [
        "OPENCOLORFUL_HOME and runtime paths",
        "Provider credential separation",
        "Sandbox policy and tool grants",
        "Native directory selection and path guards"
      ],
      "invariants": [
        "Credentials stay in AuthStorage or dedicated secret stores.",
        "Default network binding is loopback.",
        "Paths are resolved through the central path contract."
      ],
      "docs": [
        {
          "label": "Infrastructure decisions",
          "path": "docs/infrastructure-decisions.md"
        },
        {
          "label": "Security policy",
          "path": "SECURITY.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/config/paths.ts",
          "label": "Runtime paths"
        },
        {
          "path": "src/sandbox/sandbox-service.ts",
          "label": "Sandbox service"
        },
        {
          "path": "src/platform/folder-picker.ts",
          "label": "Native folder picker"
        }
      ],
      "layout": {
        "x": 300,
        "y": 590,
        "w": 220,
        "h": 102
      },
      "files": [
        {
          "path": "src/config/agent-store.ts",
          "lines": 547
        },
        {
          "path": "src/config/environment.ts",
          "lines": 44
        },
        {
          "path": "src/config/paths.ts",
          "lines": 87
        },
        {
          "path": "src/config/preferences-store.ts",
          "lines": 93
        },
        {
          "path": "src/config/provider-store.ts",
          "lines": 53
        },
        {
          "path": "src/platform/folder-picker.ts",
          "lines": 127
        },
        {
          "path": "src/sandbox/backend.ts",
          "lines": 50
        },
        {
          "path": "src/sandbox/local-backend.ts",
          "lines": 137
        },
        {
          "path": "src/sandbox/path-guard.ts",
          "lines": 233
        },
        {
          "path": "src/sandbox/policy.ts",
          "lines": 157
        },
        {
          "path": "src/sandbox/preflight.ts",
          "lines": 44
        },
        {
          "path": "src/sandbox/registry.ts",
          "lines": 35
        },
        {
          "path": "src/sandbox/sandbox-service.ts",
          "lines": 150
        }
      ],
      "fileCount": 13,
      "totalLines": 1757
    },
    {
      "id": "observability",
      "label": "Observability and usage",
      "shortLabel": "Observability",
      "layer": "runtime",
      "status": "stable",
      "roots": [
        "src/observability/"
      ],
      "purpose": "Captures activities, audits, diagnostics, traces, retention, safe values, support bundles, and usage evidence without leaking secrets.",
      "owns": [
        "Activity, audit, diagnostic and emergency channels",
        "Trace context and event catalog",
        "Redaction, retention and support bundle policy",
        "Runtime usage recording and query surfaces"
      ],
      "invariants": [
        "Sensitive values are redacted before storage or projection.",
        "Audit terminal state reflects the real domain outcome.",
        "Operational evidence must be inspectable without becoming message content."
      ],
      "docs": [
        {
          "label": "Logging architecture",
          "path": "docs/logging-architecture.md"
        },
        {
          "label": "Usage contract",
          "path": "src/contracts/usage.ts"
        }
      ],
      "keyFiles": [
        {
          "path": "src/observability/instrument.ts",
          "label": "Instrumentation"
        },
        {
          "path": "src/observability/safe-value.ts",
          "label": "Redaction"
        },
        {
          "path": "src/observability/retention.ts",
          "label": "Retention"
        },
        {
          "path": "src/runtime/usage-recorder.ts",
          "label": "Usage recorder"
        }
      ],
      "layout": {
        "x": 560,
        "y": 590,
        "w": 210,
        "h": 102
      },
      "files": [
        {
          "path": "src/observability/activity-operation.ts",
          "lines": 103
        },
        {
          "path": "src/observability/activity-recorder.ts",
          "lines": 423
        },
        {
          "path": "src/observability/audit-recorder.ts",
          "lines": 409
        },
        {
          "path": "src/observability/catalog/plugin-events.ts",
          "lines": 118
        },
        {
          "path": "src/observability/catalog/shared.ts",
          "lines": 25
        },
        {
          "path": "src/observability/catalog/skill-events.ts",
          "lines": 98
        },
        {
          "path": "src/observability/catalog/subagent-events.ts",
          "lines": 98
        },
        {
          "path": "src/observability/diagnostic-logger.ts",
          "lines": 359
        },
        {
          "path": "src/observability/emergency-spool.ts",
          "lines": 173
        },
        {
          "path": "src/observability/event-catalog.ts",
          "lines": 239
        },
        {
          "path": "src/observability/extension-port.ts",
          "lines": 240
        },
        {
          "path": "src/observability/instrument.ts",
          "lines": 613
        },
        {
          "path": "src/observability/observability-context.ts",
          "lines": 247
        },
        {
          "path": "src/observability/observability-query.ts",
          "lines": 550
        },
        {
          "path": "src/observability/retention.ts",
          "lines": 221
        },
        {
          "path": "src/observability/safe-value.ts",
          "lines": 155
        },
        {
          "path": "src/observability/stream-watermark.ts",
          "lines": 33
        },
        {
          "path": "src/observability/support-bundle.ts",
          "lines": 163
        },
        {
          "path": "src/observability/trace-context.ts",
          "lines": 85
        }
      ],
      "fileCount": 19,
      "totalLines": 4352
    },
    {
      "id": "plugin-runtime",
      "label": "Plugin runtime and host",
      "shortLabel": "Plugin runtime",
      "layer": "extension",
      "status": "active",
      "roots": [
        "src/runtime/plugins/",
        "src/platform/plugin-facade.ts"
      ],
      "purpose": "Loads, validates, grants, hosts, observes, and adapts plugin contributions from local, zip, Git, npm, OpenClaw, and Hermes sources.",
      "owns": [
        "Plugin source adapters and installer",
        "Capability grants, bindings, policy snapshots and host broker",
        "Node/Python/MCP/JSON-RPC carriers",
        "Routes, tools, providers, surfaces, secrets, skills, and background contributions"
      ],
      "invariants": [
        "Plugin execution is bounded by explicit capability policy.",
        "Secret contribution uses dedicated stores and redaction.",
        "Compatibility adapters normalize external ecosystems instead of leaking their formats inward."
      ],
      "docs": [
        {
          "label": "Plugin author guide",
          "path": "docs/plugin-development.md"
        },
        {
          "label": "Plugin implementation history",
          "path": "plans/phase-12.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/platform/plugin-facade.ts",
          "label": "Host facade"
        },
        {
          "path": "src/runtime/plugins/registry/plugin-registry.ts",
          "label": "Plugin registry"
        },
        {
          "path": "src/runtime/plugins/grants/execution-snapshot.ts",
          "label": "Policy snapshot"
        },
        {
          "path": "src/runtime/plugins/runtimes/runtime-host.ts",
          "label": "Runtime host"
        }
      ],
      "packageName": null,
      "layout": {
        "x": 810,
        "y": 590,
        "w": 210,
        "h": 102
      },
      "files": [
        {
          "path": "src/platform/plugin-facade.ts",
          "lines": 737
        },
        {
          "path": "src/runtime/plugins/compat/hermes-compat.ts",
          "lines": 1173
        },
        {
          "path": "src/runtime/plugins/compat/hermes-python-bridge.ts",
          "lines": 588
        },
        {
          "path": "src/runtime/plugins/compat/openclaw-compat.ts",
          "lines": 512
        },
        {
          "path": "src/runtime/plugins/contributions/attachment-contribution.ts",
          "lines": 234
        },
        {
          "path": "src/runtime/plugins/contributions/background-contribution.ts",
          "lines": 445
        },
        {
          "path": "src/runtime/plugins/contributions/command-contribution.ts",
          "lines": 188
        },
        {
          "path": "src/runtime/plugins/contributions/config-contribution.ts",
          "lines": 187
        },
        {
          "path": "src/runtime/plugins/contributions/contribution-registry.ts",
          "lines": 206
        },
        {
          "path": "src/runtime/plugins/contributions/custom-activity-contribution.ts",
          "lines": 163
        },
        {
          "path": "src/runtime/plugins/contributions/file-secret-store.ts",
          "lines": 238
        },
        {
          "path": "src/runtime/plugins/contributions/host-api.ts",
          "lines": 320
        },
        {
          "path": "src/runtime/plugins/contributions/provider-contribution.ts",
          "lines": 209
        },
        {
          "path": "src/runtime/plugins/contributions/route-contribution.ts",
          "lines": 393
        },
        {
          "path": "src/runtime/plugins/contributions/secret-contribution.ts",
          "lines": 263
        },
        {
          "path": "src/runtime/plugins/contributions/shared.ts",
          "lines": 291
        },
        {
          "path": "src/runtime/plugins/contributions/skill-bundle.ts",
          "lines": 71
        },
        {
          "path": "src/runtime/plugins/contributions/surface-contribution.ts",
          "lines": 200
        },
        {
          "path": "src/runtime/plugins/contributions/tool-contribution.ts",
          "lines": 311
        },
        {
          "path": "src/runtime/plugins/dev/dev-host.ts",
          "lines": 970
        },
        {
          "path": "src/runtime/plugins/dev/dev-invoke.ts",
          "lines": 86
        },
        {
          "path": "src/runtime/plugins/dev/dev-scenario.ts",
          "lines": 389
        },
        {
          "path": "src/runtime/plugins/grants/binding-service.ts",
          "lines": 289
        },
        {
          "path": "src/runtime/plugins/grants/capability-catalog.ts",
          "lines": 184
        },
        {
          "path": "src/runtime/plugins/grants/effective-policy.ts",
          "lines": 153
        },
        {
          "path": "src/runtime/plugins/grants/execution-snapshot.ts",
          "lines": 122
        },
        {
          "path": "src/runtime/plugins/grants/grant-service.ts",
          "lines": 408
        },
        {
          "path": "src/runtime/plugins/grants/host-broker.ts",
          "lines": 221
        },
        {
          "path": "src/runtime/plugins/grants/sandbox-bridge.ts",
          "lines": 213
        },
        {
          "path": "src/runtime/plugins/installer/plugin-installer.ts",
          "lines": 523
        },
        {
          "path": "src/runtime/plugins/paths.ts",
          "lines": 199
        },
        {
          "path": "src/runtime/plugins/registry/plugin-registry.ts",
          "lines": 889
        },
        {
          "path": "src/runtime/plugins/runtimes/bundle-runtime.ts",
          "lines": 97
        },
        {
          "path": "src/runtime/plugins/runtimes/carrier-registry.ts",
          "lines": 205
        },
        {
          "path": "src/runtime/plugins/runtimes/json-rpc.ts",
          "lines": 423
        },
        {
          "path": "src/runtime/plugins/runtimes/mcp-runtime.ts",
          "lines": 350
        },
        {
          "path": "src/runtime/plugins/runtimes/node-runtime.ts",
          "lines": 297
        },
        {
          "path": "src/runtime/plugins/runtimes/python-runtime.ts",
          "lines": 325
        },
        {
          "path": "src/runtime/plugins/runtimes/runtime-host.ts",
          "lines": 1050
        },
        {
          "path": "src/runtime/plugins/runtimes/stream-capture.ts",
          "lines": 217
        },
        {
          "path": "src/runtime/plugins/sources/git-source.ts",
          "lines": 161
        },
        {
          "path": "src/runtime/plugins/sources/hermes-source.ts",
          "lines": 199
        },
        {
          "path": "src/runtime/plugins/sources/local-source.ts",
          "lines": 129
        },
        {
          "path": "src/runtime/plugins/sources/npm-source.ts",
          "lines": 205
        },
        {
          "path": "src/runtime/plugins/sources/openclaw-source.ts",
          "lines": 452
        },
        {
          "path": "src/runtime/plugins/sources/source-adapter.ts",
          "lines": 227
        },
        {
          "path": "src/runtime/plugins/sources/zip-source.ts",
          "lines": 230
        }
      ],
      "fileCount": 47,
      "totalLines": 15942
    },
    {
      "id": "plugin-protocol",
      "label": "@opencolorful/plugin-protocol",
      "shortLabel": "Plugin protocol",
      "layer": "extension",
      "status": "stable",
      "roots": [
        "packages/plugin-protocol/src/"
      ],
      "packageName": "@opencolorful/plugin-protocol",
      "purpose": "Public schemas and normalized vocabulary for manifests, permissions, contributions, IPC, compatibility, and snapshots.",
      "owns": [
        "Manifest and compatibility schemas",
        "Contribution and permission contracts",
        "IPC and normalized plugin snapshots"
      ],
      "invariants": [
        "Protocol package remains free of host implementation details.",
        "Schema changes require compatibility tests and package build verification."
      ],
      "docs": [
        {
          "label": "Plugin development",
          "path": "docs/plugin-development.md"
        },
        {
          "label": "Package boundary",
          "path": "docs/repository-layout.md"
        }
      ],
      "keyFiles": [
        {
          "path": "packages/plugin-protocol/src/index.ts",
          "label": "Protocol exports"
        },
        {
          "path": "packages/plugin-protocol/src/manifest.ts",
          "label": "Manifest schema"
        },
        {
          "path": "packages/plugin-protocol/src/contribution.ts",
          "label": "Contribution schema"
        }
      ],
      "layout": {
        "x": 30,
        "y": 750,
        "w": 230,
        "h": 92
      },
      "files": [
        {
          "path": "packages/plugin-protocol/src/compatibility.ts",
          "lines": 85
        },
        {
          "path": "packages/plugin-protocol/src/contribution.ts",
          "lines": 198
        },
        {
          "path": "packages/plugin-protocol/src/index.ts",
          "lines": 16
        },
        {
          "path": "packages/plugin-protocol/src/ipc.ts",
          "lines": 85
        },
        {
          "path": "packages/plugin-protocol/src/manifest.ts",
          "lines": 98
        },
        {
          "path": "packages/plugin-protocol/src/normalized.ts",
          "lines": 73
        },
        {
          "path": "packages/plugin-protocol/src/permission.ts",
          "lines": 95
        },
        {
          "path": "packages/plugin-protocol/src/snapshot.ts",
          "lines": 52
        }
      ],
      "fileCount": 8,
      "totalLines": 702
    },
    {
      "id": "plugin-sdk",
      "label": "@opencolorful/plugin-sdk",
      "shortLabel": "Plugin SDK",
      "layer": "extension",
      "status": "stable",
      "roots": [
        "packages/plugin-sdk/src/"
      ],
      "packageName": "@opencolorful/plugin-sdk",
      "purpose": "Author-facing definitions, validation helpers, errors, and scaffolding for plugins.",
      "owns": [
        "definePlugin",
        "Plugin author errors and validation",
        "Scaffold generation"
      ],
      "invariants": [
        "SDK consumes the public protocol, not private host internals.",
        "Generated scaffolds remain compatible with the runtime package."
      ],
      "docs": [
        {
          "label": "Plugin author guide",
          "path": "docs/plugin-development.md"
        }
      ],
      "keyFiles": [
        {
          "path": "packages/plugin-sdk/src/define.ts",
          "label": "Plugin definition"
        },
        {
          "path": "packages/plugin-sdk/src/scaffold.ts",
          "label": "Scaffold"
        }
      ],
      "layout": {
        "x": 300,
        "y": 750,
        "w": 210,
        "h": 92
      },
      "files": [
        {
          "path": "packages/plugin-sdk/src/define.ts",
          "lines": 192
        },
        {
          "path": "packages/plugin-sdk/src/errors.ts",
          "lines": 43
        },
        {
          "path": "packages/plugin-sdk/src/index.ts",
          "lines": 14
        },
        {
          "path": "packages/plugin-sdk/src/scaffold.ts",
          "lines": 168
        }
      ],
      "fileCount": 4,
      "totalLines": 417
    },
    {
      "id": "plugin-package-runtime",
      "label": "@opencolorful/plugin-runtime + components",
      "shortLabel": "Plugin packages",
      "layer": "extension",
      "status": "stable",
      "roots": [
        "packages/plugin-runtime/src/",
        "packages/plugin-components/src/"
      ],
      "packageName": "@opencolorful/plugin-runtime",
      "packageNames": [
        "@opencolorful/plugin-runtime",
        "@opencolorful/plugin-components"
      ],
      "purpose": "Runtime-side plugin server helpers and bounded UI/host contribution components.",
      "owns": [
        "Plugin runtime server",
        "Host and UI contribution helpers",
        "Package-level compatibility surfaces"
      ],
      "invariants": [
        "Package APIs remain explicit and versionable.",
        "Components do not take ownership of the host shell or permission lifecycle."
      ],
      "docs": [
        {
          "label": "Repository package layout",
          "path": "docs/repository-layout.md"
        },
        {
          "label": "Plugin author guide",
          "path": "docs/plugin-development.md"
        }
      ],
      "keyFiles": [
        {
          "path": "packages/plugin-runtime/src/server.ts",
          "label": "Plugin runtime server"
        },
        {
          "path": "packages/plugin-components/src/host.ts",
          "label": "Host contribution helpers"
        },
        {
          "path": "packages/plugin-components/src/ui.ts",
          "label": "UI contribution helpers"
        }
      ],
      "layout": {
        "x": 550,
        "y": 750,
        "w": 240,
        "h": 92
      },
      "files": [
        {
          "path": "packages/plugin-components/src/host.ts",
          "lines": 146
        },
        {
          "path": "packages/plugin-components/src/index.ts",
          "lines": 12
        },
        {
          "path": "packages/plugin-components/src/ui.ts",
          "lines": 134
        },
        {
          "path": "packages/plugin-runtime/src/index.ts",
          "lines": 12
        },
        {
          "path": "packages/plugin-runtime/src/server.ts",
          "lines": 363
        }
      ],
      "fileCount": 5,
      "totalLines": 667
    },
    {
      "id": "cli-governance",
      "label": "CLI and repository checks",
      "shortLabel": "CLI / checks",
      "layer": "persistence",
      "status": "stable",
      "roots": [
        "src/cli/",
        "src/index.ts",
        "scripts/"
      ],
      "purpose": "Provides command-line lifecycle entry points plus the repository's import, package, document, smoke, and release checks.",
      "owns": [
        "ocf CLI commands",
        "PI/plugin import boundary checks",
        "Document governance and package verification",
        "Web/server smoke and release utilities"
      ],
      "invariants": [
        "Quality commands run separately and preserve exit codes.",
        "Governance checks are part of the same quality story as product code.",
        "Generated architecture data is stale when the manifest scan no longer matches it."
      ],
      "docs": [
        {
          "label": "Agent workflow",
          "path": "docs/development.md"
        },
        {
          "label": "CI/CD",
          "path": "docs/ci-cd.md"
        }
      ],
      "keyFiles": [
        {
          "path": "src/cli/main.ts",
          "label": "CLI entry"
        },
        {
          "path": "src/index.ts",
          "label": "Package entry"
        },
        {
          "path": "scripts/generate-architecture-map.mjs",
          "label": "Architecture generator"
        },
        {
          "path": "scripts/verify-document-governance.mjs",
          "label": "Document governance"
        }
      ],
      "layout": {
        "x": 800,
        "y": 750,
        "w": 220,
        "h": 92
      },
      "files": [
        {
          "path": "scripts/bump-desktop-version.mjs",
          "lines": 39
        },
        {
          "path": "scripts/generate-architecture-map.mjs",
          "lines": 478
        },
        {
          "path": "scripts/smoke-foundation.mjs",
          "lines": 96
        },
        {
          "path": "scripts/smoke-web.mjs",
          "lines": 182
        },
        {
          "path": "scripts/verify-document-governance.mjs",
          "lines": 142
        },
        {
          "path": "scripts/verify-pi-sdk-imports.mjs",
          "lines": 47
        },
        {
          "path": "scripts/verify-plugin-imports.mjs",
          "lines": 101
        },
        {
          "path": "scripts/verify-plugin-package.mjs",
          "lines": 379
        },
        {
          "path": "scripts/verify-skill-package.mjs",
          "lines": 237
        },
        {
          "path": "src/cli/chat-command.ts",
          "lines": 15
        },
        {
          "path": "src/cli/commands/plugins.ts",
          "lines": 376
        },
        {
          "path": "src/cli/commands/skills.ts",
          "lines": 710
        },
        {
          "path": "src/cli/main.ts",
          "lines": 36
        },
        {
          "path": "src/cli/server-command.ts",
          "lines": 133
        },
        {
          "path": "src/cli/supervisor-command.ts",
          "lines": 51
        },
        {
          "path": "src/index.ts",
          "lines": 4
        }
      ],
      "fileCount": 16,
      "totalLines": 3026
    }
  ],
  "edges": [
    {
      "from": "desktop-shell",
      "to": "supervisor",
      "label": "starts / proxies",
      "kind": "transport",
      "evidence": [
        "desktop/electron/main.cjs",
        "desktop/electron/api-proxy.cjs"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "desktop-renderer",
      "to": "desktop-shell",
      "label": "preload / IPC",
      "kind": "boundary",
      "evidence": [
        "desktop/src/data/ipc-source.ts",
        "desktop/electron/preload.cjs"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "desktop-renderer",
      "to": "server",
      "label": "HTTP / SSE / WS",
      "kind": "transport",
      "evidence": [
        "desktop/src/data/ipc-source.ts",
        "desktop/electron/api-proxy.cjs",
        "desktop/electron/sse-proxy.cjs"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "web-client",
      "to": "server",
      "label": "HTTP / SSE / WS",
      "kind": "transport",
      "evidence": [
        "web/src/lib/api-client.ts",
        "web/src/lib/sse-client.ts",
        "web/src/lib/ws-client.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "tui-client",
      "to": "server",
      "label": "Server protocol",
      "kind": "transport",
      "evidence": [
        "src/tui/event-client.ts",
        "src/tui/api-client.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "server",
      "to": "contracts",
      "label": "parse / emit",
      "kind": "contract",
      "evidence": [
        "src/server/app.ts",
        "src/server/routes/messages.ts",
        "src/server/sse/session-events.ts"
      ],
      "observedImports": 45,
      "observedEvidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../contracts/memory.js"
        },
        {
          "importer": "src/server/observability/client-events.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../contracts/events.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/api-error.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/base-color-templates.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/sandbox.js"
        },
        {
          "importer": "src/server/routes/directories.ts",
          "import": "../../contracts/api-error.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "session-runtime",
      "label": "delegate",
      "kind": "runtime",
      "evidence": [
        "src/server/routes/messages.ts",
        "src/server/routes/runtime-bootstrap.ts"
      ],
      "observedImports": 41,
      "observedEvidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/event-replay-store.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/model-service.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/prompt-service.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../runtime/event-replay-store.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/events.ts",
          "import": "../../runtime/event-replay-store.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "ui-projection",
      "label": "structured UI events",
      "kind": "projection",
      "evidence": [
        "src/server/routes/events.ts",
        "src/ui-projection/a2ui/project.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "session-runtime",
      "to": "pi-adapter",
      "label": "Agent session",
      "kind": "adapter",
      "evidence": [
        "src/runtime/session-runtime.ts",
        "src/pi-sdk/agent-session.ts"
      ],
      "observedImports": 5,
      "observedEvidence": [
        {
          "importer": "src/runtime/event-mapper.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/usage-recorder.ts",
          "import": "../pi-sdk/complete-text.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "storage",
      "label": "metadata / todo / usage",
      "kind": "persistence",
      "evidence": [
        "src/runtime/session-service.ts",
        "src/storage/session-index.ts",
        "src/storage/session-todos.ts"
      ],
      "observedImports": 3,
      "observedEvidence": [
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../storage/session-index.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../storage/session-todos.js"
        },
        {
          "importer": "src/runtime/usage-recorder.ts",
          "import": "../storage/usage-store.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "memory",
      "label": "recall / review",
      "kind": "runtime",
      "evidence": [
        "src/server/routes/runtime-bootstrap.ts",
        "src/runtime/memory/recall-service.ts",
        "src/runtime/memory/background-review.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "session-runtime",
      "to": "skills",
      "label": "skill snapshot / tools",
      "kind": "runtime",
      "evidence": [
        "src/server/routes/runtime-bootstrap.ts",
        "src/runtime/skills/composition.ts",
        "src/pi-sdk/skill-loader.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "session-runtime",
      "to": "subagents",
      "label": "delegation",
      "kind": "runtime",
      "evidence": [
        "src/server/routes/runtime-bootstrap.ts",
        "src/runtime/subagents/composition.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "session-runtime",
      "to": "plugin-runtime",
      "label": "host contributions",
      "kind": "extension",
      "evidence": [
        "src/server/routes/runtime-bootstrap.ts",
        "src/platform/plugin-facade.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "session-runtime",
      "to": "observability",
      "label": "activity / audit / usage",
      "kind": "telemetry",
      "evidence": [
        "src/runtime/usage-recorder.ts",
        "src/observability/instrument.ts"
      ],
      "observedImports": 4,
      "observedEvidence": [
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../observability/instrument.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "host-safety",
      "label": "paths / policy",
      "kind": "safety",
      "evidence": [
        "src/config/paths.ts",
        "src/sandbox/sandbox-service.ts"
      ],
      "observedImports": 7,
      "observedEvidence": [
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../config/provider-store.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../sandbox/sandbox-service.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/path-guard.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/preflight.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/sandbox-service.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "contracts",
      "label": "stable platform types",
      "kind": "contract",
      "evidence": [
        "src/pi-sdk/types.ts",
        "src/pi-sdk/session-tree.ts"
      ],
      "observedImports": 13,
      "observedEvidence": [
        {
          "importer": "src/pi-sdk/agent-session.ts",
          "import": "../contracts/events.js"
        },
        {
          "importer": "src/pi-sdk/agent-session.ts",
          "import": "../contracts/sandbox.js"
        },
        {
          "importer": "src/pi-sdk/complete-text.ts",
          "import": "../contracts/usage.js"
        },
        {
          "importer": "src/pi-sdk/memory-tools.ts",
          "import": "../contracts/memory.js"
        },
        {
          "importer": "src/pi-sdk/model-runtime.ts",
          "import": "../contracts/api-error.js"
        },
        {
          "importer": "src/pi-sdk/skill-loader.ts",
          "import": "../contracts/skill-protocol.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../contracts/model-policy.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../contracts/subagents.js"
        }
      ]
    },
    {
      "from": "plugin-sdk",
      "to": "plugin-protocol",
      "label": "consume schemas",
      "kind": "package",
      "evidence": [
        "packages/plugin-sdk/src/define.ts"
      ],
      "observedImports": 3,
      "observedEvidence": [
        {
          "importer": "packages/plugin-sdk/src/define.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-sdk/src/index.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-sdk/src/scaffold.ts",
          "import": "@opencolorful/plugin-protocol"
        }
      ]
    },
    {
      "from": "plugin-package-runtime",
      "to": "plugin-protocol",
      "label": "consume schemas",
      "kind": "package",
      "evidence": [
        "packages/plugin-runtime/src/index.ts",
        "packages/plugin-components/src/index.ts"
      ],
      "observedImports": 2,
      "observedEvidence": [
        {
          "importer": "packages/plugin-runtime/src/index.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-runtime/src/server.ts",
          "import": "@opencolorful/plugin-protocol"
        }
      ]
    },
    {
      "from": "plugin-runtime",
      "to": "plugin-protocol",
      "label": "normalize host boundary",
      "kind": "package",
      "evidence": [
        "src/contracts/plugin-protocol.ts",
        "src/runtime/plugins/contributions/host-api.ts"
      ],
      "observedImports": 0,
      "observedEvidence": []
    },
    {
      "from": "plugin-runtime",
      "to": "host-safety",
      "label": "grants / sandbox",
      "kind": "safety",
      "evidence": [
        "src/runtime/plugins/grants/effective-policy.ts",
        "src/runtime/plugins/grants/sandbox-bridge.ts"
      ],
      "observedImports": 10,
      "observedEvidence": [
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/host-api.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/surface-contribution.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/dev/dev-host.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/grants/sandbox-bridge.ts",
          "import": "../../../sandbox/path-guard.js"
        },
        {
          "importer": "src/runtime/plugins/grants/sandbox-bridge.ts",
          "import": "../../../sandbox/preflight.js"
        },
        {
          "importer": "src/runtime/plugins/installer/plugin-installer.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/paths.ts",
          "import": "../../config/paths.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "storage",
      "label": "catalog / bindings",
      "kind": "persistence",
      "evidence": [
        "src/runtime/skills/composition.ts",
        "src/storage/skill-bundle-store.ts",
        "src/storage/session-skill-binding-store.ts"
      ],
      "observedImports": 14,
      "observedEvidence": [
        {
          "importer": "src/runtime/skills/binding/projection.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/projection.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../storage/skill-bundle-store.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "host-safety",
      "label": "trust / sandbox",
      "kind": "safety",
      "evidence": [
        "src/runtime/skills/sources/trust-config.ts",
        "src/runtime/skills/plugin/skill-script-runner.ts"
      ],
      "observedImports": 21,
      "observedEvidence": [
        {
          "importer": "src/runtime/skills/agent/agent-skill-config.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/catalog/scan.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../sandbox/sandbox-service.js"
        },
        {
          "importer": "src/runtime/skills/core/skill-admin-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/installer/skill-installer.ts",
          "import": "../../../config/paths.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "plugin-runtime",
      "label": "plugin Skill bridge",
      "kind": "extension",
      "evidence": [
        "src/runtime/skills/plugin/plugin-skill-bridge.ts",
        "src/runtime/plugins/contributions/skill-bundle.ts"
      ],
      "observedImports": 5,
      "observedEvidence": [
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../platform/plugin-facade.js"
        },
        {
          "importer": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "import": "../../plugins/paths.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "supervisor",
      "label": "lifecycle commands",
      "kind": "host",
      "evidence": [
        "src/cli/supervisor-command.ts"
      ],
      "observedImports": 2,
      "observedEvidence": [
        {
          "importer": "src/cli/supervisor-command.ts",
          "import": "../supervisor/start.js"
        },
        {
          "importer": "src/cli/supervisor-command.ts",
          "import": "../supervisor/types.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "server",
      "label": "child process",
      "kind": "transport",
      "evidence": [
        "src/supervisor/start.ts",
        "src/supervisor/app.ts"
      ],
      "observedImports": 3,
      "observedEvidence": [
        {
          "importer": "src/supervisor/app.ts",
          "import": "../server/trust-boundary.js"
        },
        {
          "importer": "src/supervisor/process-controller.ts",
          "import": "../server/runtime-state.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../server/trust-boundary.js"
        }
      ]
    }
  ],
  "flows": [
    {
      "id": "prompt-stream",
      "label": "Prompt → streamed answer",
      "summary": "The normal conversation path: a client sends a command, the Server delegates to the Session Runtime, PI emits normalized events, Replay stores them, and the client projects the stream.",
      "nodes": [
        "desktop-renderer",
        "server",
        "contracts",
        "session-runtime",
        "pi-adapter",
        "storage",
        "desktop-renderer"
      ],
      "steps": [
        {
          "label": "Send",
          "node": "desktop-renderer",
          "detail": "Composer sends through DesktopDataSource; Web and TUI are alternate clients.",
          "files": [
            "desktop/src/data/ipc-source.ts",
            "desktop/src/components/Composer.tsx"
          ]
        },
        {
          "label": "Validate and route",
          "node": "server",
          "detail": "HTTP route parses the prompt and selects the existing runtime composition.",
          "files": [
            "src/server/routes/messages.ts",
            "src/server/routes/runtime-bootstrap.ts"
          ]
        },
        {
          "label": "Execute",
          "node": "session-runtime",
          "detail": "SessionRuntime runs the turn, maps events, applies policy, and records usage.",
          "files": [
            "src/runtime/session-runtime.ts",
            "src/runtime/prompt-service.ts",
            "src/runtime/event-mapper.ts"
          ]
        },
        {
          "label": "Delegate to PI",
          "node": "pi-adapter",
          "detail": "Only this boundary imports the PI SDK and exposes stable platform types.",
          "files": [
            "src/pi-sdk/agent-session.ts",
            "src/pi-sdk/model-runtime.ts"
          ]
        },
        {
          "label": "Persist and replay",
          "node": "storage",
          "detail": "Message and branch history remain in PI JSONL; metadata and replay state use SQLite-backed stores.",
          "files": [
            "src/storage/session-index.ts",
            "src/runtime/event-replay-store.ts"
          ]
        },
        {
          "label": "Project",
          "node": "desktop-renderer",
          "detail": "The client adopts the stream and projects events into conversation, tools, memory, and workbench surfaces.",
          "files": [
            "desktop/src/data/projector.ts",
            "desktop/src/components/ChatView.tsx"
          ]
        }
      ]
    },
    {
      "id": "wave-b-branch",
      "label": "Wave B: regenerate / branch / fork",
      "summary": "Wave B uses PI tree primitives behind a stable API. Old branches remain in JSONL; the selected branch head and todo state are durable SQLite metadata.",
      "nodes": [
        "desktop-renderer",
        "server",
        "session-runtime",
        "pi-adapter",
        "storage",
        "desktop-renderer"
      ],
      "steps": [
        {
          "label": "Choose a turn",
          "node": "desktop-renderer",
          "detail": "Timeline and branch switcher use stable entryId, branchId, and turnId anchors.",
          "files": [
            "desktop/src/components/BranchSwitcher.tsx",
            "desktop/src/components/TimelineNav.tsx"
          ]
        },
        {
          "label": "Apply semantics",
          "node": "server",
          "detail": "Server returns stable 400/404/409 errors and never silently aborts a running turn.",
          "files": [
            "src/server/routes/session-branches.ts",
            "src/contracts/session-branch.ts"
          ]
        },
        {
          "label": "Create or switch",
          "node": "session-runtime",
          "detail": "Regenerate shares the normal prompt path; fork uses a detached manager; branch switch persists the selected head.",
          "files": [
            "src/runtime/session-runtime.ts",
            "src/runtime/session-service.ts"
          ]
        },
        {
          "label": "Use PI tree",
          "node": "pi-adapter",
          "detail": "The adapter hides PI SessionManager and AgentSession tree primitives.",
          "files": [
            "src/pi-sdk/session-tree.ts"
          ]
        },
        {
          "label": "Recover",
          "node": "storage",
          "detail": "JSONL remains append-only; SQLite stores branch head and session-owned todo state.",
          "files": [
            "src/storage/session-index.ts",
            "src/storage/session-todos.ts",
            "src/storage/migrations.ts"
          ]
        },
        {
          "label": "Re-project",
          "node": "desktop-renderer",
          "detail": "Live events and restart/replay state must converge to the same desktop view.",
          "files": [
            "desktop/src/data/projector.ts",
            "desktop/src/data/ipc-source.ts"
          ]
        }
      ]
    },
    {
      "id": "memory-cycle",
      "label": "Memory activation cycle",
      "summary": "Memory remains a bounded subsystem around the conversation loop: policy decides what is injected, tools and recall expose controlled access, and background review produces advisory intent.",
      "nodes": [
        "session-runtime",
        "memory",
        "storage",
        "observability",
        "session-runtime"
      ],
      "steps": [
        {
          "label": "Resolve policy",
          "node": "session-runtime",
          "detail": "The runtime decides when memory context and tools are available.",
          "files": [
            "src/runtime/memory/memory-policy.ts",
            "src/runtime/memory/resolver.ts"
          ]
        },
        {
          "label": "Recall and write intent",
          "node": "memory",
          "detail": "Memory tools, injection, recall, and background review operate through explicit contracts.",
          "files": [
            "src/runtime/memory/recall-service.ts",
            "src/pi-sdk/memory-tools.ts",
            "src/runtime/memory/background-review.ts"
          ]
        },
        {
          "label": "Persist facts",
          "node": "storage",
          "detail": "Memory stores and files retain durable state while session messages remain PI JSONL-owned.",
          "files": [
            "src/runtime/memory/memory-files.ts",
            "src/storage/database.ts"
          ]
        },
        {
          "label": "Record evidence",
          "node": "observability",
          "detail": "Memory activity and audit outcomes remain inspectable without leaking sensitive content.",
          "files": [
            "src/observability/instrument.ts",
            "src/observability/safe-value.ts"
          ]
        },
        {
          "label": "Feed the next turn",
          "node": "session-runtime",
          "detail": "The next prompt receives only the policy-approved, bounded memory projection.",
          "files": [
            "src/runtime/memory/memory-injection.ts"
          ]
        }
      ]
    },
    {
      "id": "plugin-lifecycle",
      "label": "Plugin lifecycle",
      "summary": "External plugin formats are normalized into a host-owned capability system, then executed through bounded carriers and observed through the same platform services.",
      "nodes": [
        "plugin-package-runtime",
        "plugin-protocol",
        "plugin-sdk",
        "plugin-runtime",
        "host-safety",
        "observability"
      ],
      "steps": [
        {
          "label": "Author",
          "node": "plugin-sdk",
          "detail": "A plugin author uses definePlugin and the public protocol types.",
          "files": [
            "packages/plugin-sdk/src/define.ts",
            "packages/plugin-sdk/src/scaffold.ts"
          ]
        },
        {
          "label": "Validate",
          "node": "plugin-protocol",
          "detail": "Manifest, permissions, contributions, compatibility, and IPC schemas are checked.",
          "files": [
            "packages/plugin-protocol/src/manifest.ts",
            "packages/plugin-protocol/src/permission.ts"
          ]
        },
        {
          "label": "Host",
          "node": "plugin-runtime",
          "detail": "The host installs sources, resolves grants, loads runtimes, and exposes bounded contributions.",
          "files": [
            "src/platform/plugin-facade.ts",
            "src/runtime/plugins/registry/plugin-registry.ts",
            "src/runtime/plugins/contributions/host-api.ts"
          ]
        },
        {
          "label": "Enforce",
          "node": "host-safety",
          "detail": "Capability snapshots, sandbox bridges, path guards, and secret stores constrain execution.",
          "files": [
            "src/runtime/plugins/grants/execution-snapshot.ts",
            "src/runtime/plugins/grants/sandbox-bridge.ts"
          ]
        },
        {
          "label": "Observe",
          "node": "observability",
          "detail": "Plugin activity, audit and diagnostics use the shared safe-value and trace model.",
          "files": [
            "src/observability/extension-port.ts",
            "src/observability/audit-recorder.ts"
          ]
        }
      ]
    },
    {
      "id": "skill-lifecycle",
      "label": "Skill lifecycle",
      "summary": "A Skill moves from source discovery through validation and readiness gates to a bounded per-turn snapshot. Installation, binding and script execution remain policy-controlled.",
      "nodes": [
        "skills",
        "storage",
        "host-safety",
        "session-runtime",
        "skills"
      ],
      "steps": [
        {
          "label": "Discover sources",
          "node": "skills",
          "detail": "The composition root scans built-in, workspace, managed, ecosystem and plugin sources into one catalog.",
          "files": [
            "src/runtime/skills/composition.ts",
            "src/runtime/skills/sources/factory.ts",
            "src/runtime/skills/catalog/scan.ts"
          ]
        },
        {
          "label": "Validate and assess",
          "node": "skills",
          "detail": "Manifest, compatibility, readiness, risk and trust determine whether a candidate can be used.",
          "files": [
            "src/runtime/skills/validator.ts",
            "src/runtime/skills/readiness.ts",
            "src/runtime/skills/installer/risk.ts"
          ]
        },
        {
          "label": "Persist bindings",
          "node": "storage",
          "detail": "Bundles, agent bindings, session bindings, activation grants and operations are stored durably.",
          "files": [
            "src/storage/skill-bundle-store.ts",
            "src/storage/agent-skill-binding-store.ts",
            "src/storage/skill-activation-grant-store.ts"
          ]
        },
        {
          "label": "Enforce trust and execution",
          "node": "host-safety",
          "detail": "Trusted roots, path safety, sandbox ports and confirmation tokens gate content and scripts.",
          "files": [
            "src/runtime/skills/sources/trust-config.ts",
            "src/runtime/skills/path-safety.ts",
            "src/runtime/skills/plugin/skill-script-runner.ts"
          ]
        },
        {
          "label": "Freeze per turn",
          "node": "session-runtime",
          "detail": "The prompt path receives a bounded Skill snapshot; a later catalog mutation cannot silently expand the active turn.",
          "files": [
            "src/runtime/skills/snapshot/skill-snapshot.ts",
            "src/runtime/skills/core/skill-core-service.ts",
            "src/pi-sdk/skill-loader.ts"
          ]
        },
        {
          "label": "Load on demand",
          "node": "skills",
          "detail": "Content reads consume the frozen snapshot and activation overlay instead of arbitrary filesystem paths.",
          "files": [
            "src/runtime/skills/content/skill-content-service.ts",
            "src/runtime/skills/content/load-handle.ts",
            "src/runtime/skills/confirmation/confirmation-token.ts"
          ]
        }
      ]
    },
    {
      "id": "desktop-startup",
      "label": "Desktop startup and release",
      "summary": "Electron launches the local Supervisor, which hosts the Server and client assets. The preload and proxy keep the renderer behind an explicit capability boundary.",
      "nodes": [
        "desktop-shell",
        "supervisor",
        "server",
        "desktop-renderer"
      ],
      "steps": [
        {
          "label": "Launch",
          "node": "desktop-shell",
          "detail": "Electron creates the window and starts the local connection strategy.",
          "files": [
            "desktop/electron/main.cjs",
            "desktop/electron/auto-update.cjs"
          ]
        },
        {
          "label": "Host",
          "node": "supervisor",
          "detail": "Supervisor starts or adopts the expected Agent Server and serves the built client.",
          "files": [
            "src/supervisor/start.ts",
            "src/supervisor/app.ts"
          ]
        },
        {
          "label": "Serve",
          "node": "server",
          "detail": "The Hono server owns runtime state and protocol endpoints.",
          "files": [
            "src/server/start.ts",
            "src/server/app.ts"
          ]
        },
        {
          "label": "Render",
          "node": "desktop-renderer",
          "detail": "The renderer receives only shell operations and backend data through the approved data source.",
          "files": [
            "desktop/electron/preload.cjs",
            "desktop/src/data/ipc-source.ts"
          ]
        }
      ]
    }
  ],
  "knownGaps": [
    {
      "severity": "high",
      "title": "Wave B true-chain evidence is not complete",
      "detail": "Compact live/replay identity and durable todo true-chain coverage are still deferred to the closeout evidence; the architecture map records them as implemented code plus incomplete verification.",
      "path": "plans/p1-conversation-workbench.en.md"
    },
    {
      "severity": "medium",
      "title": "BRANCH-03/04 send-disabled defect remains bounded",
      "detail": "The post-branch-switch send path remains a known defect from B3/B6 and must not be silently represented as complete.",
      "path": "docs/project-status.md"
    },
    {
      "severity": "medium",
      "title": "Web event allowlist follow-up",
      "detail": "The Web protocol client still needs the additive todo.updated event declaration tracked in the Wave B closeout.",
      "path": "plans/p1-conversation-workbench.en.md"
    }
  ],
  "rules": [
    {
      "label": "PI boundary",
      "detail": "Only src/pi-sdk imports @earendil-works/pi-*."
    },
    {
      "label": "Server-first",
      "detail": "Desktop, Web, and TUI consume HTTP/SSE/WS or the explicit Electron bridge; they do not mutate Runtime state directly."
    },
    {
      "label": "Data ownership",
      "detail": "PI JSONL owns message bodies and branch history. SQLite owns metadata, indexes, platform state, branch heads, todos, usage, and registries."
    },
    {
      "label": "Replay before broadcast",
      "detail": "An event is durable in the Replay Store before it is sent to SSE or WebSocket subscribers."
    },
    {
      "label": "Host-owned extension points",
      "detail": "Plugins contribute through bounded contracts; the host retains layout, permissions, lifecycle, and security policy."
    }
  ],
  "locale": {
    "meta": {
      "title": "OpenColorful 架构地图",
      "subtitle": "把项目讲成人能读懂的运行结构",
      "brandSubtitle": "真实代码 · 可追溯的理解路径",
      "eyebrow": "真实代码 · 清晰边界 · 可追溯流程",
      "statusLabel": "P1 Wave B 进行中",
      "statusSummary": "当前仓库处在对话工作台收尾阶段：B0-B5b 已实现，B6 记录了边界缺陷，真实链路证据仍在补齐。",
      "heroTitle": "先看懂它怎么运转，\n再走进每一层实现。",
      "heroCopy": "这不是一张把所有东西挤在一起的图。先用总览理解系统分层，再沿着真实调用链走一遍，最后进入某个模块的工作台，查看它负责什么、不能越过什么边界，以及对应的实现文件。",
      "generatedMeta": "{nodes} 个模块 · {files} 个生产文件 · 自动生成",
      "statusSource": "查看当前状态原文",
      "themeDark": "切换到深色主题",
      "themeLight": "切换到浅色主题",
      "searchPlaceholder": "搜索模块、职责、文件、流程或规则…",
      "views": {
        "atlas": "总览",
        "guide": "怎么读",
        "flows": "关键流程",
        "modules": "模块工作台",
        "board": "项目看板",
        "boundaries": "边界规则",
        "sources": "源文件索引"
      },
      "atlas": {
        "layers": "系统分层",
        "clear": "清除筛选",
        "coverage": "代码覆盖",
        "coverageCopy": "生产源文件都应有明确的架构归属。点进模块，可以继续看文件和行数。",
        "gaps": "{count} 个待闭环事项",
        "gapsCopy": "实现、验证和发布状态分开记录，不把“代码写了”误当成“功能验收了”。",
        "mapEyebrow": "系统总览",
        "mapTitle": "入口、运行时与持久化",
        "mapHint": "点击节点进入模块工作台 · 悬停连接查看关系",
        "canvasLabel": "OpenColorful 模块关系图",
        "canvasStamp": "运行拓扑 / 真实文件覆盖",
        "legendSemantic": "架构语义连接",
        "legendEvidence": "扫描到的 import 证据",
        "legendStatus": "当前仓库状态",
        "visibleModules": "当前显示 {count} 个模块"
      },
      "guide": {
        "eyebrow": "阅读指南",
        "title": "不要从文件树开始，从问题开始。",
        "intro": "当你不知道一个功能应该放在哪里，先回答三个问题：谁接收请求？谁做业务决策？谁拥有最终数据？这张地图按这个顺序组织。",
        "principlesTitle": "先记住四句话",
        "principles": [
          {
            "number": "01",
            "title": "前端只是入口",
            "detail": "Desktop、Web、TUI 都是客户端。它们发命令、收事件、画界面，不直接改 Runtime。"
          },
          {
            "number": "02",
            "title": "Server 是总线",
            "detail": "HTTP、SSE、WebSocket 和 Electron bridge 把外部入口接到同一套服务边界。"
          },
          {
            "number": "03",
            "title": "Runtime 做决定",
            "detail": "会话、Prompt、分支、记忆、Skill、Plugin 和 Subagent 的业务编排集中在 Runtime。"
          },
          {
            "number": "04",
            "title": "数据各有主人",
            "detail": "PI JSONL 保存消息正文和分支历史；SQLite 保存元数据、索引和平台状态。"
          }
        ],
        "pathTitle": "推荐阅读顺序",
        "path": [
          {
            "number": "01",
            "title": "先看总览",
            "detail": "只看分层和大箭头，不急着记文件名。"
          },
          {
            "number": "02",
            "title": "再走一条流程",
            "detail": "从 Prompt、分支或桌面启动中选一条，按步骤打开真实文件。"
          },
          {
            "number": "03",
            "title": "进入模块工作台",
            "detail": "看清一个模块的职责、边界、依赖和关键实现。"
          },
          {
            "number": "04",
            "title": "最后查源文件",
            "detail": "只有需要继续读代码时，才用完整文件索引下钻。"
          }
        ],
        "questionTitle": "遇到新功能时，先问这五个问题",
        "questions": [
          "它从哪个产品入口进来？",
          "它属于哪个跨进程契约？",
          "谁负责真正的业务决策？",
          "它把什么数据写进哪里？",
          "需要新增哪条流程、规则或验收证据？"
        ]
      },
      "flows": {
        "eyebrow": "真实调用链",
        "title": "按场景走一遍，理解就不会悬空。",
        "intro": "每一步都绑定了当前仓库里的实现文件。流程说明是帮助理解的入口，文件和测试才是继续核对的证据。",
        "steps": "{count} 步"
      },
      "projectBoard": {
        "eyebrow": "项目状态工作台",
        "title": "把“代码做到哪了”与“项目能不能交付”分开看。",
        "intro": "看板是当前状态文档的开发者投影：卡片可以帮助日常排序、追踪验收和跳转架构模块，但状态事实仍以项目状态、计划和独立评估原文为准。",
        "updated": "看板更新时间：{date}",
        "baseline": "当前基线",
        "health": "交付判断",
        "signals": "项目脉搏",
        "focus": "接下来先做这三件事",
        "columns": "工作区",
        "filters": "筛选",
        "all": "全部卡片",
        "filterActive": "活动事项",
        "filterBlocked": "阻塞 / 风险",
        "filterDone": "已完成 / 归档",
        "filterP1": "P1",
        "filterG": "治理 / 发布",
        "cards": "{count} 张卡片",
        "checklist": "验收清单",
        "progress": "{done}/{total} 已完成",
        "modules": "关联架构模块",
        "source": "事实来源",
        "references": "相关入口",
        "openModule": "进入模块工作台",
        "openSource": "打开原文",
        "sourceTruth": "状态权威仍在文档原文；看板只负责把日常开发需要的关系组织到一起。",
        "empty": "当前筛选没有匹配的事项。",
        "state": "状态",
        "priority": "优先级",
        "boardCards": "{count} 张卡片 · {active} 张活动卡片 · {risk} 张风险卡片",
        "allModules": "全部关联模块"
      },
      "modules": {
        "eyebrow": "单模块视图",
        "title": "把一个模块单独摊开看。",
        "intro": "总览适合看关系，工作台适合做开发决策：这个模块应该接什么、不能接什么、改动后需要回看哪些文件和规则。",
        "choose": "选择模块",
        "chooseHint": "按分层浏览，或使用上方搜索",
        "oneSentence": "一句话说明",
        "owns": "它负责什么",
        "invariants": "它不能越过什么边界",
        "connections": "它和谁协作",
        "implementation": "关键实现文件",
        "coverage": "完整代码覆盖",
        "documents": "相关文档",
        "openSource": "打开实现",
        "openDocument": "打开文档",
        "incoming": "输入",
        "outgoing": "输出",
        "noConnections": "当前没有登记的架构连接。",
        "noFiles": "当前没有匹配的文件。"
      },
      "boundaries": {
        "eyebrow": "不可悄悄破坏的约束",
        "title": "这些规则决定项目能不能持续演进。",
        "intro": "它们不是装饰性的文档。部分规则由脚本、类型检查、测试和构建门禁直接守护，修改边界时要同步更新事实来源。",
        "gapsEyebrow": "当前待闭环",
        "gapsTitle": "实现完成不等于验收完成。",
        "source": "查看来源"
      },
      "sources": {
        "eyebrow": "真实文件索引",
        "title": "从架构职责下钻到源码。",
        "intro": "这是生成器扫描出的生产源文件清单。路径保持原样，方便直接在编辑器中打开。",
        "matching": "{count} 个匹配文件",
        "files": "{matched} / {total} 个文件 · {lines} 行",
        "lines": "{count} 行",
        "empty": "没有匹配的源文件。"
      },
      "footer": {
        "cooperation": "协作入口",
        "architecture": "架构说明",
        "maintenance": "维护说明"
      }
    },
    "status": {
      "active": "进行中",
      "stable": "稳定",
      "operator": "运维 / 测试入口"
    },
    "layers": {
      "surfaces": {
        "label": "产品入口",
        "description": "人或运维者从这里进入平台。"
      },
      "boundary": {
        "label": "进程与协议边界",
        "description": "跨进程共享的语言、校验和传输适配。"
      },
      "runtime": {
        "label": "Agent 运行时",
        "description": "会话执行、记忆、Skill、Plugin、Subagent 和可观测性。"
      },
      "persistence": {
        "label": "持久化与宿主服务",
        "description": "长期保存的事实、凭据、进程生命周期和本机安全边界。"
      },
      "extension": {
        "label": "扩展包",
        "description": "面向外部集成的 Plugin 协议和运行时包。"
      }
    },
    "nodes": {
      "desktop-shell": {
        "label": "Desktop Electron 外壳",
        "shortLabel": "Desktop 外壳",
        "purpose": "负责原生窗口、preload 能力边界、Supervisor 代理、SSE 代理、更新流程和打包应用生命周期。",
        "owns": [
          "Electron 主进程和窗口生命周期",
          "通过 preload 暴露的外壳能力",
          "支持重启感知的本地 Server 代理",
          "打包发布的暂存和校验"
        ],
        "invariants": [
          "Renderer 不能拿到运行时凭据、任意文件系统权限或直接 Agent API。",
          "发布前必须校验打包后的 Server 和 Plugin workspace 依赖。",
          "代理接管进程前必须核对 Supervisor 身份。"
        ]
      },
      "desktop-renderer": {
        "label": "Desktop React 工作台",
        "shortLabel": "Desktop 界面",
        "purpose": "主产品界面：围绕会话提供对话、分支、压缩、Todo、记忆、日志、用量、设置和 Agent 身份。",
        "owns": [
          "DesktopDataSource 消费模型",
          "Renderer 状态和事件投影",
          "对话与工作台组件",
          "Mock 场景和界面级验收"
        ],
        "invariants": [
          "Wave B 中，Session Todo 由一方工具写入，界面只读投影。",
          "界面通过 data source 和 preload bridge 访问后端。",
          "实时事件和重载 / 重启后的状态必须汇聚成同一份投影。"
        ]
      },
      "web-client": {
        "label": "Web 运维与测试客户端",
        "shortLabel": "Web 客户端",
        "purpose": "面向浏览器的运维和协议客户端。G1 之后它不是主产品前端。",
        "owns": [
          "HTTP、SSE、WebSocket 客户端适配",
          "工作台、设置、Plugin、Skill、Memory、日志和 Subagent 页面",
          "适合浏览器 E2E 的客户端界面"
        ],
        "invariants": [
          "Web 只能作为 Server API 的客户端，不能导入 PI SDK 内部实现。",
          "新增 SSE 事件必须先进入已知事件白名单。",
          "涉及 Web 的用户界面改动要有组件覆盖和浏览器证据。"
        ]
      },
      "tui-client": {
        "label": "TUI 协议客户端",
        "shortLabel": "TUI",
        "purpose": "通过 Server 协议工作的终端客户端，与 PI SDK 保持隔离。",
        "owns": [
          "HTTP、SSE、WebSocket 协议客户端",
          "终端事件渲染",
          "给非 Web 客户端使用的结构化摘要"
        ],
        "invariants": [
          "TUI 不能绕过 Server 修改 Session 状态。",
          "TUI 不得导入 PI 包或 src/pi-sdk。"
        ]
      },
      "contracts": {
        "label": "平台契约",
        "shortLabel": "契约",
        "purpose": "跨模块、跨进程共用的词汇：输入、事件、Session 分支、Memory、Plugin、Skill、Subagent、可观测性、用量和 UI 消息。",
        "owns": [
          "TypeBox Schema 和平台类型",
          "PlatformEventEnvelope 事件封装",
          "稳定的错误和命令词汇",
          "Host 使用的 Plugin 协议导出"
        ],
        "invariants": [
          "跨进程输入必须解析，不能用类型断言假装可信。",
          "协议版本必须显式并保持兼容。",
          "平台接口不能泄漏 PI 私有类型。"
        ]
      },
      "server": {
        "label": "HTTP / SSE / WS Server",
        "shortLabel": "Server 边界",
        "purpose": "负责认证边界、输入校验、路由组合、事件流、WebSocket Session 和传输层投影。",
        "owns": [
          "Hono 应用和路由注册",
          "Session、消息、分支、Agent、Memory、Plugin、Skill、Subagent 和用量路由",
          "SSE 重放订阅和 WebSocket 控制",
          "Runtime 启动组合根"
        ],
        "invariants": [
          "路由只负责解析和委托，Agent 业务逻辑放在 Runtime / Service。",
          "事件必须先写入 Replay Store，再广播。",
          "默认 loopback 监听和稳定 ApiError 行为不能被悄悄改变。"
        ]
      },
      "ui-projection": {
        "label": "A2UI / TokUI 投影",
        "shortLabel": "UI 投影",
        "purpose": "把结构化平台事件投影成受约束的 UI 协议，它不是另一套运行时。",
        "owns": [
          "A2UI Catalog 和 Action 校验",
          "TokUI 策略和流式投影",
          "安全的结构化 UI 消息载荷"
        ],
        "invariants": [
          "只接受本地固定 Catalog 和命名 Handler。",
          "拒绝原始 HTML、脚本、javascript URL 和任意可执行 Widget。",
          "用户 Action 必须回到 Server 重新校验。"
        ]
      },
      "supervisor": {
        "label": "Supervisor 进程宿主",
        "shortLabel": "Supervisor",
        "purpose": "启动、监控、健康检查、代理和停止 Agent Server，同时托管构建后的客户端资源。",
        "owns": [
          "Agent Server 生命周期",
          "PID 和进程身份校验",
          "端口选择和重启行为",
          "Web 静态资源托管和透明代理"
        ],
        "invariants": [
          "接管子进程前，健康响应必须能证明它是预期进程。",
          "Windows 停止时要清理子进程树。",
          "Desktop 和 CLI 使用同一套本地生命周期概念。"
        ]
      },
      "session-runtime": {
        "label": "Session 与执行 Runtime",
        "shortLabel": "Session Runtime",
        "purpose": "系统的中央编排层：会话生命周期、Prompt 执行、模型和工具策略、事件、分支、用量，以及 Memory、Skill、Plugin、Subagent 的组合。",
        "owns": [
          "SessionRuntime 和 SessionService",
          "Prompt、Abort、Compact 执行",
          "分支重新生成、Fork、切换和当前 Head 恢复",
          "事件映射、重放发布和用量记录",
          "Memory、Skill、Plugin、Subagent 的运行时组合"
        ],
        "invariants": [
          "Agent 行为由 Runtime 负责，传输层路由保持薄。",
          "Session 身份使用稳定 ID，绝不使用文件路径。",
          "重启和分支操作后必须继续使用同一套 Runtime 组合。",
          "Wave B 的分支和 Todo 语义保持 JSONL 追加历史加 SQLite 元数据 / 状态。"
        ]
      },
      "pi-adapter": {
        "label": "PI SDK 适配边界",
        "shortLabel": "PI 适配层",
        "purpose": "唯一可以直接导入 PI SDK 的边界，把 PI 的 Session、模型、工具和事件转换成 OpenColorful 平台接口。",
        "owns": [
          "AgentSession 和 SessionManager 适配",
          "ModelRuntime 和 Provider 接入",
          "Session 树和分支原语",
          "一方工具工厂"
        ],
        "invariants": [
          "只有 src/pi-sdk 可以导入 @earendil-works/pi-*。",
          "不能导入 PI 私有深路径，也不能复制 Agent Loop。",
          "平台接口不能泄漏 PI 私有类型。"
        ]
      },
      "memory": {
        "label": "Memory 子系统",
        "shortLabel": "Memory",
        "purpose": "在明确策略下构建、注入、召回、复盘和应用记忆，并把持久化文件与 Store 分开管理。",
        "owns": [
          "Memory Agent 和工具面",
          "召回与注入策略",
          "后台复盘和激活更新",
          "编译、摘要、调度和分支感知读取"
        ],
        "invariants": [
          "Memory 受策略和边界约束，不是无约束自我修改循环。",
          "后台复盘是可观察的建议过程。",
          "Memory 内容和运行日志拥有不同的隐私边界。"
        ]
      },
      "skills": {
        "label": "Skills 子系统",
        "shortLabel": "Skills",
        "purpose": "发现、校验、信任评估、安装、绑定、快照、加载并安全执行 Skill。",
        "owns": [
          "Skill 目录和来源适配器",
          "Manifest 校验、就绪度和风险评估",
          "Agent / Session 绑定、快照和激活授权",
          "内容加载、安装操作和脚本执行",
          "Plugin 和生态兼容性桥接"
        ],
        "invariants": [
          "Skill 不是发现出来就能执行，仍要通过就绪度、信任、风险和策略闸门。",
          "当前回合和 Subagent 能看到的 Skill 由快照决定，并且有边界。",
          "Plugin 提供的 Skill 遵循 Plugin 生命周期，来源禁用或移除时默认关闭。",
          "Session 文件和外部路径必须经过所有权与可信根校验。"
        ]
      },
      "subagents": {
        "label": "Subagent Runtime",
        "shortLabel": "Subagent",
        "purpose": "在父 Session 控制下运行委派任务，管理邮箱、工件、Transcript、策略租约、恢复和可观察性。",
        "owns": [
          "委派任务的启动、状态和取消",
          "父子 Session 关系和 mailbox 投递",
          "工件与 Transcript 存储和重放",
          "策略租约、用量和审计"
        ],
        "invariants": [
          "子任务必须有父 Session、范围和可回收状态。",
          "父任务可以观察、取消和恢复子任务。",
          "委派事件不能绕开平台 Event Envelope 和脱敏规则。"
        ]
      },
      "storage": {
        "label": "SQLite 元数据与状态",
        "shortLabel": "Storage",
        "purpose": "保存 Session 元数据、分支 Head、Todo、Provider 设置、Plugin / Skill 注册、用量、可观察性和平台状态，但不保存消息正文。",
        "owns": [
          "SQLite 连接、WAL 和迁移",
          "Session 索引和元数据",
          "分支 Head 和 Session Todo",
          "Provider、Plugin、Skill、用量和平台状态 Store"
        ],
        "invariants": [
          "消息正文和分支历史的事实来源仍是 PI JSONL。",
          "Schema 变化必须通过迁移，不能手工改生产库。",
          "调用方使用稳定 Session ID，不能把文件路径当身份。"
        ]
      },
      "host-safety": {
        "label": "Config、Sandbox 与宿主安全",
        "shortLabel": "宿主安全",
        "purpose": "定义本地数据路径、环境隔离、Sandbox 边界、目录选择和宿主级安全辅助能力。",
        "owns": [
          "OpenColorful 数据目录和环境覆盖",
          "Sandbox 服务和路径安全",
          "原生目录选择能力",
          "Provider / Plugin / Skill 的宿主侧安全辅助"
        ],
        "invariants": [
          "路径必须来自统一的 paths 模块，调用方不能自行拼接用户目录。",
          "默认只监听 127.0.0.1，认证前不开 LAN / 远程访问。",
          "凭据、Cookie 和 Authorization 不能进入普通配置或日志。"
        ]
      },
      "observability": {
        "label": "可观察性与用量",
        "shortLabel": "Observability",
        "purpose": "记录活动、审计、诊断、Trace、保留策略、脱敏值、支持包和用量证据，同时避免泄漏秘密。",
        "owns": [
          "三通道日志、Trace 和活动记录",
          "审计与诊断事件",
          "统一脱敏和安全值格式化",
          "用量记录、保留和支持包"
        ],
        "invariants": [
          "任何日志都不能包含 API Key、Cookie 或 Authorization。",
          "操作日志、审计事件和用户内容要有清晰的隐私边界。",
          "用量记录要可追溯、可去重，不能因为重放重复计算。"
        ]
      },
      "plugin-runtime": {
        "label": "Plugin Runtime 与宿主",
        "shortLabel": "Plugin 宿主",
        "purpose": "加载、校验、授权、托管、观察并适配来自本地、压缩包、Git、npm、OpenClaw 和 Hermes 的 Plugin 贡献。",
        "owns": [
          "Plugin 来源安装和注册",
          "权限、能力快照和执行策略",
          "Host API、UI、Skill、Tool 等贡献接入",
          "Plugin 生命周期、诊断和卸载"
        ],
        "invariants": [
          "Plugin 只能通过公开协议和 Host API 贡献能力。",
          "每次执行使用能力快照，不能在执行中静默扩大权限。",
          "宿主保留布局、生命周期、权限和安全策略。"
        ]
      },
      "plugin-protocol": {
        "label": "@opencolorful/plugin-protocol",
        "shortLabel": "Plugin 协议包",
        "purpose": "面向公开生态的 Schema 和规范化词汇，描述 Manifest、权限、贡献、IPC、兼容性和快照。",
        "owns": [
          "Plugin Manifest 和权限 Schema",
          "Host / UI / Skill / Tool 贡献 Schema",
          "IPC 和规范化 Plugin 快照契约"
        ],
        "invariants": [
          "协议包不依赖宿主实现细节。",
          "Schema 变化必须通过兼容性测试和包构建校验。"
        ]
      },
      "plugin-sdk": {
        "label": "@opencolorful/plugin-sdk",
        "shortLabel": "Plugin SDK",
        "purpose": "给 Plugin 作者使用的定义、校验、错误和脚手架工具。",
        "owns": [
          "definePlugin 作者 API",
          "Manifest 和贡献的开发期校验",
          "Plugin 脚手架生成"
        ],
        "invariants": [
          "SDK 只依赖公开 Plugin 协议，不依赖宿主私有路径。",
          "脚手架生成物必须通过协议和构建检查。"
        ]
      },
      "plugin-package-runtime": {
        "label": "@opencolorful/plugin-runtime + components",
        "shortLabel": "Plugin 包运行时",
        "purpose": "提供 Plugin 运行时侧的 Server 辅助能力，以及受约束的 UI / Host 贡献组件。",
        "owns": [
          "Plugin Runtime Server 辅助",
          "Host Contribution 辅助 API",
          "包级兼容性入口"
        ],
        "invariants": [
          "包只能消费公开协议，不绕过 Host 的授权和安全策略。",
          "组件贡献必须落在允许的 Catalog 和 Handler 范围内。"
        ]
      },
      "cli-governance": {
        "label": "CLI 与仓库治理",
        "shortLabel": "CLI / 治理",
        "purpose": "提供命令行入口，以及 import、包、文档、架构、smoke 和发布检查。",
        "owns": [
          "CLI 入口和生命周期命令",
          "架构地图生成与一致性检查",
          "文档、PI import 和 Plugin import 检查",
          "构建、测试和发布辅助"
        ],
        "invariants": [
          "质量门命令要逐条执行并读取退出码。",
          "检查脚本不能依赖真实凭据或真实 Provider 网络。",
          "仓库治理规则要能在 CI 和本地复现。"
        ]
      }
    },
    "edges": {
      "desktop-shell->supervisor": "启动 / 代理",
      "desktop-renderer->desktop-shell": "preload / IPC",
      "desktop-renderer->server": "HTTP / SSE / WS",
      "web-client->server": "HTTP / SSE / WS",
      "tui-client->server": "Server 协议",
      "server->contracts": "解析 / 发出",
      "server->session-runtime": "委托执行",
      "server->ui-projection": "结构化 UI 事件",
      "session-runtime->pi-adapter": "Agent Session",
      "session-runtime->storage": "元数据 / Todo / 用量",
      "session-runtime->memory": "召回 / 复盘",
      "session-runtime->skills": "Skill 快照 / 工具",
      "session-runtime->subagents": "委派任务",
      "session-runtime->plugin-runtime": "宿主贡献",
      "session-runtime->observability": "活动 / 审计 / 用量",
      "session-runtime->host-safety": "路径 / 策略",
      "pi-adapter->contracts": "稳定平台类型",
      "plugin-sdk->plugin-protocol": "消费协议 Schema",
      "plugin-package-runtime->plugin-protocol": "消费协议 Schema",
      "plugin-runtime->plugin-protocol": "规范化宿主边界",
      "plugin-runtime->host-safety": "授权 / Sandbox",
      "skills->storage": "目录 / 绑定",
      "skills->host-safety": "信任 / Sandbox",
      "skills->plugin-runtime": "Plugin Skill 桥接",
      "cli-governance->supervisor": "生命周期命令",
      "supervisor->server": "子进程"
    },
    "flows": {
      "prompt-stream": {
        "label": "Prompt → 流式回答",
        "summary": "最常见的对话路径：客户端发命令，Server 委托 Session Runtime，PI 产生规范化事件，Replay Store 保存事件，客户端再把事件投影成界面。",
        "steps": [
          {
            "label": "发起",
            "detail": "Composer 通过 DesktopDataSource 发送请求；Web 和 TUI 是另外两种入口。"
          },
          {
            "label": "校验并路由",
            "detail": "HTTP 路由解析 Prompt，并选择现有的 Runtime 组合。"
          },
          {
            "label": "执行",
            "detail": "SessionRuntime 执行这一回合，映射事件、应用策略并记录用量。"
          },
          {
            "label": "交给 PI",
            "detail": "只有这一层导入 PI SDK，并向上提供稳定的平台类型。"
          },
          {
            "label": "持久化并重放",
            "detail": "消息和分支历史留在 PI JSONL；元数据和重放状态进入 SQLite Store。"
          },
          {
            "label": "投影",
            "detail": "客户端接收事件，把它们投影成对话、工具、Memory 和工作台界面。"
          }
        ]
      },
      "wave-b-branch": {
        "label": "Wave B：重新生成 / 分支 / Fork",
        "summary": "Wave B 在稳定 API 后面使用 PI 的树结构原语。旧分支保留在 JSONL，当前分支 Head 和 Todo 状态由 SQLite 持久化。",
        "steps": [
          {
            "label": "选中一回合",
            "detail": "Timeline 和分支切换器使用稳定的 entryId、branchId 和 turnId 锚点。"
          },
          {
            "label": "应用语义",
            "detail": "Server 返回稳定的 400 / 404 / 409 错误，不会静默中断正在运行的回合。"
          },
          {
            "label": "创建或切换",
            "detail": "Regenerate 复用普通 Prompt 路径；Fork 使用独立的 manager；切换分支会保存当前 Head。"
          },
          {
            "label": "使用 PI 树结构",
            "detail": "适配层把 PI 的 SessionManager 和 AgentSession 树原语藏在边界后面。"
          },
          {
            "label": "恢复",
            "detail": "JSONL 保持追加历史；SQLite 保存分支 Head 和 Session 所有的 Todo 状态。"
          },
          {
            "label": "重新投影",
            "detail": "实时事件和重启 / 重放状态必须汇聚成同一份 Desktop 视图。"
          }
        ]
      },
      "memory-cycle": {
        "label": "Memory 激活循环",
        "summary": "Memory 围绕对话循环工作：策略决定注入什么，工具和召回提供受控访问，后台复盘产生可观察的建议意图。",
        "steps": [
          {
            "label": "解析策略",
            "detail": "Runtime 决定这一回合何时提供 Memory 上下文和工具。"
          },
          {
            "label": "召回并形成写入意图",
            "detail": "Memory 工具、注入、召回和后台复盘都通过明确契约运行。"
          },
          {
            "label": "保存事实",
            "detail": "Memory Store 和文件保存长期状态，而 Session 消息仍由 PI JSONL 负责。"
          },
          {
            "label": "记录证据",
            "detail": "Memory 活动和审计结果可检查，同时不泄漏敏感内容。"
          },
          {
            "label": "喂给下一回合",
            "detail": "下一次 Prompt 只接收经过策略批准、且有边界的 Memory 投影。"
          }
        ]
      },
      "plugin-lifecycle": {
        "label": "Plugin 生命周期",
        "summary": "外部 Plugin 格式先被规范化成宿主拥有的能力系统，再通过受约束的载体执行，并使用同一套平台服务观察。",
        "steps": [
          {
            "label": "编写",
            "detail": "Plugin 作者使用 definePlugin 和公开协议类型。"
          },
          {
            "label": "校验",
            "detail": "Manifest、权限、贡献、兼容性和 IPC Schema 经过检查。"
          },
          {
            "label": "托管",
            "detail": "宿主安装来源、解析授权、加载运行时并暴露受约束的贡献点。"
          },
          {
            "label": "执行约束",
            "detail": "能力快照、Sandbox bridge、路径保护和 Secret Store 共同限制执行范围。"
          },
          {
            "label": "观察",
            "detail": "Plugin 活动、审计和诊断复用统一的安全值和 Trace 模型。"
          }
        ]
      },
      "skill-lifecycle": {
        "label": "Skill 生命周期",
        "summary": "Skill 从来源发现开始，经过校验和就绪闸门，最终冻结成每回合可用的快照。安装、绑定和脚本执行都受策略控制。",
        "steps": [
          {
            "label": "发现来源",
            "detail": "组合根把内置、工作区、托管、生态和 Plugin 来源扫描进统一目录。"
          },
          {
            "label": "校验并评估",
            "detail": "Manifest、兼容性、就绪度、风险和信任共同决定候选项能否使用。"
          },
          {
            "label": "保存绑定",
            "detail": "Bundle、Agent 绑定、Session 绑定、激活授权和操作记录都被持久化。"
          },
          {
            "label": "执行信任和安全检查",
            "detail": "可信根、路径安全、Sandbox 端口和确认令牌共同约束内容与脚本。"
          },
          {
            "label": "冻结当前回合",
            "detail": "Prompt 路径接收有边界的 Skill Snapshot，后续目录变化不会偷偷扩大当前回合。"
          },
          {
            "label": "按需加载",
            "detail": "内容读取使用冻结快照和激活覆盖层，而不是任意文件系统路径。"
          }
        ]
      },
      "desktop-startup": {
        "label": "Desktop 启动与发布",
        "summary": "Electron 启动本地 Supervisor，Supervisor 托管 Server 和客户端资源；preload 与 proxy 把 Renderer 放在明确的能力边界之后。",
        "steps": [
          {
            "label": "启动",
            "detail": "Electron 创建窗口并开始本地连接策略。"
          },
          {
            "label": "托管",
            "detail": "Supervisor 启动或接管预期的 Agent Server，并提供构建后的客户端资源。"
          },
          {
            "label": "提供服务",
            "detail": "Hono Server 持有 Runtime 状态和协议端点。"
          },
          {
            "label": "渲染",
            "detail": "Renderer 只通过批准的数据源接收外壳能力和后端数据。"
          }
        ]
      }
    },
    "rules": [
      {
        "label": "PI 适配边界",
        "detail": "只有 src/pi-sdk 可以导入 @earendil-works/pi-*。"
      },
      {
        "label": "Server 优先",
        "detail": "Desktop、Web 和 TUI 通过 HTTP / SSE / WS 或明确的 Electron bridge 访问服务，不能直接修改 Runtime。"
      },
      {
        "label": "数据所有权",
        "detail": "PI JSONL 拥有消息正文和分支历史；SQLite 拥有元数据、索引、平台状态、分支 Head、Todo、用量和注册表。"
      },
      {
        "label": "先重放，再广播",
        "detail": "事件必须先在 Replay Store 中持久化，然后才能发送给 SSE 或 WebSocket 订阅者。"
      },
      {
        "label": "宿主拥有扩展边界",
        "detail": "Plugin 通过受约束的契约贡献能力；布局、权限、生命周期和安全策略仍由宿主保留。"
      }
    ],
    "knownGaps": [
      {
        "severity": "高风险",
        "title": "Wave B 的真实链路证据还不完整",
        "detail": "Compact 的 live / replay identity 和持久化 Todo 的真实链路覆盖仍留在收尾证据阶段；地图会把“代码已实现”和“验证未闭环”分开表达。"
      },
      {
        "severity": "中风险",
        "title": "BRANCH-03/04：切换分支后发送仍被禁用",
        "detail": "分支切换后的发送路径仍是 B3 / B6 记录的已知缺陷，不能在地图上被悄悄标成完成。"
      },
      {
        "severity": "中风险",
        "title": "Web 事件白名单还需要补齐",
        "detail": "Web 协议客户端还需要把新增的 todo.updated 事件加入声明，已记录在 Wave B 收尾计划中。"
      }
    ]
  },
  "projectBoard": {
    "version": 1,
    "title": "OpenColorful 项目看板",
    "sourceOfTruth": "项目状态和阶段事实仍以 docs/project-status.md、对应计划与独立质量评估为准。本文件是面向开发者的状态投影和工作入口。",
    "updatedAt": "2026-09-06",
    "baseline": {
      "branch": "main",
      "commit": "15036b7",
      "label": "B0-B5b 与 B6/B7 收尾记录已合并；独立质量评估仍未通过"
    },
    "health": {
      "label": "当前不宜宣称产品完成",
      "tone": "risk",
      "summary": "代码已经积累到可以做真实交付验证的阶段，但安全边界、迁移恢复、Wave B 稳定性、人工体验和发布链路仍需要先收口。",
      "source": "docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md"
    },
    "signals": [
      {
        "label": "当前主线",
        "value": "P1 个人助理基础体验",
        "detail": "切片 1、1.5、1.75 的工程实现已合并，当前进入质量收口和真实使用准备。",
        "source": "docs/positioning-and-roadmap.md"
      },
      {
        "label": "当前活动波次",
        "value": "P1 内部波次 B",
        "detail": "对话工作台实现基本完成，但真链、人工验收和发布验证还没有闭环。",
        "source": "docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md"
      },
      {
        "label": "当前门槛",
        "value": "独立质量评估未通过",
        "detail": "A/B 代码合并和常规自动化通过，不能替代安全、迁移、真实桌面和安装发布证据。",
        "source": "docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md"
      },
      {
        "label": "下一次真实反馈",
        "value": "5 天日用",
        "detail": "在阻断项、真实链路、安装更新和人工验收完成后，再用连续日用观察产品质量。",
        "source": "docs/project-status.md"
      }
    ],
    "focus": [
      {
        "number": "01",
        "title": "先修阻断项",
        "detail": "安全边界、v13/v14 迁移恢复、Plugin import 检查和 B3 间歇性失败必须先处理。",
        "cardId": "quality-blockers"
      },
      {
        "number": "02",
        "title": "再补真实证据",
        "detail": "补齐 Wave B 的 compact / todo Electron 真链，并执行 A/B 人工验收卡。",
        "cardId": "wave-b-evidence"
      },
      {
        "number": "03",
        "title": "最后做发布判断",
        "detail": "v0.1.1 仍需要仓库外安装、启动、更新、重启和数据恢复实测。",
        "cardId": "release-verification"
      }
    ],
    "columns": [
      {
        "id": "now",
        "label": "现在要做",
        "tone": "red",
        "description": "不解决就不应该把 A/B 标成完成的事情。",
        "cards": [
          {
            "id": "quality-blockers",
            "type": "阻断项",
            "priority": "P0",
            "state": "阻塞",
            "title": "修复独立质量评估阻断项",
            "summary": "集中处理本机 HTTP/WS 信任边界、v13/v14 迁移中断恢复、Plugin import 检查假通过和 B3 间歇性发送禁用。",
            "detail": "这张卡是当前项目的总闸门。常规类型检查、根测试、Web、Desktop Mock 和构建通过后，仍不能跳过这些独立评估发现。",
            "tags": [
              "A/B",
              "安全",
              "迁移",
              "稳定性"
            ],
            "modules": [
              "host-safety",
              "storage",
              "plugin-runtime",
              "session-runtime",
              "cli-governance"
            ],
            "checklist": [
              {
                "label": "本机 HTTP / WS 信任边界",
                "done": false
              },
              {
                "label": "v13 / v14 迁移中断后的可恢复路径",
                "done": false
              },
              {
                "label": "Plugin import 检查的真实负例",
                "done": false
              },
              {
                "label": "B3 BRANCH-03/04 重复运行稳定",
                "done": false
              }
            ],
            "source": "docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md",
            "references": [
              {
                "label": "当前项目状态",
                "path": "docs/project-status.md"
              },
              {
                "label": "A 波次计划",
                "path": "plans/p1-quality-model-usage.en.md"
              },
              {
                "label": "B 波次计划",
                "path": "plans/p1-conversation-workbench.en.md"
              }
            ]
          },
          {
            "id": "wave-b-evidence",
            "type": "真实验证",
            "priority": "P1",
            "state": "进行中",
            "title": "补齐 Wave B 真链与人工验收",
            "summary": "补 compact / todo Electron 真链，重复验证分支切换后的发送路径，并执行独立报告中的 A/B 人工验收卡。",
            "detail": "工程实现基本完成不等于对话工作台交付完成。这里需要把自动化、真实桌面操作、错误恢复和用户可理解性放在同一张证据表里。",
            "tags": [
              "Wave B",
              "Desktop",
              "人工验收"
            ],
            "modules": [
              "desktop-renderer",
              "session-runtime",
              "pi-adapter",
              "storage",
              "server"
            ],
            "checklist": [
              {
                "label": "compact live / replay identity",
                "done": false
              },
              {
                "label": "durable todo true-chain",
                "done": false
              },
              {
                "label": "BRANCH-03/04 重复运行通过",
                "done": false
              },
              {
                "label": "A/B 人工验收卡完成",
                "done": false
              }
            ],
            "source": "plans/p1-conversation-workbench.en.md",
            "references": [
              {
                "label": "Wave B 规格",
                "path": "docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md"
              },
              {
                "label": "独立质量评估",
                "path": "docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md"
              }
            ]
          },
          {
            "id": "release-verification",
            "type": "发布验证",
            "priority": "P1",
            "state": "待验证",
            "title": "完成 v0.1.1 安装与更新实测",
            "summary": "验证仓库外安装启动、更新、重启安装、数据恢复和发布资产完整性；Git tag 和 CI 绿不能替代这些证据。",
            "detail": "v0.1.1 的热修已经合并并打 tag，但 GitHub Release 仍是 Draft。发布判断必须建立在安装包真实行为上。",
            "tags": [
              "G2",
              "v0.1.1",
              "Release"
            ],
            "modules": [
              "desktop-shell",
              "supervisor",
              "cli-governance",
              "host-safety"
            ],
            "checklist": [
              {
                "label": "全新安装后启动",
                "done": false
              },
              {
                "label": "应用内更新",
                "done": false
              },
              {
                "label": "重启安装与数据恢复",
                "done": false
              },
              {
                "label": "发布资产和 Draft Release 清理",
                "done": false
              }
            ],
            "source": "plans/g2-desktop-release.md",
            "references": [
              {
                "label": "发布说明",
                "path": "docs/release.md"
              },
              {
                "label": "当前项目状态",
                "path": "docs/project-status.md"
              }
            ]
          },
          {
            "id": "five-day-use",
            "type": "产品观察",
            "priority": "P1",
            "state": "等待前置",
            "title": "准备 5 天真实日用",
            "summary": "在安全、迁移、稳定性、Desktop 真实交互和有效发布链路完成后，连续使用产品，记录真实问题和质量变化。",
            "detail": "五天日用是重要证据，但不能用它替代安全阻断项和发布链路验证。它应该在前置问题收口后开始。",
            "tags": [
              "P1",
              "真实使用",
              "反馈"
            ],
            "modules": [
              "desktop-renderer",
              "session-runtime",
              "memory",
              "observability"
            ],
            "checklist": [
              {
                "label": "前置阻断项全部关闭",
                "done": false
              },
              {
                "label": "完成 A/B 人工验收",
                "done": false
              },
              {
                "label": "使用固定反馈记录模板",
                "done": false
              }
            ],
            "source": "docs/project-status.md",
            "references": [
              {
                "label": "产品路线",
                "path": "docs/positioning-and-roadmap.md"
              },
              {
                "label": "开发流程",
                "path": "docs/development.md"
              }
            ]
          }
        ]
      },
      {
        "id": "validation",
        "label": "代码已合并，等待确认",
        "tone": "amber",
        "description": "工程实现和自动化证据已经积累，但还没有满足真实交付条件。",
        "cards": [
          {
            "id": "wave-b-implementation",
            "type": "工程状态",
            "priority": "P1",
            "state": "待人工验收",
            "title": "P1 内部波次 B：对话工作台",
            "summary": "B0-B5b 已合并，B6/B7 已记录收尾事实；Web Playwright 60/60、Desktop 单测 102/102，但 Desktop 真链和人工验收没有闭环。",
            "detail": "这里记录“代码现在是什么状态”，具体阻断工作在“现在要做”列，避免把实现状态和验收状态混在一起。",
            "tags": [
              "Wave B",
              "Desktop",
              "Web"
            ],
            "modules": [
              "desktop-renderer",
              "server",
              "session-runtime",
              "pi-adapter",
              "storage"
            ],
            "checklist": [
              {
                "label": "工程实现合并",
                "done": true
              },
              {
                "label": "聚焦自动化测试",
                "done": true
              },
              {
                "label": "Desktop 真链稳定",
                "done": false
              },
              {
                "label": "人工验收与发布验证",
                "done": false
              }
            ],
            "source": "docs/project-status.md",
            "references": [
              {
                "label": "Wave B 计划",
                "path": "plans/p1-conversation-workbench.en.md"
              },
              {
                "label": "Wave B 规格",
                "path": "docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md"
              }
            ]
          },
          {
            "id": "wave-a-implementation",
            "type": "工程状态",
            "priority": "P1",
            "state": "待人工验收",
            "title": "P1 内部波次 A：质量体系、模型与用量",
            "summary": "A0-A9 已合并，常规类型检查、根测试、Web、Desktop Mock / 构建和 Web Playwright 通过，但独立质量评估未通过。",
            "detail": "Plugin import 假通过、迁移恢复和人工验收仍是当前收口内容，不能只看 CI 结果。",
            "tags": [
              "Wave A",
              "模型",
              "用量"
            ],
            "modules": [
              "plugin-runtime",
              "storage",
              "observability",
              "server"
            ],
            "checklist": [
              {
                "label": "工程实现合并",
                "done": true
              },
              {
                "label": "常规自动化通过",
                "done": true
              },
              {
                "label": "迁移恢复和 Plugin 检查",
                "done": false
              },
              {
                "label": "人工验收和发布验证",
                "done": false
              }
            ],
            "source": "docs/project-status.md",
            "references": [
              {
                "label": "A 波次计划",
                "path": "plans/p1-quality-model-usage.en.md"
              },
              {
                "label": "独立质量评估",
                "path": "docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md"
              }
            ]
          },
          {
            "id": "p1-slice-15",
            "type": "已实现待观察",
            "priority": "P1",
            "state": "待日用观察",
            "title": "P1 切片 1.5：可用性攻坚",
            "summary": "会话中心 IA、SSE 渲染性能、设置页收敛和 Supervisor 自动拉起已合并，等待波次八验收和后续真实使用观察。",
            "detail": "切片 1.5 的后续重点是确认流畅度、零死控件、IA 自洽和环境问题是否在真实操作中成立。",
            "tags": [
              "P1",
              "可用性",
              "Desktop"
            ],
            "modules": [
              "desktop-renderer",
              "supervisor",
              "session-runtime"
            ],
            "checklist": [
              {
                "label": "代码和自动化合并",
                "done": true
              },
              {
                "label": "波次八人工回归",
                "done": false
              },
              {
                "label": "真实日用观察",
                "done": false
              }
            ],
            "source": "docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md",
            "references": [
              {
                "label": "切片 1.5 计划",
                "path": "plans/p1-t7-sse-perf.md"
              },
              {
                "label": "当前项目状态",
                "path": "docs/project-status.md"
              }
            ]
          },
          {
            "id": "p1-slice-175",
            "type": "已实现待观察",
            "priority": "P1",
            "state": "待日用观察",
            "title": "P1 切片 1.75：记忆激活",
            "summary": "记忆规则、工具引导、后台复盘和行为级闭环测试已合并，下一步是观察 remember / 复盘触发率与记忆质量。",
            "detail": "真实使用反馈将决定切片 2 是否引入衰减、有效性窗口和复盘意图强度分档。",
            "tags": [
              "P1",
              "Memory",
              "真实使用"
            ],
            "modules": [
              "memory",
              "session-runtime",
              "observability",
              "storage"
            ],
            "checklist": [
              {
                "label": "行为级闭环测试",
                "done": true
              },
              {
                "label": "真实触发率观察",
                "done": false
              },
              {
                "label": "切片 2 方向决策",
                "done": false
              }
            ],
            "source": "docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md",
            "references": [
              {
                "label": "记忆架构",
                "path": "docs/memory-architecture.md"
              },
              {
                "label": "切片 1.75 计划",
                "path": "plans/p1-t14-background-review.md"
              }
            ]
          }
        ]
      },
      {
        "id": "planned",
        "label": "接下来规划",
        "tone": "violet",
        "description": "已经有方向或规格，但不应抢跑到当前收口工作之前。",
        "cards": [
          {
            "id": "browser-capability",
            "type": "专项规划",
            "priority": "P1",
            "state": "规划中",
            "title": "浏览器能力与安全边界",
            "summary": "先做安全契约和威胁模型，再做只读 Inspect、Desktop Browser Panel、受控动作和人工元素选取，最后再评估 Agent / Plan / Cron 接线。",
            "detail": "这是独立专项，不与 Wave B 混做。它的第一步是边界和威胁模型，而不是直接接入浏览器自动化。",
            "tags": [
              "P1",
              "安全",
              "浏览器"
            ],
            "modules": [
              "host-safety",
              "server",
              "desktop-renderer",
              "contracts"
            ],
            "checklist": [
              {
                "label": "安全契约和威胁模型",
                "done": false
              },
              {
                "label": "只读 Inspect",
                "done": false
              },
              {
                "label": "受控动作",
                "done": false
              }
            ],
            "source": "docs/superpowers/specs/2026-08-31-browser-capability.md",
            "references": [
              {
                "label": "专项规格",
                "path": "docs/superpowers/specs/2026-08-31-browser-capability.md"
              },
              {
                "label": "开发流程",
                "path": "docs/development.md"
              }
            ]
          },
          {
            "id": "p2-workbench",
            "type": "产品路线",
            "priority": "P2",
            "state": "未排期",
            "title": "个人效率工作台",
            "summary": "把用户项目、任务、资料、日程与 Agent 会话和工作空间连接起来。",
            "detail": "P2 是产品方向，不是当前波次的隐含需求。开始前要从路线图重新立项并拆出明确切片。",
            "tags": [
              "P2",
              "工作台",
              "路线"
            ],
            "modules": [
              "desktop-renderer",
              "session-runtime",
              "storage"
            ],
            "checklist": [
              {
                "label": "完成 P1 质量收口",
                "done": false
              },
              {
                "label": "明确首个垂直切片",
                "done": false
              }
            ],
            "source": "docs/positioning-and-roadmap.md",
            "references": [
              {
                "label": "产品定位与路线",
                "path": "docs/positioning-and-roadmap.md"
              }
            ]
          }
        ]
      },
      {
        "id": "done",
        "label": "已完成 / 已归档",
        "tone": "green",
        "description": "有真实提交和质量证据的历史工作，不再作为当前实施指令。",
        "cards": [
          {
            "id": "g0-governance",
            "type": "治理轨道",
            "priority": "G0",
            "state": "已完成",
            "title": "G0：CI/CD 与公开协作",
            "summary": "GitHub Actions 三 job、分支保护和 Dependabot 收敛已完成，治理规则已经生效。",
            "detail": "后续治理改动应在现有护栏上增量演进，不重新打开已经完成的 G0 计划。",
            "tags": [
              "G0",
              "仓库治理",
              "CI"
            ],
            "modules": [
              "cli-governance"
            ],
            "checklist": [
              {
                "label": "三类 CI 检查",
                "done": true
              },
              {
                "label": "分支保护",
                "done": true
              },
              {
                "label": "Dependabot 存量清零",
                "done": true
              }
            ],
            "source": "plans/g0-ci-linux-fixes.md",
            "references": [
              {
                "label": "CI/CD 说明",
                "path": "docs/ci-cd.md"
              },
              {
                "label": "文档治理",
                "path": "docs/document-governance.md"
              }
            ]
          },
          {
            "id": "g1-convergence",
            "type": "治理轨道",
            "priority": "G1",
            "state": "已完成",
            "title": "G1：仓库收敛与 Desktop 优先",
            "summary": "Desktop 成为唯一产品前端，Web 冻结为运维 / 测试面，单人 + AI agent 协作护栏和编号规则完成收敛。",
            "detail": "后续功能规划默认以 Desktop 为产品入口，不要因为 Web 仍存在就重新把两套界面当成同等产品面。",
            "tags": [
              "G1",
              "Desktop",
              "仓库结构"
            ],
            "modules": [
              "desktop-shell",
              "desktop-renderer",
              "web-client",
              "cli-governance"
            ],
            "checklist": [
              {
                "label": "唯一产品前端",
                "done": true
              },
              {
                "label": "Web 运维 / 测试定位",
                "done": true
              },
              {
                "label": "编号与文档收敛",
                "done": true
              }
            ],
            "source": "plans/g1-repo-convergence.md",
            "references": [
              {
                "label": "当前项目状态",
                "path": "docs/project-status.md"
              },
              {
                "label": "仓库布局",
                "path": "docs/repository-layout.md"
              }
            ]
          },
          {
            "id": "p1-foundation-slices",
            "type": "产品切片",
            "priority": "P1",
            "state": "已完成",
            "title": "P1 切片 1：个人助理基础体验",
            "summary": "Onboarding、目录选择、Agent 身份、会话表单、档案页、记忆日用写操作和错误恢复文案已经合并。",
            "detail": "切片代码已完成，但整体 P1 仍受后续波次的质量评估、人工验收和发布验证约束。",
            "tags": [
              "P1",
              "个人助理",
              "Desktop"
            ],
            "modules": [
              "desktop-renderer",
              "session-runtime",
              "memory",
              "host-safety"
            ],
            "checklist": [
              {
                "label": "四步 onboarding",
                "done": true
              },
              {
                "label": "Agent 身份和档案",
                "done": true
              },
              {
                "label": "记忆日用写操作",
                "done": true
              }
            ],
            "source": "docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md",
            "references": [
              {
                "label": "P1 切片计划",
                "path": "plans/p1-personal-assistant.en.md"
              },
              {
                "label": "当前项目状态",
                "path": "docs/project-status.md"
              }
            ]
          },
          {
            "id": "platform-history",
            "type": "历史归档",
            "priority": "Phase 0-14",
            "state": "已归档",
            "title": "平台底座 Phase 0-14",
            "summary": "平台底座实施已经全部完成并合入 main，历史证据保留在 plans/phase-00.md 至 plans/phase-14.md。",
            "detail": "这些计划只用于查历史证据，不再作为当前实施指令或待办清单。",
            "tags": [
              "历史",
              "平台底座"
            ],
            "modules": [
              "contracts",
              "server",
              "session-runtime",
              "storage",
              "supervisor"
            ],
            "checklist": [
              {
                "label": "Phase 0-14 归档",
                "done": true
              },
              {
                "label": "当前状态移除活动指令",
                "done": true
              }
            ],
            "source": "docs/project-status.md",
            "references": [
              {
                "label": "计划目录",
                "path": "plans/README.md"
              },
              {
                "label": "架构说明",
                "path": "docs/architecture.md"
              }
            ]
          }
        ]
      }
    ]
  },
  "generated": {
    "repository": "OpenColorful",
    "generatedFrom": "docs/architecture-map/architecture.manifest.json",
    "generatedBy": "scripts/generate-architecture-map.mjs",
    "nodeCount": 21,
    "sourceFileCount": 506,
    "mappedFileCount": 506,
    "unmappedFileCount": 0,
    "totalSourceLines": 113703,
    "missingReferenceCount": 0,
    "projectBoardCardCount": 14
  },
  "observedEdges": [
    {
      "from": "cli-governance",
      "to": "contracts",
      "count": 1,
      "evidence": [
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../contracts/skill-protocol.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "host-safety",
      "count": 9,
      "evidence": [
        {
          "importer": "src/cli/chat-command.ts",
          "import": "../config/environment.js"
        },
        {
          "importer": "src/cli/chat-command.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/cli/commands/plugins.ts",
          "import": "../../config/environment.js"
        },
        {
          "importer": "src/cli/commands/plugins.ts",
          "import": "../../config/paths.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../config/environment.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../config/paths.js"
        },
        {
          "importer": "src/cli/server-command.ts",
          "import": "../config/environment.js"
        },
        {
          "importer": "src/cli/server-command.ts",
          "import": "../config/paths.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "server",
      "count": 3,
      "evidence": [
        {
          "importer": "src/cli/chat-command.ts",
          "import": "../server/trust-boundary.js"
        },
        {
          "importer": "src/cli/server-command.ts",
          "import": "../server/runtime-state.js"
        },
        {
          "importer": "src/cli/server-command.ts",
          "import": "../server/start.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "skills",
      "count": 7,
      "evidence": [
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/errors.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/installer/risk.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/pack.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/sources/linked-source-registry.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/sources/trust-config.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/sources/workspace-roots.js"
        },
        {
          "importer": "src/cli/commands/skills.ts",
          "import": "../../runtime/skills/validator.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "supervisor",
      "count": 2,
      "evidence": [
        {
          "importer": "src/cli/supervisor-command.ts",
          "import": "../supervisor/start.js"
        },
        {
          "importer": "src/cli/supervisor-command.ts",
          "import": "../supervisor/types.js"
        }
      ]
    },
    {
      "from": "cli-governance",
      "to": "tui-client",
      "count": 1,
      "evidence": [
        {
          "importer": "src/cli/chat-command.ts",
          "import": "../tui/app.js"
        }
      ]
    },
    {
      "from": "contracts",
      "to": "plugin-protocol",
      "count": 1,
      "evidence": [
        {
          "importer": "src/contracts/plugin-protocol.ts",
          "import": "@opencolorful/plugin-protocol"
        }
      ]
    },
    {
      "from": "host-safety",
      "to": "contracts",
      "count": 12,
      "evidence": [
        {
          "importer": "src/config/agent-store.ts",
          "import": "../contracts/agent-identity.js"
        },
        {
          "importer": "src/config/agent-store.ts",
          "import": "../contracts/agent-settings.js"
        },
        {
          "importer": "src/config/agent-store.ts",
          "import": "../contracts/sandbox.js"
        },
        {
          "importer": "src/config/preferences-store.ts",
          "import": "../contracts/preferences.js"
        },
        {
          "importer": "src/config/provider-store.ts",
          "import": "../contracts/provider-settings.js"
        },
        {
          "importer": "src/sandbox/backend.ts",
          "import": "../contracts/sandbox.js"
        },
        {
          "importer": "src/sandbox/local-backend.ts",
          "import": "../contracts/sandbox.js"
        },
        {
          "importer": "src/sandbox/path-guard.ts",
          "import": "../contracts/sandbox.js"
        }
      ]
    },
    {
      "from": "host-safety",
      "to": "observability",
      "count": 1,
      "evidence": [
        {
          "importer": "src/sandbox/sandbox-service.ts",
          "import": "../observability/instrument.js"
        }
      ]
    },
    {
      "from": "memory",
      "to": "contracts",
      "count": 19,
      "evidence": [
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-tools.ts",
          "import": "../../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/agent/run-report.ts",
          "import": "../../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/background-review.ts",
          "import": "../../contracts/events.js"
        },
        {
          "importer": "src/runtime/memory/compile-pipeline.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/event-indexer.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/intensity-calculator.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/runtime/memory/memory-injection.ts",
          "import": "../../contracts/memory.js"
        }
      ]
    },
    {
      "from": "memory",
      "to": "host-safety",
      "count": 2,
      "evidence": [
        {
          "importer": "src/runtime/memory/memory-ticker.ts",
          "import": "../../config/agent-store.js"
        },
        {
          "importer": "src/runtime/memory/scheduler.ts",
          "import": "../../config/agent-store.js"
        }
      ]
    },
    {
      "from": "memory",
      "to": "observability",
      "count": 10,
      "evidence": [
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/background-review.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/compile-pipeline.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/memory-ticker.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/proposal-application.ts",
          "import": "../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/memory/proposal-application.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/recall-service.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/memory/resolver.ts",
          "import": "../../observability/instrument.js"
        }
      ]
    },
    {
      "from": "memory",
      "to": "session-runtime",
      "count": 14,
      "evidence": [
        {
          "importer": "src/runtime/memory/agent/memory-agent-tools.ts",
          "import": "../../sanitize.js"
        },
        {
          "importer": "src/runtime/memory/agent/run-report.ts",
          "import": "../../sanitize.js"
        },
        {
          "importer": "src/runtime/memory/background-review.ts",
          "import": "../event-replay-store.js"
        },
        {
          "importer": "src/runtime/memory/background-review.ts",
          "import": "../session-service.js"
        },
        {
          "importer": "src/runtime/memory/compile-pipeline.ts",
          "import": "../sanitize.js"
        },
        {
          "importer": "src/runtime/memory/event-indexer.ts",
          "import": "../sanitize.js"
        },
        {
          "importer": "src/runtime/memory/memory-ticker.ts",
          "import": "../event-replay-store.js"
        },
        {
          "importer": "src/runtime/memory/memory-ticker.ts",
          "import": "../prompt-service.js"
        }
      ]
    },
    {
      "from": "memory",
      "to": "storage",
      "count": 52,
      "evidence": [
        {
          "importer": "src/runtime/memory/activation-updater.ts",
          "import": "../../storage/memory/fact-store.js"
        },
        {
          "importer": "src/runtime/memory/activation-updater.ts",
          "import": "../../storage/memory/recall-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../storage/memory/batch-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../storage/memory/event-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../storage/memory/fact-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../storage/memory/journal-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-runner.ts",
          "import": "../../../storage/memory/recall-store.js"
        },
        {
          "importer": "src/runtime/memory/agent/memory-agent-tools.ts",
          "import": "../../../storage/memory/fact-store.js"
        }
      ]
    },
    {
      "from": "observability",
      "to": "contracts",
      "count": 17,
      "evidence": [
        {
          "importer": "src/observability/activity-operation.ts",
          "import": "../contracts/observability.js"
        },
        {
          "importer": "src/observability/activity-recorder.ts",
          "import": "../contracts/observability.js"
        },
        {
          "importer": "src/observability/audit-recorder.ts",
          "import": "../contracts/observability.js"
        },
        {
          "importer": "src/observability/catalog/plugin-events.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/observability/catalog/shared.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/observability/catalog/skill-events.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/observability/catalog/subagent-events.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/observability/diagnostic-logger.ts",
          "import": "../contracts/observability.js"
        }
      ]
    },
    {
      "from": "observability",
      "to": "host-safety",
      "count": 1,
      "evidence": [
        {
          "importer": "src/observability/support-bundle.ts",
          "import": "../config/paths.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "contracts",
      "count": 13,
      "evidence": [
        {
          "importer": "src/pi-sdk/agent-session.ts",
          "import": "../contracts/events.js"
        },
        {
          "importer": "src/pi-sdk/agent-session.ts",
          "import": "../contracts/sandbox.js"
        },
        {
          "importer": "src/pi-sdk/complete-text.ts",
          "import": "../contracts/usage.js"
        },
        {
          "importer": "src/pi-sdk/memory-tools.ts",
          "import": "../contracts/memory.js"
        },
        {
          "importer": "src/pi-sdk/model-runtime.ts",
          "import": "../contracts/api-error.js"
        },
        {
          "importer": "src/pi-sdk/skill-loader.ts",
          "import": "../contracts/skill-protocol.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../contracts/model-policy.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../contracts/subagents.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "memory",
      "count": 1,
      "evidence": [
        {
          "importer": "src/pi-sdk/memory-tools.ts",
          "import": "../runtime/memory/recall-service.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "observability",
      "count": 3,
      "evidence": [
        {
          "importer": "src/pi-sdk/skill-tools.ts",
          "import": "../observability/trace-context.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../observability/audit-recorder.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools.ts",
          "import": "../observability/audit-recorder.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "session-runtime",
      "count": 3,
      "evidence": [
        {
          "importer": "src/pi-sdk/agent-session.ts",
          "import": "../runtime/tool-policy.js"
        },
        {
          "importer": "src/pi-sdk/sandbox-extension.ts",
          "import": "../runtime/tool-policy.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools.ts",
          "import": "../runtime/model-policy.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "skills",
      "count": 4,
      "evidence": [
        {
          "importer": "src/pi-sdk/skill-loader.ts",
          "import": "../runtime/skills/path-safety.js"
        },
        {
          "importer": "src/pi-sdk/skill-loader.ts",
          "import": "../runtime/skills/resolver.js"
        },
        {
          "importer": "src/pi-sdk/skill-loader.ts",
          "import": "../runtime/skills/snapshot/skill-snapshot.js"
        },
        {
          "importer": "src/pi-sdk/skill-tools.ts",
          "import": "../runtime/skills/core/skill-core-service.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "storage",
      "count": 3,
      "evidence": [
        {
          "importer": "src/pi-sdk/memory-tools.ts",
          "import": "../storage/memory/journal-store.js"
        },
        {
          "importer": "src/pi-sdk/memory-tools.ts",
          "import": "../storage/memory/pinned-store.js"
        },
        {
          "importer": "src/pi-sdk/todo-tools.ts",
          "import": "../storage/session-todos.js"
        }
      ]
    },
    {
      "from": "pi-adapter",
      "to": "subagents",
      "count": 16,
      "evidence": [
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/delegation-policy.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/protocol/protocol-dispatcher.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/recovery/startup-recovery.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/runtime/runtime-host.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/runtime/scheduler.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/runtime/types.js"
        },
        {
          "importer": "src/pi-sdk/subagent-tools-context.ts",
          "import": "../runtime/subagents/stores/index.js"
        }
      ]
    },
    {
      "from": "plugin-package-runtime",
      "to": "plugin-protocol",
      "count": 2,
      "evidence": [
        {
          "importer": "packages/plugin-runtime/src/index.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-runtime/src/server.ts",
          "import": "@opencolorful/plugin-protocol"
        }
      ]
    },
    {
      "from": "plugin-runtime",
      "to": "contracts",
      "count": 49,
      "evidence": [
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../contracts/observability.js"
        },
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../contracts/plugin-protocol.js"
        },
        {
          "importer": "src/runtime/plugins/compat/hermes-compat.ts",
          "import": "../../../contracts/plugin-protocol.js"
        },
        {
          "importer": "src/runtime/plugins/compat/hermes-python-bridge.ts",
          "import": "../../../contracts/plugin-protocol.js"
        },
        {
          "importer": "src/runtime/plugins/compat/openclaw-compat.ts",
          "import": "../../../contracts/plugin-protocol.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/attachment-contribution.ts",
          "import": "../../../contracts/plugin-protocol.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/background-contribution.ts",
          "import": "../../../contracts/observability.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/background-contribution.ts",
          "import": "../../../contracts/plugin-protocol.js"
        }
      ]
    },
    {
      "from": "plugin-runtime",
      "to": "host-safety",
      "count": 10,
      "evidence": [
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/host-api.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/surface-contribution.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/dev/dev-host.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/grants/sandbox-bridge.ts",
          "import": "../../../sandbox/path-guard.js"
        },
        {
          "importer": "src/runtime/plugins/grants/sandbox-bridge.ts",
          "import": "../../../sandbox/preflight.js"
        },
        {
          "importer": "src/runtime/plugins/installer/plugin-installer.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/plugins/paths.ts",
          "import": "../../config/paths.js"
        }
      ]
    },
    {
      "from": "plugin-runtime",
      "to": "observability",
      "count": 34,
      "evidence": [
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../observability/audit-recorder.js"
        },
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/runtime/plugins/compat/hermes-python-bridge.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/background-contribution.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/config-contribution.ts",
          "import": "../../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/config-contribution.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/custom-activity-contribution.ts",
          "import": "../../../observability/extension-port.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/file-secret-store.ts",
          "import": "../../../observability/instrument.js"
        }
      ]
    },
    {
      "from": "plugin-runtime",
      "to": "storage",
      "count": 19,
      "evidence": [
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../storage/plugin-binding-store.js"
        },
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../storage/plugin-config-store.js"
        },
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../storage/plugin-grant-store.js"
        },
        {
          "importer": "src/platform/plugin-facade.ts",
          "import": "../storage/plugin-registry-store.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/config-contribution.ts",
          "import": "../../../storage/plugin-config-store.js"
        },
        {
          "importer": "src/runtime/plugins/contributions/host-api.ts",
          "import": "../../../storage/plugin-config-store.js"
        },
        {
          "importer": "src/runtime/plugins/dev/dev-host.ts",
          "import": "../../../storage/plugin-config-store.js"
        },
        {
          "importer": "src/runtime/plugins/dev/dev-host.ts",
          "import": "../../../storage/plugin-registry-store.js"
        }
      ]
    },
    {
      "from": "plugin-sdk",
      "to": "plugin-package-runtime",
      "count": 1,
      "evidence": [
        {
          "importer": "packages/plugin-sdk/src/scaffold.ts",
          "import": "@opencolorful/plugin-runtime"
        }
      ]
    },
    {
      "from": "plugin-sdk",
      "to": "plugin-protocol",
      "count": 3,
      "evidence": [
        {
          "importer": "packages/plugin-sdk/src/define.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-sdk/src/index.ts",
          "import": "@opencolorful/plugin-protocol"
        },
        {
          "importer": "packages/plugin-sdk/src/scaffold.ts",
          "import": "@opencolorful/plugin-protocol"
        }
      ]
    },
    {
      "from": "server",
      "to": "cli-governance",
      "count": 2,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../index.js"
        },
        {
          "importer": "src/server/routes/observability.ts",
          "import": "../../index.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "contracts",
      "count": 45,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../contracts/memory.js"
        },
        {
          "importer": "src/server/observability/client-events.ts",
          "import": "../../contracts/observability.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../contracts/events.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/api-error.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/base-color-templates.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../contracts/sandbox.js"
        },
        {
          "importer": "src/server/routes/directories.ts",
          "import": "../../contracts/api-error.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "host-safety",
      "count": 29,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../config/agent-store.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../config/preferences-store.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../platform/folder-picker.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../config/agent-store.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../config/agent-store.js"
        },
        {
          "importer": "src/server/routes/directories.ts",
          "import": "../../platform/folder-picker.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../config/agent-store.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "memory",
      "count": 16,
      "evidence": [
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../runtime/memory/memory-injection.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../runtime/memory/proposal-application.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../runtime/memory/resolver.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../runtime/memory/scheduler.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/memory/memory-injection.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/memory/recall-service.js"
        },
        {
          "importer": "src/server/start.ts",
          "import": "../runtime/memory/background-review.js"
        },
        {
          "importer": "src/server/start.ts",
          "import": "../runtime/memory/memory-ticker.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "observability",
      "count": 20,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../observability/audit-recorder.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/server/observability/client-events.ts",
          "import": "../../observability/safe-value.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../observability/audit-recorder.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/server/routes/observability.ts",
          "import": "../../observability/observability-context.js"
        },
        {
          "importer": "src/server/routes/observability.ts",
          "import": "../../observability/observability-query.js"
        },
        {
          "importer": "src/server/routes/observability.ts",
          "import": "../../observability/retention.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "pi-adapter",
      "count": 8,
      "evidence": [
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/agent-session.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/index.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/memory-tools.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/skill-tools.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/subagent-tools-context.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../pi-sdk/todo-tools.js"
        },
        {
          "importer": "src/server/routes/subagent-ability-tools.ts",
          "import": "../../pi-sdk/types.js"
        },
        {
          "importer": "src/server/start.ts",
          "import": "../pi-sdk/complete-text.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "plugin-runtime",
      "count": 8,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../platform/plugin-facade.js"
        },
        {
          "importer": "src/server/routes/messages.ts",
          "import": "../../platform/plugin-facade.js"
        },
        {
          "importer": "src/server/routes/plugins.ts",
          "import": "../../platform/plugin-facade.js"
        },
        {
          "importer": "src/server/routes/plugins.ts",
          "import": "../../runtime/plugins/grants/grant-service.js"
        },
        {
          "importer": "src/server/routes/plugins.ts",
          "import": "../../runtime/plugins/sources/source-adapter.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../platform/plugin-facade.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/plugins/grants/execution-snapshot.js"
        },
        {
          "importer": "src/server/start.ts",
          "import": "../platform/plugin-facade.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "session-runtime",
      "count": 41,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/event-replay-store.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/model-service.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/prompt-service.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../runtime/event-replay-store.js"
        },
        {
          "importer": "src/server/routes/agent-events.ts",
          "import": "../../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/agents.ts",
          "import": "../../runtime/session-service.js"
        },
        {
          "importer": "src/server/routes/events.ts",
          "import": "../../runtime/event-replay-store.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "skills",
      "count": 9,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/skills/core/skill-admin-service.js"
        },
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/skills/core/skill-core-service.js"
        },
        {
          "importer": "src/server/routes/messages.ts",
          "import": "../../runtime/skills/core/skill-core-service.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/skills/core/skill-core-service.js"
        },
        {
          "importer": "src/server/routes/skill-admin.ts",
          "import": "../../runtime/skills/core/skill-admin-service.js"
        },
        {
          "importer": "src/server/routes/skill-admin.ts",
          "import": "../../runtime/skills/core/skill-core-service.js"
        },
        {
          "importer": "src/server/routes/skills.ts",
          "import": "../../runtime/skills/core/skill-core-service.js"
        },
        {
          "importer": "src/server/routes/subagent-ability-tools.ts",
          "import": "../../runtime/skills/core/skill-core-service.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "storage",
      "count": 29,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../storage/usage-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/batch-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/event-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/fact-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/pinned-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/recall-store.js"
        },
        {
          "importer": "src/server/routes/memory.ts",
          "import": "../../storage/memory/recovery-store.js"
        },
        {
          "importer": "src/server/routes/observability.ts",
          "import": "../../storage/migrations.js"
        }
      ]
    },
    {
      "from": "server",
      "to": "subagents",
      "count": 16,
      "evidence": [
        {
          "importer": "src/server/app.ts",
          "import": "../runtime/subagents/composition.js"
        },
        {
          "importer": "src/server/routes/messages.ts",
          "import": "../../runtime/subagents/composition.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/subagents/composition.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/subagents/delegation-policy.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/subagents/runtime/parent-session-adapter.js"
        },
        {
          "importer": "src/server/routes/runtime-bootstrap.ts",
          "import": "../../runtime/subagents/runtime/types.js"
        },
        {
          "importer": "src/server/routes/subagent-ability-tools.ts",
          "import": "../../runtime/subagents/delegation-policy.js"
        },
        {
          "importer": "src/server/routes/subagent-ability-tools.ts",
          "import": "../../runtime/subagents/runtime/types.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "contracts",
      "count": 19,
      "evidence": [
        {
          "importer": "src/runtime/event-mapper.ts",
          "import": "../contracts/events.js"
        },
        {
          "importer": "src/runtime/event-replay-store.ts",
          "import": "../contracts/events.js"
        },
        {
          "importer": "src/runtime/model-policy.ts",
          "import": "../contracts/api-error.js"
        },
        {
          "importer": "src/runtime/model-policy.ts",
          "import": "../contracts/memory.js"
        },
        {
          "importer": "src/runtime/model-policy.ts",
          "import": "../contracts/model-policy.js"
        },
        {
          "importer": "src/runtime/model-policy.ts",
          "import": "../contracts/preferences.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../contracts/provider-settings.js"
        },
        {
          "importer": "src/runtime/prompt-service.ts",
          "import": "../contracts/session-branch.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "host-safety",
      "count": 7,
      "evidence": [
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../config/provider-store.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../sandbox/sandbox-service.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/path-guard.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/preflight.js"
        },
        {
          "importer": "src/runtime/tool-policy.ts",
          "import": "../sandbox/sandbox-service.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "observability",
      "count": 4,
      "evidence": [
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../observability/instrument.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "pi-adapter",
      "count": 5,
      "evidence": [
        {
          "importer": "src/runtime/event-mapper.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/model-service.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/session-runtime.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/usage-recorder.ts",
          "import": "../pi-sdk/complete-text.js"
        }
      ]
    },
    {
      "from": "session-runtime",
      "to": "storage",
      "count": 3,
      "evidence": [
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../storage/session-index.js"
        },
        {
          "importer": "src/runtime/session-service.ts",
          "import": "../storage/session-todos.js"
        },
        {
          "importer": "src/runtime/usage-recorder.ts",
          "import": "../storage/usage-store.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "contracts",
      "count": 50,
      "evidence": [
        {
          "importer": "src/runtime/skills/agent/agent-skill-config.ts",
          "import": "../../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/skills/binding/projection.ts",
          "import": "../../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../contracts/observability.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../contracts/observability.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/skills/catalog/scan.ts",
          "import": "../../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/skills/catalog/skill-catalog.ts",
          "import": "../../../contracts/skill-protocol.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "host-safety",
      "count": 21,
      "evidence": [
        {
          "importer": "src/runtime/skills/agent/agent-skill-config.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/catalog/scan.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../sandbox/sandbox-service.js"
        },
        {
          "importer": "src/runtime/skills/core/skill-admin-service.ts",
          "import": "../../../config/paths.js"
        },
        {
          "importer": "src/runtime/skills/installer/skill-installer.ts",
          "import": "../../../config/paths.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "observability",
      "count": 13,
      "evidence": [
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/skills/content/skill-content-service.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/skills/core/skill-core-service.ts",
          "import": "../../../observability/instrument.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "pi-adapter",
      "count": 2,
      "evidence": [
        {
          "importer": "src/runtime/skills/core/skill-core-service.ts",
          "import": "../../../pi-sdk/skill-loader.js"
        },
        {
          "importer": "src/runtime/skills/core/skill-core-service.ts",
          "import": "../../../pi-sdk/types.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "plugin-runtime",
      "count": 5,
      "evidence": [
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../platform/plugin-facade.js"
        },
        {
          "importer": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "import": "../../plugins/contributions/shared.js"
        },
        {
          "importer": "src/runtime/skills/plugin/plugin-skill-bridge.ts",
          "import": "../../plugins/paths.js"
        }
      ]
    },
    {
      "from": "skills",
      "to": "storage",
      "count": 14,
      "evidence": [
        {
          "importer": "src/runtime/skills/binding/projection.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/projection.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/binding/skill-binding-service.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/bundles/skill-bundle-service.ts",
          "import": "../../../storage/skill-bundle-store.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../storage/agent-skill-binding-store.js"
        },
        {
          "importer": "src/runtime/skills/composition.ts",
          "import": "../../storage/skill-bundle-store.js"
        }
      ]
    },
    {
      "from": "storage",
      "to": "contracts",
      "count": 17,
      "evidence": [
        {
          "importer": "src/storage/agent-skill-binding-store.ts",
          "import": "../contracts/skill-protocol.js"
        },
        {
          "importer": "src/storage/memory/batch-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/event-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/fact-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/journal-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/pinned-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/proposal-store.ts",
          "import": "../../contracts/memory.js"
        },
        {
          "importer": "src/storage/memory/recall-store.ts",
          "import": "../../contracts/memory.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "contracts",
      "count": 26,
      "evidence": [
        {
          "importer": "src/runtime/subagents/context-resolver.ts",
          "import": "../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/subagents/context-resolver.ts",
          "import": "../../contracts/subagents.js"
        },
        {
          "importer": "src/runtime/subagents/delegation-policy.ts",
          "import": "../../contracts/skill-protocol.js"
        },
        {
          "importer": "src/runtime/subagents/delegation-policy.ts",
          "import": "../../contracts/subagents.js"
        },
        {
          "importer": "src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.ts",
          "import": "../../../contracts/subagents.js"
        },
        {
          "importer": "src/runtime/subagents/observability/subagent-observability-projector.ts",
          "import": "../../../contracts/observability.js"
        },
        {
          "importer": "src/runtime/subagents/observability/subagent-observability-projector.ts",
          "import": "../../../contracts/subagents.js"
        },
        {
          "importer": "src/runtime/subagents/protocol/protocol-dispatcher.ts",
          "import": "../../../contracts/subagents.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "host-safety",
      "count": 3,
      "evidence": [
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../config/paths.js"
        },
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../config/preferences-store.js"
        },
        {
          "importer": "src/runtime/subagents/transcript/artifact-files.ts",
          "import": "../../../config/paths.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "observability",
      "count": 8,
      "evidence": [
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../observability/activity-recorder.js"
        },
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/subagents/observability/subagent-observability-projector.ts",
          "import": "../../../observability/activity-recorder.js"
        },
        {
          "importer": "src/runtime/subagents/observability/subagent-observability-projector.ts",
          "import": "../../../observability/trace-context.js"
        },
        {
          "importer": "src/runtime/subagents/recovery/startup-recovery.ts",
          "import": "../../../observability/activity-recorder.js"
        },
        {
          "importer": "src/runtime/subagents/recovery/startup-recovery.ts",
          "import": "../../../observability/audit-recorder.js"
        },
        {
          "importer": "src/runtime/subagents/runtime/usage-ingestion.ts",
          "import": "../../../observability/instrument.js"
        },
        {
          "importer": "src/runtime/subagents/transcript/tool-summary.ts",
          "import": "../../../observability/safe-value.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "pi-adapter",
      "count": 5,
      "evidence": [
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../pi-sdk/subagent-tools-context.js"
        },
        {
          "importer": "src/runtime/subagents/runtime/pi-session-adapter.ts",
          "import": "../../../pi-sdk/agent-session.js"
        },
        {
          "importer": "src/runtime/subagents/runtime/pi-session-adapter.ts",
          "import": "../../../pi-sdk/index.js"
        },
        {
          "importer": "src/runtime/subagents/runtime/pi-session-adapter.ts",
          "import": "../../../pi-sdk/subagent-tools-context.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "session-runtime",
      "count": 2,
      "evidence": [
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../runtime/model-service.js"
        },
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../model-policy.js"
        }
      ]
    },
    {
      "from": "subagents",
      "to": "storage",
      "count": 2,
      "evidence": [
        {
          "importer": "src/runtime/subagents/composition.ts",
          "import": "../../storage/usage-store.js"
        },
        {
          "importer": "src/runtime/subagents/runtime/usage-ingestion.ts",
          "import": "../../../storage/usage-store.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "cli-governance",
      "count": 2,
      "evidence": [
        {
          "importer": "src/supervisor/app.ts",
          "import": "../index.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../index.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "host-safety",
      "count": 2,
      "evidence": [
        {
          "importer": "src/supervisor/process-controller.ts",
          "import": "../config/paths.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../config/paths.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "observability",
      "count": 4,
      "evidence": [
        {
          "importer": "src/supervisor/process-controller.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../observability/instrument.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../observability/observability-context.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../observability/trace-context.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "server",
      "count": 3,
      "evidence": [
        {
          "importer": "src/supervisor/app.ts",
          "import": "../server/trust-boundary.js"
        },
        {
          "importer": "src/supervisor/process-controller.ts",
          "import": "../server/runtime-state.js"
        },
        {
          "importer": "src/supervisor/start.ts",
          "import": "../server/trust-boundary.js"
        }
      ]
    },
    {
      "from": "supervisor",
      "to": "storage",
      "count": 1,
      "evidence": [
        {
          "importer": "src/supervisor/start.ts",
          "import": "../storage/database.js"
        }
      ]
    },
    {
      "from": "ui-projection",
      "to": "contracts",
      "count": 5,
      "evidence": [
        {
          "importer": "src/ui-projection/a2ui/action.ts",
          "import": "../../contracts/ui-message.js"
        },
        {
          "importer": "src/ui-projection/a2ui/project.ts",
          "import": "../../contracts/events.js"
        },
        {
          "importer": "src/ui-projection/a2ui/project.ts",
          "import": "../../contracts/ui-message.js"
        },
        {
          "importer": "src/ui-projection/tokui/project.ts",
          "import": "../../contracts/events.js"
        },
        {
          "importer": "src/ui-projection/tokui/project.ts",
          "import": "../../contracts/ui-message.js"
        }
      ]
    }
  ],
  "unmappedFiles": [],
  "missingReferences": []
};

# OpenColorful Desktop Design

> Status: desktop visual and interaction baseline
> Updated: 2026-08-18

## 1. Product thesis

OpenColorful Desktop is the local workbench where a person lives and works with long-running Agents. It is not a generic chatbot, an IDE clone, or an administration dashboard. The interface should make identity, memory, ongoing work, artifacts, and relationships feel like parts of one continuous life.

The website uses **Open Window** as its visual thesis. The desktop translation is **Window Desk**: a quiet working surface beside that open window. Watercolor scenery remains present as atmosphere and identity, while the operational surface becomes denser, calmer, and more precise.

## 2. Sources and translation

### OpenColorful World

Keep:

- warm paper, ink text, fine dividers, restrained semantic color;
- watercolor scenes as real environment rather than decoration;
- editorial hierarchy: small context label, clear title, readable body;
- Agent-specific identity colors and visible provenance;
- content density created by typography and rhythm, not card stacks.

Translate for desktop:

- the website hero becomes a compact Agent scene or empty-state canvas;
- community navigation becomes a stable tool rail and task/session index;
- editorial sections become docked work surfaces separated by one-pixel lines;
- large page whitespace becomes controlled breathing room around the conversation.

### OpenHanako

Borrow the strong desktop grammar:

- native-feeling titlebar and stable three-pane layout;
- Agent switcher near the work surface;
- conversation in the center, desk/context on the right;
- composer as a persistent grounded tool, not a floating chat bubble;
- calm empty states that introduce the Agent before work begins.

Do not copy its very pale contrast, oversized empty regions, or feature-specific ornament.

### Codex and Kimi

Borrow the interaction model, not their visual skin:

- projects, tasks, and threads are first-class navigation objects;
- long-running work exposes progress, changed files, artifacts, and handoffs;
- parallel Agent activity stays inspectable without taking over the conversation;
- the center remains the primary work narrative, while operational detail lives in a dock.

## 3. Visual direction

### Palette

| Token | Value | Role |
| --- | --- | --- |
| `paper` | `#fbfaf6` | main canvas |
| `paper-warm` | `#f5f1e7` | rails, quiet surfaces |
| `paper-deep` | `#eee8da` | selected and structural surfaces |
| `ink` | `#1b1e1c` | primary text and command buttons |
| `muted` | `#686962` | supporting text |
| `line` | `rgba(45,47,43,.16)` | pane boundaries |
| `sky` | `#4d91dc` | links, workspace context |
| `leaf` | `#5ba67c` | healthy/running state |
| `sun` | `#e8b128` | attention and waiting |
| `coral` | `#e87561` | interruption and human action |
| `violet` | `#8c72bf` | Agent/system identity |

The application must not collapse into a beige monochrome. The paper system is the substrate; semantic colors must remain visible in identities, event markers, focus, and status.

### Type

- Display and Agent names: `Noto Serif SC`, `Source Han Serif SC`, `Songti SC`, Georgia.
- Interface and conversation: `Noto Sans SC`, `PingFang SC`, `Microsoft YaHei`, system UI.
- Runtime facts: `SFMono-Regular`, Consolas, monospace.
- Do not scale type with viewport width. Use a restrained fixed scale from 11px to 24px.
- Letter spacing is zero except for short uppercase Latin utility labels.

### Shape and depth

- Main panes are unframed and separated primarily by small tonal shifts and soft inset rules, not high-contrast borders.
- Cards are reserved for user input, expandable execution detail, repeated artifacts, and modal objects.
- Use one restrained geometry system: 5px controls and 7px floating surfaces. Do not mix sharp shell seams with oversized rounded chat cards.
- Shadows appear only on floating menus, dialogs, and the composer.
- Avoid gradients as decoration, glass effects, decorative blobs, and nested cards.

## 4. Desktop information architecture

```text
titlebar: brand / pinned workspace pages / runtime state / window controls

session sidebar           | conversation or plugin page       | workbench dock
Agent and recent sessions | messages, plans and focused work  | desk / diff
scheduled work            | grounded composer or settings     | terminal / browser
settings entry            |                                   | contextual plugin tool
```

### Session sidebar

The left sidebar has one stable responsibility: choosing who and what the person is working with. It contains the current Agent, session creation and history, a small scheduled-work section, and the single entry to Settings. It does not become a permanent catalog of every platform capability.

The sidebar can be fully hidden when the center needs the space. Hidden means zero-width and no residual rail; the restore control moves to the top-left titlebar so the working surface stays uninterrupted.

There is no application-wide search field in the titlebar. Search belongs inside a surface that owns searchable content, such as a long session list, a memory page, or a browser panel.

### Workspace pages

The center of the titlebar switches between user-visible work pages. Conversation is the core page. A plugin may contribute another page, but installation alone must not add permanent navigation. A plugin page appears only when it is enabled and either pinned by the user or opened by an explicit workflow.

Settings is not a workspace tab. It opens as an application-level modal from the bottom of the session sidebar. The modal uses a compact category list on the left and one focused category on the right. Plugin management, application preferences, Agent defaults, and security controls all live there without replacing the active conversation.

### Conversation

Messages read like an editorial work log rather than chat bubbles. User messages may use a quiet inset surface; Agent responses remain unframed and are never collapsed merely because they are long. The transcript has two explicit semantic layers:

- **conversation messages**: user input and normal Agent text remain continuously readable;
- **execution events**: thinking, tool calls, file changes, plans, approvals, Subagent activity, compaction, memory recall, and runtime errors render as compact summaries with status and optional disclosure.

Execution events sit in a quiet event gutter with semantic marks. There is no continuous vertical rule through the conversation; the gutter should clarify event type without becoming a second visual timeline. Expanding an event reveals operational evidence, not another copy of the Agent's prose response.

New conversations start in a deliberately sparse welcome state: the active Agent, Agent choice, workspace entry, memory entry, and one grounded composer. The execution timeline only appears after the first message is sent.

### Workbench dock

The right side is a general-purpose workbench, not a second navigation system. It starts with a quiet empty state and a small set of tool entry points. A browser, file diff, terminal, artifact preview, approval surface, or plugin-contributed tool only appears after an explicit click. Only one workbench tool is primary at a time.

The dock may collapse, but wide desktop keeps the three-column structure. Opening a tool must not replace the conversation or inject unrelated status cards into the center.

The conversation header owns a compact **activity popover** for work that needs attention: plan progress, pending approvals, Subagents, and running terminals. It is closed by default and does not duplicate the full event transcript. The left session rail also exposes a small history locator with timestamp anchors; it is a navigation aid, not a decorative line.

### Composer

The composer is the stable command surface. It includes attachments/tools, model or mode selection, workspace context, and send/stop. Advanced controls remain in menus until relevant.

## 5. Signature element: execution gutter and activity lens

The product-specific signature is a restrained execution gutter beside the central work narrative. Events use small semantic marks without a continuous line:

- blue: workspace or file context;
- green: memory and retained knowledge;
- violet: Agent or Subagent activity;
- yellow: waiting, approval, or scheduled work;
- coral: interruption, denial, or human correction.

This is not decorative. It makes the platform's central promise visible: conversations, memories, tools, and relationships belong to one continuing Agent life. The activity popover is the second lens: it answers "what needs attention now?" while the conversation answers "what happened?".

## 6. Agent-platform design audit (2026)

Recent agent workbenches converge on a few useful patterns:

- **Projects and threads are first-class objects.** A project scopes files, permissions, model defaults, and history; a thread is the durable execution narrative inside it.
- **Long-running work must be inspectable without becoming chat noise.** Plans, approvals, tool calls, diffs, terminals, and Subagents are compact states with explicit disclosure and a clear next action.
- **Operational surfaces are contextual.** A terminal, browser, diff, or artifact view belongs in a workbench or overlay and should not permanently occupy the conversation.
- **The current execution state is glanceable.** A small activity surface can expose progress and blockers; it should collapse so the main narrative remains calm.
- **Plugins contribute capabilities through host-owned slots.** Navigation, permissions, lifecycle, and layout remain host responsibilities even when models, tools, skills, storage, schedules, and UI are composable.
- **The working context is visible before execution.** Project directory, branch/workspace, model, permission mode, and thinking level should be readable near the composer or session header.

These patterns are consistent with the current Codex multi-thread task model, Kimi Work's local-agent workflow, and DeepSeek Harness's plugin-composable runtime. OpenColorful adopts the interaction principles while keeping its own visual language.

### Settings

Settings opens as an application modal with a category rail and one scrollable category surface. Categories mirror real platform ownership rather than arbitrary UI groupings:

- general layout and appearance preferences;
- Agent identity, base color, default workspace, and sandbox settings;
- Providers, models, reasoning capability, and credentials state;
- Session model, thinking level, tool mode, workspace confirmation, and context usage;
- memory defaults and recall visibility;
- Subagent defaults, runtime limits, observability, and diagnostics;
- plugins, Skills, permissions, security, and application information.

Dense settings use compact rows, selects, toggles, and focused secondary views. Unsupported or future options must be labelled as such instead of being presented as live configuration.

## 7. Interaction principles

- Keep the selected Agent and workspace visible at all times.
- Prefer one-click inspection over modal navigation.
- Never collapse ordinary Agent output based on character count.
- Keep thinking, tool internals, file bodies, diffs, Subagent transcripts, and diagnostics collapsed until requested.
- Use short event summaries, state, and one clear disclosure affordance instead of stacking operational paragraphs in the conversation.
- Preserve the center scroll position when changing or opening the workbench dock.
- Keep the three-column structure at the 1024px minimum shell; the right workbench may still be collapsed manually.
- A long-running action must expose state, next action, and cancellation.
- Empty states explain the next concrete action without product marketing copy.
- A new conversation should feel like an invitation to begin, not an empty error state; keep the first screen to one Agent focus and one command surface.
- Fully hidden navigation restores from the titlebar instead of leaving a miniature permanent sidebar.
- Respect `prefers-reduced-motion`; normal motion uses 150-240ms transitions.
- Every icon-only command has an accessible label and tooltip.

## 8. Plugin UI contribution model

The host owns navigation, layout, permissions, loading states, and lifecycle. Plugins contribute bounded content through three contracts:

| Contribution | Placement | Visibility rule |
| --- | --- | --- |
| `workspace.page` | Center titlebar and primary surface | Enabled and explicitly opened or user-pinned |
| `workbench.panel` | Right workbench body | Opened by the current task, command, or user action |
| `settings.section` | Unified Settings page | Plugin is loaded, enabled, and declares configuration UI |

This follows the useful boundary demonstrated by DeepSeek Harness UI slots: the shell declares composition points, while feature and external plugins contribute pages or settings surfaces without taking over the host layout.

Rules:

- installing or enabling a plugin never automatically creates a permanent sidebar item;
- a plugin may declare several workbench panels but only the active panel renders;
- top page order is user-controlled and persisted independently from plugin load order;
- disabling a plugin removes its page and panel contributions and falls back to Conversation;
- external plugin UI remains sandboxed and communicates through the plugin protocol, not direct renderer imports;
- a future Cordis adapter maps Cordis services and extensions onto these host-owned contracts rather than redefining desktop navigation.

## 9. Backend isolation

Renderer components consume a `DesktopDataSource`-style interface. The prototype uses local mock data only. Future adapters may use HTTP/SSE/WS, Electron IPC, or another runtime without changing visual components.

The Electron preload exposes only window-shell operations. Runtime credentials, filesystem access, and Agent APIs must not be exposed directly to the renderer.

### Backend-visible information

The desktop adapter must preserve these existing backend concepts even when the first renderer uses fixtures:

| Backend concept | Primary desktop placement |
| --- | --- |
| `message.*` and normal assistant text | Continuous conversation message |
| `thinking.delta` | Collapsible thinking event |
| `tool.started/delta/completed` | Tool event with per-call state and duration |
| `plan.updated` | Compact plan progress event; detailed plan may open in the workbench |
| attachments and changed files | File event plus right-side preview or diff |
| sandbox denial and workspace confirmation | Inline approval/denial event with explicit scope |
| session status, model, thinking level, tool mode, cwd | Header, composer context, and session settings |
| token usage and context usage | Session status/details and diagnostics settings |
| memory recall and memory Agent phases | Memory events and Knowledge workspace page |
| Subagent thread, run, tool activity, artifacts, result | Subagent event summary plus inspectable transcript/artifacts |
| observability health, logs, activity, audit | Runtime and diagnostics settings/workbench surfaces |

The renderer may derive presentation summaries from these contracts, but it must not flatten all event kinds into generic chat messages.

## 10. Acceptance viewports

- primary: 1440x900;
- compact desktop: 1280x800;
- wide desktop: 1728x1117;
- minimum supported shell: 1024x720.

No incoherent overlap, horizontal page overflow, clipped controls, or text occlusion is acceptable at these sizes.

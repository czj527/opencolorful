(() => {
  "use strict"

  const model = window.__OPENCOLORFUL_ARCHITECTURE__
  if (!model || !model.locale) {
    document.body.innerHTML = "<p>架构数据不完整，请先运行 npm run architecture:map。</p>"
    return
  }

  const copy = model.locale
  const state = {
    view: "atlas",
    selectedNode: "session-runtime",
    atlasFocus: null,
    selectedCard: "quality-blockers",
    boardFilter: "all",
    activeLayers: new Set(model.layers.map((layer) => layer.id)),
    search: "",
    theme: localStorage.getItem("oc-architecture-theme") || "dark",
  }

  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => [...document.querySelectorAll(selector)]
  const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]))
  const link = (filePath, label = filePath) => `<a class="file-link" href="../../${filePath}" title="${esc(filePath)}">${esc(label)}</a>`
  const nodeById = (id) => model.nodes.find((node) => node.id === id)
  const layerById = (id) => model.layers.find((layer) => layer.id === id)
  const nodeCopy = (node) => copy.nodes[node.id] || node
  const layerCopy = (layer) => copy.layers[layer.id] || layer
  const flowCopy = (flow) => copy.flows[flow.id] || flow
  const tone = (node) => layerById(node.layer)?.tone || "cyan"
  const statusLabel = (status) => copy.status[status] || status
  const matches = (value) => state.search === "" || String(value).toLowerCase().includes(state.search)
  const localizedNodeSearch = (node) => {
    const translated = nodeCopy(node)
    return [
      node.id,
      node.label,
      node.purpose,
      ...(node.owns || []),
      ...(node.invariants || []),
      translated.label,
      translated.purpose,
      ...(translated.owns || []),
      ...(translated.invariants || []),
    ].join(" ")
  }
  const localizedFlowSearch = (flow) => {
    const translated = flowCopy(flow)
    return [
      flow.id,
      flow.label,
      flow.summary,
      translated.label,
      translated.summary,
      ...(translated.steps || []).flatMap((step) => [step.label, step.detail]),
    ].join(" ")
  }
  const textWithBreaks = (value) => esc(value).replace(/\n/g, "<br>")
  const format = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "")

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme
    const themeToggle = $("#theme-toggle")
    themeToggle.textContent = state.theme === "dark" ? "☼" : "◐"
    themeToggle.title = state.theme === "dark" ? copy.meta.themeLight : copy.meta.themeDark
    themeToggle.setAttribute("aria-label", themeToggle.title)
  }

  function renderStaticCopy() {
    document.title = copy.meta.title
    $("#hero-eyebrow").textContent = copy.meta.eyebrow
    $("#hero-title").innerHTML = textWithBreaks(copy.meta.heroTitle)
    $("#hero-copy").textContent = copy.meta.heroCopy
    $("#global-search").placeholder = copy.meta.searchPlaceholder
    $("#layers-label").textContent = copy.meta.atlas.layers
    $("#clear-filters").textContent = copy.meta.atlas.clear
    $("#coverage-label").textContent = copy.meta.atlas.coverage
    $("#coverage-copy").textContent = copy.meta.atlas.coverageCopy
    $("#map-eyebrow").textContent = copy.meta.atlas.mapEyebrow
    $("#map-title").textContent = copy.meta.atlas.mapTitle
    $("#map-hint").textContent = copy.meta.atlas.mapHint
    $("#edge-layer").setAttribute("aria-label", copy.meta.atlas.canvasLabel)
    $("#guide-eyebrow").textContent = copy.meta.guide.eyebrow
    $("#guide-title").textContent = copy.meta.guide.title
    $("#guide-intro").textContent = copy.meta.guide.intro
    $("#principles-title").textContent = copy.meta.guide.principlesTitle
    $("#path-title").textContent = copy.meta.guide.pathTitle
    $("#question-title").textContent = copy.meta.guide.questionTitle
    $("#flows-eyebrow").textContent = copy.meta.flows.eyebrow
    $("#flows-title").textContent = copy.meta.flows.title
    $("#flows-intro").textContent = copy.meta.flows.intro
    $("#modules-eyebrow").textContent = copy.meta.modules.eyebrow
    $("#modules-title").textContent = copy.meta.modules.title
    $("#modules-intro").textContent = copy.meta.modules.intro
    $("#module-choose").textContent = copy.meta.modules.choose
    $("#module-choose-hint").textContent = copy.meta.modules.chooseHint
    $("#board-eyebrow").textContent = copy.meta.projectBoard.eyebrow
    $("#board-title").textContent = copy.meta.projectBoard.title
    $("#board-intro").textContent = copy.meta.projectBoard.intro
    $("#board-signals-title").textContent = copy.meta.projectBoard.signals
    $("#board-focus-title").textContent = copy.meta.projectBoard.focus
    $("#board-columns-title").textContent = copy.meta.projectBoard.columns
    $("#board-source-truth").textContent = copy.meta.projectBoard.sourceTruth
    $("#boundaries-eyebrow").textContent = copy.meta.boundaries.eyebrow
    $("#boundaries-title").textContent = copy.meta.boundaries.title
    $("#boundaries-intro").textContent = copy.meta.boundaries.intro
    $("#gaps-eyebrow").textContent = copy.meta.boundaries.gapsEyebrow
    $("#gaps-title").textContent = copy.meta.boundaries.gapsTitle
    $("#sources-eyebrow").textContent = copy.meta.sources.eyebrow
    $("#sources-title").textContent = copy.meta.sources.title
    $("#sources-intro").textContent = copy.meta.sources.intro
    $("#footer-cooperation").textContent = copy.meta.footer.cooperation
    $("#footer-architecture").textContent = copy.meta.footer.architecture
    $("#footer-maintenance").textContent = copy.meta.footer.maintenance
    $$(".view-tab").forEach((tab) => {
      tab.textContent = copy.meta.views[tab.dataset.view] || tab.dataset.view
    })
  }

  function renderHeader() {
    const stats = model.generated
    $("#generated-meta").textContent = format(copy.meta.generatedMeta, {
      nodes: stats.nodeCount,
      files: stats.sourceFileCount.toLocaleString(),
    })
    $("#status-card").innerHTML = `
      <div class="status-label">
        <span class="status-dot" aria-hidden="true"></span>
        <strong>${esc(copy.meta.statusLabel)}</strong>
        <a class="status-link" href="../../${model.status.source}">${esc(copy.meta.statusSource)} ↗</a>
      </div>
      <p>${esc(copy.meta.statusSummary)}</p>
    `
    $("#coverage-count").textContent = `${stats.mappedFileCount}/${stats.sourceFileCount}`
    $("#gap-mini").innerHTML = `
      <strong>${format(copy.meta.atlas.gaps, { count: model.knownGaps.length })}</strong>
      <span>${esc(copy.meta.atlas.gapsCopy)}</span>
    `
  }

  function renderLayerFilters() {
    $("#layer-filters").innerHTML = model.layers.map((layer) => {
      const translated = layerCopy(layer)
      const count = model.nodes.filter((node) => node.layer === layer.id).length
      const active = state.activeLayers.has(layer.id)
      return `
        <button class="layer-filter ${active ? "is-active" : ""}" data-layer="${layer.id}" type="button" title="${esc(translated.description)}">
          <span class="layer-dot tone-${layer.tone}"></span>
          <span>${esc(translated.label)}</span>
          <small>${count}</small>
        </button>
      `
    }).join("")
  }

  function edgePath(from, to) {
    const fromCenter = { x: from.layout.x + from.layout.w / 2, y: from.layout.y + from.layout.h / 2 }
    const toCenter = { x: to.layout.x + to.layout.w / 2, y: to.layout.y + to.layout.h / 2 }
    const horizontal = Math.abs(toCenter.x - fromCenter.x) > Math.abs(toCenter.y - fromCenter.y)
    if (horizontal) {
      const startX = toCenter.x > fromCenter.x ? from.layout.x + from.layout.w : from.layout.x
      const endX = toCenter.x > fromCenter.x ? to.layout.x : to.layout.x + to.layout.w
      const bend = (startX + endX) / 2
      return {
        d: `M ${startX} ${fromCenter.y} C ${bend} ${fromCenter.y}, ${bend} ${toCenter.y}, ${endX} ${toCenter.y}`,
        labelX: bend,
        labelY: (fromCenter.y + toCenter.y) / 2 - 5,
      }
    }
    const startY = toCenter.y > fromCenter.y ? from.layout.y + from.layout.h : from.layout.y
    const endY = toCenter.y > fromCenter.y ? to.layout.y : to.layout.y + to.layout.h
    const bend = (startY + endY) / 2
    return {
      d: `M ${fromCenter.x} ${startY} C ${fromCenter.x} ${bend}, ${toCenter.x} ${bend}, ${toCenter.x} ${endY}`,
      labelX: (fromCenter.x + toCenter.x) / 2 + 5,
      labelY: bend,
    }
  }

  function renderMap() {
    const visibleNodes = model.nodes.filter((node) => (
      state.activeLayers.has(node.layer) && matches(localizedNodeSearch(node))
    ))
    const visibleIds = new Set(visibleNodes.map((node) => node.id))
    const selected = state.atlasFocus
    const connectedIds = new Set()
    if (selected) {
      model.edges.forEach((edge) => {
        if (edge.from === selected || edge.to === selected) {
          connectedIds.add(edge.from)
          connectedIds.add(edge.to)
        }
      })
    }

    $("#node-layer").innerHTML = model.nodes.map((node) => {
      const translated = nodeCopy(node)
      const visible = visibleIds.has(node.id)
      const classes = [
        "map-node",
        `tone-${tone(node)}`,
        node.id === selected ? "is-selected" : "",
        selected && !connectedIds.has(node.id) ? "is-muted" : "",
        selected && connectedIds.has(node.id) ? "is-connected" : "",
      ].filter(Boolean).join(" ")
      return `
        <button class="${classes}" data-node="${node.id}" type="button"
          style="left:${node.layout.x}px;top:${node.layout.y}px;width:${node.layout.w}px;height:${node.layout.h}px;${visible ? "" : "display:none"}">
          <span class="node-kicker"><span>${esc(layerCopy(layerById(node.layer)).label)}</span><span>${esc(statusLabel(node.status))}</span></span>
          <span class="node-title">${esc(translated.label)}</span>
          <span class="node-purpose">${esc(translated.purpose)}</span>
          <span class="node-stats"><span>${node.fileCount} 个文件</span><span>${node.totalLines.toLocaleString()} 行</span></span>
        </button>
      `
    }).join("")

    $("#edge-layer").innerHTML = `
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
        </marker>
      </defs>
      ${model.edges.map((edge) => {
        const from = nodeById(edge.from)
        const to = nodeById(edge.to)
        if (!from || !to || !visibleIds.has(from.id) || !visibleIds.has(to.id)) return ""
        const path = edgePath(from, to)
        const active = selected && (edge.from === selected || edge.to === selected)
        const label = copy.edges[`${edge.from}->${edge.to}`] || edge.label
        return `
          <path class="edge-line ${selected && !active ? "is-muted" : ""} ${active ? "is-highlight" : ""}" d="${path.d}" data-edge="${edge.from}->${edge.to}">
            <title>${esc(label)} · ${edge.observedImports || 0} 个 import 证据</title>
          </path>
          <text class="edge-label" x="${path.labelX}" y="${path.labelY}">${esc(label)}</text>
        `
      }).join("")}
    `
    $("#atlas-footnote").innerHTML = `
      <span class="tone-cyan">${esc(copy.meta.atlas.legendSemantic)}</span>
      <span class="tone-violet">${esc(copy.meta.atlas.legendEvidence)}</span>
      <span class="tone-amber">${esc(copy.meta.atlas.legendStatus)}</span>
      <strong>${format(copy.meta.atlas.visibleModules, { count: visibleNodes.length })}</strong>
    `
  }

  function renderGuide() {
    $("#principle-list").innerHTML = copy.meta.guide.principles.map((item) => `
      <article class="principle-item">
        <span class="guide-number">${esc(item.number)}</span>
        <div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div>
      </article>
    `).join("")
    $("#reading-path").innerHTML = copy.meta.guide.path.map((item) => `
      <article class="path-item">
        <span class="guide-number">${esc(item.number)}</span>
        <div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div>
      </article>
    `).join("")
    $("#question-list").innerHTML = copy.meta.guide.questions.map((question) => `
      <li>${esc(question)}</li>
    `).join("")
  }

  function allBoardCards() {
    return model.projectBoard.columns.flatMap((column) => column.cards.map((card) => ({ ...card, columnId: column.id })))
  }

  function boardCardById(cardId) {
    return allBoardCards().find((card) => card.id === cardId)
  }

  function boardCardProgress(card) {
    const total = card.checklist?.length || 0
    const done = card.checklist?.filter((item) => item.done).length || 0
    return { total, done, ratio: total === 0 ? 0 : Math.round((done / total) * 100) }
  }

  function boardCardMatches(card) {
    const moduleNames = (card.modules || []).map((moduleId) => {
      const node = nodeById(moduleId)
      return node ? `${moduleId} ${node.label} ${nodeCopy(node).label} ${nodeCopy(node).shortLabel}` : moduleId
    })
    const query = [
      card.id,
      card.title,
      card.summary,
      card.detail,
      card.type,
      card.priority,
      card.state,
      ...(card.tags || []),
      ...moduleNames,
      ...(card.references || []).flatMap((reference) => [reference.label, reference.path]),
    ].join(" ")
    if (!matches(query)) return false
    if (state.boardFilter === "active") return !["已完成", "已归档"].includes(card.state)
    if (state.boardFilter === "blocked") return card.priority === "P0" || card.state === "阻塞"
    if (state.boardFilter === "done") return ["已完成", "已归档"].includes(card.state)
    if (state.boardFilter === "p1") return (card.tags || []).includes("P1") || card.priority === "P1"
    if (state.boardFilter === "governance") return (card.tags || []).some((tag) => ["G0", "G1", "G2", "CI", "Release"].includes(tag))
    return true
  }

  function renderBoardHeader() {
    const board = model.projectBoard
    const cardCount = allBoardCards().length
    const activeCount = allBoardCards().filter((card) => !["已完成", "已归档"].includes(card.state)).length
    const riskCount = allBoardCards().filter((card) => card.priority === "P0" || card.state === "阻塞").length
    $("#board-updated").textContent = format(copy.meta.projectBoard.updated, { date: board.updatedAt })
    $("#board-header").innerHTML = `
      <div class="board-health">
        <div class="board-health-top">
          <span class="health-pulse"></span>
          <strong>${esc(board.health.label)}</strong>
          <a class="file-link" href="../../${board.health.source}">查看质量评估 ↗</a>
        </div>
        <p>${esc(board.health.summary)}</p>
      </div>
      <div class="board-baseline">
        <span class="eyebrow">${esc(copy.meta.projectBoard.baseline)}</span>
        <strong>${esc(board.baseline.branch)} <code>${esc(board.baseline.commit)}</code></strong>
        <small>${esc(board.baseline.label)}</small>
      </div>
      <div class="board-rollup">
        <div><strong>${cardCount}</strong><span>总事项</span></div>
        <div><strong>${activeCount}</strong><span>活动事项</span></div>
        <div><strong>${riskCount}</strong><span>高风险</span></div>
      </div>
    `
  }

  function renderBoardSignals() {
    $("#board-signals").innerHTML = model.projectBoard.signals.map((signal) => `
      <article class="signal-card">
        <span class="eyebrow">${esc(signal.label)}</span>
        <strong>${esc(signal.value)}</strong>
        <p>${esc(signal.detail)}</p>
        ${link(signal.source, "查看依据 ↗")}
      </article>
    `).join("")
  }

  function renderBoardFocus() {
    $("#board-focus").innerHTML = model.projectBoard.focus.map((focus) => {
      const card = boardCardById(focus.cardId)
      if (!card) return ""
      return `
        <button class="focus-item ${state.selectedCard === card.id ? "is-active" : ""}" data-card="${card.id}" type="button">
          <span class="guide-number">${esc(focus.number)}</span>
          <span><strong>${esc(focus.title)}</strong><small>${esc(focus.detail)}</small></span>
          <em>${esc(card.priority)}</em>
        </button>
      `
    }).join("")
  }

  function renderBoardFilters() {
    const filters = [
      ["all", copy.meta.projectBoard.all],
      ["active", copy.meta.projectBoard.filterActive],
      ["blocked", copy.meta.projectBoard.filterBlocked],
      ["done", copy.meta.projectBoard.filterDone],
      ["p1", copy.meta.projectBoard.filterP1],
      ["governance", copy.meta.projectBoard.filterG],
    ]
    $("#board-filters").innerHTML = filters.map(([id, label]) => `
      <button class="board-filter ${state.boardFilter === id ? "is-active" : ""}" data-board-filter="${id}" type="button">${esc(label)}</button>
    `).join("")
  }

  function renderBoardCard(card) {
    const progress = boardCardProgress(card)
    return `
      <article class="board-card ${state.selectedCard === card.id ? "is-selected" : ""}" data-card="${card.id}">
        <div class="board-card-meta">
          <span class="card-type">${esc(card.type)}</span>
          <span class="card-priority">${esc(card.priority)}</span>
        </div>
        <h4>${esc(card.title)}</h4>
        <p>${esc(card.summary)}</p>
        <div class="board-card-progress">
          <span><i style="width:${progress.ratio}%"></i></span>
          <small>${format(copy.meta.projectBoard.progress, { done: progress.done, total: progress.total })}</small>
        </div>
        <div class="board-tags">${(card.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join("")}</div>
        <button class="card-open" data-card="${card.id}" type="button">查看事项 ↗</button>
      </article>
    `
  }

  function renderBoardInspector(card) {
    if (!card) return `<div class="board-inspector-empty">${esc(copy.meta.projectBoard.empty)}</div>`
    const progress = boardCardProgress(card)
    return `
      <aside class="board-inspector">
        <div class="inspector-topline">
          <span class="card-type">${esc(card.type)}</span>
          <span class="card-priority">${esc(card.priority)}</span>
        </div>
        <h3>${esc(card.title)}</h3>
        <div class="inspector-state"><span>${esc(copy.meta.projectBoard.state)}</span><strong>${esc(card.state)}</strong></div>
        <p class="inspector-summary">${esc(card.detail)}</p>
        <section class="inspector-section">
          <div class="inspector-section-heading">
            <h4>${esc(copy.meta.projectBoard.checklist)}</h4>
            <span>${format(copy.meta.projectBoard.progress, { done: progress.done, total: progress.total })}</span>
          </div>
          <ul class="board-checklist">
            ${(card.checklist || []).map((item) => `
              <li class="${item.done ? "is-done" : ""}"><span>${item.done ? "✓" : "○"}</span>${esc(item.label)}</li>
            `).join("")}
          </ul>
        </section>
        <section class="inspector-section">
          <h4>${esc(copy.meta.projectBoard.modules)}</h4>
          <div class="board-module-links">
            ${(card.modules || []).map((moduleId) => {
              const node = nodeById(moduleId)
              return node ? `<button data-node="${node.id}" type="button">${esc(nodeCopy(node).shortLabel)} ↗</button>` : ""
            }).join("")}
          </div>
        </section>
        <section class="inspector-section">
          <h4>${esc(copy.meta.projectBoard.source)}</h4>
          ${link(card.source, card.source)}
          <h4 class="inspector-subtitle">${esc(copy.meta.projectBoard.references)}</h4>
          <div class="inspector-references">
            ${(card.references || []).map((reference) => link(reference.path, reference.label)).join("")}
          </div>
        </section>
      </aside>
    `
  }

  function renderBoardColumns() {
    const visibleCardIds = model.projectBoard.columns
      .flatMap((column) => column.cards.filter(boardCardMatches).map((card) => card.id))
    if (state.selectedCard && !visibleCardIds.includes(state.selectedCard)) {
      state.selectedCard = visibleCardIds[0] || null
    }
    const selectedCard = boardCardById(state.selectedCard)
    const columns = model.projectBoard.columns.map((column) => {
      const visibleCards = column.cards.filter(boardCardMatches)
      return `
        <section class="board-column">
          <header class="board-column-header">
            <div><span class="column-marker tone-${column.tone}"></span><h4>${esc(column.label)}</h4></div>
            <span>${format(copy.meta.projectBoard.cards, { count: visibleCards.length })}</span>
          </header>
          <p class="board-column-description">${esc(column.description)}</p>
          <div class="board-card-list">${visibleCards.map(renderBoardCard).join("") || `<p class="empty-column">${esc(copy.meta.projectBoard.empty)}</p>`}</div>
        </section>
      `
    }).join("")
    $("#board-columns").innerHTML = `
      <div class="board-columns-grid">${columns}</div>
      ${renderBoardInspector(selectedCard)}
    `
  }

  function renderProjectBoard() {
    renderBoardHeader()
    renderBoardSignals()
    renderBoardFocus()
    renderBoardFilters()
    renderBoardColumns()
  }

  function renderFlows() {
    const flows = model.flows.filter((flow) => matches(localizedFlowSearch(flow)))
    $("#flow-list").innerHTML = flows.map((flow) => {
      const translated = flowCopy(flow)
      return `
        <article class="flow-card">
          <div class="flow-card-header">
            <div>
              <span class="eyebrow">流程 / ${esc(flow.id)}</span>
              <h2>${esc(translated.label)}</h2>
              <p>${esc(translated.summary)}</p>
            </div>
            <span class="flow-id">${format(copy.meta.flows.steps, { count: flow.steps.length })}</span>
          </div>
          <div class="flow-steps">
            ${flow.steps.map((step, index) => {
              const translatedStep = translated.steps[index] || step
              return `
                <div class="flow-step">
                  <button class="step-index" data-node="${step.node}" data-flow="${flow.id}" type="button" title="打开 ${esc(nodeCopy(nodeById(step.node)).label)}">${String(index + 1).padStart(2, "0")}</button>
                  <h3>${esc(translatedStep.label)}</h3>
                  <p>${esc(translatedStep.detail)}</p>
                  ${(step.files || []).map((file) => link(file)).join("")}
                </div>
              `
            }).join("")}
          </div>
        </article>
      `
    }).join("") || `<p class="empty-state">${esc(copy.meta.sources.empty)}</p>`
  }

  function renderModuleList() {
    const visibleNodes = model.nodes.filter((node) => matches(localizedNodeSearch(node)))
    $("#module-count").textContent = `${visibleNodes.length}/${model.nodes.length}`
    $("#module-list").innerHTML = model.layers.map((layer) => {
      const nodes = visibleNodes.filter((node) => node.layer === layer.id)
      if (nodes.length === 0) return ""
      const translatedLayer = layerCopy(layer)
      return `
        <section class="module-group">
          <div class="module-group-title"><span class="layer-dot tone-${layer.tone}"></span>${esc(translatedLayer.label)}</div>
          ${nodes.map((node) => {
            const translated = nodeCopy(node)
            return `
              <button class="module-list-item ${node.id === state.selectedNode ? "is-active" : ""}" data-node="${node.id}" type="button">
                <span><strong>${esc(translated.shortLabel)}</strong><small>${esc(statusLabel(node.status))}</small></span>
                <em>${node.fileCount} 个文件</em>
              </button>
            `
          }).join("")}
        </section>
      `
    }).join("") || `<p class="empty-state">${esc(copy.meta.modules.noFiles)}</p>`
  }

  function renderModuleBoard() {
    const node = nodeById(state.selectedNode) || model.nodes[0]
    if (!node) return
    state.selectedNode = node.id
    const translated = nodeCopy(node)
    const layer = layerById(node.layer)
    const translatedLayer = layerCopy(layer)
    const connections = model.edges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => {
        const outgoing = edge.from === node.id
        const other = nodeById(outgoing ? edge.to : edge.from)
        return {
          outgoing,
          other,
          label: copy.edges[`${edge.from}->${edge.to}`] || edge.label,
          observed: edge.observedImports || 0,
        }
      })
    const evidence = model.observedEdges.filter((edge) => edge.from === node.id || edge.to === node.id)

    $("#module-board").innerHTML = `
      <div class="module-board-header">
        <div>
          <div class="module-kicker"><span class="tone-${tone(node)}">${esc(translatedLayer.label)}</span><span>${esc(statusLabel(node.status))}</span></div>
          <h2>${esc(translated.label)}</h2>
          <p class="module-purpose">${esc(translated.purpose)}</p>
        </div>
        <button class="board-action" data-board-atlas type="button">在总览中定位 <span aria-hidden="true">↗</span></button>
      </div>
      <div class="module-stats">
        <div><strong>${node.fileCount}</strong><span>生产文件</span></div>
        <div><strong>${node.totalLines.toLocaleString()}</strong><span>代码行</span></div>
        <div><strong>${connections.length}</strong><span>登记连接</span></div>
        <div><strong>${evidence.length}</strong><span>扫描证据</span></div>
      </div>
      <div class="module-sections">
        <section class="module-section">
          <div class="module-section-title"><span class="section-mark">01</span><h3>${esc(copy.meta.modules.owns)}</h3></div>
          <ul class="plain-list">${translated.owns.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
        </section>
        <section class="module-section boundary-section">
          <div class="module-section-title"><span class="section-mark">02</span><h3>${esc(copy.meta.modules.invariants)}</h3></div>
          <ul class="plain-list">${translated.invariants.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
        </section>
        <section class="module-section">
          <div class="module-section-title"><span class="section-mark">03</span><h3>${esc(copy.meta.modules.connections)}</h3></div>
          <div class="connection-list">
            ${connections.map((connection) => connection.other ? `
              <button class="connection-item" data-node="${connection.other.id}" type="button">
                <span class="connection-direction">${connection.outgoing ? "输出" : "输入"}</span>
                <strong>${esc(nodeCopy(connection.other).shortLabel)}</strong>
                <span>${esc(connection.label)}</span>
                <small>${connection.observed} 个 import 证据 · 查看模块 ↗</small>
              </button>
            ` : "").join("") || `<p class="empty-state">${esc(copy.meta.modules.noConnections)}</p>`}
          </div>
        </section>
        <section class="module-section">
          <div class="module-section-title"><span class="section-mark">04</span><h3>${esc(copy.meta.modules.implementation)}</h3></div>
          <div class="implementation-list">
            ${node.keyFiles.map((file) => `
              <div class="implementation-item">
                <span class="implementation-role">关键实现</span>
                ${link(file.path, file.path)}
              </div>
            `).join("")}
          </div>
        </section>
        <section class="module-section coverage-section">
          <div class="module-section-title">
            <span class="section-mark">05</span>
            <h3>${esc(copy.meta.modules.coverage)}</h3>
            <span class="section-count">${node.fileCount} 个文件 · ${node.totalLines.toLocaleString()} 行</span>
          </div>
          <div class="coverage-files">
            ${node.files.slice(0, 28).map((file) => `<div>${link(file.path)}<small>${file.lines} 行</small></div>`).join("")}
          </div>
          ${node.files.length > 28 ? `<p class="coverage-more">还有 ${node.files.length - 28} 个文件，请在源文件索引中继续搜索。</p>` : ""}
        </section>
        <section class="module-section">
          <div class="module-section-title"><span class="section-mark">06</span><h3>${esc(copy.meta.modules.documents)}</h3></div>
          <div class="implementation-list">
            ${node.docs.map((doc) => `
              <div class="implementation-item">
                <span class="implementation-role">相关文档</span>
                ${link(doc.path, doc.path)}
              </div>
            `).join("")}
          </div>
        </section>
      </div>
    `
  }

  function renderBoundaries() {
    const rules = model.rules.filter((rule, index) => {
      const translated = copy.rules[index] || rule
      return matches(`${rule.label} ${rule.detail} ${translated.label} ${translated.detail}`)
    })
    $("#boundary-list").innerHTML = rules.map((rule) => {
      const index = model.rules.indexOf(rule)
      const translated = copy.rules[index] || rule
      return `
        <article class="boundary-card">
          <span class="eyebrow">规则 / ${String(index + 1).padStart(2, "0")}</span>
          <h3>${esc(translated.label)}</h3>
          <p>${esc(translated.detail)}</p>
        </article>
      `
    }).join("") || `<p class="empty-state">${esc(copy.meta.sources.empty)}</p>`
    $("#known-gap-list").innerHTML = model.knownGaps.map((gap, index) => {
      const translated = copy.knownGaps[index] || gap
      return `
        <article class="known-gap">
          <span class="severity">${esc(translated.severity)}</span>
          <div><h3>${esc(translated.title)}</h3><p>${esc(translated.detail)}</p></div>
          ${link(gap.path, copy.meta.boundaries.source + " ↗")}
        </article>
      `
    }).join("")
  }

  function renderSources() {
    const groups = model.nodes.map((node) => ({
      node,
      files: node.files.filter((file) => matches(`${file.path} ${localizedNodeSearch(node)}`)),
    })).filter((group) => group.files.length > 0)
    const total = groups.reduce((sum, group) => sum + group.files.length, 0)
    $("#source-count").textContent = format(copy.meta.sources.matching, { count: total })
    $("#source-list").innerHTML = groups.map(({ node, files }) => {
      const translated = nodeCopy(node)
      return `
        <details class="source-group">
          <summary><strong>${esc(translated.shortLabel)}</strong><span>${format(copy.meta.sources.files, {
            matched: files.length,
            total: node.fileCount,
            lines: node.totalLines.toLocaleString(),
          })}</span></summary>
          <div class="source-files">
            ${files.map((file) => `<div class="source-file">${link(file.path)}<small>${format(copy.meta.sources.lines, { count: file.lines })}</small></div>`).join("")}
          </div>
        </details>
      `
    }).join("") || `<p class="empty-state">${esc(copy.meta.sources.empty)}</p>`
  }

  function setView(view) {
    state.view = view
    $$(".view-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view))
    $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-hidden", panel.dataset.viewPanel !== view))
    if (view === "atlas") renderMap()
    if (view === "guide") renderGuide()
    if (view === "flows") renderFlows()
    if (view === "modules") {
      renderModuleList()
      renderModuleBoard()
    }
    if (view === "board") renderProjectBoard()
    if (view === "boundaries") renderBoundaries()
    if (view === "sources") renderSources()
  }

  function openNode(nodeId) {
    if (!nodeById(nodeId)) return
    state.selectedNode = nodeId
    state.atlasFocus = null
    setView("modules")
  }

  $("#theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark"
    localStorage.setItem("oc-architecture-theme", state.theme)
    applyTheme()
  })
  $$(".view-tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)))
  $("#global-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase()
    renderMap()
    renderFlows()
    renderModuleList()
    renderModuleBoard()
    renderProjectBoard()
    renderBoundaries()
    renderSources()
  })
  $("#clear-filters").addEventListener("click", () => {
    state.activeLayers = new Set(model.layers.map((layer) => layer.id))
    renderLayerFilters()
    renderMap()
  })
  $("#layer-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-layer]")
    if (!button) return
    const layer = button.dataset.layer
    if (state.activeLayers.has(layer)) {
      if (state.activeLayers.size === 1) return
      state.activeLayers.delete(layer)
    } else {
      state.activeLayers.add(layer)
    }
    renderLayerFilters()
    renderMap()
  })
  $("#node-layer").addEventListener("click", (event) => {
    const button = event.target.closest("[data-node]")
    if (button) openNode(button.dataset.node)
  })
  $("#flow-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-node]")
    if (button) openNode(button.dataset.node)
  })
  $("#module-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-node]")
    if (!button) return
    state.selectedNode = button.dataset.node
    renderModuleList()
    renderModuleBoard()
  })
  $("#module-board").addEventListener("click", (event) => {
    const nodeButton = event.target.closest("[data-node]")
    if (nodeButton) {
      state.selectedNode = nodeButton.dataset.node
      renderModuleList()
      renderModuleBoard()
      return
    }
    if (event.target.closest("[data-board-atlas]")) {
      state.atlasFocus = state.selectedNode
      setView("atlas")
    }
  })
  $("#board-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-board-filter]")
    if (!button) return
    state.boardFilter = button.dataset.boardFilter
    renderBoardFilters()
    renderBoardColumns()
  })
  $("#board-focus").addEventListener("click", (event) => {
    const button = event.target.closest("[data-card]")
    if (!button) return
    state.selectedCard = button.dataset.card
    renderBoardFocus()
    renderBoardColumns()
  })
  $("#board-columns").addEventListener("click", (event) => {
    const nodeButton = event.target.closest("[data-node]")
    if (nodeButton) {
      state.selectedNode = nodeButton.dataset.node
      setView("modules")
      return
    }
    const card = event.target.closest("[data-card]")
    if (!card) return
    state.selectedCard = card.dataset.card
    renderBoardFocus()
    renderBoardColumns()
  })

  applyTheme()
  renderStaticCopy()
  renderHeader()
  renderLayerFilters()
  renderMap()
  renderGuide()
  renderFlows()
  renderModuleList()
  renderModuleBoard()
  renderProjectBoard()
  renderBoundaries()
  renderSources()
})()

/*
 * The icon rail: a vertical strip of one icon per right-sidebar tab, fixed below the
 * host expand button and, while the right sidebar is open, just left of its column; a
 * click opens that tab.
 *
 * Adapted from dsh-rightbar-quicknav 0.3.9, Copyright (c) 2026 zuoyunlai,
 * MIT License, see THIRD_PARTY_NOTICES.md.
 *
 * Changed for dsh-claude-sidebar: the slot id, locale namespace, console tag, class
 * names and tooltip id prefix are ours; comments and messages are English;
 * findToggleEl's aria-label fallback and the unreachable cube icon are removed; the window
 * resize listener is now removed on cleanup; the rail no longer hides while the right
 * sidebar is open: it stays beside the open column and follows that column's width.
 *
 * This file is one part of client.js, concatenated inside the module factory by
 * scripts/build-client.mjs.
 */

    /* React and h come from shared.js; the rail takes the other hooks it needs. */
    const { useLayoutEffect, useRef, useCallback, useMemo } = React
    /* ================= constants ================= */

    const TAG = '[dsh-claude-sidebar rail]'

    /** One icon button's side / the rail's padding / the icon itself. */
    const ITEM = 26
    const RAIL_PAD = 4
    const ICON = 16
    /** The rail's total width (horizontal padding + icon cell + border). */
    const RAIL_W = ITEM + RAIL_PAD * 2 + 2
    /** Gap from the rail to the viewport's right edge / from the expand button's bottom to the rail's top. */
    const RIGHT_GAP = 10
    const TOP_GAP = 50
    /** How many items show while collapsed; hover expands the rest downwards. */
    const COLLAPSED_COUNT = 3
    /** Tooltip DOM id prefix, unique per instance: shell.overlay is a list slot. */
    const TIP_ID_PREFIX = 'dsh-cs-rail-tip-'
    /** Locale namespace, registered when the host locale service is available. */
    const NS = 'claudeSidebarRail'
    /** The host's stable expand-button attribute; locating by it avoids text and class names. */
    const TOGGLE_ATTR = 'data-sidebar-right-expand'
    /** The open panel's root; present only while the sidebar is expanded. */
    const PANEL_OPEN_ATTR = 'data-sidebar-right-open'
    /** The open panel's placement mode: 'push' for the normal column, 'fullscreen' for the overlay. */
    const PANEL_MODE_ATTR = 'data-sidebar-right-panel'
    /** Set on the panel while its opening transition runs; removed when the transition ends. */
    const PANEL_OPENING_ATTR = 'data-sidebar-right-opening'
    /** The right column's container; it stays in the DOM while the sidebar is closed. */
    const COLUMN_ATTR = 'data-rightbar-col'
    /** Gap from the open column's left edge to the rail. */
    const OPEN_GAP = 6
    /** Fallback top, relative to the open panel, when no button and no previous button top is known. */
    const OPEN_TOP = 100
    /** Collapse delay in milliseconds. */
    const CLOSE_DELAY = 200
    /** Fallback top position when the host's expand button is not found. */
    const DEFAULT_TOP = 64

    /* ================= dictionary (zh/en built in; the locale service wins when present) ================= */

    const DICT = {
      zh: {
        'rail.ariaLabel': '右侧栏快捷导航',
        'rail.anchorLabel': '快捷导航锚点',
        'rail.empty': '右侧栏还没有可直达的标签页',
        'rail.noService': '当前宿主没有右侧栏服务，无法直达',
        'rail.openFailed': '打开失败：该标签当前不可用',
      },
      en: {
        'rail.ariaLabel': 'Right sidebar quick nav',
        'rail.anchorLabel': 'Quick nav anchor',
        'rail.empty': 'No right-sidebar tabs to jump to',
        'rail.noService': 'This host has no right-sidebar service',
        'rail.openFailed': 'Could not open that tab',
      },
    }

    /**
     * Detect the system language when the locale service is unavailable.
     * Only clear Chinese gets Chinese; everything else gets English,
     * because an unknown language is easier to read in English than in Chinese.
     */
    function navLang() {
      try {
        const l = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language).toLowerCase() : ''
        return l.indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (e) {
        return 'en'
      }
    }

    /**
     * The current UI language.
     * It starts from the system language (no ctx needed) and the locale service may override it;
     * only a host language starting with 'zh' is Chinese; en, en-US, and future ja or es get English.
     */
    let LANG = navLang()

    /** Rail instance counter: keeps DOM ids unique when several instances mount. */
    let instanceSeq = 0

    /** Read one dictionary entry. */
    function t(key) {
      const d = DICT[LANG] || DICT.zh
      return d[key] || DICT.en[key] || key
    }

    /* ================= helpers ================= */

    /* serviceOf comes from shared.js: one guarded service lookup for every feature. */

    /** Whether the system asks for reduced motion. */
    function prefersReduced() {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      } catch (e) {
        return false
      }
    }

    /** Find the host's "open right sidebar" button; reads attributes and identity, not geometry. */
    function findToggleEl() {
      // The host's stable attribute, independent of language and class names.
      try {
        const el = document.querySelector('[' + TOGGLE_ATTR + ']')
        if (el) return el
      } catch (e) {
        /* ignore */
      }
      return null
    }

    /** Every element carrying the open marker, in document order; a query, not a layout read. */
    function panelMarkerEls() {
      const found = []
      try {
        const list = document.querySelectorAll('[' + PANEL_OPEN_ATTR + ']')
        for (let i = 0; i < list.length; i++) {
          const el = list[i]
          if (el) found.push(el)
        }
      } catch (e) {
        /* ignore */
      }
      return found
    }

    /**
     * Find the open column among the markers: the first one with a non-empty rect, else the
     * right column container (still in the DOM while the sidebar is closed), else null.
     * Reads layout, so it belongs to the geometry path only, never to a DOM mutation.
     */
    function findPanelEl(markers) {
      const list = markers || panelMarkerEls()
      for (let i = 0; i < list.length; i++) {
        const el = list[i]
        if (el && el.getBoundingClientRect().width >= 8) return el
      }
      try {
        const col = document.querySelector('[' + COLUMN_ATTR + ']')
        if (col && col.getBoundingClientRect().width >= 8) return col
      } catch (e) {
        /* ignore */
      }
      return null
    }

    /**
     * The cheap signature of the open markers: their count plus each marker's mode and
     * opening flag, in document order. Attribute reads only, so a DOM mutation can build it
     * without touching layout.
     */
    function panelMarkersKey(markers) {
      const list = markers || panelMarkerEls()
      let key = String(list.length)
      for (let i = 0; i < list.length; i++) {
        const el = list[i]
        let mode = ''
        let opening = '0'
        try {
          mode = el.getAttribute(PANEL_MODE_ATTR) || ''
          opening = el.hasAttribute(PANEL_OPENING_ATTR) ? '1' : '0'
        } catch (e) {
          mode = ''
          opening = '0'
        }
        key += '|' + mode + ':' + opening
      }
      return key
    }

    /** The panel's mode; the column fallback and an unset attribute both read as push. */
    function panelModeOf(el) {
      try {
        return (el && el.getAttribute(PANEL_MODE_ATTR)) || 'push'
      } catch (e) {
        return 'push'
      }
    }

    /**
     * The two cheap sidebar states used by both placement paths: `seat` is false when no
     * session is on screen, `expanded` is whether the sidebar is open. A missing or throwing
     * service keeps the rail visible and closed, as before.
     */
    function readSidebarState(sidebarRight) {
      let seat = true
      try {
        const m = sidebarRight && sidebarRight.mounted
        if (m && typeof m.getSnapshot === 'function') seat = m.getSnapshot() !== undefined
      } catch (e) {
        seat = true
      }
      let expanded = false
      try {
        expanded = sidebarRight && typeof sidebarRight.isExpanded === 'function' ? !!sidebarRight.isExpanded() : false
      } catch (e) {
        expanded = false
      }
      return { seat, expanded }
    }

    /**
     * Decide the rail's display, left and top from measured inputs, with no DOM access.
     * Rules, in order: no session on screen hides it; a usable expand button anchors its top;
     * while the sidebar is expanded the rail sits just left of the open column and hides in
     * fullscreen; otherwise it keeps the viewport-edge placement it had before.
     * @param {{ seat: boolean, expanded: boolean, viewport: { width: number, height: number },
     *   button: { top: number, bottom: number, width: number, height: number } | null,
     *   panel: { left: number, top: number, mode: string } | null,
     *   lastTop: number | null }} input
     * @returns {{ display: false } | { display: true, left: number, top: number, usedButton: boolean }}
     */
    function railPlacement(input) {
      const viewport = input.viewport || {}
      const button = input.button || null
      const panel = input.panel || null
      if (!input.seat) return { display: false }
      // The same vertical gate as before: inside the top bar and not clipped by the viewport.
      const usable =
        !!button &&
        button.width >= 8 &&
        button.height >= 8 &&
        button.top <= 96 &&
        button.bottom <= (viewport.height || 0) - 40
      const closedLeft = Math.max(4, Math.round((viewport.width || 0) - RAIL_W - RIGHT_GAP))
      if (input.expanded && panel) {
        // Fullscreen covers the whole window; a rail beside it would float over the panel.
        if (panel.mode === 'fullscreen') return { display: false }
        let top
        let usedButton = false
        if (usable) {
          top = Math.round(button.bottom + TOP_GAP)
          usedButton = true
        } else if (input.lastTop !== null && input.lastTop !== undefined) {
          // The button was measurable before: keep the rail level while the panel is open.
          top = Math.round(input.lastTop)
        } else {
          top = Math.round(panel.top + OPEN_TOP)
        }
        return { display: true, left: Math.max(4, Math.round(panel.left - RAIL_W - OPEN_GAP)), top, usedButton }
      }
      if (usable) return { display: true, left: closedLeft, top: Math.round(button.bottom + TOP_GAP), usedButton: true }
      // A button that is present but unusable means the header is clipped: hide rather than guess.
      if (button) return { display: false }
      return { display: true, left: closedLeft, top: DEFAULT_TOP, usedButton: false }
    }

    /* ============ semantic default icons (used when an entry brings none) ============ */

    /**
     * Icon shape table: one 16x16 viewBox, stroke=currentColor, 1.25 stroke width,
     * the same visual language as host icons (vector, no dependency, follows text color).
     * rects: [x,y,w,h,rx] / circles: [cx,cy,r] / paths: [d,...]
     */
    const GLYPH = {
      image: { rects: [[1.6, 2.6, 12.8, 10.8, 2]], circles: [[5.2, 6.1, 1.05]], paths: ['M2.2 11.9l3.3-3 2.3 1.8 2.3-2.3 3.3 3.1'] },
      file: { paths: ['M4.2 2h4.6L12 5.2V14H4.2z', 'M8.6 2v3.3H12'] },
      folder: { paths: ['M2 4.6h4.1l1.5 1.9H14V13H2z'] },
      git: { circles: [[4.8, 3.6, 1.3], [4.8, 12.4, 1.3], [11.2, 6.2, 1.3]], paths: ['M4.8 4.9v6.2', 'M11.2 7.5v.9a2.4 2.4 0 0 1-2.4 2.4H6.1'] },
      terminal: { rects: [[1.6, 3, 12.8, 10, 2]], paths: ['M4.6 6.6l1.9 1.7-1.9 1.7', 'M8.6 10.4h3'] },
      tasks: { paths: ['M2.8 4.3l1.3 1.3 2-2.1', 'M2.8 11l1.3 1.3 2-2.1', 'M9 4.8h4.2', 'M9 11.5h4.2'] },
      globe: { circles: [[8, 8, 6.1]], paths: ['M1.9 8h12.2', 'M8 1.9c2.3 2.5 2.3 9.7 0 12.2', 'M8 1.9c-2.3 2.5-2.3 9.7 0 12.2'] },
      search: { circles: [[7, 7, 4.1]], paths: ['M10.1 10.1L14 14'] },
      chart: { paths: ['M2.4 13.2h11.2', 'M4.6 13V8.4', 'M8 13V4.6', 'M11.4 13V6.6'] },
      code: { paths: ['M5.6 5.2L2.6 8l3 2.8', 'M10.4 5.2l3 2.8-3 2.8', 'M9.2 3.2L6.8 12.8'] },
      chat: { paths: ['M2.6 3.6h10.8v7.1H7.3L3.9 13.6v-2.9H2.6z'] },
      doc: { paths: ['M3 3.2h10', 'M3 6.6h10', 'M3 10h6.6', 'M3 13.2h4'] },
      sparkle: { paths: ['M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z'] },
      plug: { paths: ['M6 2v3.6', 'M10 2v3.6', 'M4.2 5.6h7.6v2.9a3.8 3.8 0 0 1-7.6 0z', 'M8 12.3V14'] },
      sliders: { circles: [[6, 5.1, 1.5], [10.2, 10.9, 1.5]], paths: ['M2.2 5.1h2.3', 'M7.5 5.1h6.3', 'M2.2 10.9h6.5', 'M11.7 10.9h2.1'] },
      layers: { paths: ['M8 2.2l5.6 2.9L8 8 2.4 5.1z', 'M2.4 8.1L8 11l5.6-2.9'] },
      db: { paths: ['M2.6 4.3c0-.9 2.4-1.6 5.4-1.6s5.4.7 5.4 1.6', 'M2.6 4.3v7.4c0 .9 2.4 1.6 5.4 1.6s5.4-.7 5.4-1.6V4.3', 'M2.6 8c0 .9 2.4 1.6 5.4 1.6s5.4-.7 5.4-1.6'] },
      grid: { rects: [[2.6, 2.6, 4.6, 4.6, 1], [8.8, 2.6, 4.6, 4.6, 1], [2.6, 8.8, 4.6, 4.6, 1], [8.8, 8.8, 4.6, 4.6, 1]] },
      hexagon: { paths: ['M8 2l5.2 3v6L8 14l-5.2-3V5z'] },
      dot: { circles: [[8, 8, 5.4]] },
    }

    /** Render one semantic icon. */
    function GlyphIcon({ size, name }) {
      const spec = GLYPH[name] || GLYPH.dot
      const s = size || ICON
      const kids = []
      ;(spec.rects || []).forEach((r, i) =>
        kids.push(h('rect', { key: 'r' + i, x: r[0], y: r[1], width: r[2], height: r[3], rx: r[4] || 0 })),
      )
      ;(spec.circles || []).forEach((c, i) => kids.push(h('circle', { key: 'c' + i, cx: c[0], cy: c[1], r: c[2] })))
      ;(spec.paths || []).forEach((d, i) => kids.push(h('path', { key: 'p' + i, d })))
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        kids,
      )
    }

    /**
     * Keyword -> icon, matched against `kind` and the title, first match wins.
     * Order matters: more specific rules come first (gallery before studio).
     * The Chinese alternatives match titles of tabs whose plugins ship Chinese titles.
     */
    const ICON_RULES = [
      [/image|photo|picture|gallery|canvas|图像|图片|图库|画廊|画布|绘画|出图/, 'image'],
      [/git|diff|commit|branch|版本|变更|分支|提交/, 'git'],
      [/terminal|shell|console|终端|命令行|控制台/, 'terminal'],
      [/task|todo|automation|schedule|任务|待办|计划|定时|自动化/, 'tasks'],
      [/memory|context|mnemon|viking|记忆|上下文|知识库/, 'db'],
      [/browser|web(?!hook)|url|网页|浏览|浏览器/, 'globe'],
      [/search|find|query|搜索|检索|查找/, 'search'],
      [/chart|usage|metric|token|stat|统计|用量|图表|分析/, 'chart'],
      [/settings|config|preference|theme|palette|设置|配置|偏好|主题|配色/, 'sliders'],
      [/skill|prompt|persona|技能|提示词|角色/, 'sparkle'],
      [/mcp|server|protocol|插件|扩展|协议|服务/, 'plug'],
      [/code|dev|develop|开发|源码|代码/, 'code'],
      [/chat|message|session|conversation|对话|会话|消息/, 'chat'],
      [/doc|note|readme|markdown|文档|笔记|说明/, 'doc'],
      [/file|asset|resource|folder|文件|资源|目录/, 'file'],
      [/db|data|sql|数据库|数据/, 'db'],
    ]

    /** Neutral icon pool for no keyword hit: chosen by a kind hash so items differ. */
    const NEUTRAL_ICONS = ['layers', 'grid', 'hexagon', 'dot']

    /** Pick an entry's default icon name (a pure function, easy to test). */
    function pickIconName(kind, title) {
      const hay = String(kind || '') + ' ' + String(title || '')
      const s = hay.toLowerCase()
      for (let i = 0; i < ICON_RULES.length; i++) {
        if (ICON_RULES[i][0].test(s)) return ICON_RULES[i][1]
      }
      const key = String(kind || title || '')
      let sum = 0
      for (let i = 0; i < key.length; i++) sum = (sum * 31 + key.charCodeAt(i)) % 100003
      return NEUTRAL_ICONS[sum % NEUTRAL_ICONS.length]
    }

    /** An entry's semantic default icon element. */
    function defaultIcon(kind, title, size) {
      return h(GlyphIcon, { size: size || ICON, name: pickIconName(kind, title) })
    }

    /** An entry's own icon; when it throws, fall back to the icon its caller passed. */
    function safeIcon(IconComp, size, fallback) {
      try {
        return h(IconComp, { size }) || fallback
      } catch (e) {
        return fallback
      }
    }

    /* ================= error boundary ================= */

    /**
     * Render nothing when the rail throws, instead of blanking the whole slot entry
     * (the same idea as dsh-pet's PetBoundary).
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        try {
          console.error(TAG, 'render failed, rail hidden:', error)
        } catch (e) {
          /* ignore */
        }
      }
      render() {
        if (this.state.failed) return null
        return this.props.children
      }
    }

    /* ================= the rail ================= */

    function Rail(props) {
      const ctx = (props && props.ctx) || null
      const [entries, setEntries] = useState([])
      const [hover, setHover] = useState(null)
      const [expanded, setExpanded] = useState(false)
      const [tip, setTip] = useState(null)
      const [activeIndex, setActiveIndex] = useState(0)
      const [focusIndex, setFocusIndex] = useState(null)
      const [flash, setFlash] = useState(null)
      const [, setLangTick] = useState(0)

      const railRef = useRef(null)
      const tipRef = useRef(null)
      const btnRefs = useRef([])
      const closeTimer = useRef(0)
      const flashTimer = useRef(0)
      /** Unique tooltip id per instance: shell.overlay is a list slot. */
      const tipIdRef = useRef(null)
      if (tipIdRef.current === null) {
        instanceSeq += 1
        tipIdRef.current = TIP_ID_PREFIX + instanceSeq
      }
      const tipId = tipIdRef.current

      const tabsReg = serviceOf(ctx, 'sidebarRightTabs')
      const sidebarRight = serviceOf(ctx, 'sidebarRight')

      /* ---------- entries and language ---------- */

      /**
       * Entries come from the host registry; re-read on a language change (title() is live, so a re-read localizes).
       * The registry subscription and locale/change event both land here, so one re-render does both.
       */
      useEffect(() => {
        const detectLang = () => {
          try {
            const loc = serviceOf(ctx, 'locale')
            const snap = loc && typeof loc.getSnapshot === 'function' ? loc.getSnapshot() : null
            const active = snap && snap.active ? String(snap.active).toLowerCase() : ''
            // Follow the host's language preference: only zh* is Chinese, everything
            // else is English (en, en-US, and any future ja or es are safer than Chinese).
            const next = active ? (active.indexOf('zh') === 0 ? 'zh' : 'en') : navLang()
            if (next !== LANG) {
              LANG = next
              setLangTick((n) => n + 1)
            }
          } catch (e) {
            /* keep previous */
          }
        }
        const readEntries = () => {
          try {
            const list = (tabsReg && typeof tabsReg.guide === 'function' ? tabsReg.guide() : []) || []
            setEntries(list.filter((e) => e && e.kind))
          } catch (e) {
            try {
              console.error(TAG, 'guide() failed:', e)
            } catch (e2) {
              /* ignore */
            }
            setEntries([])
          }
          // The entry set changed, so a stale hover or tooltip must not be orphaned.
          setTip(null)
          setHover(null)
        }
        detectLang()
        readEntries()
        const offs = []
        try {
          if (tabsReg && typeof tabsReg.subscribe === 'function') {
            offs.push(
              tabsReg.subscribe(() => {
                detectLang()
                readEntries()
              }),
            )
          }
        } catch (e) {
          /* ignore */
        }
        try {
          if (ctx && typeof ctx.on === 'function') {
            const off = ctx.on('locale/change', () => {
              detectLang()
              readEntries()
            })
            if (typeof off === 'function') offs.push(off)
          }
        } catch (e) {
          /* ignore */
        }
        return () => offs.forEach((d) => {
          try {
            d()
          } catch (e) {
            /* ignore */
          }
        })
      }, [ctx, tabsReg])

      /* ---------- anchor to the host expand button (event-driven, no polling) ---------- */

      const anchorRef = useRef(null)
      const observedRef = useRef(null)
      const lastTopRef = useRef(null)
      const keyRef = useRef('')
      const warnedRef = useRef(false)
      const roRef = useRef(null)
      const moRef = useRef(null)
      const rafRef = useRef(0)
      /** A forced pass requested while a frame is still pending; consumed by that frame. */
      const pendingForceRef = useRef(false)

      const hideRail = useCallback(() => {
        const node = railRef.current
        if (node && node.style.display !== 'none') node.style.display = 'none'
      }, [])

      /**
       * The geometry path: the only code that reads layout. It gathers the seat, the open
       * state, the viewport, the button and the open markers once, applies railPlacement to
       * the rail node, and re-attaches the ResizeObserver when the observed target set changed.
       */
      const placeRail = useCallback(() => {
        const node = railRef.current
        if (!node) return

        const state = readSidebarState(sidebarRight)
        const seat = state.seat
        const expandedNow = state.expanded
        let vw = 1200
        let vh = 800
        try {
          vw = window.innerWidth || 1200
          vh = window.innerHeight || 800
        } catch (e) {
          /* keep the defaults */
        }

        let buttonEl = null
        let button = null
        try {
          buttonEl = findToggleEl()
          if (buttonEl) {
            const r = buttonEl.getBoundingClientRect()
            button = { top: r.top, bottom: r.bottom, width: r.width, height: r.height }
          }
        } catch (e) {
          buttonEl = null
          button = null
        }
        if (!buttonEl && !warnedRef.current) {
          warnedRef.current = true
          try {
            console.warn(TAG, 'host expand button not found ([' + TOGGLE_ATTR + ']); placing from the sidebar or the default position.')
          } catch (e) {
            /* ignore */
          }
        }

        // While expanded, every marker is an observation target, even one still at zero width:
        // the panel can mount before its opening transition gives it a size.
        let markers = []
        let panelEl = null
        let panel = null
        try {
          markers = expandedNow ? panelMarkerEls() : []
          panelEl = expandedNow ? findPanelEl(markers) : null
          if (panelEl) {
            const r = panelEl.getBoundingClientRect()
            panel = { left: r.left, top: r.top, mode: panelModeOf(panelEl) }
          }
        } catch (e) {
          panelEl = null
          panel = null
        }
        anchorRef.current = buttonEl

        const result = railPlacement({
          seat,
          expanded: expandedNow,
          viewport: { width: vw, height: vh },
          button,
          panel,
          lastTop: lastTopRef.current,
        })
        if (!result.display) {
          hideRail()
        } else {
          try {
            node.style.left = result.left + 'px'
            node.style.top = result.top + 'px'
            node.style.display = 'flex'
          } catch (e) {
            hideRail()
          }
          // Only a button-derived top survives a period without a usable button.
          if (result.usedButton) lastTopRef.current = result.top
        }

        // Observe the button and, while the sidebar is open, every open marker. Compare the
        // whole target set, so a replaced marker is disconnected and observed again.
        const targets = []
        if (buttonEl) targets.push(buttonEl)
        for (let i = 0; i < markers.length; i++) {
          const marker = markers[i]
          if (targets.indexOf(marker) < 0) targets.push(marker)
        }
        // The column fallback carries no open marker: observe the measured element itself,
        // or a column resize would leave the rail behind.
        if (panelEl && targets.indexOf(panelEl) < 0) targets.push(panelEl)
        const ro = roRef.current
        if (ro) {
          const prev = observedRef.current
          let same = !!prev && prev.length === targets.length
          if (same) {
            for (let i = 0; i < targets.length; i++) {
              if (prev[i] !== targets[i]) {
                same = false
                break
              }
            }
          }
          if (!same) {
            observedRef.current = targets
            try {
              ro.disconnect()
            } catch (e) {
              /* ignore */
            }
            for (let i = 0; i < targets.length; i++) {
              try {
                ro.observe(targets[i])
              } catch (e) {
                /* ignore */
              }
            }
          }
        }
      }, [sidebarRight, hideRail])

      /**
       * Cheap pass: reads attributes and identity, never layout. Only a change in anchor
       * identity, sidebar open state, seat presence or the open markers' signature (count,
       * mode, opening flag) triggers one geometry measurement. force=true is for certain
       * geometry changes (a window resize) and must relocate even when the key is unchanged.
       */
      const cheapPass = useCallback(
        (force) => {
          const el = findToggleEl()
          const state = readSidebarState(sidebarRight)
          // Every marker's mode and opening flag, in document order, without layout.
          const markersKey = panelMarkersKey()
          const key = (el ? '1' : '0') + '|' + state.expanded + '|' + (state.seat ? 'ok' : 'none') + '|' + markersKey
          // The anchor identity is part of the key: a new anchor must relocate and re-observe.
          const anchorChanged = el !== anchorRef.current
          if (!force && key === keyRef.current && !anchorChanged) return
          keyRef.current = key
          placeRail()
        }, [sidebarRight, placeRail])

      const schedulePass = useCallback(
        (force) => {
          // A forced request must survive an already-pending non-forced frame.
          if (force) pendingForceRef.current = true
          if (rafRef.current) return
          try {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = 0
              const forced = pendingForceRef.current
              pendingForceRef.current = false
              cheapPass(forced)
            })
          } catch (e) {
            rafRef.current = 0
            const forced = pendingForceRef.current
            pendingForceRef.current = false
            cheapPass(forced)
          }
        },
        [cheapPass],
      )

      /* The first placement must finish before paint, so the rail never flashes at the top-left. */
      useLayoutEffect(() => {
        hideRail()
        cheapPass(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        let disposed = false

        /* DOM changes run the cheap pass only (no layout when the identity is unchanged).
           MutationObserver passes (mutations, observer), so force=false is passed explicitly;
           otherwise every DOM change would force a geometry measurement. The open marker, its
           mode and its opening flag are attributes, so opening the sidebar, switching
           fullscreen and the end of the opening transition are seen without observing style
           (which would fire on every style change in the app). */
        try {
          const mo = new MutationObserver(() => schedulePass(false))
          mo.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [PANEL_OPEN_ATTR, PANEL_MODE_ATTR, PANEL_OPENING_ATTR],
          })
          moRef.current = mo
        } catch (e) {
          moRef.current = null
        }

        /* Button and marker resize -> the geometry path (a column-width drag must move the
           rail). placeRail observes every open marker and re-attaches whenever the target set
           changes. */
        try {
          if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => {
              if (!disposed) placeRail()
            })
            observedRef.current = null
            roRef.current = ro
            // Observe the targets the layout effect just measured.
            placeRail()
          }
        } catch (e) {
          roRef.current = null
        }

        const onResize = () => schedulePass(true)
        window.addEventListener('resize', onResize, true)

        return () => {
          disposed = true
          if (rafRef.current) {
            try {
              cancelAnimationFrame(rafRef.current)
            } catch (e) {
              /* ignore */
            }
            rafRef.current = 0
          }
          pendingForceRef.current = false
          if (moRef.current) {
            try {
              moRef.current.disconnect()
            } catch (e) {
              /* ignore */
            }
            moRef.current = null
          }
          if (roRef.current) {
            try {
              roRef.current.disconnect()
            } catch (e) {
              /* ignore */
            }
            roRef.current = null
          }
          window.removeEventListener('resize', onResize, true)
        }
      }, [schedulePass, placeRail])

      /* A seat change (session switch or leaving the screen) re-evaluates visibility; mounted is a subscribable store. */
      useEffect(() => {
        const m = sidebarRight && sidebarRight.mounted
        if (!m || typeof m.subscribe !== 'function') return undefined
        let off = null
        try {
          off = m.subscribe(() => {
            schedulePass(true)
          })
        } catch (e) {
          off = null
        }
        return () => {
          if (typeof off === 'function') {
            try {
              off()
            } catch (e) {
              /* ignore */
            }
          }
        }
      }, [sidebarRight, cheapPass, schedulePass])

      /* ---------- interaction ---------- */

      const cancelCollapse = useCallback(() => {
        if (closeTimer.current) {
          clearTimeout(closeTimer.current)
          closeTimer.current = 0
        }
      }, [])

      const scheduleCollapse = useCallback(() => {
        cancelCollapse()
        closeTimer.current = setTimeout(() => {
          closeTimer.current = 0
          setExpanded(false)
          setHover(null)
          setTip(null)
        }, CLOSE_DELAY)
      }, [cancelCollapse])

      useEffect(() => cancelCollapse, [cancelCollapse])
      useEffect(
        () => () => {
          if (flashTimer.current) clearTimeout(flashTimer.current)
        },
        [],
      )

      const showFlash = useCallback((msg) => {
        setFlash(msg)
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => {
          flashTimer.current = 0
          setFlash(null)
        }, 2400)
      }, [])

      const goTab = useCallback(
        (kind) => {
          // Re-resolve the service on click instead of capturing it during render.
          const svc = serviceOf(ctx, 'sidebarRight')
          if (!svc || typeof svc.openTab !== 'function') {
            try {
              console.warn(TAG, 'this host has no sidebarRight.openTab; cannot open a tab.')
            } catch (e) {
              /* ignore */
            }
            showFlash(t('rail.noService'))
            return
          }
          try {
            svc.openTab(kind)
          } catch (e) {
            try {
              console.error(TAG, 'openTab("' + kind + '") failed:', e)
            } catch (e2) {
              /* ignore */
            }
            showFlash(t('rail.openFailed'))
            return
          }
          // An already-open and active tab changes nothing in the session store, so the
          // sizing feature cannot see this click: ask it to re-apply for the on-screen session.
          try {
            const mounted = svc.mounted
            const sessionId = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
            if (sessionId !== undefined && sessionId !== null && PANE_SIZING && typeof PANE_SIZING.apply === 'function') {
              PANE_SIZING.apply(sessionId)
            }
          } catch (e) {
            /* sizing is optional; a failure here must not affect the rail */
          }
        },
        [ctx, showFlash],
      )

      /* Collapsed renders only the first 3 items, so the height is exact, nothing is clipped and no hidden item is focusable. */
      const items = useMemo(() => {
        const list = entries.filter((e) => e && e.kind)
        return expanded ? list : list.slice(0, COLLAPSED_COUNT)
      }, [entries, expanded])

      /* Clamp the active index when fewer items are visible, so the toolbar keeps one Tab stop. */
      const act = items.length ? Math.min(activeIndex, items.length - 1) : 0
      /* Arrow keys use all entries as the index space: collapsed expands first, so no entry is skipped. */
      const totalCount = entries.length
      const actFull = totalCount ? Math.min(activeIndex, totalCount - 1) : 0

      const onKeyDown = useCallback(
        (e) => {
          const n = totalCount
          if (e.key === 'Escape') {
            setTip(null)
            setHover(null)
            return
          }
          if (!n) return
          let next = -1
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (actFull + 1) % n
          else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (actFull - 1 + n) % n
          else if (e.key === 'Home') next = 0
          else if (e.key === 'End') next = n - 1
          else return
          e.preventDefault()
          setActiveIndex(next)
          setExpanded(true)
          try {
            requestAnimationFrame(() => {
              const el = btnRefs.current[next]
              if (el && el.focus) el.focus()
            })
          } catch (err) {
            /* ignore */
          }
        },
        [totalCount, actFull],
      )

      /* ---------- render ---------- */

      /**
       * Tooltip colour and position:
       *  - The background shifts one step from the rail's actual colour (lighter in dark
       *    mode, darker in light mode); no border, just that separation from the backdrop.
       *  - JS mixing instead of color-mix: works in every host browser and tints the tail.
       *  - Coordinates are measured against the current layout, not the hover snapshot.
       */
      const tipStyle = useCallback(() => {
        // Parse an rgb()/rgba() literal.
        const parseRgb = (s) => {
          const m = String(s || '').match(/rgba?\(([^)]+)\)/)
          if (!m) return null
          const p = m[1].split(',').map((v) => parseFloat(v))
          if (p.length < 3 || p.some((v) => !isFinite(v))) return null
          return { r: p[0], g: p[1], b: p[2] }
        }
        const railEl = railRef.current
        if (!railEl) return null
        let base = ''
        try {
          base = getComputedStyle(railEl).backgroundColor
        } catch (e) {
          return null
        }
        const c = parseRgb(base)
        if (!c) return null
        // Dark mode moves towards white (lighter); light mode towards black (darker).
        let dark = false
        try {
          dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme'))
        } catch (e) {
          dark = false
        }
        const target = dark ? 255 : 0
        const ratio = dark ? 0.1 : 0.08
        const mix = (v) => Math.round(v + (target - v) * ratio)
        return 'rgb(' + mix(c.r) + ',' + mix(c.g) + ',' + mix(c.b) + ')'
      }, [])

      useLayoutEffect(() => {
        const el = tipRef.current
        if (!tip || !el) return
        const btn = btnRefs.current[tip.index]
        if (!btn) return
        try {
          const r = btn.getBoundingClientRect()
          const bg = tipStyle() || ''
          if (bg) {
            el.style.background = bg
            el.style.backgroundColor = bg
          }
          const tail = el.querySelector('[data-dsh-cs-rail-tail]')
          const w = el.offsetWidth || 0
          const leftSpace = r.left - 10
          const flip = w > 0 && leftSpace - w < 8
          el.style.top = r.top + r.height / 2 + 'px'
          if (flip) {
            // No room on the left: flip to the icon's right, tail pointing left.
            el.style.left = r.right + 10 + 'px'
            el.style.transform = 'translate(0, -50%)'
            if (tail) {
              tail.style.right = 'auto'
              tail.style.left = '-5px'
              tail.style.borderRight = '5px solid ' + (bg || 'transparent')
              tail.style.borderLeft = '0'
            }
          } else {
            el.style.left = leftSpace + 'px'
            el.style.transform = 'translate(-100%, -50%)'
            if (tail) {
              tail.style.left = 'auto'
              tail.style.right = '-5px'
              tail.style.borderLeft = '5px solid ' + (bg || 'transparent')
              tail.style.borderRight = '0'
            }
          }
        } catch (e) {
          /* ignore */
        }
      }, [tip, expanded, entries, tipStyle])

      const reduced = prefersReduced()
      const kids = []
      let lastProvider = null

      items.forEach((entry, i) => {
        let title = ''
        try {
          title = typeof entry.title === 'function' ? String(entry.title()) : String(entry.title || entry.kind)
        } catch (e) {
          title = entry.kind
        }
        const provider = entry.providerId || ''
        if (lastProvider !== null && provider !== lastProvider) {
          kids.push(
            h('div', {
              key: 'sep-' + i,
              role: 'separator',
              'aria-hidden': 'true',
              style: {
                width: 18,
                height: 1,
                margin: '2px 0',
                flex: 'none',
                alignSelf: 'center',
                background: 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
              },
            }),
          )
        }
        lastProvider = provider
        const active = i === hover
        const focused = i === focusIndex
        const described = tip && tip.index === i ? tipId : undefined

        kids.push(
          h(
            'button',
            {
              key: (provider || '') + '/' + (entry.id || i),
              ref: (el) => {
                btnRefs.current[i] = el
              },
              type: 'button',
              className: 'dsh-cs-rail-item' + (active ? ' is-hover' : ''),
              'aria-label': title,
              'aria-describedby': described,
              // Roving tabindex: the toolbar holds a single Tab stop.
              tabIndex: i === act ? 0 : -1,
              onClick: (e) => {
                e.preventDefault()
                e.stopPropagation()
                goTab(entry.kind)
              },
              onMouseEnter: () => {
                setHover(i)
                setExpanded(true)
                cancelCollapse()
                setTip({ index: i, title: title })
              },
              onMouseLeave: () => {
                setHover((cur) => (cur === i ? null : cur))
                setTip((cur) => (cur && cur.index === i ? null : cur))
              },
              onFocus: (e) => {
                // Draw the focus ring for keyboard focus only; a mouse click must not leave one.
                let keyboard = true
                try {
                  keyboard = !e.currentTarget.matches || e.currentTarget.matches(':focus-visible')
                } catch (err) {
                  keyboard = true
                }
                setFocusIndex(keyboard ? i : null)
                setActiveIndex(i)
                setExpanded(true)
                setTip({ index: i, title: title })
              },
              onBlur: () => {
                setFocusIndex((cur) => (cur === i ? null : cur))
                setTip((cur) => (cur && cur.index === i ? null : cur))
              },
              style: {
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: ITEM,
                height: ITEM,
                padding: 0,
                margin: 0,
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                background: active
                  ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))'
                  : 'transparent',
                color: active
                  ? 'var(--dsw-alias-label-primary, #f5f6f7)'
                  : 'var(--dsw-alias-label-secondary, #8a8f98)',
                transition: reduced ? 'none' : 'background .12s ease, color .12s ease',
                // The focus ring is inline because class-based styles have no host styles service.
                outline: focused ? '2px solid var(--dsw-alias-brand-primary, #4c78ff)' : 'none',
                outlineOffset: focused ? '1px' : '0',
              },
            },
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: ICON, height: ICON } },
              // An entry's own icon wins (it may be a colour bitmap or SVG, left as is);
              // without one, pick a semantic icon from kind/title instead of one shared glyph.
              entry.icon && typeof entry.icon === 'function'
                ? safeIcon(entry.icon, ICON, defaultIcon(entry.kind, title, ICON))
                : defaultIcon(entry.kind, title, ICON),
            ),
          ),
        )
      })

      if (!items.length) {
        kids.push(
          h(
            'div',
            {
              key: 'empty',
              role: 'status',
              style: {
                fontSize: 11.5,
                lineHeight: 1.35,
                color: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
                maxWidth: 160,
                padding: '4px 6px',
                textAlign: 'center',
              },
            },
            t('rail.empty'),
          ),
        )
      }

      const tipEl = tip
        ? h(
            'div',
            {
              id: tipId,
              ref: tipRef,
              role: 'tooltip',
              style: {
                position: 'fixed',
                zIndex: 901,
                top: 0,
                left: 0,
                transform: 'translate(-100%, -50%)',
                padding: '4px 8px',
                borderRadius: 7,
                // One line, no wrap, width follows the content.
                whiteSpace: 'nowrap',
                fontSize: 11.5,
                lineHeight: 1.3,
                pointerEvents: 'none',
                // The effect mixes the background from the rail's colour; no border.
                background: 'inherit',
                border: 'none',
                color: 'var(--dsw-alias-label-primary, #f5f6f7)',
                boxShadow: '0 2px 8px rgba(0,0,0,.14)',
              },
            },
            tip.title,
            // Small tail pointing at the icon (on the tooltip's right edge, pointing out).
            h('span', {
              'data-dsh-cs-rail-tail': '1',
              'aria-hidden': 'true',
              style: {
                position: 'absolute',
                top: '50%',
                right: '-5px',
                width: 0,
                height: 0,
                transform: 'translateY(-50%)',
                borderTop: '5px solid transparent',
                borderBottom: '5px solid transparent',
                borderLeft: '5px solid transparent',
              },
            }),
          )
        : null

      const flashEl = flash
        ? h(
            'div',
            {
              role: 'status',
              style: {
                marginTop: 4,
                padding: '4px 6px',
                borderRadius: 6,
                fontSize: 11,
                lineHeight: 1.3,
                color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                background: 'var(--dsw-alias-state-error-secondary, rgba(239,68,68,.12))',
                maxWidth: 180,
              },
            },
            flash,
          )
        : null

      return h(
        'div',
        {
          ref: railRef,
          className: 'dsh-cs-rail',
          // No toolbar without entries (an empty toolbar is wrong); use group + status text.
          role: items.length ? 'toolbar' : 'group',
          'aria-orientation': items.length ? 'vertical' : undefined,
          'aria-label': t('rail.ariaLabel'),
          'aria-expanded': items.length ? (expanded ? 'true' : 'false') : undefined,
          onMouseEnter: () => {
            cancelCollapse()
            setExpanded(true)
          },
          onMouseLeave: scheduleCollapse,
          onKeyDown: onKeyDown,
          style: {
            // left / top / display are written imperatively by the effect:
            // keeping them out of React's style stops every re-render resetting them.
            position: 'fixed',
            zIndex: 900,
            boxSizing: 'border-box',
            width: RAIL_W,
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
            padding: RAIL_PAD,
            borderRadius: 12,
            // The background matches the main column (--dsw-alias-bg-base); the shadow only lifts it slightly.
            // (The old 0 10px 28px shadow was too heavy in light mode; a little is enough.)
            background: 'var(--dsw-alias-bg-base, #1b1c1f)',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
            boxShadow: '0 2px 8px rgba(0,0,0,.10)',
            fontFamily: 'inherit',
          },
        },
        kids,
        tipEl,
        flashEl,
      )
    }

    /* ================= plugin entry ================= */

    function mount(ctx) {
      try {
        console.info(TAG, 'rail loaded')
      } catch (e) {
        /* ignore */
      }

      /* Locale namespace: register it when the host locale service is available so the
         slot label can be localized. Without a successful registration the spec must not
         declare one, or the host treats assembly as failed. */
      let localeReady = false
      try {
        const loc = serviceOf(ctx, 'locale')
        if (loc && typeof loc.register === 'function') {
          const off = loc.register(NS, {
            en: {
              'rail.ariaLabel': DICT.en['rail.ariaLabel'],
              'rail.anchorLabel': DICT.en['rail.anchorLabel'],
            },
            zh: {
              'rail.ariaLabel': DICT.zh['rail.ariaLabel'],
              'rail.anchorLabel': DICT.zh['rail.anchorLabel'],
            },
          })
          localeReady = true
          ctx.effect(() => () => {
            if (typeof off === 'function') {
              try {
                off()
              } catch (e) {
                /* ignore */
              }
            }
          }, 'dsh-claude-sidebar rail: locale disposer')
        }
      } catch (e) {
        localeReady = false
      }

      const mountSlot = (slot, spec, Component, extraProps) => {
        try {
          ctx.slots.inject(slot, () =>
            ctx.slots.register(spec, (props) =>
              h(Boundary, null, h(Component, Object.assign({}, props, extraProps || {}))),
            ),
          )
        } catch (e) {
          try {
            console.warn(TAG, 'this host has no "' + slot + '" slot; the rail cannot mount.')
          } catch (e2) {
            /* ignore */
          }
        }
      }

      // The rail itself: a frame-level floating layer beside the open sidebar and below the
      // host's expand button.
      const spec = { name: 'shell.overlay', id: 'dsh-claude-sidebar/rail', order: 300, label: t('rail.ariaLabel') }
      if (localeReady) spec.locale = NS
      mountSlot('shell.overlay', spec, Rail, { ctx })
    }

    registerFeature({ name: 'rail', inject: ['slots', 'sidebarRightTabs', 'sidebarRight'], mount })

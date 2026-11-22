    /* Environment group 4/4 — environment.js: column frame, Environment and Changes sections, EnvironmentBody and mount. */
    /** Each kind of change row and the palette tone its letter takes. */
    const CHANGE_TONE = { staged: 'success', unstaged: 'warn', both: 'warn', untracked: 'idle', conflicted: 'error' }

    /**
     * The human name of a Node platform, as the Claude desktop environment panel shows it.
     * @param {string} platform
     * @returns {string} the product name, or the raw platform for an unknown one.
     */
    function platformLabel(platform) {
      if (platform === 'win32') return 'Windows'
      if (platform === 'darwin') return 'macOS'
      if (platform === 'linux') return 'Linux'
      return platform
    }

    /**
     * The one-letter change mark for a file row: '?' untracked, '!' conflicted, otherwise
     * the worktree letter, else the index letter.
     * @param {{ index: string, worktree: string, kind: string }} file
     * @returns {string}
     */
    function changeLetter(file) {
      if (file.kind === 'untracked') return '?'
      if (file.kind === 'conflicted') return '!'
      if (typeof file.worktree === 'string' && file.worktree !== '.') return file.worktree
      return typeof file.index === 'string' ? file.index : '.'
    }

    /**
     * A stored section order made whole: unknown and repeated ids are dropped, and every
     * default id a stored order missed is appended in default order.
     * @param {unknown} stored - whatever localStorage held under `order`.
     * @param {string[]} defaults - the column's default order.
     * @returns {string[]} a fresh, complete order.
     */
    function normalizeOrder(stored, defaults) {
      const order = []
      const seen = new Set()
      if (Array.isArray(stored)) {
        for (const id of stored) {
          if (typeof id !== 'string' || seen.has(id) || !defaults.includes(id)) continue
          seen.add(id)
          order.push(id)
        }
      }
      for (const id of defaults) if (!seen.has(id)) order.push(id)
      return order
    }

    /**
     * One section moved by one place. A section at an end, or an id the order does not
     * hold, leaves the order untouched.
     * @param {string[]} order
     * @param {string} id
     * @param {number} delta - -1 for one place up, 1 for one place down.
     * @returns {string[]} the same order when nothing moves, else a new one.
     */
    function moveSection(order, id, delta) {
      const index = order.indexOf(id)
      const target = index + delta
      if (index === -1 || target < 0 || target >= order.length) return order
      const next = order.slice()
      next.splice(index, 1)
      next.splice(target, 0, id)
      return next
    }

    /**
     * One section dropped onto another: it goes immediately before or after the target
     * section, as the pointer's position says. Dropping a section on itself or on an id
     * the order does not hold changes nothing.
     * @param {string[]} order
     * @param {string} draggedId
     * @param {string} targetId
     * @param {'before' | 'after'} [position] - defaults to 'before'.
     * @returns {string[]} the same order when nothing moves, else a new one.
     */
    function dropSection(order, draggedId, targetId, position) {
      if (draggedId === targetId) return order
      const from = order.indexOf(draggedId)
      if (from === -1 || order.indexOf(targetId) === -1) return order
      const next = order.slice()
      next.splice(from, 1)
      const to = next.indexOf(targetId)
      next.splice(position === 'after' ? to + 1 : to, 0, draggedId)
      return next
    }

    /**
     * Where a drop on a header lands: above or below its vertical midpoint. A drag event
     * without a usable rect (a synthetic event) defaults to 'before'.
     * @param {object} event
     * @returns {'before' | 'after'}
     */
    function dropPositionAt(event) {
      const target = event?.currentTarget
      if (target === null || target === undefined || typeof target.getBoundingClientRect !== 'function') {
        return 'before'
      }
      const rect = target.getBoundingClientRect()
      if (rect === null || rect === undefined || !Number.isFinite(rect.top) || !Number.isFinite(rect.height)) {
        return 'before'
      }
      const y = typeof event.clientY === 'number' ? event.clientY : rect.top
      return y < rect.top + rect.height / 2 ? 'before' : 'after'
    }

    /**
     * Whether keyboard focus sits inside one element. The narrow transition uses it to pass
     * focus to the strip before the column's focused header or Refresh button disappears.
     * @param {unknown} node
     * @returns {boolean}
     */
    function focusInside(node) {
      if (node === null || typeof node !== 'object') return false
      if (typeof document === 'undefined') return false
      const active = document.activeElement
      if (active === null || active === undefined || active === node) return false
      return typeof node.contains === 'function' && node.contains(active) === true
    }

    /**
     * The folder name and its parent, from a working directory: the last path segment,
     * split on either separator, with a trailing separator ignored. A drive root such as
     * `D:\` is its own name with no parent.
     * @param {unknown} cwd
     * @returns {{ name: string, parent: string | null } | null}
     */
    function folderParts(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return null
      const trimmed = cwd.replace(/[\\/]+$/u, '')
      if (/^[A-Za-z]:$/u.test(trimmed)) return { name: trimmed + '\\', parent: null }
      if (trimmed === '') {
        if (cwd === '/' || cwd === '\\') return { name: cwd, parent: null }
        return null
      }
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      if (separator === -1) return { name: trimmed, parent: null }
      const name = trimmed.slice(separator + 1)
      let parent = trimmed.slice(0, separator)
      if (parent === '' && trimmed.startsWith('/')) parent = '/'
      if (/^[A-Za-z]:$/u.test(parent)) parent = parent + '\\'
      return { name, parent }
    }

    /**
     * The upstream state the branch row shows: `↑<ahead> ↓<behind>` with only the
     * non-zero parts, `up to date` when both are zero, `gone` when both are null, and
     * nothing at all without an upstream.
     * @param {{ upstream?: string | null, ahead?: number | null, behind?: number | null } | null | undefined} changes
     * @returns {string | null}
     */
    function upstreamState(changes) {
      if (changes === null || changes === undefined) return null
      if (typeof changes.upstream !== 'string' || changes.upstream === '') return null
      const ahead = typeof changes.ahead === 'number' ? changes.ahead : null
      const behind = typeof changes.behind === 'number' ? changes.behind : null
      if (ahead === 0 && behind === 0) return 'up to date'
      if (ahead === null && behind === null) return 'gone'
      const parts = []
      if (ahead !== null && ahead !== 0) parts.push('↑' + ahead)
      if (behind !== null && behind !== 0) parts.push('↓' + behind)
      return parts.length === 0 ? null : parts.join(' ')
    }

    /**
     * The state name a pull request row renders and colors: `draft` wins, then open,
     * merged and closed are matched case-insensitively, and anything else is unknown.
     * @param {{ state?: unknown, draft?: unknown }} pull
     * @returns {'draft' | 'open' | 'merged' | 'closed' | 'unknown'}
     */
    function pullState(pull) {
      if (pull?.draft === true) return 'draft'
      const state = typeof pull?.state === 'string' ? pull.state.toLowerCase() : ''
      if (state === 'draft' || state === 'open' || state === 'merged' || state === 'closed') return state
      return 'unknown'
    }

    /**
     * The icon tone for a pull request: open succeeds, merged takes the brand color, and
     * closed or draft stays secondary.
     * @param {{ state?: unknown, draft?: unknown }} pull
     * @returns {string}
     */
    function pullTone(pull) {
      const state = pullState(pull)
      if (state === 'open') return STATE_TONE.success
      if (state === 'merged') return STATE_TONE.active
      return 'var(--dsw-alias-label-secondary, inherit)'
    }

    /** The column's saved state, or its defaults when storage is missing, broken or disabled. */
    function readColumnState() {
      const collapsed = {}
      for (const id of COLUMN_SECTIONS) collapsed[id] = false
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(COLUMN_KEY)
        if (typeof raw !== 'string' || raw === '') return { order: COLUMN_SECTIONS.slice(), collapsed }
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { order: COLUMN_SECTIONS.slice(), collapsed }
        }
        const stored = parsed.collapsed
        if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
          for (const id of COLUMN_SECTIONS) if (stored[id] === true) collapsed[id] = true
        }
        return { order: normalizeOrder(parsed.order, COLUMN_SECTIONS), collapsed }
      } catch {
        return { order: COLUMN_SECTIONS.slice(), collapsed }
      }
    }

    /** Save the column state; a browser that refuses storage keeps this mount's state only. */
    function saveColumnState(column) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(COLUMN_KEY, JSON.stringify({ order: column.order, collapsed: column.collapsed }))
      } catch {
        // Storage disabled or full: the column still works for this mount.
      }
    }

    async function fetchEnvironment(sessionId) {
      const { response, body } = await fetchJson(ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
      if (!response.ok) {
        const reason = body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + response.status
        throw new Error(reason)
      }
      // A 200 that is not the route's JSON object must not blank the panel.
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('unexpected answer from the Environment route')
      }
      return body
    }

    /** The Environment tab's guide icon: a monitor, drawn in the current text color and sized by props.size. */
    function EnvironmentIcon(props) {
      return iconFrame(
        props.size ?? 16,
        h('rect', { x: 1.75, y: 2.5, width: 12.5, height: 8, rx: 1.5 }),
        h('path', { d: 'M5.5 13h5M8 10.5V13' }),
      )
    }

    /** The laptop icon of the computer row. */
    function MachineIcon() {
      return lineIcon(h('rect', { x: 1.75, y: 3, width: 12.5, height: 7.5, rx: 1.5 }), h('path', { d: 'M5 13h6' }))
    }

    /** The folder icon of the working-directory row. */
    function FolderIcon() {
      return lineIcon(
        h('path', { d: 'M2 6V4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 2h5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5V6z' }),
      )
    }

    /** The branch icon of the branch row. */
    function BranchIcon() {
      return lineIcon(
        h('circle', { cx: 4.5, cy: 3.5, r: 1.5 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.5 }),
        h('circle', { cx: 11.5, cy: 5.5, r: 1.5 }),
        h('path', { d: 'M4.5 5v6M11.5 7v1.5a3 3 0 0 1-3 3H8' }),
      )
    }

    /** The book icon of the repository row. */
    function RepositoryIcon() {
      return lineIcon(
        h('path', { d: 'M3 3.5A1.5 1.5 0 0 1 4.5 2H13v11H4.5A1.5 1.5 0 0 0 3 14.5V3.5z' }),
        h('path', { d: 'M3 12.5A1.5 1.5 0 0 1 4.5 11H13' }),
      )
    }

    /** The ticket icon of the card row. */
    function CardIcon() {
      return lineIcon(h('rect', { x: 2.75, y: 4.5, width: 10.5, height: 7, rx: 1 }), h('path', { d: 'M6 4.5v7' }))
    }

    /** The list icon of the progress-file row. */
    function ProgressIcon() {
      return lineIcon(
        h('path', { d: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8' }),
        h('path', { d: 'M2.75 4.5h.5M2.75 8h.5M2.75 11.5h.5' }),
      )
    }

    /** The file icon of the uncommitted-changes row. */
    function FileIcon() {
      return lineIcon(h('path', { d: 'M4 2.5h5l3 3v8H4z' }), h('path', { d: 'M9 2.5V6h3' }))
    }

    /** The pull-request icon of a bound change request. */
    function PullRequestIcon() {
      return lineIcon(
        h('circle', { cx: 4.5, cy: 3.5, r: 1.5 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.5 }),
        h('path', { d: 'M4.5 5v6' }),
        h('path', { d: 'M11 4.5v3a3 3 0 0 1-3 3H6.5M8 9l-1.5 1.5L8 12' }),
      )
    }

    /**
     * One collapsed-by-default expanding row: a line icon, the text, an optional right
     * detail and a chevron; opening it shows the body under the row.
     */
    function ExpandingRow(props) {
      const [open, setOpen] = useState(false)
      return h(
        'div',
        { style: S.sectionBody },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(
            'button',
            {
              type: 'button',
              style: { ...S.rowButton, flex: '1 1 auto', minWidth: 0 },
              title: props.title,
              'aria-expanded': open ? 'true' : 'false',
              'aria-controls': props.bodyId,
              onClick: () => setOpen(value => !value),
            },
            h('span', { style: S.rowIcon }, h(props.icon)),
            h('span', { style: S.rowText }, props.label),
            props.right === undefined ? null : h('span', { style: S.rowRight }, props.right),
            chevron(open),
          ),
          props.action ?? null,
        ),
        h(
          'div',
          { id: props.bodyId, style: open ? S.rowBody : { display: 'none' }, hidden: open ? undefined : true },
          open ? props.children : null,
        ),
      )
    }

    /** A file row keeps the old file-row look but is activatable like a button. */
    const FILE_ROW_BUTTON = {
      ...S.fileRow,
      width: '100%',
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }

    /** The working tree: an ExpandingRow with its capped file list. */
    function workingTreeRow(changes, bodyId, openGit) {
      const files = Array.isArray(changes.files)
        ? changes.files.filter(file => file !== null && typeof file === 'object')
        : []
      const total = typeof changes.total === 'number' ? changes.total : files.length
      const shown = files.slice(0, MAX_CHANGE_ROWS)
      const more = Math.max(0, total - shown.length)
      const counts = []
      if (changes.staged > 0) counts.push(changes.staged + ' staged')
      if (changes.unstaged > 0) counts.push(changes.unstaged + ' unstaged')
      if (changes.untracked > 0) counts.push(changes.untracked + ' untracked')
      if (changes.conflicted > 0) counts.push(changes.conflicted + ' conflicted')
      const rows = shown.map((file, index) => {
        const filePath = typeof file.path === 'string' ? file.path : ''
        const content = [
          h(
            'span',
            { style: { ...S.letter, color: STATE_TONE[CHANGE_TONE[file.kind] ?? 'idle'] } },
            changeLetter(file),
          ),
          h(
            'span',
            { style: S.mono },
            typeof file.origPath === 'string' && typeof file.path === 'string'
              ? file.origPath + ' → ' + file.path
              : String(file.path ?? ''),
          ),
        ]
        /* Only a file opens the Git tab on a specific path, and only while the Git row is
           on; a folder or an inactive Git feature keeps a plain, read-only row. */
        return file.folder === true || typeof openGit !== 'function'
          ? h('div', { key: index, style: S.fileRow, 'data-git-path': filePath }, ...content)
          : h('button', {
              key: index,
              type: 'button',
              style: FILE_ROW_BUTTON,
              'data-git-path': filePath,
              title: filePath,
              onClick: () => openGit(filePath),
            }, ...content)
      })
      const label = total + (total === 1 ? ' uncommitted change' : ' uncommitted changes')
      return h(ExpandingRow, {
        key: 'working-tree',
        icon: FileIcon,
        label,
        title: counts.length > 0 ? label + ' · ' + counts.join(' · ') : label,
        right: counts.length > 0 ? counts.join(' · ') : undefined,
        bodyId,
        action: openGit === undefined
          ? null
          : h('button', {
              type: 'button',
              style: S.refresh,
              'aria-label': 'Open in the Git tab',
              onClick: () => openGit(),
            }, 'Open in Git'),
        children: [
          ...rows,
          more > 0 ? h('span', { key: 'more', style: S.note }, 'and ' + more + ' more') : null,
        ],
      })
    }

    /** The Environment rows: computer, folder, branch, repository, card and progress file. */
    function environmentRows(data, regionPrefix) {
      if (data === null || data === undefined) return []
      const rows = []
      const machine = data.machine ?? null
      if (machine !== null) {
        const parts = []
        if (typeof machine.hostname === 'string' && machine.hostname !== '') parts.push(machine.hostname)
        if (typeof machine.platform === 'string' && machine.platform !== '') parts.push(platformLabel(machine.platform))
        if (parts.length > 0) rows.push(row(MachineIcon, 'This computer', { key: 'machine', title: parts.join(' · ') }))
      }
      const folder = folderParts(data.cwd)
      if (folder !== null) {
        rows.push(
          row(
            FolderIcon,
            [
              h('span', { key: 'name' }, folder.name),
              folder.parent === null
                ? null
                : h('span', { key: 'parent', style: S.rowSecondary }, ' · ' + folder.parent),
            ],
            { key: 'folder', title: data.cwd },
          ),
        )
      }
      const task = data.task ?? {}
      const git = task.git ?? null
      const changes = data.changes ?? null
      if (git === null) {
        rows.push(row(BranchIcon, 'Not a git folder', { key: 'branch' }))
      } else {
        const branch =
          git.detached === true || typeof git.branch !== 'string' || git.branch === '' ? 'detached HEAD' : git.branch
        let title = branch
        if (git.linkedWorktree === true && typeof git.mainRoot === 'string' && git.mainRoot !== '') {
          title += ' · worktree of ' + git.mainRoot
        }
        rows.push(row(BranchIcon, branch, { key: 'branch', title, right: upstreamState(changes) }))
      }
      if (git !== null && typeof task.repo === 'string' && task.repo !== '') {
        rows.push(row(RepositoryIcon, task.repo, { key: 'repository', title: task.repo }))
      }
      const card = task.card
      if (git !== null && card !== null && card !== undefined && typeof card === 'object') {
        const key = String(card.key ?? '')
        const warning =
          task.branchFollowsConvention === false
            ? h('span', { style: S.warn, title: OFF_PATTERN_WARNING }, 'name off-pattern')
            : undefined
        // With no configured tracker address the route sends a key without a URL: show the key,
        // but never a link with an empty or undefined href.
        const label =
          typeof card.url === 'string' && card.url !== ''
            ? h('a', { href: card.url, target: '_blank', rel: 'noreferrer', style: S.link }, key)
            : key
        rows.push(row(CardIcon, label, { key: 'card', title: key, right: warning }))
      }
      const progress = task.progress
      if (progress !== null && progress !== undefined && typeof progress === 'object') {
        rows.push(
          h(ExpandingRow, {
            key: 'progress',
            icon: ProgressIcon,
            label: 'Progress file',
            bodyId: regionPrefix + '-progress',
            children: [
              typeof progress.path === 'string' ? h('span', { key: 'path', style: S.path }, progress.path) : null,
              h(
                'pre',
                { key: 'text', style: S.pre, tabIndex: 0 },
                typeof progress.text === 'string' ? progress.text : '',
              ),
              progress.truncated === true
                ? h('span', { key: 'truncated', style: S.note }, 'Truncated to 6000 characters')
                : null,
            ],
          }),
        )
      }
      return rows
    }

    /** The bound pull requests: one two-line row each, the title linked to its URL. */
    function pullRequestRows(pulls) {
      return pulls.map((pull, index) => {
        const state = pullState(pull)
        const number = '#' + pull.number
        const hasTitle = typeof pull.title === 'string' && pull.title !== ''
        const title = hasTitle ? pull.title : 'Pull request ' + number
        const label = hasTitle ? 'Pull request ' + number + ': ' + pull.title : 'Pull request ' + number
        const parts = []
        if (typeof pull.checks === 'string' && pull.checks !== '') parts.push(pull.checks)
        if (typeof pull.review === 'string' && pull.review !== '') parts.push(pull.review)
        const meta = [number, ...parts].join(' · ')
        return h(
          'div',
          { key: index, style: S.pullRow, 'data-pull-state': state },
          h('span', { style: { ...S.pullIcon, color: pullTone(pull) } }, h(PullRequestIcon)),
          h(
            'div',
            { style: S.pullText },
            h(
              'span',
              { style: S.pullTitle },
              h(
                'a',
                {
                  href: pull.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: S.link,
                  title: label,
                  'aria-label': label,
                },
                title,
              ),
            ),
            h('span', { style: S.pullMeta, title: meta }, meta),
          ),
        )
      })
    }

    /** The Changes body: pull requests first, then the working tree, or the state note. */
    function changesBody(data, regionPrefix, openGit) {
      if (data === null || data === undefined) return []
      const changesError = data.errors?.changes
      const pullsError = data.errors?.pullRequests
      const children = []
      if (typeof changesError === 'string') {
        children.push(h('p', { key: 'changes-error', style: S.error, role: 'status' }, changesError))
      }
      if (typeof pullsError === 'string') {
        children.push(h('p', { key: 'pulls-error', style: S.error, role: 'status' }, pullsError))
      }
      const pulls = Array.isArray(data.pullRequests)
        ? data.pullRequests.filter(
            pull => pull !== null && typeof pull === 'object' && Number.isFinite(pull.number),
          )
        : []
      children.push(...pullRequestRows(pulls))
      if (typeof changesError === 'string') return children
      const task = data.task ?? {}
      if ((task.git ?? null) === null) {
        children.push(h('span', { key: 'not-git', style: S.note }, 'Not a git folder'))
        return children
      }
      const changes = data.changes ?? null
      if (changes === null) return children
      const files = Array.isArray(changes.files) ? changes.files : []
      const total = typeof changes.total === 'number' ? changes.total : files.length
      if (total === 0) {
        if (pulls.length === 0 && typeof pullsError !== 'string') {
          children.push(h('span', { key: 'clean', style: S.note }, 'No changes'))
        }
        return children
      }
      children.push(workingTreeRow(changes, regionPrefix + '-changes', openGit))
      return children
    }

    /**
     * One column section: a header row holding the draggable header button and, for the
     * Environment section, its Refresh button, plus the body. The action is a sibling of
     * the header button because a button must not contain another button. The body element
     * always exists so aria-controls resolves, but its content renders only while expanded.
     */
    function sectionFrame(options) {
      const style = {
        ...S.columnSection,
        ...(options.divider === true ? S.sectionDivider : {}),
        ...(options.dropPosition === null
          ? {}
          : {
              boxShadow:
                (options.dropPosition === 'after' ? 'inset 0 -2px 0 ' : 'inset 0 2px 0 ') + STATE_TONE.active,
            }),
      }
      const header = h(
        'button',
        {
          type: 'button',
          style: S.sectionHeader,
          'aria-label': options.ariaLabel,
          'aria-expanded': options.expanded ? 'true' : 'false',
          'aria-controls': options.bodyId,
          'data-section': options.id,
          draggable: true,
          onClick: options.onToggle,
          onKeyDown: options.onKeyDown,
          onDragStart: options.onDragStart,
          onDragOver: options.onDragOver,
          onDragLeave: options.onDragLeave,
          onDrop: options.onDrop,
          onDragEnd: options.onDragEnd,
        },
        h('span', { style: S.sectionName }, COLUMN_TITLES[options.id] ?? options.id),
        chevron(options.expanded),
        options.summary,
      )
      return h(
        'section',
        { key: options.key, style, 'data-column-section': options.id },
        h('div', { style: S.sectionHeaderRow }, header, options.action ?? null),
        h(
          'div',
          {
            id: options.bodyId,
            style: options.expanded ? S.sectionBody : { display: 'none' },
            hidden: options.expanded ? undefined : true,
          },
          options.expanded ? options.children : null,
        ),
      )
    }

    /** The icon each section shows in the narrow strip. */
    const STRIP_ICONS = {
      environment: EnvironmentIcon,
      context: GaugeIcon,
      connectors: PlugIcon,
      changes: BranchIcon,
    }

    /**
     * The name one strip icon carries: its section's title, and for Context its percent
     * when one is known.
     * @param {string} id
     * @param {number | null} percent
     * @returns {string}
     */
    function stripLabel(id, percent) {
      const name = COLUMN_TITLES[id] ?? id
      return id === 'context' && percent !== null ? name + ', ' + percent + '% used' : name
    }

    /**
     * One item of the narrow strip: a 32 x 32 icon carrying its section's name and, under
     * the Context icon only, the percent in 10 px secondary text. The icon is a plain
     * element with role="img", not a button: a pane cannot be widened from a plugin, so
     * there is nothing to activate, and a focusable dead button would only mislead.
     * @param {string} id
     * @param {number | null} percent - the Context percent; ignored for other sections.
     * @returns {object}
     */
    function stripItem(id, percent) {
      const label = stripLabel(id, percent)
      const Icon = STRIP_ICONS[id] ?? MachineIcon
      return h(
        'div',
        { key: id, style: S.stripItem, 'data-strip-section': id },
        h('span', { style: S.stripIcon, role: 'img', 'aria-label': label, title: label }, h(Icon)),
        id === 'context' && percent !== null
          ? h('span', { style: S.stripPercent, 'aria-hidden': 'true' }, percent + '%')
          : null,
      )
    }

    /**
     * The strip a too-narrow pane shows instead of the column: one icon per section in the
     * column's saved order, top-aligned in a labeled group that can take focus. It reads
     * the same state as the column; it starts nothing.
     * @param {string[]} order
     * @param {number | null} percent
     * @param {{ current: unknown } | null} stripRef - where focus lands when the column goes.
     * @returns {object}
     */
    function narrowStrip(order, percent, stripRef) {
      return h(
        'div',
        {
          ref: stripRef,
          style: S.strip,
          role: 'group',
          'aria-label': 'Sections',
          tabIndex: -1,
          'data-column-strip': '',
        },
        ...order.map(id => stripItem(id, id === 'context' ? percent : null)),
      )
    }

    /** The tab body. The slot supplies sessionId, useTabInfo and useProjection. */
    function EnvironmentBody(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const tabInfo = props.useTabInfo()
      const tabVisible = tabInfo.tab.visible
      /* The documented tab action: the summary's action opens the Git tab beside this
         column; a clicked file also carries its path. A host without the action keeps the
         rows read-only and harmless. */
      const openGit = filePath => {
        const openTab = tabInfo?.tab?.actions?.openTab
        if (typeof openTab !== 'function') return
        const options = {}
        if (typeof filePath === 'string' && filePath !== '') options.params = { path: filePath }
        /* A Git tab already mounted in this session lives in a known pane; pages de-duplicate
           within that pane, so naming it reveals the tab with the new params. */
        const held = typeof GIT_TAB_PANES.get === 'function' ? GIT_TAB_PANES.get(sessionId) : null
        const openTabs = typeof props.openTabsSnapshot === 'function' ? props.openTabsSnapshot() : null
        const stillOpen = held !== null && held !== undefined && Array.isArray(openTabs) &&
          openTabs.some(entry => entry !== null && typeof entry === 'object' &&
            entry.sessionId === sessionId && entry.tabId === held.tabId && entry.kind === 'claude-sidebar-git')
        if (stillOpen) options.paneId = held.paneId
        else options.preferNewPane = true
        openTab('claude-sidebar-git', options)
      }
      const pressure =
        typeof props.useProjection === 'function' ? props.useProjection('contextPressure') : undefined
      const breakdown =
        typeof props.useProjection === 'function' ? props.useProjection('contextBreakdown') : undefined
      /* The host hooks are called on every render (their presence is fixed for a mount)
         and they subscribe to primitives, so a keystroke in the message box does not
         re-render the whole tab. */
      const inputSignal =
        typeof props.useInput === 'function' ? props.useInput(compactInputSignal) : undefined
      const sessionRunning =
        typeof props.useSessionStatus === 'function'
          ? props.useSessionStatus(state =>
              state !== null && state !== undefined && typeof state.get === 'function'
                ? state.get(sessionId)?.running === true
                : false,
            )
          : undefined
      const [state, setState] = useState({})
      const [manual, setManual] = useState(0)
      const [column, setColumn] = useState(readColumnState)
      const [claude, setClaude] = useState({})
      const [narrow, setNarrow] = useState(false)
      const routeMissing = React.useRef(false)
      const contextInFlight = React.useRef(false)
      const compactGuard = React.useRef(null)
      const regionRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const stripRef = React.useRef(null)
      const narrowRef = React.useRef(false)
      /* Set when the column loses focus as it narrows; the strip takes it after the render. */
      const focusInsideRef = React.useRef(false)
      const wasNarrow = React.useRef(false)
      if (regionRef.current === null) {
        bodySeq += 1
        regionRef.current = 'dsh-cs-env-' + bodySeq
      }
      const regionPrefix = regionRef.current
      const dragId = React.useRef(null)
      /* Set by a keyboard move: the section whose header must take focus back after it. */
      const movedSection = React.useRef(null)
      const [dropTarget, setDropTarget] = useState(null)
      const contextOpen = column.collapsed.context !== true
      /* The poll effect outlives a collapse, so it reads the section's state from a ref
         and the expand effect calls the same loader between two ticks. */
      const contextOpenRef = React.useRef(contextOpen)
      const contextLoad = React.useRef(null)
      const wasOpen = React.useRef(contextOpen)

      /* The tab body's own root is the only element measured. The root is 320 px wide and
         clamped by maxWidth 100%, so its border-box width is the pane's width whenever the
         pane is narrower than the column; the narrow state then swaps the same root element
         to a full-width wrapper around the 40 px strip. The first width is read right here,
         synchronously before the observer is installed, so a mount in a narrow pane paints
         the strip (and asks no Context route) straight away. A zero width means the element
         is not rendered (a hidden session): it is not a measurement and the mode stays.
         Created once per mount and disconnected on unmount; without a ResizeObserver the
         column always shows. */
      React.useLayoutEffect(() => {
        if (typeof ResizeObserver !== 'function') return undefined
        const node = rootRef.current
        if (node === null || node === undefined) return undefined
        const measure = () => {
          let width = NaN
          try {
            width = node.getBoundingClientRect().width
          } catch {
            width = NaN
          }
          if (!Number.isFinite(width) || width <= 0) return
          const next = width < COLUMN_WIDTH
          /* Captured while the column is still on screen: once it unmounts, focus has
             already fallen to the body and cannot be traced any more. */
          if (next) focusInsideRef.current = focusInside(node)
          narrowRef.current = next
          setNarrow(current => (current === next ? current : next))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      /* Entering the strip removes the focused header or Refresh button with the column;
         hand focus to the strip's labeled group instead of letting it fall to the body. */
      React.useLayoutEffect(() => {
        if (!narrow || !focusInsideRef.current) return
        focusInsideRef.current = false
        const strip = stripRef.current
        if (strip !== null && strip !== undefined && typeof strip.focus === 'function') strip.focus()
      }, [narrow])

      /* React moves a reordered section with insertBefore, and Chromium drops focus from a
         node it removes even when it inserts it again: a keyboard reorder hands focus back
         to the moved section's header once the move has committed. */
      React.useLayoutEffect(() => {
        const id = movedSection.current
        if (id === null) return
        movedSection.current = null
        const root = rootRef.current
        if (root === null || root === undefined || typeof root.querySelector !== 'function') return
        const header = root.querySelector('[data-section="' + id + '"]')
        if (header !== null && header !== undefined && typeof header.focus === 'function') header.focus()
      }, [column.order])

      useEffect(() => {
        if (!tabVisible || sessionId === '') return undefined
        let live = true
        let inFlight = false
        const loadEnvironment = async () => {
          if (!live || inFlight) return
          inFlight = true
          try {
            const answer = await fetchEnvironment(sessionId)
            if (!live) return
            setState({ sessionId, data: answer })
          } catch (error) {
            if (!live) return
            setState(current =>
              current.sessionId === sessionId
                ? { sessionId, data: current.data, error: messageOf(error) }
                : { sessionId, error: messageOf(error) },
            )
          } finally {
            inFlight = false
          }
        }
        /* The detailed Context body prefers the Claude plugin's route, so it is asked
           only while its section is open and visible; a 404 ends the asking for this
           mount. The narrow strip does not render the section, so it asks nothing. */
        const loadClaude = async () => {
          if (
            !live ||
            contextInFlight.current ||
            routeMissing.current ||
            !contextOpenRef.current ||
            narrowRef.current
          ) {
            return
          }
          contextInFlight.current = true
          try {
            const answer = await fetchClaudeContext(sessionId)
            if (!live) return
            /* A request started while the section was open must not land after the strip
               appears or the section collapses: widening or expanding back asks again. */
            if (narrowRef.current || !contextOpenRef.current) return
            if (answer.missing) routeMissing.current = true
            setClaude({ sessionId, data: answer.data })
          } catch {
            if (!live || narrowRef.current) return
            // A failed poll falls back to dsh's projections; the next tick retries.
            setClaude({ sessionId, data: null })
          } finally {
            contextInFlight.current = false
          }
        }
        contextLoad.current = loadClaude
        const load = () => {
          loadEnvironment()
          loadClaude()
        }
        if (visible()) load()
        const timer = setInterval(() => {
          if (visible()) load()
        }, REFRESH_MS)
        const onVisibility = () => {
          if (visible()) load()
        }
        const listening = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        if (listening) document.addEventListener('visibilitychange', onVisibility)
        return () => {
          live = false
          contextLoad.current = null
          clearInterval(timer)
          if (listening) document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, tabVisible, manual])

      /* Expanding the section asks the route at once, even between two poll ticks.
         Collapsing drops the stored route answer, like narrowing does, so a stale answer
         can never re-appear: re-expanding shows contextPressure until the fresh one. */
      useEffect(() => {
        contextOpenRef.current = contextOpen
        const wasOpenBefore = wasOpen.current
        wasOpen.current = contextOpen
        if (!contextOpen) {
          if (wasOpenBefore) setClaude({})
          return
        }
        if (!wasOpenBefore && visible() && contextLoad.current !== null) contextLoad.current()
      }, [contextOpen])

      /* The strip does not render the Context section. Entering it drops the stored route
         answer, so a stale one can never re-appear, and leaving it with the section open
         asks the route at once, exactly as expanding does. */
      useEffect(() => {
        if (wasNarrow.current === narrow) return
        wasNarrow.current = narrow
        if (narrow) {
          setClaude({})
          return
        }
        if (contextOpen && visible() && contextLoad.current !== null) contextLoad.current()
      }, [narrow])

      /* A Compact click stays blocked until the input signal or the running state
         moves, or the short guard window passes, so a double click cannot send twice. */
      useEffect(() => {
        compactGuard.current = null
      }, [inputSignal, sessionRunning, sessionId])

      const updateColumn = next => {
        setColumn(next)
        saveColumnState(next)
      }

      const toggleSection = id => {
        updateColumn({
          order: column.order,
          collapsed: { ...column.collapsed, [id]: !column.collapsed[id] },
        })
      }

      const move = (id, delta) => {
        const order = moveSection(column.order, id, delta)
        if (order === column.order) return
        movedSection.current = id
        updateColumn({ order, collapsed: column.collapsed })
      }

      const startDrag = (event, id) => {
        dragId.current = id
        setDropTarget(null)
        const transfer = event?.dataTransfer
        if (transfer === null || transfer === undefined) return
        try {
          transfer.effectAllowed = 'move'
          if (typeof transfer.setData === 'function') transfer.setData(DRAG_TYPE, id)
        } catch {
          // A drag that refuses to carry data still reorders through dragId.
        }
      }

      const overSection = (event, id) => {
        if (dragId.current === null) return
        event.preventDefault()
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
        if (id === dragId.current) {
          setDropTarget(null)
          return
        }
        const position = dropPositionAt(event)
        setDropTarget(current =>
          current !== null && current.id === id && current.position === position ? current : { id, position },
        )
      }

      const leaveSection = event => {
        const target = event?.currentTarget
        const related = event?.relatedTarget
        const inside =
          target !== null &&
          target !== undefined &&
          typeof target.contains === 'function' &&
          related !== null &&
          related !== undefined &&
          target.contains(related)
        if (!inside) setDropTarget(null)
      }

      const dropOn = (event, id) => {
        if (dragId.current === null) return
        event.preventDefault()
        const position = dropTarget !== null && dropTarget.id === id ? dropTarget.position : dropPositionAt(event)
        const order = dropSection(column.order, dragId.current, id, position)
        dragId.current = null
        setDropTarget(null)
        if (order !== column.order) updateColumn({ order, collapsed: column.collapsed })
      }

      const endDrag = () => {
        dragId.current = null
        setDropTarget(null)
      }

      const onKeyDown = (event, id) => {
        if (
          event.altKey !== true ||
          event.shiftKey === true ||
          event.ctrlKey === true ||
          event.metaKey === true
        ) {
          return
        }
        const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
        if (delta === 0) return
        event.preventDefault()
        move(id, delta)
      }

      /* Only the current session's answer renders: a switch or an empty session leaves
         the previous session's data and error behind, and the panel stays busy until the
         current session answers. */
      const current = state.sessionId === sessionId ? state : {}
      const error = sessionId === '' ? 'No session' : current.error
      const busy = sessionId !== '' && state.sessionId !== sessionId
      const usage = contextUsage(pressure)
      const claudeAnswer = claude.sessionId === sessionId ? claude.data : null
      const view = contextView({ claude: claudeAnswer, usage, breakdown })
      /* The header names the same percent as the body while the Context section is open:
         the route's when it answers, dsh's contextPressure otherwise, and nothing before
         the first model request. Collapsed or in the narrow strip, the section is not
         visible, so both follow contextPressure alone. */
      const contextPercent = contextDisplayPercent({ narrow, open: contextOpen, claude: claudeAnswer, usage })
      const compact = compactControl({
        actions: props.inputActions,
        signal: inputSignal,
        running: sessionRunning,
        sessionId,
        guard: compactGuard,
      })
      const bodyOf = {
        environment: () => environmentRows(current.data, regionPrefix),
        context: () => contextBody(view, compact),
        connectors: () =>
          h(ConnectorsBody, {
            data: current.data,
            moreId: regionPrefix + '-connectors-more',
            restartConnector: props.restartConnector,
            saveCredential: props.saveCredential,
            refresh: () => setManual(count => count + 1),
          }),
        /* The Git tab is a separate row: without it the Changes rows stay read-only. */
        changes: () => changesBody(current.data, regionPrefix, ACTIVE_FEATURES.has('git') ? openGit : undefined),
      }
      const refresh = h(
        'button',
        { type: 'button', style: S.refresh, onClick: () => setManual(count => count + 1) },
        'Refresh',
      )
      const sections = column.order.map((id, index) =>
        sectionFrame({
          key: id,
          id,
          divider: index > 0,
          action: id === 'environment' ? refresh : undefined,
          bodyId: regionPrefix + '-section-' + id,
          expanded: column.collapsed[id] !== true,
          ariaLabel:
            id === 'context'
              ? contextPercent === null
                ? 'Context'
                : 'Context, ' + contextPercent + '% used'
              : undefined,
          summary: id === 'context' ? contextSummary(contextPercent) : undefined,
          dropPosition: dropTarget !== null && dropTarget.id === id ? dropTarget.position : null,
          onToggle: () => toggleSection(id),
          onKeyDown: event => onKeyDown(event, id),
          onDragStart: event => startDrag(event, id),
          onDragOver: event => overSection(event, id),
          onDragLeave: leaveSection,
          onDrop: event => dropOn(event, id),
          onDragEnd: endDrag,
          children: column.collapsed[id] === true ? null : bodyOf[id](),
        }),
      )
      return h(
        'div',
        { ref: rootRef, style: narrow ? S.panelNarrow : S.panel, 'aria-busy': busy ? 'true' : undefined },
        narrow
          ? narrowStrip(column.order, contextPercent, stripRef)
          : [
              typeof error === 'string' ? h('p', { key: 'error', style: S.error, role: 'status' }, error) : null,
              h('div', { key: 'column', style: S.column }, ...sections),
            ],
      )
    }

    function mount(ctx) {
      ctx.effect(
        () => {
          const disposeTab = ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => 'Environment',
            guide: [
              {
                id: 'environment',
                order: 30,
                title: () => 'Environment',
                description: () => "Machine, folder, branch, context use and changes of this session, and the app's connectors",
                icon: EnvironmentIcon,
              },
            ],
          })
          /* The row's Configure control shares this effect's lifetime: it is present only
             while the Environment feature is mounted. inject waits for a page slot that
             may not exist yet; a host without that slot keeps the panel working. */
          let disposeConfig = () => {}
          try {
            disposeConfig =
              ctx.slots.inject(CONFIG_SLOT, () =>
                ctx.slots.register({ name: CONFIG_SLOT, key: CONFIG_KEY }, EnvironmentSettingsView),
              ) ?? disposeConfig
          } catch (error) {
            console.warn('environment row: this host has no "' + CONFIG_SLOT + '" slot', error)
          }
          return () => {
            try {
              disposeTab()
            } finally {
              if (typeof disposeConfig === 'function') disposeConfig()
            }
          }
        },
        'environment panel: sidebar tab type',
      )

      /* Both Connectors actions are optional: their Remote namespace comes from
         @deepseek-ai/dsh-api-remotes, which a host may not load. Listing the services in
         this feature's inject array would make them required for the whole bundle (the
         generated footer unions every feature's list), so each is taken with its own
         scoped injection. The body gets handles fixed at mount, because the slot may
         evaluate the registration's inject() only once; subscriptions let it repaint when
         a service appears or goes, and a client context without scoped injection keeps the
         section read-only. */
      const restartConnector = remoteServiceAction(
        ctx,
        ['remote', 'remote.mcpManager'],
        inner => inner.remote.mcpManager,
        'restart',
        'the MCP manager is not available',
      )
      const saveCredential = remoteServiceAction(
        ctx,
        ['remote', 'remote.credentials'],
        inner => inner.remote.credentials,
        'set',
        'credential storage is not available',
      )
      /* The open-tab inventory is a store; the body gets a stable getter, never the service. */
      let sidebarRight = null
      try {
        sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : ctx.sidebarRight
      } catch {
        sidebarRight = null
      }
      const openTabsSnapshot = () => {
        try {
          const store = sidebarRight?.openTabs
          return store !== null && store !== undefined && typeof store.getSnapshot === 'function'
            ? store.getSnapshot()
            : null
        } catch {
          return null
        }
      }
      const bodyProps = () => ({ restartConnector, saveCredential, openTabsSnapshot })

      // The body seat belongs to the right sidebar; a host without it keeps the plugin quiet.
      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, key: TAB_ID, inject: bodyProps }, EnvironmentBody),
        )
      } catch (error) {
        console.warn('environment panel: this host has no "' + SLOT + '" slot', error)
      }
    }

    registerFeature({ name: 'environment', inject: ['slots', 'sidebarRightTabs', 'sidebarRight'], mount })

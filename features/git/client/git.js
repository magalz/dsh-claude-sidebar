     /* Git tab: a read-only view of this session's folder — branch, changed files with
        inline diffs, and recent commits. The Host owns every git call; this part only
        renders the documented JSON shapes and never writes to a repository. */

     /** This implementation's identity; also the key its body registers under. */
     const GIT_TAB_ID = 'dsh-claude-sidebar/git'
     /** The type openTab() names, also used by the Environment Changes rows. */
     const GIT_KIND = 'claude-sidebar-git'
     const GIT_SLOT = 'sidebar.right.pane.tab'
     const GIT_ROUTE = '/dsh-claude-sidebar/git'
     const GIT_DIFF_ROUTE = '/dsh-claude-sidebar/git/diff'
     /** The Environment tab's poll cadence, shared here so both tabs behave alike. */
     const GIT_REFRESH_MS = 12_000
     const GIT_FETCH_TIMEOUT_MS = 30_000
     /** Diffs and their in-flight guards are keyed by session as well as path. */
     function gitDiffKey(sessionId, filePath) { return sessionId + '|' + filePath }
     /** Last handled navigation revision per open tab (its signal), kept across remounts. */
     const GIT_NAV_REVISIONS = new WeakMap()
     /** Each mounted body owns its ids, so two Git tabs never share a diff container id. */
     let GIT_BODY_SEQ = 0
     /** Only these tokens leave the part; every one already belongs to the bundle's palette. */
     const GIT_LABEL = 'var(--dsw-alias-label-primary, #1f2328)'
     const GIT_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
     const GIT_BORDER_1 = 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18))'
     const GIT_BORDER_2 = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))'
     const GIT_LAYER_1 = 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))'
     /* The tints are deliberately paler than the state colors themselves. */
     const GIT_ADD_TINT = 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #2da44e) 12%, transparent)'
     const GIT_DEL_TINT = 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 12%, transparent)'
     /** Status letter color by file kind; untracked is deliberately quiet secondary text. */
     function gitLetterColor(kind) {
       if (kind === 'unstaged') return STATE_TONE.warn
       if (kind === 'untracked') return GIT_SECONDARY
       if (kind === 'conflicted') return STATE_TONE.error
       return STATE_TONE.success
     }

     /** Inline styles, in the Environment tab's 13 px / 12 px type scale. */
     const GS = {
       panel: { padding: '10px 12px', color: GIT_LABEL, fontSize: 13, lineHeight: '18px' },
       header: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, paddingBottom: 8 },
       branch: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
       upstream: { flex: 'none', fontSize: 12, color: GIT_SECONDARY, fontFamily: MONO },
       refresh: {
         flex: 'none', border: '1px solid ' + GIT_BORDER_2, borderRadius: 5, background: GIT_LAYER_1,
         color: GIT_LABEL, fontSize: 12, padding: '2px 7px', cursor: 'pointer',
       },
       error: { margin: '0 0 8px', color: STATE_TONE.error, fontSize: 12 },
       section: { borderTop: '1px solid ' + GIT_BORDER_1, paddingTop: 6, marginTop: 6 },
       sectionHeader: {
         display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '3px 0',
         border: 0, background: 'transparent', color: GIT_LABEL, fontSize: 13,
         fontWeight: 600, textAlign: 'left', cursor: 'pointer',
       },
       chevron: { display: 'inline-block', width: 10, color: GIT_SECONDARY, transformOrigin: 'center' },
       sectionBody: { padding: '2px 0 4px' },
       row: { display: 'flex', alignItems: 'center', gap: 7, minHeight: 22, padding: '1px 0', width: '100%' },
       rowButton: {
         display: 'flex', alignItems: 'center', gap: 7, minHeight: 22, padding: '1px 0',
         width: '100%', border: 0, background: 'transparent', color: GIT_LABEL,
         fontSize: 13, textAlign: 'left', cursor: 'pointer',
       },
       letter: { width: 14, flex: 'none', textAlign: 'center', fontFamily: MONO, fontWeight: 600 },
       path: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
       dir: { color: GIT_SECONDARY },
       counts: { flex: 'none', fontFamily: MONO, fontSize: 12, color: GIT_SECONDARY },
       note: { display: 'block', padding: '3px 0', fontSize: 12, color: GIT_SECONDARY },
       diff: { padding: '2px 0 6px 21px' },
       hunk: { fontFamily: MONO, fontSize: 12, color: GIT_SECONDARY, padding: '2px 0' },
       line: { display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: MONO, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '1px 4px' },
       number: { flex: 'none', width: 28, textAlign: 'right', color: GIT_SECONDARY, fontFamily: MONO },
       lineText: { flex: '1 1 auto', minWidth: 0 },
       commit: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 },
       commitHash: { flex: 'none', fontFamily: MONO, fontSize: 12, color: GIT_SECONDARY },
       commitSubject: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
       commitDate: { flex: 'none', fontSize: 12, color: GIT_SECONDARY, fontFamily: MONO },
     }

     /**
      * One same-origin GET the poll can abandon: response and JSON body, null when the
      * text is not JSON. Copied into this part so it shares no scope with the Environment.
      */
     async function gitFetchJson(url) {
       const response = await fetch(api(url), {
         cache: 'no-store',
         credentials: 'same-origin',
         signal: AbortSignal.timeout(GIT_FETCH_TIMEOUT_MS),
       })
       const raw = await response.text()
       let body = null
       try { body = JSON.parse(raw) } catch { body = null }
       return { response, body }
     }

     function gitError(response, body) {
       if (body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== '') return body.error
       return 'HTTP ' + response.status
     }

     async function gitFetchAnswer(sessionId, filePath) {
       const url = filePath === undefined
         ? GIT_ROUTE + '?sessionId=' + encodeURIComponent(sessionId)
         : GIT_DIFF_ROUTE + '?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath)
       const { response, body } = await gitFetchJson(url)
       if (!response.ok) throw new Error(gitError(response, body))
       if (body === null || typeof body !== 'object' || Array.isArray(body)) {
         throw new Error(filePath === undefined ? 'unexpected answer from the Git route' : 'unexpected answer from the Git diff route')
       }
       return body
     }

     /** The Git guide icon: a branch, drawn in the current text color. */
     function GitIcon(props) {
       return h(
         'svg',
         {
           width: props?.size ?? 16,
           height: props?.size ?? 16,
           viewBox: '0 0 16 16',
           fill: 'none',
           stroke: 'currentColor',
           strokeWidth: 1.25,
           strokeLinecap: 'round',
           strokeLinejoin: 'round',
           'aria-hidden': 'true',
         },
         h('circle', { cx: 4.5, cy: 3.5, r: 1.5 }),
         h('circle', { cx: 4.5, cy: 12.5, r: 1.5 }),
         h('circle', { cx: 11.5, cy: 5.5, r: 1.5 }),
         h('path', { d: 'M4.5 5v6M11.5 7v1.5a3 3 0 0 1-3 3H8' }),
       )
     }

     function gitChevron(expanded) {
       return h('span', { style: { ...GS.chevron, transform: expanded ? 'rotate(90deg)' : undefined }, 'aria-hidden': 'true' }, '›')
     }

     /** The one-letter change mark: '?' untracked, '!' conflicted, else the worktree letter. */
     function gitChangeLetter(file) {
       if (file.kind === 'untracked') return '?'
       if (file.kind === 'conflicted') return '!'
       if (typeof file.worktree === 'string' && file.worktree !== '.') return file.worktree
       return typeof file.index === 'string' ? file.index : '.'
     }

     /** Directory in secondary text, file name in primary, so long folders do not shout. */
     function gitPathParts(filePath) {
       const value = typeof filePath === 'string' ? filePath : ''
       const slash = value.lastIndexOf('/')
       if (slash === -1) return h('span', { style: GS.path }, value)
       return h(
         'span',
         { style: GS.path, title: value },
         h('span', { style: GS.dir }, value.slice(0, slash + 1)),
         value.slice(slash + 1),
       )
     }

     /** +N −M, or binary / new when the Host had no counts for this row. */
     function gitCountLabel(file) {
       if (file.binary === true) return 'binary'
       if (!Number.isFinite(file.added) || !Number.isFinite(file.deleted)) return 'new'
       return '+' + file.added + ' \u2212' + file.deleted
     }

     /** A short relative date; the full ISO date stays in the row's title. */
     function gitRelativeDate(value) {
       const time = Date.parse(value)
       if (!Number.isFinite(time)) return ''
       const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
       if (seconds < 60) return 'now'
       const minutes = Math.floor(seconds / 60)
       if (minutes < 60) return minutes + 'm'
       const hours = Math.floor(minutes / 60)
       if (hours < 24) return hours + 'h'
       return Math.floor(hours / 24) + 'd'
     }

     /** One collapsible section: its header button controls a body that only mounts when open. */
     function gitSection(id, title, expanded, onToggle, children) {
       const bodyId = 'dsh-cs-git-' + id
       return h(
         'section',
         { key: id, style: GS.section },
         h(
           'button',
           {
             type: 'button',
             style: GS.sectionHeader,
             'data-section': id,
             'aria-expanded': expanded ? 'true' : 'false',
             'aria-controls': bodyId,
             onClick: onToggle,
           },
           gitChevron(expanded),
           title,
         ),
         h(
           'div',
           { id: bodyId, style: expanded ? GS.sectionBody : { display: 'none' }, hidden: expanded ? undefined : true },
           expanded ? children : null,
         ),
       )
     }

     /** One diff line: two narrow number columns and the text, tinted by add/del. */
     function gitDiffLine(line) {
       const type = typeof line?.type === 'string' ? line.type : 'context'
       const base = type === 'add'
         ? { color: STATE_TONE.success, background: GIT_ADD_TINT }
         : type === 'del'
           ? { color: STATE_TONE.error, background: GIT_DEL_TINT }
           : type === 'note'
             ? { color: GIT_SECONDARY }
             : {}
       return h(
         'div',
         { key: String(line.old ?? '') + ':' + String(line.new ?? '') + ':' + String(line.text ?? ''), style: { ...GS.line, ...base }, 'data-git-line-type': type },
         h('span', { style: GS.number }, Number.isFinite(line.old) ? String(line.old) : ''),
         h('span', { style: GS.number }, Number.isFinite(line.new) ? String(line.new) : ''),
         h('span', { style: GS.lineText, 'data-git-line-text': '' }, typeof line.text === 'string' ? line.text : ''),
       )
     }

     /** The body of one expanded file: loading, error, special states, then hunks. */
     function gitDiffBody(entry) {
       if (!entry) return h('span', { style: GS.note }, 'Loading diff…')
       if (entry.error) return h('p', { style: GS.error, role: 'status' }, entry.error)
       const answer = entry.data
       if (!answer) return h('span', { style: GS.note }, 'Loading diff…')
       if (answer.tooLarge === true) return h('span', { style: GS.note }, 'Diff too large to show')
       if (answer.binary === true) return h('span', { style: GS.note }, 'Binary file')
       const hunks = Array.isArray(answer.hunks) ? answer.hunks : []
       const rows = []
       for (const hunk of hunks) {
         if (hunk === null || typeof hunk !== 'object') continue
         if (typeof hunk.header === 'string') {
           rows.push(h('div', { key: 'h-' + rows.length, style: GS.hunk, 'data-git-hunk-header': '' }, hunk.header))
         }
         const lines = Array.isArray(hunk.lines) ? hunk.lines : []
         for (const line of lines) {
           if (line !== null && typeof line === 'object') rows.push(gitDiffLine(line))
         }
       }
       if (answer.truncated === true) rows.push(h('span', { key: 'truncated', style: GS.note }, 'Diff truncated'))
       if (rows.length === 0) rows.push(h('span', { key: 'empty', style: GS.note }, 'No diff to show'))
       return h('div', { style: GS.diff }, ...rows)
     }

     /** The Git tab body. The slot supplies sessionId, useTabInfo and useProjection. */
     function GitBody(props) {
       const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
       const tabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : {}
       const tabVisible = tabInfo?.tab?.visible
       const navigation = tabInfo?.tab?.navigation ?? null
       const tabSignal = tabInfo?.tab?.signal ?? null
       const [state, setState] = useState({})
       const [manual, setManual] = useState(0)
       const [collapsed, setCollapsed] = useState({})
       const [expanded, setExpanded] = useState({})
       const [diffs, setDiffs] = useState({})
       const [navRequest, setNavRequest] = useState(null)
       const [scrollPath, setScrollPath] = useState(null)
       const [scrollSeq, setScrollSeq] = useState(0)
       const alive = React.useRef(true)
       const diffInFlight = React.useRef({})
       const rowRef = React.useRef(null)
       const loadDiffRef = React.useRef(null)
       const localRevision = React.useRef(null)
       const bodyId = React.useRef(null)
       if (bodyId.current === null) {
         GIT_BODY_SEQ += 1
         bodyId.current = 'dsh-cs-git-' + GIT_BODY_SEQ
       }
       const tabId = tabInfo?.tab?.id
       const panelId = tabInfo?.panel?.id

       useEffect(() => () => { alive.current = false }, [])

       /* While this body is mounted, remember where its tab lives; a hidden tab unmounts
          but still exists, so the registry deliberately has no delete on cleanup. */
       useEffect(() => {
         if (typeof tabId !== 'string' || typeof panelId !== 'string') return undefined
         GIT_TAB_PANES.set(sessionId, { tabId, paneId: panelId })
         return undefined
       }, [sessionId, tabId, panelId])

       /* The main poll, exactly like the Environment body's: visible tab and session only,
          no overlapping requests, visibility changes and Refresh ask again. */
       useEffect(() => {
         if (!tabVisible || sessionId === '') return undefined
         let live = true
         let inFlight = false
         const load = async () => {
           if (!live || inFlight) return
           inFlight = true
           try {
             const answer = await gitFetchAnswer(sessionId)
             if (live) setState({ sessionId, data: answer })
           } catch (error) {
             if (live) {
               setState(current =>
                 current.sessionId === sessionId
                   ? { sessionId, data: current.data, error: messageOf(error) }
                   : { sessionId, error: messageOf(error) },
               )
             }
           } finally {
             inFlight = false
           }
         }
         if (visible()) load()
         const timer = setInterval(() => { if (visible()) load() }, GIT_REFRESH_MS)
         const onVisibility = () => { if (visible()) load() }
         const listening = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
         if (listening) document.addEventListener('visibilitychange', onVisibility)
         return () => {
           live = false
           clearInterval(timer)
           if (listening) document.removeEventListener('visibilitychange', onVisibility)
         }
       }, [sessionId, tabVisible, manual])

       /* One diff read per expansion. The session is captured so an old answer cannot land
          after a session switch, and unmount drops the answer entirely. */
       const loadDiff = (filePath, keepCurrent) => {
         const key = gitDiffKey(sessionId, filePath)
         if (diffInFlight.current[key]) return
         diffInFlight.current[key] = true
         if (keepCurrent !== true) setDiffs(current => ({ ...current, [key]: { loading: true } }))
         gitFetchAnswer(sessionId, filePath)
           .then(answer => {
             if (!alive.current) return
             setDiffs(current => ({ ...current, [key]: { data: answer } }))
           })
           .catch(error => {
             if (!alive.current) return
             setDiffs(current => ({ ...current, [key]: { error: messageOf(error) } }))
           })
           .finally(() => { diffInFlight.current[key] = false })
       }
       loadDiffRef.current = loadDiff

       /* navigation is a plain value delivered by useTabInfo(); a new revision re-renders
          the body. The tab signal survives hiding and remounts but is new on reopen. */
       useEffect(() => {
         const path = navigation?.params?.path
         if (typeof path !== 'string' || path === '') return
         const revision = navigation?.revision
         const handled = tabSignal !== null ? GIT_NAV_REVISIONS.get(tabSignal) : localRevision.current
         if (handled === revision) return
         if (tabSignal !== null) GIT_NAV_REVISIONS.set(tabSignal, revision)
         else localRevision.current = revision
         setNavRequest({ path, revision })
       }, [navigation?.revision, tabSignal])

       /* A session switch closes every open diff; answers themselves are keyed by session. */
       useEffect(() => { setExpanded({}) }, [sessionId])

       /* A path can arrive before this session's status answer; wait for that answer before
          deciding whether the path is known. An unknown path is ignored for good. */
       const current = state.sessionId === sessionId ? state : {}
       const files = Array.isArray(current.data?.files) ? current.data.files : []
       useEffect(() => {
         if (navRequest === null || current.data === undefined) return
         const known = files.some(file => file !== null && typeof file === 'object' && file.path === navRequest.path)
         if (known) {
           setExpanded(value => ({ ...value, [navRequest.path]: true }))
           setScrollPath(navRequest.path)
           setScrollSeq(value => value + 1)
           if (typeof loadDiffRef.current === 'function') loadDiffRef.current(navRequest.path)
         }
         setNavRequest(null)
       }, [navRequest, current.data, sessionId])

       /* The scroll runs on the render after the ref moved to the navigated row. */
       useEffect(() => {
         if (scrollSeq === 0) return
         const node = rowRef.current
         if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
           node.scrollIntoView({ block: 'nearest' })
         }
       }, [scrollSeq, scrollPath])

       const toggleSection = id => setCollapsed(value => ({ ...value, [id]: value[id] !== true }))
       const toggleFile = filePath => {
         const willOpen = expanded[filePath] !== true
         setExpanded(value => ({ ...value, [filePath]: willOpen }))
         const stored = diffs[gitDiffKey(sessionId, filePath)]
         if (willOpen && (!stored || stored.error)) loadDiff(filePath)
       }
       const refresh = () => {
         setManual(value => value + 1)
         for (const filePath of Object.keys(expanded)) if (expanded[filePath]) loadDiff(filePath, true)
       }

       const error = sessionId === '' ? 'No session' : current.error
       const busy = sessionId !== '' && state.sessionId !== sessionId
       const repo = current.data?.repo ?? null
       const isGit = current.data?.git === true
       const knownFiles = files.filter(file => file !== null && typeof file === 'object')
       const shownFiles = knownFiles.slice(0, 200)
       const more = Math.max(0, Number.isFinite(current.data?.total) ? current.data.total - shownFiles.length : 0)
       const commits = Array.isArray(current.data?.commits) ? current.data.commits : []

       const header = h(
         'div',
         { style: GS.header },
         h('span', { style: GS.branch },
           !isGit
             ? 'Not a git folder'
             : repo === null
               ? 'No commits yet'
               : repo.detached === true
                 ? 'detached at ' + (repo.head ?? '')
                 : String(repo.branch ?? ''),
         ),
         isGit && repo !== null && typeof repo.upstream === 'string' && repo.upstream !== ''
           ? h('span', { style: GS.upstream },
               repo.ahead > 0 ? '↑' + repo.ahead : '',
               repo.behind > 0 ? (repo.ahead > 0 ? ' ' : '') + '↓' + repo.behind : '',
             )
           : null,
         h('button', { type: 'button', style: GS.refresh, onClick: refresh }, 'Refresh'),
       )

       const fileRows = shownFiles.map((file, index) => {
         const filePath = typeof file.path === 'string' ? file.path : ''
         const letter = h('span', {
           style: { ...GS.letter, color: gitLetterColor(file.kind) },
         }, gitChangeLetter(file))
         const path = typeof file.origPath === 'string' && file.origPath !== filePath
           ? h('span', { style: GS.path, title: file.origPath + ' → ' + filePath },
               gitPathParts(file.origPath), ' → ', gitPathParts(filePath))
           : gitPathParts(filePath)
         const right = h('span', { style: GS.counts }, gitCountLabel(file))
         const isFolder = file.folder === true
         const ref = scrollPath === filePath ? rowRef : undefined
         const scroll = scrollPath === filePath ? filePath : undefined
         if (isFolder) {
           return h('div', { key: filePath, style: GS.row, 'data-git-path': filePath, 'data-git-scroll': scroll, ref },
             letter, path, right)
         }
         const open = expanded[filePath] === true
         const diffId = bodyId.current + '-diff-' + index
         const entry = diffs[gitDiffKey(sessionId, filePath)]
         const diff = h('div', {
           id: diffId,
           'data-git-diff': filePath,
           hidden: open ? undefined : true,
           style: open ? undefined : { display: 'none' },
         }, open && entry ? gitDiffBody(entry) : null)
         return h(
           'div',
           { key: filePath },
           h('button', {
             type: 'button',
             style: GS.rowButton,
             'data-git-path': filePath,
             'data-git-scroll': scroll,
             'aria-expanded': open ? 'true' : 'false',
             'aria-controls': diffId,
             ref,
             onClick: () => toggleFile(filePath),
           }, letter, path, right),
           diff,
         )
       })
       if (more > 0) fileRows.push(h('span', { key: 'more', style: GS.note }, 'and ' + more + ' more'))
       if (isGit && shownFiles.length === 0 && more === 0 && !current.error) {
         fileRows.push(h('span', { key: 'clean', style: GS.note }, 'No changes'))
       }

       const commitRows = commits.map(commit => {
         if (commit === null || typeof commit !== 'object') return null
         return h(
           'div',
           { key: String(commit.hash ?? ''), style: GS.commit, 'data-git-commit': String(commit.hash ?? ''), title: typeof commit.date === 'string' ? commit.date : undefined },
           h('span', { style: GS.commitHash }, String(commit.hash ?? '')),
           h('span', { style: GS.commitSubject, title: typeof commit.subject === 'string' ? commit.subject : undefined }, String(commit.subject ?? '')),
           h('span', { style: GS.commitDate }, gitRelativeDate(commit.date)),
         )
       })
       if (commitRows.length === 0 && isGit && !current.error) {
         commitRows.push(h('span', { key: 'no-commits', style: GS.note }, 'No commits yet'))
       }

       return h(
         'div',
         { style: GS.panel, 'aria-busy': busy ? 'true' : undefined },
         typeof error === 'string' ? h('p', { style: GS.error, role: 'status' }, error) : null,
         header,
         gitSection('changes', 'Changes', collapsed.changes !== true, () => toggleSection('changes'), fileRows),
         gitSection('commits', 'Commits', collapsed.commits !== true, () => toggleSection('commits'), commitRows),
       )
     }

     function mountGit(ctx) {
       ctx.effect(
         () =>
           ctx.sidebarRightTabs.register({
             id: GIT_TAB_ID,
             kind: GIT_KIND,
             title: () => 'Git',
             guide: [
               {
                 id: 'git',
                 order: 40,
                 title: () => 'Git',
                 description: () => "Branch, changed files with their diffs, and recent commits of this session's folder",
                 icon: GitIcon,
               },
             ],
           }),
         'git panel: sidebar tab type',
       )
       try {
         ctx.slots.inject(GIT_SLOT, () => ctx.slots.register({ name: GIT_SLOT, key: GIT_TAB_ID }, GitBody))
       } catch (error) {
         console.warn('git panel: this host has no "' + GIT_SLOT + '" slot', error)
       }
     }

     registerFeature({ name: 'git', inject: ['slots', 'sidebarRightTabs'], mount: mountGit })

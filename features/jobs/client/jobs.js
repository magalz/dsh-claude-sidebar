    /*
     * The Jobs tab: a right-sidebar tab that lists the background jobs of the open
     * session, streams the output of the one expanded job, and stops a running job.
     * Client-only: every row, stream and stop comes from ctx.jobs
     * (dsh-api-job-controller), passed through the slot registration's own inject face
     * exactly as the shipped job list does.
     *
     * dsh APIs used (0.2.2-rc.5):
     *   ctx.sidebarRightTabs.register(...)          dsh-client-ui-sidebar-right README.md:85
     *   ctx.slots.inject / ctx.slots.register(...)  README.md:86
     *   registration inject() -> props, hooks -> use<Name>
     *                                              dsh-client-ui-jobs src/client/index.ts:43-50
     *   slot "sidebar.right.pane.tab" body props    (sessionId, useTabInfo)
     *   ctx.jobs state/watchRows/observe/kill       dsh-api-job-controller src/client/service.ts:49-76
     *   theme tokens with fallbacks                 dsh-rightbar-quicknav client.js:1115-1116
     */

    /* React and h come from shared.js; the output tail needs a ref. */
    const { useRef } = React

    /** This implementation's identity; also the key its body registers under. */
    const TAB_ID = 'dsh-claude-sidebar/jobs'
    /** The type openTab() names. */
    const KIND = 'claude-sidebar-jobs'
    const SLOT = 'sidebar.right.pane.tab'
    /** How long the first stop press stays armed. */
    const CONFIRM_MS = 3_000
    /** How often a live duration refreshes while the tab is visible. */
    const TICK_MS = 1_000

    /* Theme tokens only, each with a fallback so a renamed token degrades instead of
       breaking: light/dark both come from the host's --dsw-alias-* aliases. */
    const S = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        minHeight: 0,
        overflow: 'auto',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      note: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
      },
      header: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        width: '100%',
        minWidth: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      line: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      status: { fontSize: 11.5, flex: 'none' },
      kind: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, inherit)', flex: 'none' },
      command: {
        fontFamily: MONO,
        fontSize: 12,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        flex: '1 1 auto',
      },
      duration: {
        marginLeft: 'auto',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        flex: 'none',
      },
      meta: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, inherit)', wordBreak: 'break-word' },
      detail: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 0 2px 10px' },
      error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, inherit)' },
      stop: {
        alignSelf: 'flex-start',
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        background: 'transparent',
        color: 'var(--dsw-alias-state-warn-primary, #c98a00)',
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
      pre: {
        margin: 0,
        maxHeight: 320,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        borderRadius: 8,
        padding: 8,
      },
    }

    /* The escape grammar a terminal output tail can carry, in removal order: OSC covers a
       terminal title and ends at BEL, ESC backslash, the next ESC or the end of the text;
       CSI covers colors and clear-line (parameter bytes 0x30-0x3F, intermediate 0x20-0x2F,
       one final byte 0x40-0x7E); then the character-set selections and the other
       two-character escapes. A tail cut mid-sequence is removed from its end. */
    const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b)|$)/g
    const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
    const CHARSET = /\u001b[()*+](?:[ -~])?/g
    const TWO_CHARACTER_ESCAPE = /\u001b[@-Z\\^_]/g
    const CUT_ESCAPE = /\u001b(?:$|\[[0-?]*[ -/]*$)/g
    /* C0 controls other than tab, newline and carriage return, plus DEL. */
    const C0_AND_DEL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

    /** Per-body region-id prefix, so aria-controls stays unique across panes. */
    let bodySeq = 0

    /**
     * Whether a job is still live: running, or stopping after a kill was asked for.
     * @param {object | undefined} job
     * @returns {boolean}
     */
    function isLive(job) {
      return (
        job !== null &&
        job !== undefined &&
        (job.status === 'running' || job.status === 'stopping')
      )
    }

    /**
     * A job's start as a comparable number; a missing or malformed value sorts as 0.
     * @param {object | undefined} job
     * @returns {number}
     */
    function startedAtOf(job) {
      const value = job === null || job === undefined ? Number.NaN : Number(job.startedAt)
      return Number.isFinite(value) ? value : 0
    }

    /**
     * Sort jobs for display: live work first, then the rest; newest startedAt first
     * inside each group. Never mutates the input.
     * @param {readonly object[] | undefined} rows
     * @returns {object[]}
     */
    function sortJobs(rows) {
      const list = Array.isArray(rows) ? rows.slice() : []
      return list.sort((a, b) => {
        const liveA = isLive(a)
        const liveB = isLive(b)
        if (liveA !== liveB) return liveA ? -1 : 1
        return startedAtOf(b) - startedAtOf(a)
      })
    }

    /**
     * The visible label, palette tone and dot form for one job status.
     * @param {object | undefined} job
     * @returns {{ label: string, tone: 'active' | 'warn' | 'success' | 'idle' | 'error', hollow: boolean }}
     */
    function statusInfo(job) {
      const status = job === null || job === undefined ? '' : job.status
      if (status === 'running') return { label: 'Running', tone: 'active', hollow: false }
      if (status === 'stopping') return { label: 'Stopping', tone: 'warn', hollow: false }
      if (status === 'completed') return { label: 'Completed', tone: 'success', hollow: false }
      if (status === 'killed') return { label: 'Stopped', tone: 'idle', hollow: true }
      if (status === 'failed') return { label: 'Failed', tone: 'error', hollow: false }
      return { label: 'Unknown', tone: 'idle', hollow: true }
    }

    /**
     * A compact duration: '12s', '3m 05s', '1h 02m'. Negative or non-finite is '0s'.
     * @param {number} ms
     * @returns {string}
     */
    function formatDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return '0s'
      const total = Math.floor(value / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm'
      if (minutes > 0) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's'
      return total + 's'
    }

    /**
     * The text a terminal leaves after progress-line carriage returns: the last non-empty
     * segment of the line, so a trailing `\r` never blanks the line.
     * @param {string} line
     * @returns {string}
     */
    function progressLine(line) {
      const segments = line.split('\r')
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (segments[i] !== '') return segments[i]
      }
      return ''
    }

    /**
     * Plain display text from a job output tail: strip the escape grammar a terminal can
     * emit, drop the remaining C0 controls and DEL, normalize line endings, then resolve
     * progress-line carriage returns.
     * @param {unknown} text
     * @returns {string}
     */
    function cleanOutput(text) {
      if (typeof text !== 'string') return ''
      return text
        .replace(OSC, '')
        .replace(CSI, '')
        .replace(CHARSET, '')
        .replace(TWO_CHARACTER_ESCAPE, '')
        .replace(CUT_ESCAPE, '')
        .replace(C0_AND_DEL, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(progressLine)
        .join('\n')
    }

    /**
     * One row's duration text: a settled job uses finishedAt, a live one the clock.
     * @param {object} job
     * @param {number} now
     * @returns {string}
     */
    function durationOf(job, now) {
      const start = typeof job.startedAt === 'number' && Number.isFinite(job.startedAt) ? job.startedAt : now
      const end =
        typeof job.finishedAt === 'number' && Number.isFinite(job.finishedAt) ? job.finishedAt : now
      return formatDuration(end - start)
    }

    /**
     * The Jobs tab's guide icon: a play mark inside a rounded square, drawn in the
     * current text color and sized by props.size.
     * @param {{ size?: number }} [props]
     */
    function JobsIcon(props) {
      const size = props.size ?? 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2.5 }),
        h('path', { d: 'M6.5 5.6L10.4 8l-3.9 2.4z' }),
      )
    }

    /**
     * The expanded part of one row: the live output tail and, while the job runs, the
     * two-press stop control. It is its own component so the parent calls no hook in
     * the changing loop over rows.
     * @param {object} props - id, sessionId, job, tabVisible, useJobs, observe, killJob.
     */
    function JobDetail(props) {
      const job = props.job
      const id = String(job.id)
      const useJobs = props.useJobs
      const observed = useJobs(state => state.observed[id])
      const text = cleanOutput(observed === null || observed === undefined ? '' : observed.text)
      const gapBefore = observed !== null && observed !== undefined && observed.gapBefore === true
      const error =
        observed !== null && observed !== undefined && typeof observed.error === 'string' ? observed.error : ''
      const [confirming, setConfirming] = useState(false)
      const [stopError, setStopError] = useState(false)
      const preRef = useRef(null)
      const stickRef = useRef(true)

      useEffect(() => {
        if (!props.tabVisible) return undefined
        return props.observe(props.sessionId, job.id)
      }, [props.sessionId, id, props.tabVisible])

      /* The confirm state reverts by itself after CONFIRM_MS; leaving it, or the row,
         clears the timer. */
      useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
        return () => clearTimeout(timer)
      }, [confirming])

      /* Follow the output while the user stays at the end; a scrolled-up user keeps
         their position. */
      useEffect(() => {
        if (stickRef.current !== true) return
        const node = preRef.current
        node.scrollTop = node.scrollHeight
      }, [text])

      const onScroll = event => {
        const node = event.currentTarget
        stickRef.current = !(node.scrollHeight - node.scrollTop - node.clientHeight > 8)
      }

      const parts = []
      if (job.status === 'running') {
        parts.push(
          h(
            'button',
            {
              key: 'stop',
              type: 'button',
              style: S.stop,
              onClick: async () => {
                if (!confirming) {
                  setStopError(false)
                  setConfirming(true)
                  return
                }
                setConfirming(false)
                try {
                  const ok = await props.killJob(props.sessionId, job.id)
                  if (ok !== true) setStopError(true)
                } catch {
                  setStopError(true)
                }
              },
            },
            confirming ? 'Confirm stop' : 'Stop',
          ),
        )
      }
      if (gapBefore) parts.push(h('p', { key: 'gap', style: S.note }, 'Earlier output was dropped'))
      if (error !== '') parts.push(h('p', { key: 'error', style: S.error, role: 'status' }, error))
      parts.push(
        h(
          'pre',
          { key: 'output', ref: preRef, tabIndex: 0, style: S.pre, onScroll },
          text === '' && error === '' ? 'No output yet' : text,
        ),
      )
      if (stopError) {
        parts.push(h('p', { key: 'stop-error', style: S.error, role: 'status' }, 'Could not stop the job'))
      }
      return h('div', { id: props.id, style: S.detail }, parts)
    }

    /**
     * One row: its header button toggles the row, the expanded body renders its output.
     * @param {object} job
     * @param {object} view - sessionId, regionPrefix, now, expanded, tabVisible, useJobs,
     *   observe, killJob, onToggle.
     */
    function jobRow(job, view) {
      const id = String(job.id)
      const info = statusInfo(job)
      /* Only the loud statuses color their label; the rest keep the ordinary text color. */
      const tinted = info.tone === 'error' || info.tone === 'warn'
      const live = isLive(job)
      const secondary = live ? job.progress : job.detail
      const label = job.label === null || job.label === undefined ? '' : String(job.label)
      const kind = job.kind === null || job.kind === undefined ? '' : String(job.kind)
      const regionId = view.regionPrefix + '-' + id
      return h(
        'section',
        { key: id, style: S.row },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': view.expanded,
            'aria-label': info.label + ': ' + label,
            'aria-controls': view.expanded ? regionId : undefined,
            onClick: view.onToggle,
            style: S.header,
          },
          h(
            'span',
            { style: S.line },
            h('span', { style: stateMark(info.tone, info.hollow) }),
            h('span', { style: tinted ? { ...S.status, color: STATE_TONE[info.tone] } : S.status }, info.label),
            h('span', { style: S.kind }, kind),
            h('span', { style: S.duration }, durationOf(job, view.now)),
          ),
          h('span', { style: S.command, title: label }, label),
          typeof secondary === 'string' && secondary !== '' ? h('span', { style: S.meta }, secondary) : null,
        ),
        view.expanded
          ? h(JobDetail, {
              key: id,
              id: regionId,
              sessionId: view.sessionId,
              job,
              tabVisible: view.tabVisible,
              useJobs: view.useJobs,
              observe: view.observe,
              killJob: view.killJob,
            })
          : null,
      )
    }

    /** The tab body. The slot supplies sessionId and the useTabInfo hook. */
    function JobsBody(props) {
      const sessionId = props.sessionId
      const tabInfo = props.useTabInfo()
      const tabVisible = tabInfo.tab.visible
      const useJobs = props.useJobs
      const rows = useJobs(state => state.rows[String(sessionId)])
      const jobs = sortJobs(rows)
      const [expandedId, setExpandedId] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const regionRef = useRef(null)
      if (regionRef.current === null) {
        bodySeq += 1
        regionRef.current = 'dsh-cs-jobs-' + bodySeq
      }
      const regionPrefix = regionRef.current

      useEffect(() => {
        return props.watchRows(sessionId)
      }, [sessionId])

      const live = jobs.some(isLive)
      useEffect(() => {
        if (!live || !tabVisible) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(timer)
      }, [live, tabVisible])

      if (jobs.length === 0) {
        return h(
          'div',
          { style: S.panel, role: 'status' },
          h('p', { style: S.note }, 'No background jobs in this session'),
        )
      }
      return h(
        'div',
        { style: S.panel },
        jobs.map(job =>
          jobRow(job, {
            sessionId,
            regionPrefix,
            now,
            expanded: expandedId === String(job.id),
            tabVisible,
            useJobs,
            observe: props.observe,
            killJob: props.killJob,
            onToggle: () =>
              setExpandedId(current => (current === String(job.id) ? null : String(job.id))),
          }),
        ),
      )
    }

    function mount(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => 'Jobs',
            guide: [
              {
                id: 'jobs',
                order: 35,
                title: () => 'Jobs',
                description: () => 'Background jobs of this session and their live output',
                icon: JobsIcon,
              },
            ],
          }),
        'jobs panel: sidebar tab type',
      )

      // The body seat belongs to the right sidebar; a host without it keeps the plugin quiet.
      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              key: TAB_ID,
              inject: () => ({
                hooks: { jobs: ctx.jobs.state },
                watchRows: sessionId => ctx.jobs.watchRows(sessionId),
                observe: (sessionId, id) => ctx.jobs.observe(sessionId, id),
                killJob: async (sessionId, id) => (await ctx.jobs.kill(sessionId, id)).ok,
              }),
            },
            JobsBody,
          ),
        )
      } catch (error) {
        console.warn('jobs panel: this host has no "' + SLOT + '" slot', error)
      }
    }

    registerFeature({ name: 'jobs', inject: ['slots', 'sidebarRightTabs', 'jobs'], mount })

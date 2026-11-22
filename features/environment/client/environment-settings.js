    /* Environment group 2/5 — environment-settings.js: the Environment row's Configure page.
     *
     * dsh's Plugins page shows a Configure control on a row whose browser half registers
     * plugins.row.config under <package name>#<row id>. The page owner calls the view with
     * view 'summary' (one line) or 'page' (the form), and passes a form only when the row's
     * namespace is exposed. Everything here stays in the browser half: no dsh client import,
     * nothing appended to document.body, and React only through the shared h() helper.
     *
     * dsh APIs used (0.2.2-rc.5):
     *   ctx.slots.inject / ctx.slots.register    README.md:86; the page slot may not exist
     *                                             yet, so inject() waits for it;
     *   form.state / form.mutate(ops, revision)   dsh-client-ui-plugin-manager slot-contract.ts
     */

    /** The row slot and its key; KIND is the Environment row's id declared in environment-base.js. */
    const CONFIG_SLOT = 'plugins.row.config'
    const CONFIG_KEY = 'dsh-claude-sidebar#' + KIND

    /** The three volatile fields the row's Config declares in features/environment/host.js. */
    const SETTINGS_FIELDS = ['taskFacts', 'trackerUrl', 'registryPath']
    const SETTINGS_DEFAULTS = { taskFacts: false, trackerUrl: '', registryPath: '' }
    /** A tracked revision that no page owner can supply: re-arms the follow effect after a save. */
    const FOLLOW_AGAIN = Symbol('settings-follow-again')

    const SETTINGS_COPY = {
      off: 'Task facts: off',
      on: 'Task facts: on',
      unavailable: 'Turn the Environment tab row on to change these settings.',
      loading: 'Loading…',
      refused: 'Could not save: the settings changed elsewhere. Reload the page and try again.',
      taskFacts: 'Show task facts',
      taskFactsHelp: "Show the tracker card named by the branch and the work tree's progress file in the Environment tab.",
      trackerUrl: 'Tracker web address',
      trackerUrlHelp: 'Used to link cards; leave empty for cards without links.',
      registryPath: 'Registry path',
      registryPathHelp: 'Path of the itsaplan link registry; leave empty for the default.',
      save: 'Save',
      saved: 'Saved',
    }

    /* Theme tokens only, each with a fallback so a renamed token degrades instead of
       breaking. These are the same aliases the rest of the Environment panel uses. */
    const SETTINGS_STYLE = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' },
      help: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, inherit)' },
      note: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' },
      checkbox: { margin: 0, accentColor: 'var(--dsw-alias-brand-primary, #4f6ef7)' },
      input: {
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 13,
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))',
        borderRadius: 4,
      },
      save: {
        alignSelf: 'flex-start',
        font: 'inherit',
        fontSize: 13,
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary, #4f6ef7)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary, #4f6ef7)',
        cursor: 'pointer',
      },
      saveDisabled: {
        cursor: 'default',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        borderColor: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))',
      },
      saved: { fontSize: 12, color: STATE_TONE.success },
      failed: { fontSize: 12, color: STATE_TONE.error },
    }

    /** Per-mount ids, so a label's htmlFor stays paired with its input across renders. */
    let settingsSeq = 0

    /**
     * The draft always holds all three fields, even when the snapshot omits one. Text is
     * trimmed here so the baseline and the draft compare and save the same way.
     */
    function settingsDraft(value) {
      return {
        taskFacts: value?.taskFacts === true,
        trackerUrl: typeof value?.trackerUrl === 'string' ? value.trackerUrl.trim() : '',
        registryPath: typeof value?.registryPath === 'string' ? value.registryPath.trim() : '',
      }
    }

    function settingsEqual(a, b) {
      return a.taskFacts === b.taskFacts && a.trackerUrl === b.trackerUrl && a.registryPath === b.registryPath
    }

    function settingsTrim(draft) {
      return {
        taskFacts: draft.taskFacts === true,
        trackerUrl: draft.trackerUrl.trim(),
        registryPath: draft.registryPath.trim(),
      }
    }

    /**
     * One op per field the user changed, measured against the snapshot the draft was read
     * from — not against a newer accepted value, which would overwrite another writer's
     * edit. `next` is already trimmed by settingsTrim().
     */
    function settingsOps(next, baseline) {
      const ops = []
      for (const field of SETTINGS_FIELDS) {
        const value = next[field]
        if (value === baseline[field]) continue
        ops.push(
          value === SETTINGS_DEFAULTS[field]
            ? { op: 'unset', path: [field] }
            : { op: 'set', path: [field], value },
        )
      }
      return ops
    }

    /**
     * The View registered for the Environment row. A summary is one line; the page owns
     * its own form and Save control (the page frame draws title, icon and breadcrumb).
     */
    function EnvironmentSettingsView(props) {
      const form = props?.form
      const state = form?.state
      const accepted = state?.value
      const ready = Boolean(form && state && state.status === 'ready' && accepted !== undefined && accepted !== null)
      const draftOfState = () => settingsDraft(accepted)

      const [draft, setDraft] = useState(draftOfState)
      /** Snapshot the draft was last based on; comparing against it decides "unsaved". */
      const [baseline, setBaseline] = useState(draftOfState)
      const [revision, setRevision] = useState(() => (state ? state.revision : undefined))
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState('')
      /* React batches state, so a second click in the same turn still sees saving === false. */
      const inFlight = React.useRef(false)
      /* The revision the last accepted save was made against; until a newer one arrives, the
         snapshot still holds the old values and must not replace what was just saved. */
      const savedFrom = React.useRef(undefined)
      const ids = React.useMemo(() => {
        settingsSeq += 1
        const prefix = 'dsh-claude-sidebar-settings-' + settingsSeq + '-'
        return { taskFacts: prefix + 'task-facts', trackerUrl: prefix + 'tracker-url', registryPath: prefix + 'registry-path' }
      }, [])

      /* Follow a newly accepted state only while there are no unsaved edits of our own.
         Both the draft and its baseline move together, so a later edit stays detectable. */
      useEffect(() => {
        if (!ready) return undefined
        if (state.revision === revision) return undefined
        if (revision === FOLLOW_AGAIN && state.revision === savedFrom.current) return undefined
        if (!settingsEqual(settingsTrim(draft), baseline)) return undefined
        const next = settingsDraft(accepted)
        setDraft(next)
        setBaseline(next)
        setRevision(state.revision)
        return undefined
      }, [state ? state.revision : undefined, accepted, revision])

      if (props?.view === 'summary') {
        return accepted?.taskFacts === true ? SETTINGS_COPY.on : SETTINGS_COPY.off
      }
      if (!form || !state || state.status === 'unavailable') {
        return h('p', { style: SETTINGS_STYLE.note }, SETTINGS_COPY.unavailable)
      }
      if (state.status === 'loading' || !accepted) {
        return h('p', { style: SETTINGS_STYLE.note }, SETTINGS_COPY.loading)
      }

      const trimmed = settingsTrim(draft)
      const unsaved = !settingsEqual(trimmed, baseline)
      const disabled = !unsaved || saving || state.writable !== true
      const update = (field, value) => {
        setDraft(current => ({ ...current, [field]: value }))
        setMessage('')
      }
      const save = () => {
        if (disabled || inFlight.current) return
        const ops = settingsOps(trimmed, baseline)
        inFlight.current = true
        setDraft(trimmed)
        setSaving(true)
        setMessage('')
        const revisionAtSave = state.revision
        Promise.resolve()
          .then(() => form.mutate(ops, revisionAtSave))
          .then(
            ok => {
              inFlight.current = false
              setSaving(false)
              if (ok === true) {
                setBaseline(trimmed)
                /* The page owner may have accepted before this promise settled, while the
                   draft still had unsaved edits; re-arm the follow effect to adopt it. */
                savedFrom.current = revisionAtSave
                setRevision(FOLLOW_AGAIN)
                setMessage(SETTINGS_COPY.saved)
              } else {
                setMessage(SETTINGS_COPY.refused)
              }
            },
            error => {
              inFlight.current = false
              setSaving(false)
              setMessage('Could not save: ' + messageOf(error))
            },
          )
      }
      const help = (id, text) => h('span', { id: id + '-help', style: SETTINGS_STYLE.help }, text)
      const textField = (field, label, placeholder, helpText) =>
        h(
          'div',
          { style: SETTINGS_STYLE.field, key: field },
          h('label', { htmlFor: ids[field], style: SETTINGS_STYLE.label }, label),
          h('input', {
            id: ids[field],
            type: 'text',
            value: draft[field],
            placeholder,
            'aria-describedby': ids[field] + '-help',
            onChange: event => update(field, event.target.value),
            style: SETTINGS_STYLE.input,
          }),
          help(ids[field], helpText),
        )

      return h(
        'div',
        { style: SETTINGS_STYLE.root },
        h(
          'div',
          { style: SETTINGS_STYLE.field, key: 'taskFacts' },
          h('label', { htmlFor: ids.taskFacts, style: SETTINGS_STYLE.label }, SETTINGS_COPY.taskFacts),
          h('input', {
            id: ids.taskFacts,
            type: 'checkbox',
            checked: draft.taskFacts,
            'aria-describedby': ids.taskFacts + '-help',
            onChange: event => update('taskFacts', event.target.checked === true),
            style: SETTINGS_STYLE.checkbox,
          }),
          help(ids.taskFacts, SETTINGS_COPY.taskFactsHelp),
        ),
        textField('trackerUrl', SETTINGS_COPY.trackerUrl, 'https://tracker.example.com', SETTINGS_COPY.trackerUrlHelp),
        textField('registryPath', SETTINGS_COPY.registryPath, '~/.claude/itsaplan/links.json', SETTINGS_COPY.registryPathHelp),
        h(
          'button',
          {
            type: 'button',
            disabled,
            onClick: save,
            style: disabled ? { ...SETTINGS_STYLE.save, ...SETTINGS_STYLE.saveDisabled } : SETTINGS_STYLE.save,
          },
          SETTINGS_COPY.save,
        ),
        message
          ? h('p', { key: 'status', role: 'status', style: message === SETTINGS_COPY.saved ? SETTINGS_STYLE.saved : SETTINGS_STYLE.failed }, message)
          : null,
      )
    }

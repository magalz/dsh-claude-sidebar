    /* Environment group 3/4 — environment-connectors.js: the Connectors section. */
    /**
     * The label for a failed connector's reason when it carries no lastError. The MCP
     * client names 'gave-up', 'reconnect-disabled' or 'unclosed-generation'; any other
     * string is shown as it is, and a non-string reason has no label.
     * @param {unknown} reason
     * @returns {string | null}
     */
    function failedReasonLabel(reason) {
      if (reason === 'gave-up') return 'gave up reconnecting'
      if (reason === 'reconnect-disabled') return 'reconnect disabled'
      if (reason === 'unclosed-generation') return 'previous connection did not close'
      return typeof reason === 'string' ? reason : null
    }

    /** The plug icon of the Connectors strip item. */
    function PlugIcon() {
      return lineIcon(
        h('path', { d: 'M5.5 1.5v3M10.5 1.5v3' }),
        h('path', { d: 'M3.5 4.5h9V6a4.5 4.5 0 0 1-9 0z' }),
        h('path', { d: 'M8 10.5v4' }),
      )
    }

    /**
     * The letter a connector's avatar shows: the first letter or digit of its name,
     * uppercased, or '?' when the name has neither.
     * @param {unknown} name
     * @returns {string}
     */
    function connectorInitial(name) {
      if (typeof name !== 'string') return '?'
      for (const character of name) {
        if (/[\p{L}\p{N}]/u.test(character)) return Array.from(character.toUpperCase())[0]
      }
      return '?'
    }

    /**
     * The details of a connector row: its state, tool count, attempt or error, or
     * the pinned sentence. Null for a state the section does not name.
     * @param {{ state?: unknown, toolCount?: unknown, attempt?: unknown, error?: unknown, reason?: unknown }} connector
     * @returns {string | null}
     */
    function connectorDetails(connector) {
      const tools =
        typeof connector.toolCount === 'number'
          ? connector.toolCount + (connector.toolCount === 1 ? ' tool' : ' tools')
          : null
      const error = typeof connector.error === 'string' && connector.error !== '' ? connector.error : null
      if (connector.state === 'connected') {
        return tools === null ? 'connected' : 'connected · ' + tools
      }
      if (connector.state === 'pinned') {
        return (tools === null ? 'pinned' : 'pinned · ' + tools) + '. ' + PINNED_NOTE
      }
      if (connector.state === 'connecting' || connector.state === 'reconnecting') {
        let details = connector.state
        if (typeof connector.attempt === 'number') details += ' · attempt ' + connector.attempt
        if (error !== null) details += ' · ' + error
        return details
      }
      if (connector.state === 'waiting-credentials') {
        return error === null ? 'waiting for credentials' : 'waiting for credentials · ' + error
      }
      if (connector.state === 'failed') {
        const reason = error ?? failedReasonLabel(connector.reason)
        return reason === null ? 'failed' : 'failed · ' + reason
      }
      if (connector.state === 'disabled' || connector.state === 'closed') return 'off'
      return null
    }

    /**
     * The right-side state text of a connector row, and whether it warns.
     * Connected and pinned rows carry no right-side text.
     * @param {unknown} state
     * @returns {{ text: string, warn: boolean } | null}
     */
    function connectorState(state) {
      if (state === 'connecting' || state === 'reconnecting') return { text: 'Connecting…', warn: false }
      if (state === 'waiting-credentials') return { text: 'Sign in', warn: true }
      if (state === 'failed') return { text: 'Failed', warn: true }
      if (state === 'disabled' || state === 'closed') return { text: 'Off', warn: false }
      return null
    }

    /**
     * The service's own error text. A RemoteError reaches the browser as an error object
     * from another realm (or as a plain { message } after serialization), so the message is
     * read off the object instead of relying on a local instanceof Error.
     * @param {unknown} error
     * @returns {string}
     */
    function errorMessageOf(error) {
      return error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : messageOf(error)
    }

    /** The message a failed connector action shows: at most 200 characters. */
    function actionErrorMessage(error) {
      return errorMessageOf(error).slice(0, ACTION_ERROR_MAX)
    }

    /**
     * A failed save's message: scrub every attempted value from the full text first, then
     * bound it. Longer values go first so a short value nested in a longer one cannot leave
     * a suffix behind, and a value straddling character 200 is still removed.
     * @param {unknown} error
     * @param {string[]} values - the non-empty values that were sent.
     * @returns {string}
     */
    function credentialErrorMessage(error, values) {
      let text = errorMessageOf(error)
      const longestFirst = values.slice().sort((left, right) => right.length - left.length)
      for (const value of longestFirst) {
        if (value !== '') text = text.split(value).join('[redacted]')
      }
      return text.slice(0, ACTION_ERROR_MAX)
    }

    /**
     * The inline form under a waiting row: one labeled password input per credential name,
     * then Save and Cancel. The row's status region stays a sibling, so a failed save reuses
     * it without moving the row or its Sign in button.
     * @param {{ name: string, credentials: string[], values: object, saving: boolean }} form
     * @param {{ id: string, firstInputRef: object, change: Function, save: Function, cancel: Function }} options
     * @returns {object}
     */
    function credentialForm(form, options) {
      const saving = form.saving === true
      return h(
        'div',
        {
          key: 'signin-' + form.name,
          id: options.id,
          style: S.credentialForm,
          'data-credential-form': form.name,
        },
        form.credentials.map((name, index) =>
          h(
            'label',
            { key: name, style: S.credentialLabel },
            h('span', { style: S.credentialLabelText }, name),
            h('input', {
              ref: index === 0 ? options.firstInputRef : undefined,
              style: S.credentialInput,
              type: 'password',
              value: form.values[name] ?? '',
              autoComplete: 'off',
              spellCheck: false,
              readOnly: saving,
              'aria-disabled': saving ? 'true' : undefined,
              'aria-label': name,
              onChange: event => options.change(name, event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { style: S.credentialActions },
          h(
            'button',
            {
              type: 'button',
              style: saving ? S.credentialPending : S.credentialButton,
              'aria-disabled': saving ? 'true' : undefined,
              onClick: options.save,
            },
            'Save',
          ),
          h(
            'button',
            { type: 'button', style: S.credentialButton, disabled: saving, onClick: options.cancel },
            'Cancel',
          ),
        ),
      )
    }

    /**
     * One connector row: its letter avatar, its name, its details and its right side. While
     * the Host's manager is reachable and the row is a failed or closed managed server, the
     * right side is the Reconnect action; while the credential service is reachable and the
     * row is waiting with names from the route, it is Sign in. A pinned row keeps neither.
     * Every other state keeps its state word.
     * @param {{ state?: unknown, credentials?: unknown }} connector
     * @param {number} index
     * @param {{ action?: { pending?: boolean, error?: string } | undefined, restart?: ((name: string) => void) | null, signIn?: Function | null, form?: object | null, buttonRef?: object }} options
     * @returns {object}
     */
    function connectorRow(connector, index, options) {
      const name = String(connector.name ?? '')
      const details = connectorDetails(connector)
      const action = options.action
      const pending = action !== undefined && action.pending === true
      const restartable =
        typeof options.restart === 'function' && (connector.state === 'failed' || connector.state === 'closed')
      const credentials = Array.isArray(connector.credentials)
        ? connector.credentials.filter(value => typeof value === 'string' && value !== '')
        : []
      const signIn =
        !restartable &&
        connector.state === 'waiting-credentials' &&
        credentials.length > 0 &&
        typeof options.signIn === 'function'
      const expanded = signIn && options.form !== null && options.form?.name === name
      const saving = options.form?.saving === true
      const state = connectorState(connector.state)
      return h(
        'div',
        {
          key: index,
          style: S.row,
          title: details === null ? name : name + ' · ' + details,
          'data-connector-state': String(connector.state ?? ''),
        },
        h('span', { style: S.connectorAvatar, 'aria-hidden': 'true' }, connectorInitial(connector.name)),
        h('span', { style: S.rowText }, name),
        details === null ? null : h('span', { style: S.visuallyHidden }, details),
        restartable
          ? h(
              'button',
              {
                type: 'button',
                style: pending ? S.reconnectPending : S.reconnect,
                'aria-label': RECONNECT_LABEL + ' ' + name,
                'aria-disabled': pending ? 'true' : undefined,
                onClick: () => options.restart(name),
              },
              pending ? RECONNECT_PENDING_LABEL : RECONNECT_LABEL,
            )
          : signIn
            ? h(
                'button',
                {
                  type: 'button',
                  style: S.reconnect,
                  'aria-label': SIGNIN_LABEL + ' to ' + name,
                  'aria-expanded': expanded ? 'true' : 'false',
                  'aria-controls': expanded ? options.formId : undefined,
                  'aria-disabled': saving ? 'true' : undefined,
                  ref: options.buttonRef,
                  onClick: () => options.signIn(name, credentials),
                },
                SIGNIN_LABEL,
              )
            : state === null
              ? null
              : h(
                  'span',
                  {
                    style: state.warn ? { ...S.rowRight, color: STATE_TONE.warn } : S.rowRight,
                    'aria-hidden': 'true',
                  },
                  state.text,
                ),
      )
    }

    /**
     * One connector row, its optional credential form and, under both, the status region
     * shared by Reconnect and Sign in. The wrapper is always the same shape: adding or
     * clearing a message changes only the region's text and style, so React keeps the row's
     * DOM nodes — and the action button's keyboard focus — in place. The region is always in
     * the tree, empty and boxless until there is a message, so a screen reader announces the
     * text when it appears. The per-connector state is the body's, keyed by name, so it
     * survives a poll and a re-render.
     * @param {object} connector
     * @param {number} index
     * @param {{ restart: ((name: string) => void) | null, signIn: Function | null, actions: object, form: object | null }} options
     * @returns {object}
     */
    function connectorEntry(connector, index, options) {
      const name = String(connector.name ?? '')
      const action = options.actions[name]
      const form =
        options.form !== null &&
        options.form.name === name &&
        connector.state === 'waiting-credentials' &&
        options.signIn !== null
          ? options.form
          : null
      const formId = options.formPrefix + '-' + index
      const row = connectorRow(connector, index, {
        action,
        restart: options.restart,
        signIn: options.signIn,
        form,
        formId,
        buttonRef: options.buttonRef(name),
      })
      const restartError = action !== undefined && typeof action.error === 'string' ? action.error : null
      const error = form !== null && typeof form.error === 'string' ? form.error : restartError
      return h(
        'div',
        { key: index, style: S.connectorItem },
        row,
        form === null
          ? null
          : credentialForm(form, {
              id: formId,
              firstInputRef: options.firstInputRef,
              change: options.change,
              save: options.save,
              cancel: options.cancel,
            }),
        h('p', { style: error === null ? S.actionStatusEmpty : S.actionError, role: 'status' }, error),
      )
    }

    /**
     * The Connectors body: avatar rows, at most three at first, Reconnect on failed or closed
     * managed servers while the Host's manager is reachable, and Sign in on waiting rows whose
     * route answer names credentials while the Remote credential service is reachable. Both
     * actions ask the Environment route again on success; a failure leaves its message under
     * the row until a click succeeds or the row's state changes.
     */
    function ConnectorsBody(props) {
      const [expanded, setExpanded] = useState(false)
      const [actions, setActions] = useState({})
      const [, setActionTick] = useState(0)
      const [signIn, setSignIn] = useState(null)
      /* The synchronous double-click guard: state would only reflect the second click on the
         next render, which a fast double click does not wait for. */
      const inFlight = React.useRef({})
      const lastStates = React.useRef(null)
      /* One ref per row's Sign in button, so focus can return to the one that opened the form. */
      const signInRefs = React.useRef({})
      const firstInputRef = React.useRef(null)
      const focusName = React.useRef(null)
      const saveInFlight = React.useRef(false)
      const formPrefix = React.useRef(null)
      if (formPrefix.current === null) {
        signInSeq += 1
        formPrefix.current = 'dsh-cs-env-signin-' + signInSeq
      }
      const buttonRef = name => {
        if (signInRefs.current[name] === undefined) signInRefs.current[name] = { current: null }
        return signInRefs.current[name]
      }
      const restartConnector = typeof props.restartConnector === 'function' ? props.restartConnector : null
      const saveCredential = typeof props.saveCredential === 'function' ? props.saveCredential : null
      const data = props.data
      const connectors = data?.connectors
      const list = Array.isArray(connectors)
        ? connectors.filter(connector => connector !== null && typeof connector === 'object')
        : []
      /* The handles are fixed at mount, so availability is read on every render instead:
         either Remote service may appear or go after the body mounted. */
      const restartAvailable = restartConnector !== null && restartConnector.available() === true
      const saveAvailable = saveCredential !== null && saveCredential.available() === true
      /* A click held from an earlier render (a button the poll has since changed) must read
         the current rows and form, not the ones it was rendered against. */
      const latest = React.useRef({ list, signIn, saveAvailable })
      latest.current = { list, signIn, saveAvailable }

      /* Repaint when either scoped service appears or is disposed after this body mounted.
         A service may also have appeared between this render's availability read and the
         subscribe below, in which case no listener will fire: compare once here and bump the
         tick if a handle disagrees with the value this render used. */
      useEffect(() => {
        const unsubscribes = []
        for (const [handle, available] of [
          [restartConnector, restartAvailable],
          [saveCredential, saveAvailable],
        ]) {
          if (handle === null) continue
          unsubscribes.push(handle.subscribe(() => setActionTick(tick => tick + 1)))
          if (handle.available() !== available) setActionTick(tick => tick + 1)
        }
        return () => {
          for (const unsubscribe of unsubscribes) unsubscribe()
        }
      }, [restartConnector, saveCredential])

      /* Opening the form focuses its first input; switching rows focuses the new form;
         closing hands focus back to the Sign in button that opened it. The dependency is the
         open row's name, so typing or a failure message does not steal focus from the field. */
      React.useEffect(() => {
        if (signIn === null) {
          const name = focusName.current
          if (name === null) return
          focusName.current = null
          firstInputRef.current = null
          const button = buttonRef(name).current
          if (button !== null && typeof button.focus === 'function') button.focus()
          return
        }
        focusName.current = signIn.name
        const input = firstInputRef.current
        if (input !== null && typeof input.focus === 'function') input.focus()
      }, [signIn?.name ?? null])

      /* A form belongs to one waiting row and one reachable service. A poll that changes the
         row, a row that leaves the list or a service that goes drops the form and everything
         typed into it, so no stale value can reappear when the row or service comes back. */
      useEffect(() => {
        if (signIn === null) return
        const current = list.find(connector => String(connector.name ?? '') === signIn.name)
        if (current === undefined || current.state !== 'waiting-credentials' || saveAvailable !== true) {
          setSignIn(null)
        }
      }, [data, saveAvailable, signIn?.name])

      /* A poll is what moves a connector row's state, and the message a failed Reconnect left
         belongs to the state it failed in: a row whose state changed, or left the list, drops
         it, so a stale message can never outlive its row. */
      useEffect(() => {
        const states = new Map()
        for (const connector of list) states.set(String(connector.name ?? ''), String(connector.state ?? ''))
        const previous = lastStates.current
        lastStates.current = states
        setActions(current => {
          let changed = false
          const next = {}
          for (const [name, action] of Object.entries(current)) {
            if (!states.has(name)) {
              changed = true
              continue
            }
            if (action.error !== undefined && previous !== null && previous.get(name) !== states.get(name)) {
              changed = true
              if (action.pending === true) next[name] = { pending: true }
              continue
            }
            next[name] = action
          }
          return changed ? next : current
        })
      }, [data])

      /**
       * Restart one connector from the user's click: at most one call per row at a time; a
       * resolve asks the route again, a rejection keeps its message and enables the button.
       * A click held since a poll changed the row is ignored unless it is still failed or closed.
       * @param {string} name
       */
      const restart = name => {
        if (restartConnector === null || inFlight.current[name] === true) return
        if (restartConnector.available() !== true) return
        const current = latest.current.list.find(connector => String(connector.name ?? '') === name)
        if (current === undefined || (current.state !== 'failed' && current.state !== 'closed')) return
        inFlight.current[name] = true
        setActions(current => ({ ...current, [name]: { pending: true, error: current[name]?.error } }))
        const settle = action => {
          delete inFlight.current[name]
          setActions(current => {
            const next = { ...current }
            if (action === null) delete next[name]
            else next[name] = action
            return next
          })
        }
        let answer
        try {
          answer = restartConnector(name)
        } catch (error) {
          settle({ error: actionErrorMessage(error) })
          return
        }
        Promise.resolve(answer).then(
          () => {
            settle(null)
            if (typeof props.refresh === 'function') props.refresh()
          },
          error => settle({ error: actionErrorMessage(error) }),
        )
      }

      /** Toggle the form from a click on a waiting row's button that names credentials. */
      const openSignIn = (name, credentials) => {
        if (saveCredential === null || saveCredential.available() !== true) return
        if (saveInFlight.current === true) return
        const current = latest.current.list.find(connector => String(connector.name ?? '') === name)
        if (current === undefined || current.state !== 'waiting-credentials') return
        setSignIn(form =>
          form !== null && form.name === name
            ? null
            : { name, credentials, values: {}, saving: false, error: null },
        )
      }

      const changeCredential = (name, value) => {
        setSignIn(form => (form === null ? form : { ...form, values: { ...form.values, [name]: value } }))
      }

      /**
       * Store the non-empty values one at a time. One save at a time: a second Save or a
       * Sign in click while it runs is ignored, like Reconnect's synchronous guard. The
       * inputs are cleared on the attempt, before any promise settles, so a secret is not
       * left on screen while saving or after a failure. Only success closes the form and asks
       * the route again; a failure uses the row's status region and never echoes a value.
       */
      const save = async () => {
        const opened = latest.current
        if (opened.signIn === null || opened.signIn.saving === true || saveInFlight.current === true) return
        if (saveCredential === null || saveCredential.available() !== true || opened.saveAvailable !== true) return
        const current = opened.list.find(connector => String(connector.name ?? '') === opened.signIn.name)
        if (current === undefined || current.state !== 'waiting-credentials') return
        const entries = Object.entries(opened.signIn.values).filter(([, value]) => value !== '')
        if (entries.length === 0) return
        const name = opened.signIn.name
        const values = entries.map(([, value]) => value)
        saveInFlight.current = true
        setSignIn(form => (form === null ? form : { ...form, values: {}, saving: true, error: null }))
        try {
          for (const [credential, value] of entries) {
            await saveCredential(credential, value)
          }
          saveInFlight.current = false
          setSignIn(form => (form !== null && form.name === name ? null : form))
          if (typeof props.refresh === 'function') props.refresh()
        } catch (error) {
          saveInFlight.current = false
          const message = credentialErrorMessage(error, values)
          setSignIn(form =>
            form !== null && form.name === name ? { ...form, error: message, saving: false } : form,
          )
        }
      }

      const cancelSignIn = () => setSignIn(null)

      if (data === null || data === undefined) return null
      const message = data.errors?.connectors
      if (typeof message === 'string') return h('p', { style: S.error, role: 'status' }, message)
      if (connectors === null || connectors === undefined) return null
      if (list.length === 0) return h('span', { style: S.note }, 'No connectors')
      const rest = list.slice(MAX_CONNECTOR_ROWS)
      const moreId = rest.length === 0 ? undefined : props.moreId
      const options = {
        restart: restartAvailable ? restart : null,
        signIn: saveAvailable ? openSignIn : null,
        form: signIn,
        formPrefix: formPrefix.current,
        buttonRef,
        firstInputRef,
        change: changeCredential,
        save,
        cancel: cancelSignIn,
        actions,
      }
      return [
        ...list
          .slice(0, MAX_CONNECTOR_ROWS)
          .map((connector, index) => connectorEntry(connector, index, options)),
        moreId === undefined
          ? null
          : h(
              'div',
              {
                key: 'more',
                id: moreId,
                style: expanded ? S.sectionBody : { display: 'none' },
                hidden: expanded ? undefined : true,
              },
              expanded
                ? rest.map((connector, index) =>
                    connectorEntry(connector, index + MAX_CONNECTOR_ROWS, options),
                  )
                : null,
            ),
        moreId === undefined
          ? null
          : h(
              'button',
              {
                key: 'toggle',
                type: 'button',
                style: S.showMore,
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-controls': moreId,
                onClick: () => setExpanded(value => !value),
              },
              expanded ? 'Show less' : 'Show more',
            ),
      ].filter(item => item !== null)
    }

    /**
     * Build one optional action handle from a Remote service. Both the namespace and the
     * dotted service must be declared for Cordis 4.1's scoped injection, which is called
     * straight from mount (it returns a Fiber, so it never goes inside ctx.effect). The
     * handle is fixed at mount; the body reads availability on every render and subscribes
     * for repaints. A call while the service is gone rejects, as the old restart handle did.
     * In this build a Remote method resolves { ok: true, value } or { ok: false, error }
     * (dsh-typert-protocol src/types.ts:124-132) and rejects only on assembly faults, so a
     * refused call is turned into a rejection here: both actions then share one failure path.
     */
    function remoteServiceAction(ctx, names, read, method, missing) {
      let service = null
      const listeners = new Set()
      const label = names[names.length - 1]
      const handle = async (...args) => {
        if (service === null) throw new Error(missing)
        const result = await service[method](...args)
        if (result !== null && typeof result === 'object' && result.ok === false) {
          // errorMessageOf reads the service's message wherever the failure is shown.
          throw result.error ?? new Error('the ' + label + ' action failed')
        }
        if (result !== null && typeof result === 'object' && result.ok === true && Object.hasOwn(result, 'value')) {
          return result.value
        }
        return result
      }
      handle.available = () => service !== null
      handle.subscribe = listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const announce = () => {
        for (const listener of Array.from(listeners)) listener()
      }
      if (typeof ctx.inject !== 'function') return handle
      try {
        ctx.inject(names, inner => {
          const found = read(inner)
          if (found === null || found === undefined || typeof found[method] !== 'function') return undefined
          service = found
          announce()
          return () => {
            service = null
            announce()
          }
        })
      } catch (error) {
        console.warn('environment panel: ' + label + ' is unavailable', error)
      }
      return handle
    }


    /* Environment group 2/4 — environment-context.js: the Context section. */
    /** The Context rows' swatch colors, by sorted position; later rows take the idle tone. */
    const CONTEXT_SWATCH = [
      STATE_TONE.active,
      STATE_TONE.warn,
      STATE_TONE.success,
      'var(--dsw-alias-label-secondary, inherit)',
    ]
    /** The one-segment bar dsh's percent draws before a breakdown is known. */
    const CONTEXT_NEUTRAL = STATE_TONE.idle
    /** The buffer swatch's fill, and the free swatch's border. */
    const CONTEXT_BUFFER = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))'

    /**
     * The context use the app's own meter shows: the projected token total when the
     * session has one, otherwise the last pressure reading, against its context window.
     * A reading that cannot be computed (a non-finite token count, or a zero or
     * non-finite window) answers null, so the tab shows its pre-request note instead of
     * NaN% or a false 100%.
     * @param {{ pressureTokens?: number, projectedTokens?: number, contextWindow?: number } | undefined | null} pressure
     * @returns {{ usedTokens: number, contextWindow: number, percent: number } | null}
     */
    function contextUsage(pressure) {
      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
      const contextWindow = pressure?.contextWindow
      if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
      return {
        usedTokens,
        contextWindow,
        percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
      }
    }

    /**
     * The Context percent the header and the narrow strip show: the route's percent while
     * the Context section is open in the column, dsh's contextPressure otherwise, and
     * nothing before the first model request. The strip never shows a route answer: its
     * section is not visible there, and one kept from before the strip would be stale.
     * @param {{
     *   narrow: boolean,
     *   open: boolean,
     *   claude: { percent: number } | null,
     *   usage: { percent: number } | null,
     * }} options
     * @returns {number | null}
     */
    function contextDisplayPercent(options) {
      if (!options.narrow && options.open && options.claude !== null) return options.claude.percent
      return options.usage === null ? null : options.usage.percent
    }

    /**
     * The palette tone of a context reading: brand below 80%, warn from 80% and
     * error from 95%.
     * @param {number} percent
     * @returns {'active' | 'warn' | 'error'}
     */
    function contextTone(percent) {
      return percent >= 95 ? 'error' : percent >= 80 ? 'warn' : 'active'
    }

    /**
     * A token count in the app meter's short form: '950', '84.1k', '200k', '1.05M', '2M'.
     * @param {number} n
     * @returns {string}
     */
    function formatTokens(n) {
      const value = Number(n)
      if (!Number.isFinite(value) || value < 0) return '0'
      if (value < 1_000) return String(value)
      if (value < 1_000_000) {
        const thousands = Math.round(value / 100) / 10
        // A rounded 999.95k is 1000k, which the short form spells as one million.
        if (thousands >= 1_000) return '1M'
        return thousands.toFixed(1).replace(/\.0$/u, '') + 'k'
      }
      return (value / 1_000_000).toFixed(2).replace(/\.?0+$/u, '') + 'M'
    }

    /**
     * dsh's own context composition scaled so its three rows add up exactly to the
     * used tokens: each row takes its floored share and the leftover tokens go to
     * the largest remainders, ties first. Null when the breakdown is missing or adds
     * up to nothing, which leaves the section on the neutral bar.
     * @param {{ systemTokens?: number, toolsTokens?: number, messageTokens?: number } | undefined | null} breakdown
     * @param {number} usedTokens
     * @returns {{ name: string, tokens: number }[] | null}
     */
    function scaledBreakdown(breakdown, usedTokens) {
      if (breakdown === null || typeof breakdown !== 'object') return null
      const counts = [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens]
      const raw = ['System prompt', 'Tool definitions', 'Messages'].map((name, index) => ({
        name,
        tokens: Number.isFinite(counts[index]) && counts[index] > 0 ? counts[index] : 0,
      }))
      const total = raw.reduce((sum, row) => sum + row.tokens, 0)
      if (!(total > 0)) return null
      const target = Math.max(0, Math.round(usedTokens))
      const exact = raw.map(row => (row.tokens / total) * target)
      const rows = exact.map((value, index) => ({ name: raw[index].name, tokens: Math.floor(value) }))
      let leftover = target - rows.reduce((sum, row) => sum + row.tokens, 0)
      const byRemainder = exact
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
      for (const candidate of byRemainder) {
        if (leftover <= 0) break
        rows[candidate.index].tokens += 1
        leftover -= 1
      }
      return rows
    }

    /**
     * The kind of one Claude-route category. A known `kind` wins; without one a
     * category is deferred when flagged, free when named 'Free space', buffer when
     * its name ends in 'buffer', and used otherwise.
     * @param {{ name?: unknown, kind?: unknown, deferred?: unknown }} entry
     * @returns {'used' | 'free' | 'buffer' | 'deferred'}
     */
    function contextCategoryKind(entry) {
      if (entry.kind === 'used' || entry.kind === 'free' || entry.kind === 'buffer' || entry.kind === 'deferred') {
        return entry.kind
      }
      if (entry.deferred === true) return 'deferred'
      const name = String(entry.name ?? '').trim().toLowerCase()
      if (name === 'free space') return 'free'
      if (name.endsWith('buffer')) return 'buffer'
      return 'used'
    }

    /**
     * The dsh-oh-my-claude context answer as the section reads it, or null when the
     * answer is not that route's contract. The route's own percentage is the source
     * of the headline; invalid categories are skipped instead of blanking the body.
     * @param {unknown} body
     * @returns {{
     *   categories: { name: string, tokens: number, kind: string }[],
     *   totalTokens: number,
     *   maxTokens: number,
     *   percent: number,
     *   model: string | null,
     * } | null}
     */
    function claudeContext(body) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
      if (body.ok !== true || !Array.isArray(body.categories)) return null
      if (!Number.isFinite(body.totalTokens) || !Number.isFinite(body.maxTokens)) return null
      if (body.totalTokens < 0 || body.maxTokens <= 0) return null
      const categories = []
      for (const entry of body.categories) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        if (typeof entry.name !== 'string' || entry.name === '') continue
        if (!Number.isFinite(entry.tokens) || entry.tokens < 0) continue
        categories.push({ name: entry.name, tokens: entry.tokens, kind: contextCategoryKind(entry) })
      }
      const percentage = Number.isFinite(body.percentage)
        ? body.percentage
        : (body.totalTokens / body.maxTokens) * 100
      return {
        categories,
        totalTokens: body.totalTokens,
        maxTokens: body.maxTokens,
        percent: Math.min(100, Math.max(0, Math.round(percentage))),
        model: typeof body.model === 'string' && body.model !== '' ? body.model : null,
      }
    }

    /**
     * The Context body's view from the preferred source: the Claude route's answer
     * first, else dsh's projections, else null (the pre-request note). Used rows sort
     * by tokens; buffer, free and deferred rows keep the route's order.
     * @param {{ claude: object | null, usage: { usedTokens: number, contextWindow: number, percent: number } | null, breakdown: unknown }} options
     * @returns {{
     *   percent: number,
     *   usedTokens: number,
     *   maxTokens: number,
     *   model: string | null,
     *   rows: { name: string, tokens: number }[],
     *   buffer: { name: string, tokens: number }[],
     *   free: { name: string, tokens: number }[],
     *   deferred: { name: string, tokens: number }[],
     *   neutral: boolean,
     * } | null}
     */
    function contextView(options) {
      const claude = options.claude
      if (claude !== null) {
        const categories = claude.categories
        return {
          percent: claude.percent,
          usedTokens: claude.totalTokens,
          maxTokens: claude.maxTokens,
          model: claude.model,
          rows: categories.filter(category => category.kind === 'used').sort((left, right) => right.tokens - left.tokens),
          buffer: categories.filter(category => category.kind === 'buffer'),
          free: categories.filter(category => category.kind === 'free'),
          deferred: categories.filter(category => category.kind === 'deferred'),
          neutral: false,
        }
      }
      const usage = options.usage
      if (usage === null) return null
      const rows = scaledBreakdown(options.breakdown, usage.usedTokens)
      return {
        percent: usage.percent,
        usedTokens: usage.usedTokens,
        maxTokens: usage.contextWindow,
        model: null,
        rows: rows === null ? [] : rows.sort((left, right) => right.tokens - left.tokens),
        buffer: [],
        free: rows === null ? [] : [{ name: 'Free space', tokens: Math.max(0, usage.contextWindow - usage.usedTokens) }],
        deferred: [],
        neutral: rows === null,
      }
    }

    /**
     * One token count's share of the window, with the spec's one decimal.
     * @param {number} tokens
     * @param {number} maxTokens
     * @returns {string}
     */
    function contextShare(tokens, maxTokens) {
      return ((tokens / maxTokens) * 100).toFixed(1) + '%'
    }

    /**
     * One bar segment's width: the token share, never below the spec's 0.4%.
     * @param {number} tokens
     * @param {number} maxTokens
     * @returns {string}
     */
    function contextSegmentWidth(tokens, maxTokens) {
      const width = Math.max((tokens / maxTokens) * 100, 0.4)
      return Number(width.toFixed(3)) + '%'
    }

    /**
     * The swatch color of one used row: by its sorted position, idle for later rows.
     * @param {number} index
     * @returns {string}
     */
    function contextSwatchColor(index) {
      return CONTEXT_SWATCH[index] ?? STATE_TONE.idle
    }

    /**
     * Ask the dsh-oh-my-claude plugin for a Claude session's context breakdown. The
     * context section falls back to dsh's projections whenever the answer is not the
     * route's contract; `missing` marks the one answer (a 404) that says the route
     * will not exist for the rest of the mount.
     * @param {string} sessionId
     * @returns {Promise<{ data: object | null, missing: boolean }>}
     */
    async function fetchClaudeContext(sessionId) {
      const { response, body } = await fetchJson(CLAUDE_CONTEXT_ROUTE + '?session=' + encodeURIComponent(sessionId))
      if (!response.ok) return { data: null, missing: response.status === 404 }
      return { data: claudeContext(body), missing: false }
    }

    /** The gauge icon of the Context strip item. */
    function GaugeIcon() {
      return lineIcon(h('path', { d: 'M2.5 11.5a5.5 5.5 0 0 1 11 0' }), h('path', { d: 'M8 11.5l2.75-3.25' }))
    }

    /** The Context header summary: the percent and its pill bar, or nothing before a request. */
    function contextSummary(percent) {
      if (percent === null) return null
      return h(
        'span',
        { style: S.sectionSummary, 'aria-hidden': 'true' },
        h('span', { style: S.contextPercent }, percent + '%'),
        h(
          'span',
          { style: S.contextPill },
          h('span', {
            style: {
              ...S.contextPillFill,
              width: percent + '%',
              background: STATE_TONE[contextTone(percent)],
            },
          }),
        ),
      )
    }

    /** One Context row: its swatch, name, tokens and share (an em dash for a deferred row). */
    function contextRow(row, key) {
      return h(
        'div',
        { key, style: S.contextRow, 'data-context-row': row.kind },
        h('span', { style: { ...S.contextSwatch, ...row.swatch }, 'aria-hidden': 'true' }),
        h('span', { style: S.contextName, title: row.name }, row.name),
        h('span', { style: S.contextTokens }, formatTokens(row.tokens)),
        h('span', { style: S.contextShare }, row.share === null ? '—' : row.share),
      )
    }

    /** The stacked bar's segments: one per used row, or dsh's single neutral segment. */
    function contextSegments(view) {
      if (view.neutral) {
        return [
          h('div', {
            key: 'neutral',
            style: {
              ...S.contextSegment,
              width: contextSegmentWidth(view.percent, 100),
              background: CONTEXT_NEUTRAL,
            },
            'data-context-segment': '',
          }),
        ]
      }
      return view.rows.map((row, index) =>
        h('div', {
          key: 'segment-' + index,
          style: {
            ...S.contextSegment,
            width: contextSegmentWidth(row.tokens, view.maxTokens),
            background: contextSwatchColor(index),
          },
          'data-context-segment': '',
        }),
      )
    }

    /** The Compact session footer: the disabled reason at the left, the button at the right. */
    function contextFooter(compact) {
      if (compact === null) return null
      return h(
        'div',
        { key: 'footer', style: S.contextFooter },
        compact.reason === null ? null : h('span', { style: S.contextFooterNote }, compact.reason),
        h(
          'button',
          {
            type: 'button',
            style: compact.enabled
              ? S.compactButton
              : { ...S.compactButton, color: 'var(--dsw-alias-label-secondary, inherit)', cursor: 'default' },
            disabled: compact.enabled ? undefined : true,
            onClick: compact.run,
          },
          'Compact session',
        ),
      )
    }

    /** The Context body: headline, stacked bar, rows and footer, or the pre-request note. */
    function contextBody(view, compact) {
      const footer = contextFooter(compact)
      if (view === null) {
        return [h('span', { key: 'note', style: S.note }, 'Shown after the first model request'), footer].filter(
          item => item !== null,
        )
      }
      const children = [
        h(
          'div',
          { key: 'headline', style: S.contextHeadline, 'data-context-headline': '' },
          h(
            'span',
            { style: S.contextHeadlineText },
            view.percent + '% used',
            view.model === null ? null : h('span', { style: S.contextModel }, ' · ' + view.model),
          ),
          h(
            'span',
            { style: S.contextHeadlineCount },
            formatTokens(view.usedTokens) + ' / ' + formatTokens(view.maxTokens),
          ),
        ),
        h(
          'div',
          {
            key: 'bar',
            style: S.contextBar,
            role: 'progressbar',
            'aria-label': 'Context use',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': view.percent,
          },
          ...contextSegments(view),
        ),
      ]
      if (view.rows.length > 0) {
        children.push(
          h(
            'div',
            { key: 'used', style: S.contextRows, 'data-context-group': 'used' },
            ...view.rows.map((row, index) =>
              contextRow(
                {
                  ...row,
                  kind: 'used',
                  share: contextShare(row.tokens, view.maxTokens),
                  swatch: { background: contextSwatchColor(index) },
                },
                'used-' + index,
              ),
            ),
          ),
        )
      }
      const extra = [
        ...view.buffer.map((row, index) =>
          contextRow(
            {
              ...row,
              kind: 'buffer',
              share: contextShare(row.tokens, view.maxTokens),
              swatch: { background: CONTEXT_BUFFER },
            },
            'buffer-' + index,
          ),
        ),
        ...view.free.map((row, index) =>
          contextRow(
            {
              ...row,
              kind: 'free',
              share: contextShare(row.tokens, view.maxTokens),
              swatch: {
                background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))',
                border: '1px solid ' + CONTEXT_BUFFER,
              },
            },
            'free-' + index,
          ),
        ),
      ]
      if (extra.length > 0) {
        /* The section body has a 6 px gap; the extra 4 px makes the spec's 10 px space. */
        children.push(
          h('div', { key: 'extra', style: { ...S.contextRows, marginTop: 4 }, 'data-context-group': 'extra' }, ...extra),
        )
      }
      if (view.deferred.length > 0) {
        children.push(
          h(
            'div',
            { key: 'deferred', style: { ...S.contextRows, marginTop: 4 }, 'data-context-group': 'deferred' },
            ...view.deferred.map((row, index) =>
              contextRow(
                { ...row, kind: 'deferred', share: null, swatch: { background: STATE_TONE.idle } },
                'deferred-' + index,
              ),
            ),
          ),
        )
      }
      if (footer !== null) children.push(footer)
      return children
    }

    /**
     * The message-box signal the Compact footer subscribes to: a primitive that moves
     * only when the draft or attachments go between empty and non-empty, or the phase
     * leaves plain, so a keystroke inside a non-empty draft does not re-render the tab.
     * @param {{ draft?: unknown, attachmentIds?: unknown, phase?: unknown } | null | undefined} state
     * @returns {'draft' | 'busy' | null}
     */
    function compactInputSignal(state) {
      if (state === null || typeof state !== 'object') return null
      const draft = typeof state.draft === 'string' ? state.draft.trim() : ''
      const attached = Array.isArray(state.attachmentIds) && state.attachmentIds.length > 0
      if (draft !== '' || attached) return 'draft'
      if (typeof state.phase === 'string' && state.phase !== 'plain') return 'busy'
      return null
    }

    /**
     * The Compact session control, or null when the host cannot read the message box
     * or cannot send the command. A click types /compact and submits it, exactly as
     * typing it in the message box and pressing send would, but only while the draft
     * is empty, nothing is attached, the phase is plain and the session is not running.
     * @param {{
     *   actions: object | null | undefined,
     *   signal: 'draft' | 'busy' | null | undefined,
     *   running: boolean | undefined,
     *   sessionId: string,
     *   guard: { current: number | null },
     * }} options
     * @returns {{ enabled: boolean, reason: string | null, run: () => void } | null}
     */
    function compactControl(options) {
      const { actions, signal, running, sessionId, guard } = options
      if (sessionId === '') return null
      if (actions === null || actions === undefined) return null
      if (typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return null
      if (signal !== null && signal !== 'draft' && signal !== 'busy') return null
      if (typeof running !== 'boolean') return null
      const reason =
        signal === 'draft' ? COMPACT_BLOCKED_DRAFT : signal === 'busy' || running ? COMPACT_BLOCKED_BUSY : null
      return {
        enabled: reason === null,
        reason,
        run: () => {
          if (reason !== null) return
          const now = Date.now()
          if (guard.current !== null && now - guard.current < COMPACT_GUARD_MS) return
          guard.current = now
          actions.setDraft('/compact')
          actions.submit()
        },
      }
    }


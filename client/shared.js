    /* What every feature in this bundle shares: React, the element helper, the fetch and
       visibility helpers, the monospace stack, and the feature registry the generated footer
       reads. This file is one part of client.js, concatenated inside the module factory by
       scripts/build-client.mjs; React is the only module a part may require. */

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    /** The one font stack the tabs share (a font, not a color: no theme token names it). */
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    /** Installed by the sizing feature while mounted; rail clicks request an apply through it. */
    const PANE_SIZING = { apply: null }

    /** Read a service lazily: ctx.get first, then a plain context property; never throw. */
    function serviceOf(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const value = ctx.get(name)
          if (value !== undefined && value !== null) return value
        }
      } catch (e) {
        /* fallthrough to the plain property */
      }
      try {
        return ctx && ctx[name]
      } catch (e) {
        return undefined
      }
    }

    /** Each state's color token, shared by every tab; no literal color leaves this table. */
    const STATE_TONE = {
      active: 'var(--dsw-alias-brand-primary, #4f6ef7)',
      success: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
      idle: 'var(--dsw-alias-state-idle-primary, #8a8f98)',
      warn: 'var(--dsw-alias-state-warn-primary, #c98a00)',
      error: 'var(--dsw-alias-state-error-primary, #d64545)',
    }

    /**
     * The inline style of one status dot: an 8 px circle filled with the tone, or hollow
     * (transparent, inside a tone border) so "not running" reads without color alone.
     * @param {'active' | 'success' | 'idle' | 'warn' | 'error'} tone
     * @param {boolean} hollow
     * @returns {object}
     */
    function stateMark(tone, hollow) {
      const color = STATE_TONE[tone]
      if (hollow) {
        return {
          width: 8,
          height: 8,
          borderRadius: '50%',
          flex: 'none',
          boxSizing: 'border-box',
          background: 'transparent',
          border: '1.5px solid ' + color,
        }
      }
      return { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: color }
    }

    /** Every tab registers itself here; the generated footer unions their inject lists. */
    const FEATURES = []
    /** The rows switched on for this mount; the generated footer fills it before mounting. */
    const ACTIVE_FEATURES = new Set()
    /** sessionId → { tabId, paneId } of the Git tab last mounted in that session. */
    const GIT_TAB_PANES = new Map()

    /**
     * Register one feature's tab with the bundle.
     * @param {{ name: string, inject: string[], mount: (ctx: object) => void }} feature
     */
    function registerFeature(feature) {
      FEATURES.push({ name: feature.name, inject: feature.inject, mount: feature.mount })
    }

    /** Resolve the route against the page, the way dsh-session-console lib/client.js:381-390 does. */
    function api(path) {
      const relative = String(path).replace(/^\/+/u, '')
      if (typeof document === 'undefined') return '/' + relative
      const url = new URL(relative, document.baseURI)
      return url.pathname + url.search
    }

    function visible() {
      return typeof document === 'undefined' || document.visibilityState !== 'hidden'
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

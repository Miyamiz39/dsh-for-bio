window.__ModuleLoader__.load({
  id: 'dsh-for-bio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PATH = '/api/dsh-for-bio/signin'
    const PACKAGE = 'dsh-for-bio'


    async function request(action, signal) {
      const init = action
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action),
          }
        : { method: 'GET' }
      const response = await fetch(PATH, { ...init, credentials: 'same-origin', cache: 'no-store', signal })
      let result
      try {
        result = await response.json()
      } catch {
        throw new Error('The sign-in service is unavailable; reload the plugin and refresh the page.')
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'The sign-in action failed.')
      return result.servers
    }

    const css = `
      .bio-signin{font:inherit;color:inherit;width:100%;box-sizing:border-box}
      .bio-signin *{box-sizing:border-box}
      .bio-signin h4{font-size:14px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
      .bio-signin .bio-lead{margin:0 0 14px;font-size:13px;line-height:1.6;color:color-mix(in srgb,currentColor 62%,transparent)}
      .bio-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:.5px solid color-mix(in srgb,currentColor 12%,transparent)}
      .bio-row:first-of-type{border-top:0}
      .bio-main{flex:1;min-width:0}
      .bio-name{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
      .bio-desc{margin:3px 0 0;font-size:12.5px;line-height:1.55;color:color-mix(in srgb,currentColor 60%,transparent)}
      .bio-badge{flex:none;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:500;background:color-mix(in srgb,currentColor 8%,transparent)}
      .bio-badge[data-state=on]{color:#15803d;background:color-mix(in srgb,#22c55e 14%,transparent)}
      .bio-badge[data-state=busy]{color:#1d4ed8;background:color-mix(in srgb,#3b82f6 14%,transparent)}
      .bio-badge[data-state=error]{color:#b91c1c;background:color-mix(in srgb,#ef4444 14%,transparent)}
      .bio-actions{flex:none;display:flex;gap:8px;align-items:center}
      .bio-signin button{font:inherit;font-size:12.5px;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:6px 12px;background:transparent;color:inherit;white-space:nowrap}
      .bio-signin button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
      .bio-signin button.ghost{border-color:transparent;color:color-mix(in srgb,currentColor 62%,transparent);padding:6px 4px}
      .bio-signin button:disabled{opacity:.45;cursor:default}
      .bio-signin button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
      .bio-note{margin:6px 0 0;font-size:12px;line-height:1.55;color:color-mix(in srgb,currentColor 60%,transparent)}
      .bio-note.error{color:#b91c1c}
      .bio-note.busy{color:#1d4ed8}
      @media(max-width:560px){.bio-row{flex-wrap:wrap}.bio-actions{width:100%;justify-content:flex-end}}
    `

    function badgeOf(server) {
      if (server.phase === 'error') return { state: 'error', text: 'Sign-in failed' }
      if (server.phase === 'discovering' || server.phase === 'authorizing' || server.phase === 'saving') {
        return { state: 'busy', text: server.phase === 'saving' ? 'Saving' : 'Waiting for browser' }
      }
      if (server.configured) return { state: 'on', text: 'Signed in' }
      return { state: 'off', text: 'Not signed in' }
    }

    function Row({ server, busy, onAct }) {
      const badge = badgeOf(server)
      const running = badge.state === 'busy'
      return h(
        'div',
        { className: 'bio-row' },
        h(
          'div',
          { className: 'bio-main' },
          h('div', { className: 'bio-name' }, server.label, h('span', { className: 'bio-badge', 'data-state': badge.state }, badge.text)),
          h('p', { className: 'bio-desc' }, server.description),
          server.error !== undefined && h('p', { className: 'bio-note error', role: 'alert' }, server.error),
          running && server.notice !== undefined && h('p', { className: 'bio-note busy', role: 'status' }, server.notice),
          !running && server.configured && server.obtainedAt !== undefined
            ? h('p', { className: 'bio-note' }, `Authorized ${new Date(server.obtainedAt).toLocaleString()}`)
            : null,
        ),
        h(
          'div',
          { className: 'bio-actions' },
          running
            ? h('button', { type: 'button', className: 'ghost', disabled: busy, onClick: () => onAct('cancel', server.name) }, 'Cancel')
            : h(
                'button',
                {
                  type: 'button',
                  className: server.configured ? 'ghost' : 'primary',
                  // A read-only credential store cannot accept a sign-in; say so instead of failing silently.
                  disabled: busy || !server.writable,
                  title: server.writable ? undefined : 'The credential store is read-only in this composition',
                  onClick: () => onAct(server.configured ? 'signout' : 'signin', server.name),
                },
                server.configured ? 'Sign out' : 'Sign in',
              ),
        ),
      )
    }

    function SignInPanel({ view } = {}) {
      const [servers, setServers] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [refresh, setRefresh] = React.useState(0)
      const mounted = React.useRef(false)
      const acting = React.useRef(false)
      const version = React.useRef(0)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          version.current++
        }
      }, [])

      // `summary` renders the one-liner only; the bundle page renders `page`.
      React.useEffect(() => {
        if (view === 'summary') return undefined
        let stopped = false
        let timer
        let controller
        const poll = async () => {
          if (document.visibilityState === 'hidden' || acting.current) {
            timer = setTimeout(poll, 2500)
            return
          }
          const id = version.current
          controller = new AbortController()
          try {
            const next = await request(undefined, controller.signal)
            if (!stopped && id === version.current) {
              setServers(next)
              setError('')
            }
          } catch (caught) {
            if (!stopped && id === version.current && !controller.signal.aborted) setError(caught.message)
          } finally {
            if (!stopped) timer = setTimeout(poll, 2500)
          }
        }
        poll()
        return () => {
          stopped = true
          clearTimeout(timer)
          controller?.abort()
        }
      }, [view, refresh])

      async function act(action, server) {
        if (acting.current) return
        acting.current = true
        const id = ++version.current
        setBusy(true)
        setError('')
        const controller = new AbortController()
        try {
          const next = await request({ action, server }, controller.signal)
          if (mounted.current && id === version.current) setServers(next)
        } catch (caught) {
          if (mounted.current && !controller.signal.aborted) setError(caught.message)
        } finally {
          acting.current = false
          if (mounted.current) {
            setBusy(false)
            setRefresh(n => n + 1)
          }
        }
      }

      if (view === 'summary') return h('span', null, 'Sign in to the data sources that need authorization.')
      if (servers === null && error === '') return h('div', { className: 'bio-signin' }, h('style', null, css), h('p', { className: 'bio-lead' }, 'Reading sign-in state…'))
      return h(
        'section',
        { className: 'bio-signin', 'aria-label': 'Data source sign-in' },
        h('style', null, css),
        h('h4', null, 'Data source sign-in'),
        h(
          'p',
          { className: 'bio-lead' },
          'PubMed, bioRxiv, ClinicalTrials.gov, ChEMBL, and Open Targets need no account. These four do, and stay disconnected until you sign in.',
        ),
        error !== '' && h('p', { className: 'bio-note error', role: 'alert' }, error),
        (servers ?? []).map(server => h(Row, { key: server.name, server, busy, onAct: act })),
      )
    }

    const paperCss = `
      .bio-papers{display:flex;flex-direction:column;gap:6px;margin:4px 0 2px;font:inherit}
      .bio-papers-head{display:flex;align-items:center;gap:8px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}
      .bio-papers-head b{font-weight:600;color:var(--dsw-alias-label-primary)}
      .bio-paper{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
      .bio-paper-title{font-size:14px;line-height:1.45;font-weight:500;color:var(--dsw-alias-label-primary);text-decoration:none}
      .bio-paper-title:hover{text-decoration:underline;text-underline-offset:3px}
      .bio-paper-meta{display:flex;flex-wrap:wrap;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
      .bio-paper-meta span+span::before{content:'·';margin:0 6px;color:var(--dsw-alias-label-tertiary)}
      .bio-paper-badge{flex:none;border-radius:999px;padding:1px 7px;font-size:11px;background:color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary)}
      .bio-paper-abstract{margin:2px 0 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .bio-paper-abstract[data-open=true]{display:block;-webkit-line-clamp:unset}
      .bio-papers-more{align-self:flex-start;margin:2px 0 0;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;cursor:pointer}
      .bio-papers-more:hover{text-decoration:underline}
    `

    const PAPERS_PATH = '/api/dsh-for-bio/papers'
    const turnCache = new Map()

    /** Fetch one turn's paper groups; a failure renders nothing rather than an error. */
    async function loadTurnPapers(sessionId, seq, signal) {
      try {
        const url = `${PAPERS_PATH}?session=${encodeURIComponent(sessionId)}&seq=${seq}`
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal })
        const body = await response.json()
        if (response.ok && body?.ok && Array.isArray(body.groups)) return body.groups
        return []
      } catch {
        return []
      }
    }

    function PaperCard({ papers, title, fallback }) {
      const [expanded, setExpanded] = React.useState(false)
      const shown = expanded ? papers : papers.slice(0, 3)
      return h(
        'div',
        { className: 'bio-papers' },
        h('style', null, paperCss),
        h('div', { className: 'bio-papers-head' },
          h('b', null, 'Papers'),
          title !== undefined && h('span', { title }, `「${title}」`),
          h('span', null, `${papers.length} result${papers.length === 1 ? '' : 's'}`)),
        fallback !== undefined && h('pre', { className: 'bio-paper-abstract' }, fallback),
        shown.map((p, i) => h(PaperRow, { key: `${i}-${p.url ?? p.title}`, p })),
        papers.length > 3 &&
          h('button', { type: 'button', className: 'bio-papers-more', 'aria-expanded': expanded, onClick: () => setExpanded(v => !v) },
            expanded ? 'Show fewer' : `Show all ${papers.length}`),
      )
    }

    function PaperRow({ p }) {
      const [open, setOpen] = React.useState(false)
      const meta = [p.authors, p.year === undefined ? '' : String(p.year), p.venue, p.citations === undefined ? '' : `${p.citations} citations`].filter(Boolean)
      return h(
        'div',
        { className: 'bio-paper' },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
          p.url === undefined
            ? h('span', { className: 'bio-paper-title' }, p.title)
            : h('a', { className: 'bio-paper-title', href: p.url, target: '_blank', rel: 'noreferrer noopener' }, p.title),
          p.badge !== undefined && h('span', { className: 'bio-paper-badge' }, p.badge)),
        meta.length > 0 && h('div', { className: 'bio-paper-meta' }, meta.map((v, i) => h('span', { key: i }, v))),
        p.abstract !== undefined &&
          h('p', { className: 'bio-paper-abstract', 'data-open': open, title: open ? 'Collapse' : 'Expand', onClick: () => setOpen(v => !v) }, p.abstract),
      )
    }

    /**
     * The papers one turn produced, rendered below the reply.
     *
     * The Host reads them from its own Session log, so this only fetches: the
     * tool call keeps its raw result, and a turn with no paper results renders
     * nothing at all.
     */
    function TurnPapers({ seq, sessionId }) {
      const key = sessionId === undefined || sessionId === null ? undefined : `${sessionId}:${seq}`
      const [groups, setGroups] = React.useState(() => (key === undefined ? null : (turnCache.get(key) ?? null)))

      React.useEffect(() => {
        if (key === undefined) return undefined
        const cached = turnCache.get(key)
        if (cached !== undefined) {
          setGroups(cached)
          return undefined
        }
        let alive = true
        loadTurnPapers(sessionId, seq).then(value => {
          turnCache.set(key, value)
          if (alive) setGroups(value)
        })
        return () => { alive = false }
      }, [key, sessionId, seq])

      if (groups === null || groups.length === 0) return null
      return h(
        'div',
        { className: 'bio-turn-papers' },
        groups.map(group =>
          h(PaperCard, {
            key: group.callId,
            papers: group.papers,
            title: group.query === '' ? undefined : group.query,
            fallback: group.isError ? group.text : undefined,
          }),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The bundle's own page, between its description and its rows.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, registrant: PACKAGE }, SignInPanel),
        )
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${PACKAGE}`, registrant: PACKAGE }, SignInPanel),
        )
        // Cards belong below the reply, not at the Tool call: the call site shows
        // the raw result on purpose, so nothing is registered on tool.call.toolview.
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({ name: 'conversation.chat.turnTail', id: PACKAGE, order: 30 }, TurnPapers),
        )
      },
    }
  },
})

/**
 * Collect the papers one completed turn produced, from the Session log.
 *
 * The tool call itself must keep showing its raw result — that is where the
 * reader inspects what actually happened — so the card is built here instead and
 * rendered below the reply. Call names come from the turn's own `tool/call`
 * events, because a `tool/result` records only the call id.
 *
 * @module
 */

import { normalizePapers, PAPER_TOOLS } from './papers.js'

/** A failed result keeps its short text so the card can fall back to it. */
const MAX_FALLBACK_CHARS = 4000

/** Join the text blocks of one tool-result message. */
export function resultText(message) {
  const parts = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Read a query-like argument from a recorded call, when the tool carries one. */
function queryOf(raw) {
  try {
    const value = JSON.parse(String(raw ?? ''))
    for (const key of ['query', 'term', 'search']) {
      if (typeof value?.[key] === 'string' && value[key].trim().length > 0) return value[key].trim()
    }
    if (Array.isArray(value?.query_strings) && typeof value.query_strings[0] === 'string') {
      return value.query_strings.join(', ')
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Read the papers one completed turn produced.
 *
 * @param session - the live Session whose log holds the turn.
 * @param seq - the turn's closing event sequence.
 * @returns one entry per paper-bearing tool result in that turn, in call order.
 */
export function turnPapers(session, seq) {
  if (session === undefined || session === null) return []
  if (!Number.isInteger(seq) || seq < 0) return []
  const end = Math.min(seq, Number(session.seq))
  const events = session.snapshotEvents(0, end + 1)

  const calls = new Map()
  let turn
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, args: event.data.arguments })
    } else if (event.type === 'turn/start') {
      turn = event.data.turn
    }
  }
  if (turn === undefined) return []

  const out = []
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data.turn !== turn) continue
    const callId = event.data.message?.source?.callId
    const call = calls.get(callId)
    if (call === undefined || !PAPER_TOOLS.has(call.name)) continue

    const text = resultText(event.data.message)
    const isError = event.data.message?.isError === true
    const papers = isError ? [] : normalizePapers(text)
    // A result the card cannot render from records keeps its raw text so the
    // reader still sees the failure instead of an empty card.
    if (papers.length === 0 && !isError) continue
    out.push({
      callId: String(callId),
      tool: call.name,
      query: queryOf(call.args),
      isError,
      papers,
      text: papers.length > 0 ? '' : text.slice(0, MAX_FALLBACK_CHARS),
    })
  }
  return out
}

/**
 * Serve one turn's papers to the conversation.
 *
 * Read-only and peer-admitted by `connection.fetch`; it answers only for a live
 * Session the Host holds.
 *
 * @param connection - the Host connection service.
 * @param ctx - a context carrying `sessions`.
 * @returns the route's disposer.
 */
export function registerTurnApi(connection, ctx) {
  return connection.fetch.register({
    path: '/api/dsh-for-bio/papers',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const json = (value, status = 200) =>
        Response.json(value, {
          status,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        })
      try {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session') ?? ''
        const seq = Number(url.searchParams.get('seq'))
        if (sessionId === '' || !Number.isInteger(seq) || seq < 0) {
          return json({ ok: false, error: 'Expected a session and seq' }, 400)
        }
        const session = ctx.get('sessions')?.get(sessionId)
        if (session === undefined || session === null) return json({ ok: true, groups: [] })
        return json({ ok: true, groups: turnPapers(session, seq) })
      } catch {
        return json({ ok: false, error: 'Paper results are unavailable; reload the page and retry.' }, 503)
      }
    },
  })
}

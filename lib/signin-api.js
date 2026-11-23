/**
 * HTTP surface for the sign-in panel.
 *
 * Registered through `connection.fetch`, which owns Host/Origin checks,
 * authenticated Peer admission, owner-only access, and Desktop IPC routing.
 * Never register an unprotected `webServer` route for credential actions.
 *
 * @module
 */

import { OAuthError } from './oauth.js'
import { AUTH_MCP_SERVERS } from './signin.js'

/** The panel's single endpoint. */
export const SIGNIN_PATH = '/api/dsh-for-bio/signin'

/** Allowed actions; anything else is a 400 rather than a silent no-op. */
const ACTIONS = new Set(['signin', 'cancel', 'signout'])

/** A JSON response that no cache may retain. */
function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/**
 * Serve the panel's status reads and its three actions.
 *
 * @param connection - the Host connection service.
 * @param controller - the sign-in controller.
 * @returns the registration disposer.
 */
export function registerSignInApi(connection, controller) {
  return connection.fetch.register({
    path: SIGNIN_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') {
          return json({ ok: true, servers: await controller.status() })
        }
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return json({ ok: false, error: 'Expected application/json' }, 415)
        }
        const text = await request.text()
        if (Buffer.byteLength(text) > 1024) return json({ ok: false, error: 'Request too large' }, 413)
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, 400)
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json({ ok: false, error: 'Expected an object' }, 400)
        }
        const keys = Object.keys(body)
        if (keys.length !== 2 || !keys.includes('action') || !keys.includes('server')) {
          return json({ ok: false, error: 'Expected an action and a server' }, 400)
        }
        if (!ACTIONS.has(body.action)) {
          return json({ ok: false, error: 'Unknown action' }, 400)
        }
        if (!AUTH_MCP_SERVERS.some(server => server.name === body.server)) {
          return json({ ok: false, error: 'Unknown server' }, 400)
        }

        if (body.action === 'signin') controller.start(body.server)
        else if (body.action === 'cancel') controller.cancel(body.server)
        else await controller.signOut(body.server)

        return json({ ok: true, servers: await controller.status() }, body.action === 'signin' ? 202 : 200)
      } catch (error) {
        if (error instanceof OAuthError) return json({ ok: false, error: error.message }, 400)
        return json({ ok: false, error: 'The sign-in action failed; check the Host log.' }, 503)
      }
    },
  })
}

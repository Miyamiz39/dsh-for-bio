/**
 * Generic MCP OAuth 2.1 client for the dsh-for-bio data sources.
 *
 * Implements the MCP authorization flow that the servers advertise through
 * RFC 9728 protected-resource metadata: discovery, dynamic client registration
 * (RFC 7591), authorization code + PKCE (S256), a loopback redirect, and
 * refresh. One instance owns one server's grant.
 *
 * The grant is stored through the DSH credential seam, so `${credential:REF}`
 * templates in the MCP manager resolve the current access token and a token
 * rotation reaches the next connection without a restart.
 *
 * @module
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Loopback path the authorization server redirects back to. */
const CALLBACK_PATH = '/oauth/callback'

/** How long a browser sign-in may take before the flow gives up. */
const AUTH_TIMEOUT_MS = 180_000

/** Reject non-HTTPS authorization endpoints, except a loopback test server. */
function assertSecureUrl(url, label) {
  const parsed = new URL(url)
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return parsed
  throw new OAuthError(`${label} must use HTTPS`)
}

/** A failure whose message is safe to show in the settings panel. */
export class OAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OAuthError'
  }
}

/** Constant-time comparison of the round-tripped `state`. */
function equalState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** PKCE S256 challenge for one verifier. */
function codeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Read a JSON document, turning transport and parse failures into OAuthError. */
async function readJson(response, label) {
  const text = await response.text()
  if (!response.ok) {
    throw new OAuthError(`${label} failed (HTTP ${response.status})`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthError(`${label} returned a non-JSON body`)
  }
}

/**
 * Discover the authorization server for one MCP endpoint.
 *
 * Waits for a `401` carrying `resource_metadata`, then reads that document and
 * the authorization server's own metadata. Both are required: the MCP spec
 * gives no defaults, and guessing endpoints is how a flow silently targets the
 * wrong issuer.
 *
 * @param endpoint - the MCP server URL.
 * @param signal - cancellation.
 * @returns resource metadata plus authorization server metadata.
 */
export async function discover(endpoint, signal) {
  const probe = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-for-bio', version: '1' } },
    }),
    signal,
  })

  if (probe.status !== 401) {
    throw new OAuthError(`Expected the server to require authorization, got HTTP ${probe.status}`)
  }

  const challenge = probe.headers.get('www-authenticate') ?? ''
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  if (metadataUrl === undefined) {
    throw new OAuthError('The server advertised no OAuth resource metadata')
  }

  const resource = await readJson(await fetch(metadataUrl, { signal }), 'Resource metadata discovery')
  const issuer = Array.isArray(resource.authorization_servers) ? resource.authorization_servers[0] : undefined
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new OAuthError('The resource metadata names no authorization server')
  }

  const issuerBase = assertSecureUrl(issuer, 'Authorization server')
  const wellKnown = new URL('/.well-known/oauth-authorization-server', issuerBase)
  const server = await readJson(await fetch(wellKnown, { signal }), 'Authorization server metadata')

  if (typeof server.authorization_endpoint !== 'string' || typeof server.token_endpoint !== 'string') {
    throw new OAuthError('The authorization server metadata is missing required endpoints')
  }

  return {
    resource: typeof resource.resource === 'string' ? resource.resource : endpoint,
    scopes: Array.isArray(resource.scopes_supported) ? resource.scopes_supported : [],
    authorizationEndpoint: assertSecureUrl(server.authorization_endpoint, 'Authorization endpoint').href,
    tokenEndpoint: assertSecureUrl(server.token_endpoint, 'Token endpoint').href,
    registrationEndpoint:
      typeof server.registration_endpoint === 'string'
        ? assertSecureUrl(server.registration_endpoint, 'Registration endpoint').href
        : undefined,
    tokenAuthMethods: Array.isArray(server.token_endpoint_auth_methods_supported)
      ? server.token_endpoint_auth_methods_supported
      : ['client_secret_post'],
  }
}

/**
 * Register this client with the authorization server (RFC 7591).
 *
 * @param discovery - the discovery result.
 * @param redirectUri - the loopback redirect this client will use.
 * @param signal - cancellation.
 * @returns the client information to replay on the token request.
 */
export async function registerClient(discovery, redirectUri, signal) {
  if (discovery.registrationEndpoint === undefined) {
    throw new OAuthError('This server requires a pre-registered OAuth client and offers no registration endpoint')
  }
  const authMethod = discovery.tokenAuthMethods.includes('none')
    ? 'none'
    : discovery.tokenAuthMethods.includes('client_secret_post')
      ? 'client_secret_post'
      : 'client_secret_basic'

  const body = {
    client_name: 'dsh-for-bio',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
    ...(discovery.scopes.length > 0 ? { scope: discovery.scopes.join(' ') } : {}),
  }

  const response = await fetch(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const info = await readJson(response, 'Client registration')
  if (typeof info.client_id !== 'string' || info.client_id.length === 0) {
    throw new OAuthError('Client registration returned no client_id')
  }
  return { ...info, token_endpoint_auth_method: info.token_endpoint_auth_method ?? authMethod }
}

/** Build the token-request body shared by the code exchange and the refresh. */
function tokenForm(client, extra) {
  const form = new URLSearchParams(extra)
  form.set('client_id', client.client_id)
  const method = client.token_endpoint_auth_method ?? 'none'
  if (method === 'client_secret_post' && typeof client.client_secret === 'string') {
    form.set('client_secret', client.client_secret)
  }
  return form
}

/** Authorization header for a confidential client that authenticates with Basic. */
function tokenHeaders(client) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if ((client.token_endpoint_auth_method ?? 'none') === 'client_secret_basic' && typeof client.client_secret === 'string') {
    const raw = `${client.client_id}:${client.client_secret}`
    headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`
  }
  return headers
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param discovery - the discovery result.
 * @param client - registered client information.
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier for this attempt.
 * @param redirectUri - the redirect used in the authorization request.
 * @param signal - cancellation.
 * @returns token response fields, with an absolute `expires_at`.
 */
export async function exchangeCode(discovery, client, code, verifier, redirectUri, signal) {
  const response = await fetch(discovery.tokenEndpoint, {
    method: 'POST',
    headers: tokenHeaders(client),
    body: tokenForm(client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: discovery.resource,
    }),
    signal,
  })
  return normalizeTokens(await readJson(response, 'Token exchange'))
}

/**
 * Refresh an access token.
 *
 * @param discovery - the discovery result.
 * @param client - registered client information.
 * @param refreshToken - the stored refresh token.
 * @param signal - cancellation.
 * @returns a fresh token response.
 */
export async function refresh(discovery, client, refreshToken, signal) {
  const response = await fetch(discovery.tokenEndpoint, {
    method: 'POST',
    headers: tokenHeaders(client),
    body: tokenForm(client, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      resource: discovery.resource,
    }),
    signal,
  })
  return normalizeTokens(await readJson(response, 'Token refresh'))
}

/** Validate one token response and add an absolute expiry. */
function normalizeTokens(token) {
  if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
    throw new OAuthError('The token response carried no access_token')
  }
  const expiresIn = Number(token.expires_in)
  return {
    ...token,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  }
}

/**
 * Run one interactive authorization.
 *
 * Opens a loopback listener, asks `prepare` for the client registration bound
 * to that exact redirect URI, sends the browser to the authorization endpoint,
 * and resolves with the authorization code the server redirects back with. The
 * listener answers exactly one well-formed callback and rejects replay.
 *
 * `prepare` exists because the redirect URI contains a per-attempt loopback
 * port, so a client registration cannot be reused across attempts without one.
 *
 * @param discovery - the discovery result.
 * @param prepare - receives the redirect URI and returns the client to use.
 * @param options - `openBrowser`, the abort signal, an optional notice sink, and
 * an `onUrl` callback that receives the authorization URL before it is opened.
 * @returns the authorization code, the PKCE verifier, and the client used.
 */
export async function authorize(discovery, prepare, { openBrowser, signal, notify = () => {}, onUrl = () => {} }) {
  const verifier = randomBytes(32).toString('base64url')
  const expectedState = randomBytes(32).toString('base64url')

  const callback = Promise.withResolvers()
  // A rejection the caller may never observe must not crash the process.
  callback.promise.catch(() => {})

  let redirectOrigin
  const server = createServer((request, response) => {
    const reply = (status, text) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      })
      response.end(text)
    }

    if (request.method !== 'GET' || request.headers.origin !== undefined) {
      reply(403, 'Forbidden')
      return
    }
    let url
    try {
      url = new URL(request.url ?? '/', redirectOrigin)
    } catch {
      reply(400, 'Invalid callback')
      return
    }
    if (url.origin !== redirectOrigin || url.pathname !== CALLBACK_PATH) {
      reply(404, 'Not found')
      return
    }
    const params = url.searchParams
    if (!equalState(params.get('state'), expectedState)) {
      reply(403, 'Invalid OAuth state')
      return
    }
    if (params.has('error')) {
      callback.reject(new OAuthError(`Sign-in was not completed (${params.get('error')})`))
      reply(403, 'Sign-in was not completed. Return to DeepSeek Harness and retry.')
      return
    }
    const code = params.get('code')
    if (typeof code !== 'string' || code.length === 0) {
      reply(400, 'Invalid callback')
      return
    }
    callback.resolve(code)
    reply(200, 'Authorization received. Return to DeepSeek Harness; you can close this tab.')
  })

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })

  const cleanup = async () => {
    clearTimeout(timer)
    if (server.listening) {
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
    }
  }

  const timer = setTimeout(() => {
    callback.reject(new OAuthError('Browser sign-in timed out'))
  }, AUTH_TIMEOUT_MS)

  const stop = () => callback.reject(new OAuthError('Sign-in was cancelled'))
  signal?.addEventListener('abort', stop, { once: true })

  try {
    redirectOrigin = await listen()
    const redirectUri = `${redirectOrigin}${CALLBACK_PATH}`
    const client = await prepare(redirectUri)

    const authorizeUrl = new URL(discovery.authorizationEndpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', client.client_id)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('state', expectedState)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge(verifier))
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('resource', discovery.resource)
    if (discovery.scopes.length > 0) authorizeUrl.searchParams.set('scope', discovery.scopes.join(' '))

    // Report the URL before opening: if the OS opener fails or mangles it, the
    // panel can still show a link the user copies into a browser.
    onUrl(authorizeUrl.href)
    notify('Complete sign-in in the browser; this panel updates when it finishes.')
    await openBrowser(authorizeUrl.href)

    const code = await callback.promise
    return { code, verifier, redirectUri, client }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    await cleanup()
  }
}

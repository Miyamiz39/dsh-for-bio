/**
 * Sign-in state for the dsh-for-bio MCP data sources.
 *
 * One controller owns every server that needs a browser grant. A successful
 * sign-in stores the access token through the DSH credential seam under the
 * reference the MCP manager's `${credential:…}` template names, so the manager
 * resolves it on the next connection — and on rotation — without a restart.
 *
 * @module
 */

import { discover, registerClient, authorize, exchangeCode, OAuthError } from './oauth.js'
import { spawn } from 'node:child_process'

/**
 * Open a URL in the user's default browser without a package dependency.
 *
 * The authorization URL is one the server just issued over HTTPS, and the
 * caller passes it through a fixed argument vector — never a shell — so no
 * shell metacharacter can reach an interpreter.
 *
 * @param url - the HTTPS authorization URL.
 */
export function openBrowser(url) {
  // Windows must not go through `cmd /c start`: an authorization URL is mostly
  // `&`-separated query parameters, and cmd treats `&` as a command break, so the
  // browser receives a truncated URL with no client_id. rundll32 hands the URL to
  // the shell's protocol handler without any command-line parsing.
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false, detached: true })
    child.once('error', () => reject(new OAuthError('Could not open a browser for sign-in')))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Servers that answer 401 until a browser grant exists.
 *
 * `auth` records what the server actually offers, so the panel can say why a
 * server that is not signed in yet is not simply "broken".
 */
export const AUTH_MCP_SERVERS = [
  {
    name: 'consensus',
    label: 'Consensus',
    url: 'https://mcp.consensus.app/mcp',
    credential: 'BIO_RESEARCH_CONSENSUS_TOKEN',
    description: 'AI search and synthesis over peer-reviewed research.',
  },
  {
    name: 'synapse',
    label: 'Synapse',
    url: 'https://mcp.synapse.org/mcp',
    credential: 'BIO_RESEARCH_SYNAPSE_TOKEN',
    description: 'Collaborative research data management (Sage Bionetworks).',
  },
  {
    name: 'wiley',
    label: 'Wiley Scholar Gateway',
    url: 'https://connector.scholargateway.ai/mcp',
    credential: 'BIO_RESEARCH_WILEY_TOKEN',
    description: 'Academic research and publications.',
  },
  {
    name: 'biorender',
    label: 'BioRender',
    url: 'https://mcp.services.biorender.com/mcp',
    credential: 'BIO_RESEARCH_BIORENDER_TOKEN',
    description: 'Scientific illustration and figures.',
  },
  {
    name: 'owkin',
    label: 'Owkin',
    url: 'https://mcp.k.owkin.com/mcp',
    credential: 'BIO_RESEARCH_OWKIN_TOKEN',
    description: 'AI for biology: histopathology and drug discovery.',
  },
]

/** The stored grant keeps the refresh token and client registration. */
function tokenKey(name) {
  return `dsh-for-bio/${name}/token`
}

/** A failure whose message is safe to show in the settings panel. */
function userFacing(error) {
  if (error instanceof OAuthError) return error.message
  return 'Sign-in failed. Check the network and the Host log, then retry.'
}

/**
 * Own the sign-in attempts and the stored grants.
 *
 * A grant is written in two places on purpose: the credential reference holds
 * the bare access token for the MCP manager's template, and the token record
 * keeps the full response so the panel can report expiry and so a future
 * refresh can replace the reference.
 */
export class SignInController {
  #ctx
  #jobs = new Map()
  #disposed = false

  /**
   * @param ctx - a context carrying `credentials` and `logger`.
   */
  constructor(ctx) {
    this.#ctx = ctx
  }

  /**
   * Read the sign-in state of every server without exposing token values.
   *
   * @returns one entry per server with its status and any running attempt.
   */
  async status() {
    const credentials = this.#ctx.get('credentials')
    const out = []
    for (const server of AUTH_MCP_SERVERS) {
      const job = this.#jobs.get(server.name)
      const info = credentials === undefined ? undefined : await credentials.describe(server.credential)
      const record = credentials === undefined ? undefined : await credentials.readRecord(tokenKey(server.name))
      out.push({
        name: server.name,
        label: server.label,
        description: server.description,
        url: server.url,
        configured: info?.configured === true,
        writable: info?.writable ?? false,
        phase: job?.phase ?? 'idle',
        error: job?.phase === 'error' ? job.error : undefined,
        notice: job?.notice,
        url: job?.url,
        obtainedAt: typeof record?.payload?.obtained_at === 'number' ? record.payload.obtained_at : undefined,
      })
    }
    return out
  }

  /**
   * Start one browser sign-in. Returns immediately; `status()` reports progress.
   *
   * @param name - the server to authorize.
   * @throws when the server is unknown, already signing in, or the seam is absent.
   */
  start(name) {
    if (this.#disposed) throw new OAuthError('The sign-in controller is disposed')
    const server = AUTH_MCP_SERVERS.find(entry => entry.name === name)
    if (server === undefined) throw new OAuthError(`Unknown server "${name}"`)
    const current = this.#jobs.get(name)
    if (current !== undefined && current.phase !== 'error') return

    const credentials = this.#ctx.get('credentials')
    if (credentials === undefined) throw new OAuthError('This composition has no credential provider')

    const controller = new AbortController()
    const job = { phase: 'discovering', error: undefined, notice: undefined }
    this.#jobs.set(name, job)

    const run = async () => {
      const discovery = await discover(server.url, controller.signal)
      job.phase = 'authorizing'
      const grant = await authorize(
        discovery,
        async redirectUri => {
          const client = await registerClient(discovery, redirectUri, controller.signal)
          return client
        },
        {
          signal: controller.signal,
          notify: text => { job.notice = text },
          // Keep the URL so the panel can offer a manual link if the OS opener
          // fails — a wrong-offset browser on Windows is otherwise a dead end.
          onUrl: url => { job.url = url },
          openBrowser,
        },
      )

      job.phase = 'saving'
      const tokens = await exchangeCode(discovery, grant.client, grant.code, grant.verifier, grant.redirectUri, controller.signal)
      await credentials.set(server.credential, tokens.access_token)
      await credentials.modifyRecord(tokenKey(name), async () => ({
        kind: 'grant',
        payload: {
          version: 1,
          issuer: discovery.authorizationEndpoint,
          token_endpoint: discovery.tokenEndpoint,
          resource: discovery.resource,
          client_id: grant.client.client_id,
          token_endpoint_auth_method: grant.client.token_endpoint_auth_method,
          ...(typeof grant.client.client_secret === 'string' ? { client_secret: grant.client.client_secret } : {}),
          access_token: tokens.access_token,
          ...(typeof tokens.refresh_token === 'string' ? { refresh_token: tokens.refresh_token } : {}),
          ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }),
          obtained_at: Date.now(),
        },
      }))

      this.#jobs.delete(name)
      // No status broadcast here: `credentials.set` above already emitted
      // `credentials/reference-updated`, and the plugin's own listener registers
      // (or re-registers) this server from that event.
    }

    run().catch(error => {
      job.phase = 'error'
      job.error = userFacing(error)
      job.notice = undefined
      if (!(error instanceof OAuthError)) {
        this.#ctx.logger.warn(`dsh-for-bio: sign-in for "${name}" failed`)
        this.#ctx.logger.warn(error)
      }
    })
  }

  /** Abandon a running sign-in attempt. */
  cancel(name) {
    const job = this.#jobs.get(name)
    if (job !== undefined && job.phase !== 'error') this.#jobs.delete(name)
  }

  /**
   * Forget a stored grant.
   *
   * @param name - the server to sign out of.
   */
  async signOut(name) {
    const server = AUTH_MCP_SERVERS.find(entry => entry.name === name)
    if (server === undefined) throw new OAuthError(`Unknown server "${name}"`)
    this.#jobs.delete(name)
    const credentials = this.#ctx.get('credentials')
    if (credentials === undefined) return
    await credentials.unset(server.credential)
    await credentials.deleteRecord(tokenKey(name))
  }

  /** Stop every running attempt. */
  async dispose() {
    this.#disposed = true
    this.#jobs.clear()
  }
}

/**
 * Turn a token record into an `Authorization` header, refreshing when needed.
 *
 * Exported so a test can drive it without a live browser.
 *
 * @param record - the stored grant payload.
 * @param refreshFn - performs the refresh, injected for testability.
 * @returns the bearer header value and, when rotated, the new payload.
 */
export async function bearerFor(record, refreshFn) {
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
    throw new OAuthError('The stored grant has no access token')
  }
  const expiresAt = record.expires_at
  const stale = typeof expiresAt === 'number' && expiresAt <= Date.now() + 60_000
  if (!stale || typeof record.refresh_token !== 'string') {
    return { header: `Bearer ${record.access_token}`, payload: undefined }
  }
  const tokens = await refreshFn(record)
  return {
    header: `Bearer ${tokens.access_token}`,
    payload: {
      ...record,
      access_token: tokens.access_token,
      ...(typeof tokens.refresh_token === 'string' ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }),
      obtained_at: Date.now(),
    },
  }
}

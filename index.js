import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignInController, AUTH_MCP_SERVERS } from './lib/signin.js'
import { registerSignInApi } from './lib/signin-api.js'
import { registerTurnApi } from './lib/turns.js'

/**
 * dsh-for-bio bundle: register the six bundled analysis skills, and register
 * the literature, clinical-trial, chemistry, and drug-target MCP servers with
 * the Host's MCP manager.
 *
 * The Web and Desktop profiles own one shared MCP fleet through
 * `ctx.mcpManager`, so a server is registered here as an effect of this plugin
 * rather than inserted as a separate `dsh-mcp-client` row: the manager mounts
 * one client instance per registration, withdraws its tools when this plugin
 * unloads, and reports its status beside the Settings-configured servers.
 * A profile without a manager falls back to the skill-only behavior.
 */

/** Skills shipped in this bundle, in catalog order. */
const SKILL_NAMES = [
  'start',
  'single-cell-rna-qc',
  'scvi-tools',
  'nextflow-development',
  'instrument-data-to-allotrope',
  'scientific-problem-selection',
]

/** Precedence rank for packaged skill providers. */
const BUNDLED_SKILL_RANK = 600

const PROVIDER_NAME = 'dsh-for-bio'

/**
 * Anonymous MCP endpoints. Each was probed with a protocol `initialize` and
 * `tools/list` before being listed here; the tool counts are what that server
 * advertised at the time, not a contract.
 */
const MCP_SERVERS = [
  { name: 'pubmed', url: 'https://pubmed.mcp.claude.com/mcp', tools: 7 },
  { name: 'biorxiv', url: 'https://hcls.mcp.claude.com/biorxiv/mcp', tools: 7 },
  { name: 'c_trials', url: 'https://hcls.mcp.claude.com/clinical_trials/mcp', tools: 6 },
  { name: 'chembl', url: 'https://hcls.mcp.claude.com/chembl/mcp', tools: 6 },
  { name: 'ot', url: 'https://mcp.platform.opentargets.org/mcp', tools: 5 },
]

/**
 * Servers that answer 401 until a browser grant exists. Each is registered only
 * while its grant is stored, so an unauthenticated server contributes no tools
 * and reserves no name. See `registerMcpServers`.
 *
 * Benchling ships no endpoint upstream, so it has no row.
 */
const MCP_SERVERS_REQUIRING_AUTH = AUTH_MCP_SERVERS

/** Read `name` and `description` from a SKILL.md frontmatter block. */
function parseFrontmatter(raw) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (block?.[1] === undefined) return undefined
  const fields = {}
  for (const line of block[1].split(/\r?\n/u)) {
    const match = /^([A-Za-z][\w-]*):\s?(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      if (value.length > 1 && value.endsWith(quote)) value = value.slice(1, -1)
    }
    fields[match[1]] = value
  }
  return fields
}

/** Register the bundled analysis skills on the Host skill registry. */
function registerSkills(ctx) {
  const root = fileURLToPath(new URL('./skills/', import.meta.url))
  const reported = new Map()

  function warn(skillName, error) {
    const failure = String(error)
    if (reported.get(skillName) !== failure) {
      reported.set(skillName, failure)
      ctx.logger.warn(`dsh-for-bio: skill "${skillName}" is unavailable: ${failure}`)
    }
  }

  async function readSkill(skillName, signal) {
    const path = join(root, skillName, 'SKILL.md')
    let raw
    try {
      raw = await readFile(path, { encoding: 'utf8', signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      warn(skillName, error)
      return { kind: 'missing' }
    }
    const fields = parseFrontmatter(raw)
    const description = fields?.description
    if (typeof description !== 'string' || description.length === 0) {
      warn(skillName, `${path} has no frontmatter description`)
      return { kind: 'invalid' }
    }
    const block = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(raw)
    reported.delete(skillName)
    return {
      kind: 'loaded',
      description,
      whenToUse: fields.whenToUse,
      content: raw.slice(block?.[0].length ?? 0).trim(),
    }
  }

  ctx.skills.registerProvider((control) => ({
    name: PROVIDER_NAME,
    async list(options) {
      const reads = await Promise.all(
        SKILL_NAMES.map(async (skillName) => ({
          skillName,
          read: await readSkill(skillName, options.signal),
        })),
      )
      const candidates = []
      for (const { skillName, read } of reads) {
        if (read.kind !== 'loaded') continue
        const directory = join(root, skillName)
        candidates.push({
          name: skillName,
          description: read.description,
          ...(read.whenToUse === undefined ? {} : { whenToUse: read.whenToUse }),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
          locator: join(directory, 'SKILL.md'),
        })
      }
      return { candidates, complete: reads.every(({ read }) => read.kind !== undefined) }
    },
    async get(candidate, options) {
      const { rank: _rank, locator: _locator, ...summary } = candidate
      const read = await readSkill(candidate.name, options.signal)
      if (read.kind !== 'loaded') {
        control.invalidate()
        return undefined
      }
      return { ...summary, content: read.content }
    },
  }))
}

/**
 * Register the MCP servers with the Host MCP manager.
 *
 * The five anonymous sources are registered unconditionally. A source that
 * needs a grant is registered only while that grant exists: without a stored
 * credential the server has no tools to contribute, so mounting it would list a
 * permanently-failing server and reserve a name for nothing. `register` returns
 * the disposer that withdraws it, so a sign-out unregisters the server and a
 * sign-in mounts it — both through `credentials/reference-updated`.
 *
 * `ctx.inject` defers this until the manager exists and skips it when the
 * composition has none, so a skills-only profile activates without an error.
 */
function registerMcpServers(ctx) {
  ctx.inject(['mcpManager'], (inner) => {
    for (const server of MCP_SERVERS) {
      inner.effect(
        () =>
          inner.mcpManager.register(server.name, {
            transport: 'streamable-http',
            url: server.url,
            startupTimeoutMs: 30000,
          }),
        `dsh-for-bio.mcp.${server.name}`,
      )
    }

    /** Live registration per gated server, keyed by server name. */
    const mounted = new Map()

    const sync = async () => {
      const credentials = inner.get('credentials')
      for (const server of MCP_SERVERS_REQUIRING_AUTH) {
        const configured =
          credentials !== undefined && (await credentials.describe(server.credential)).configured === true
        const live = mounted.has(server.name)
        if (configured && !live) {
          const dispose = inner.mcpManager.register(server.name, {
            transport: 'streamable-http',
            url: server.url,
            startupTimeoutMs: 30000,
            headers: { Authorization: `Bearer \${credential:${server.credential}}` },
          })
          mounted.set(server.name, dispose)
        } else if (!configured && live) {
          mounted.get(server.name)()
          mounted.delete(server.name)
        }
      }
    }

    // One sync at a time: reference updates can arrive in bursts.
    let queue = Promise.resolve()
    const schedule = () => {
      queue = queue.then(sync).catch(error => {
        inner.logger.warn('dsh-for-bio: reconciling gated MCP servers failed')
        inner.logger.warn(error)
      })
    }

    inner.effect(() => () => {
      for (const dispose of mounted.values()) dispose()
      mounted.clear()
    }, 'dsh-for-bio.mcp.gated')

    inner.on('credentials/reference-updated', schedule)
    schedule()
  })
}

/**
 * Serve the sign-in panel's API and own its controller.
 *
 * Both halves are optional: the route needs `connection`, and the controller
 * needs `credentials`. A composition with neither still gets the skills and the
 * anonymous data sources.
 */
function registerSignIn(ctx) {
  ctx.inject(['connection', 'credentials'], (inner) => {
    const controller = new SignInController(inner)
    inner.effect(() => () => controller.dispose(), 'dsh-for-bio.signin.dispose')
    inner.effect(() => registerSignInApi(inner.connection, controller), 'dsh-for-bio.signin.api')
    // The conversation's paper cards read a turn's own tool results here; the
    // tool call itself keeps rendering its raw result.
    inner.effect(() => registerTurnApi(inner.connection, inner), 'dsh-for-bio.papers.api')
  })
}

export const name = 'dsh-for-bio'
export const inject = ['skills']
export { SKILL_NAMES, MCP_SERVERS, MCP_SERVERS_REQUIRING_AUTH }

export function apply(ctx) {
  registerSkills(ctx)
  registerMcpServers(ctx)
  registerSignIn(ctx)
}

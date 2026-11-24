# dsh-for-bio

Connect to preclinical research tools and databases (literature search, genomics
analysis, target prioritization) to accelerate early-stage life sciences R&D.

Six analysis skills and nine MCP data sources for DeepSeek Harness. Five sources
connect immediately; four need your own account and sign in from the plugin page.

Ported from Anthropic's `bio-research` v1.2.0 Claude Code plugin
(`anthropics/knowledge-work-plugins`). The skills are reproduced unchanged; the
MCP wiring and sign-in are DSH-native. Licensed Apache 2.0 — see `LICENSE`.

## What it adds

**Skills** (auto-discovered, model-invocable):

| Skill | Purpose |
|---|---|
| `start` | Survey the connected sources and pick a workflow |
| `single-cell-rna-qc` | MAD-based scRNA-seq QC with scverse conventions |
| `scvi-tools` | scVI / scANVI / totalVI / PeakVI / MultiVI / DestVI / veloVI / scArches |
| `nextflow-development` | nf-core `rnaseq`, `sarek`, `atacseq` over local or GEO/SRA FASTQs |
| `instrument-data-to-allotrope` | Instrument files → Allotrope ASM JSON/CSV (40+ instruments) |
| `scientific-problem-selection` | Fischbach & Walsh problem-selection framework |

**MCP data sources** (36 tools, anonymous):

| Name | Server | Tools |
|---|---|---|
| `pubmed` | `pubmed.mcp.claude.com` | 7 |
| `biorxiv` | `hcls.mcp.claude.com/biorxiv` | 7 |
| `c_trials` | `hcls.mcp.claude.com/clinical_trials` | 6 |
| `chembl` | `hcls.mcp.claude.com/chembl` | 6 |
| `ot` | `mcp.platform.opentargets.org` | 5 |

Cards: every paper-bearing tool renders its results as a paper card —
`consensus.search`, `pubmed.search_articles`, `pubmed.get_article_metadata`,
`biorxiv.search_preprints`, and their siblings. Chemistry, trial, and target
results keep the generic row, because they are not papers. One normalizer
(`lib/papers.js`) adapts PubMed's nested metadata, bioRxiv's semicolon-joined
authors, and Consensus's pre-formatted text into one record; `client.js` embeds
a generated copy via `tools/sync-papers.mjs` (run it after editing, and
`--check` fails on drift).

## How the MCP wiring works

Web and Desktop profiles own one shared MCP fleet through
`@deepseek-ai/dsh-mcp-manager`. A statically inserted `dsh-mcp-client` row does
not take effect there, so `index.js` registers servers as plugin effects
instead:

```js
ctx.inject(['mcpManager'], (inner) => {
  inner.effect(() => inner.mcpManager.register('pubmed', {
    transport: 'streamable-http',
    url: 'https://pubmed.mcp.claude.com/mcp',
  }))
})
```

The registration lives for this plugin's lifetime: disabling or removing the
bundle unloads the servers and withdraws their tools. In a composition without
a manager the plugin still activates with skills only.

## Servers that need a credential — sign in from the plugin page

Five servers answer `401` until you authorize them. **Each is registered only
while its grant is stored**, so an unauthenticated server contributes no tools
and reserves no name; signing out unregisters it again. The header still carries
a `${credential:…}` template so a rotated token reaches the next connection.

| Name | Credential reference |
|---|---|
| `consensus` | `BIO_RESEARCH_CONSENSUS_TOKEN` |
| `synapse` (Sage Bionetworks) | `BIO_RESEARCH_SYNAPSE_TOKEN` |
| `wiley` (Scholar Gateway) | `BIO_RESEARCH_WILEY_TOKEN` |
| `biorender` | `BIO_RESEARCH_BIORENDER_TOKEN` |
| `owkin` | `BIO_RESEARCH_OWKIN_TOKEN` |

**Plugins → dsh-for-bio** shows a *Data source sign-in* panel — one row per
server, with a Sign in / Sign out button and the live state. Sign in opens your
browser; the flow is standard MCP OAuth:

1. Read the server's `401` `WWW-Authenticate` challenge and its RFC 9728
   protected-resource metadata.
2. Read the authorization server's metadata for the endpoints.
3. Register this client (RFC 7591) against a fresh loopback redirect URI.
4. Send the browser to the authorization endpoint with PKCE (S256) and a
   one-shot `state`.
5. Catch the loopback callback, exchange the code, and store the access token
   through `ctx.credentials.set` under the reference above.
6. `credentials/reference-updated` fires, the plugin registers that server, and
   its tools appear — no restart.

Sign out unsets the reference; the reference update unregisters the server and
withdraws its tools.

Benchling ships no endpoint in the upstream plugin, so it has no row here.

### What the panel needs

| Piece | Why |
|---|---|
| `@deepseek-ai/dsh-mcp-manager` | Mounts the servers; hard-codes `expandTemplates: true` for every instance |
| a credential provider | `set`/`describe` back the Sign in button and the `${credential:…}` lookup |
| `connection` | The panel's HTTP endpoint goes through `connection.fetch.register`, which owns the Host/Origin check, Peer admission, and owner-only access — never an unprotected `webServer` route |

A composition with none of these still gets the skills and the five anonymous
sources; the sign-in panel is simply absent.

### Consensus replaces dsh-consensus

Both register the `mcp__consensus__*` namespace, so only one may run. This
bundle's version is a plain MCP source with the shared paper card; the
standalone `dsh-consensus` bundle renders its results differently. Enable one or
the other, not both.

## Python and Nextflow dependencies are installed on demand

The bundle ships instructions, not interpreters. Each skill states its own
requirements, and the agent installs what a task actually needs when it gets
there — nothing is bundled, and nothing installs at startup.

| Skill | What a task may need |
|---|---|
| `single-cell-rna-qc`, `scvi-tools` | `anndata`, `scanpy`, `scvi-tools`, `matplotlib`, `scipy` |
| `nextflow-development` | `nextflow`, a container runtime (Docker/Podman), `sra-tools` |
| `instrument-data-to-allotrope` | the pinned versions in `skills/instrument-data-to-allotrope/requirements.txt` |

Two cautions, both inherited from the upstream skills rather than added here:

- `nextflow-development` instructs installing Nextflow with
  `curl -s https://get.nextflow.io | bash`. That pipes a remote script into a
  shell; prefer the released binary from the Nextflow GitHub releases unless you
  have checked the endpoint.
- The allotrope `requirements.txt` pins exact versions for reproducible ASM
  output. Installing into a shared environment can downgrade `pandas` and
  `openpyxl`; use a virtual environment.


## Install

In DSH, open **Plugins → Add plugin** and enter:

```
dsh-for-bio
```

Or paste this repository's URL: <https://github.com/Miyamiz39/dsh-for-bio>

Then open the bundle's page to sign in to the data sources that need an account.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host plugin: registers skills, MCP servers, and the sign-in route |
| `client.js` | Browser half: the *Data source sign-in* panel |
| `lib/oauth.js` | MCP OAuth: discovery, dynamic registration, PKCE, loopback, token exchange |
| `lib/signin.js` | Sign-in controller and stored-grant handling |
| `lib/signin-api.js` | The panel's `connection.fetch` endpoint |
| `lib/papers.js` | Paper normalizers for PubMed, bioRxiv, and Consensus |
| `lib/papers.client.js` | Generated copy embedded in `client.js` |
| `tools/sync-papers.mjs` | Regenerates that copy; `--check` detects drift |
| `cordis.patch.yml` | Bundle patch inserting the `dsh-for-bio` row |
| `skills/` | The six skill bundles |
| `locale/*.json` | English and Chinese display metadata |
| `icon.svg` | Plugin icon |

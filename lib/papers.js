/**
 * Normalize paper-bearing MCP tool results into one card shape.
 *
 * The paper sources do not share a schema. PubMed's search returns only PMIDs,
 * its metadata call nests authors and dates, bioRxiv joins authors into one
 * semicolon string, and Consensus returns pre-formatted text blocks. Each
 * adapter below reads exactly one source and emits the same normalized record,
 * so the UI renders one card for all of them instead of pattern-matching four
 * different payloads.
 *
 * A tool that yields no papers returns an empty list, and the caller falls back
 * to the generic tool row: chemistry and clinical-trial sources stay untouched.
 *
 * @module
 */

/** A paper as the card renders it; every field but `title` is optional. */
export function paper(fields) {
  return {
    title: fields.title,
    ...(fields.authors === undefined ? {} : { authors: fields.authors }),
    ...(fields.year === undefined ? {} : { year: fields.year }),
    ...(fields.venue === undefined ? {} : { venue: fields.venue }),
    ...(fields.citations === undefined ? {} : { citations: fields.citations }),
    ...(fields.url === undefined ? {} : { url: fields.url }),
    ...(fields.abstract === undefined ? {} : { abstract: fields.abstract }),
    ...(fields.badge === undefined ? {} : { badge: fields.badge }),
  }
}

/** Join the first few author surnames for a compact line. */
function shortAuthors(names, max = 3) {
  if (names.length === 0) return undefined
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} et al.`
}

/** Read a value at a dotted path, or undefined. */
function at(value, path) {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** Coerce a numeric string; anything else is undefined. */
function count(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value)
  return undefined
}

/**
 * One PubMed metadata article.
 *
 * `authors` is `{ last_name, fore_name }[]`; the card wants surnames only, and
 * `publication_date` may carry just a year.
 */
export function fromPubMedMetadata(article) {
  const title = at(article, 'title')
  if (typeof title !== 'string' || title.length === 0) return undefined
  const authors = Array.isArray(article.authors)
    ? article.authors.map(a => a?.last_name).filter(name => typeof name === 'string')
    : []
  const year = count(at(article, 'publication_date.year'))
  const doi = at(article, 'identifiers.doi')
  return paper({
    title: title.replace(/\.$/u, ''),
    authors: shortAuthors(authors),
    year,
    venue: at(article, 'journal.iso_abbreviation') ?? at(article, 'journal.title'),
    ...(typeof doi === 'string' ? { url: `https://doi.org/${doi}` } : {}),
    ...(typeof article.abstract === 'string' && article.abstract.length > 0 ? { abstract: article.abstract } : {}),
  })
}

/** Whether a payload looks like the PubMed metadata envelope. */
function isPubMedMetadata(value) {
  return Array.isArray(value?.articles) && value.articles.every(a => typeof a?.title === 'string')
}

/** One bioRxiv result; `authors` is a single semicolon-separated string. */
export function fromBioRxivResult(result) {
  const title = at(result, 'title')
  if (typeof title !== 'string' || title.length === 0) return undefined
  const authors = typeof result.authors === 'string'
    ? result.authors.split(';').map(name => name.trim()).filter(Boolean)
    : []
  const year = typeof result.date === 'string' ? count(result.date.slice(0, 4)) : undefined
  const doi = result.doi
  return paper({
    title,
    authors: shortAuthors(authors),
    year,
    ...(typeof doi === 'string' ? { url: `https://doi.org/${doi}` } : {}),
    ...(typeof result.abstract_preview === 'string' ? { abstract: result.abstract_preview } : {}),
    badge: 'Preprint',
  })
}

/** Whether a payload looks like a bioRxiv search envelope. */
function isBioRxivResults(value) {
  return Array.isArray(value?.results) && value.results.every(r => typeof r?.title === 'string')
}

/**
 * Consensus returns pre-formatted text, one entry per paper:
 *
 *   [1] [Title](https://…?utm_source=claude_desktop) (Authors, 2020, 831 citations, Nature Communications)
 *
 * The URL is Consensus's own detail page, so it is kept as-is rather than
 * rewritten to a DOI link.
 */
const CONSENSUS_ENTRY = /^\[(\d+)\]\s+\[(.+?)\]\((https?:\/\/[^\s)]+)\)\s*\(([^)]*)\)/u

export function fromConsensusText(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const line of text.split(/\r?\n/u)) {
    const match = CONSENSUS_ENTRY.exec(line.trim())
    if (match === null) continue
    const [, , title, url, meta] = match
    // Meta reads "Authors, Year, N citations, Venue" with the fields optional,
    // so each part is classified rather than read by position.
    const parts = meta.split(',').map(part => part.trim()).filter(Boolean)
    let authors
    let year
    let citations
    const venueParts = []
    for (const part of parts) {
      const citationMatch = /^([\d,]+)\s+citations?$/u.exec(part)
      if (citationMatch !== null) {
        citations = count(citationMatch[1].replaceAll(',', ''))
        continue
      }
      if (/^(19|20)\d{2}$/u.test(part)) {
        year = Number(part)
        continue
      }
      // The first non-year, non-count part is the author list; the rest is venue.
      if (authors === undefined && /[a-z]/u.test(part) && !venueParts.length) {
        authors = part
        continue
      }
      venueParts.push(part)
    }
    out.push(
      paper({
        title,
        authors,
        year,
        citations,
        venue: venueParts.length > 0 ? venueParts.join(', ') : undefined,
        url,
      }),
    )
  }
  return out
}

/**
 * Normalize whatever a paper tool returned.
 *
 * @param text - the tool result as text (JSON or pre-formatted).
 * @returns normalized papers, empty when the result carries none.
 */
export function normalizePapers(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []

  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      return fromConsensusText(text)
    }
    if (isPubMedMetadata(value)) {
      return value.articles.map(fromPubMedMetadata).filter(Boolean)
    }
    if (isBioRxivResults(value)) {
      return value.results.map(fromBioRxivResult).filter(Boolean)
    }
    // A single article metadata call.
    if (typeof value?.title === 'string' && value.article_types !== undefined) {
      const one = fromPubMedMetadata(value)
      return one === undefined ? [] : [one]
    }
    return []
  }

  return fromConsensusText(text)
}

/**
 * Paper-bearing tools, by wire name.
 *
 * Membership is what lets the UI decide whether to draw a card or the generic
 * row; a tool absent here never attempts normalization.
 */
export const PAPER_TOOLS = new Set([
  'mcp__consensus__search',
  'mcp__pubmed__search_articles',
  'mcp__pubmed__get_article_metadata',
  'mcp__pubmed__find_related_articles',
  'mcp__biorxiv__search_preprints',
  'mcp__biorxiv__search_published_preprints',
  'mcp__biorxiv__get_preprint',
])

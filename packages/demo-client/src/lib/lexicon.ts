/**
 * Client-side lexicon metadata — mirrors the LexiconMeta type from @atsearch/common.
 *
 * Kept here so the demo-client has zero runtime dependency on the Node.js
 * common package. Keep in sync with packages/common/src/normalize.ts.
 */

export interface LexiconMeta {
  /** Short human-readable label for the type chip */
  label: string
  /** CSS variant class suffix: .type-chip--{variant} */
  variant: 'post' | 'profile' | 'feed' | 'list' | 'blog' | 'link' | 'function' | 'thing' | 'generic'
}

const LEXICON_META: Record<string, LexiconMeta> = {
  'app.bsky.feed.post':         { label: 'post',     variant: 'post' },
  'app.bsky.actor.profile':     { label: 'profile',  variant: 'profile' },
  'app.bsky.feed.generator':    { label: 'feed',     variant: 'feed' },
  'app.bsky.graph.list':        { label: 'list',     variant: 'list' },
  'app.bsky.graph.starterpack': { label: 'starter',  variant: 'list' },
  'com.whtwnd.blog.entry':      { label: 'blog',     variant: 'blog' },
  'fyi.unravel.frontpage.post': { label: 'link',     variant: 'link' },
  'blue.linkat.board':          { label: 'linkat',   variant: 'link' },
  'at.functions.metadata':      { label: 'function', variant: 'function' },
  'com.example.thing':          { label: 'thing',    variant: 'thing' },
}

/**
 * Return display metadata for a lexicon $type string.
 * Falls back gracefully: uses the last segment of the reverse-DNS identifier
 * (e.g. "app.bsky.graph.follow" → "follow") with the 'generic' variant.
 */
export function lexiconMeta($type: string): LexiconMeta {
  const known = LEXICON_META[$type]
  if (known) return known
  const segments = $type.split('.')
  const label = segments[segments.length - 1] ?? $type
  return { label, variant: 'generic' }
}

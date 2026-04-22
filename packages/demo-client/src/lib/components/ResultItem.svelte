<script lang="ts">
  import { onMount } from 'svelte'
  import type { SearchResult } from '$lib/api'
  import { fetchPostInteractions, type PostInteractionsResponse } from '$lib/api'
  import { recordWebUrl } from '$lib/recordWebUrl'

  export let result: SearchResult
  export let rank: number

  $: ({ ref, record, matchedDescriptors, score, verified, verificationError, fetchError } = result)
  $: webUrl = recordWebUrl(ref.uri, record.url, record.author?.handle)
  $: openLabel = (() => {
    if (record.$type === 'app.bsky.feed.post' && record.description) {
      const t = record.description.trim().slice(0, 80)
      return t ? `Open post: ${t}${record.description.length > 80 ? '…' : ''}` : 'Open post on Bluesky'
    }
    if (record.title?.trim()) return `Open: ${record.title.trim()}`
    return 'Open record'
  })()

  $: isPost    = record.$type === 'app.bsky.feed.post'
  $: isProfile = record.$type === 'app.bsky.actor.profile'

  $: statusLabel = verified
    ? 'verified'
    : fetchError?.includes('cache') || fetchError?.includes('unreachable')
      ? 'cache'
      : 'unverified'

  $: tagDescriptors   = matchedDescriptors.filter(d => d.startsWith('tag:'))
  $: tokenDescriptors = matchedDescriptors.filter(d => d.startsWith('token:'))
  $: geoDescriptors   = matchedDescriptors.filter(d => d.startsWith('geo:'))
  $: langDescriptors  = matchedDescriptors.filter(d => d.startsWith('lang:'))

  function truncateCid(cid: string): string {
    if (cid.length <= 20) return cid
    return cid.slice(0, 14) + '…' + cid.slice(-6)
  }

  function truncateUri(uri: string): string {
    const match = uri.match(/^(at:\/\/)(did:[^:]+:[^/]{0,6})[^/]*(\/[^/]+\/[^/]+)$/)
    if (match) return `${match[1]}${match[2]}…${match[3]}`
    return uri.length > 60 ? uri.slice(0, 57) + '…' : uri
  }

  function truncateDid(did: string): string {
    if (did.length <= 24) return did
    return did.slice(0, 16) + '…' + did.slice(-6)
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString('en', {
        year: 'numeric', month: 'short', day: 'numeric'
      })
    } catch { return iso }
  }

  let interactions: PostInteractionsResponse | null = null
  let interactionsLoading = false
  let interactionsError: string | null = null

  onMount(() => {
    if (result.record.$type === 'app.bsky.feed.post') {
      void loadInteractions(result.ref.uri)
    }
  })

  async function loadInteractions(subjectUri: string) {
    interactionsLoading = true
    interactionsError = null
    try {
      interactions = await fetchPostInteractions(subjectUri)
    } catch (e) {
      interactionsError = e instanceof Error ? e.message : 'Failed to load interactions'
    } finally {
      interactionsLoading = false
    }
  }

  let copied = ''
  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text)
    copied = key
    setTimeout(() => { copied = '' }, 1200)
  }
</script>

<article class="result" class:result--post={isPost} class:result--profile={isProfile}>
  <!-- Rank gutter -->
  <span class="rank" aria-label={`Result ${rank}`}>
    {String(rank).padStart(2, '0')}
  </span>

  <!-- Main content -->
  <div class="body">

    <!-- Title + snippet link out to canonical viewer when we can resolve a URL -->
    <div class="result-header">
      {#if webUrl}
        <a
          class="result-open"
          href={webUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={openLabel}
        >
          <div class="title-group">
            {#if isPost}
              <span class="type-chip type-chip--post">post</span>
              {#if record.author?.did}
                <span class="author-line">{record.author.handle ?? truncateDid(record.author.did)}</span>
              {/if}
            {:else if isProfile}
              <span class="type-chip type-chip--profile">profile</span>
              <h2 class="title">{record.title}</h2>
            {:else}
              <h2 class="title">{record.title}</h2>
            {/if}
          </div>
          {#if isPost && record.description}
            <p class="post-text">{record.description}</p>
          {:else if !isPost && record.description}
            <p class="description">{record.description}</p>
          {/if}
        </a>
      {:else}
        <div class="result-open result-open--static">
          <div class="title-group">
            {#if isPost}
              <span class="type-chip type-chip--post">post</span>
              {#if record.author?.did}
                <span class="author-line">{record.author.handle ?? truncateDid(record.author.did)}</span>
              {/if}
            {:else if isProfile}
              <span class="type-chip type-chip--profile">profile</span>
              <h2 class="title">{record.title}</h2>
            {:else}
              <h2 class="title">{record.title}</h2>
            {/if}
          </div>
          {#if isPost && record.description}
            <p class="post-text">{record.description}</p>
          {:else if !isPost && record.description}
            <p class="description">{record.description}</p>
          {/if}
        </div>
      {/if}

      <span class="status status--{statusLabel}" title={verificationError ?? fetchError ?? ''}>
        {statusLabel}
      </span>
    </div>

    {#if isPost && (interactionsLoading || interactions || interactionsError)}
      <div class="interactions" aria-label="Post interactions">
        {#if interactionsLoading}
          <p class="interactions-status">Loading likes and replies…</p>
        {:else if interactionsError}
          <p class="interactions-err" role="status">{interactionsError}</p>
        {:else if interactions}
          {#if interactions.partialErrors?.length}
            <p class="interactions-partial" role="status">
              {interactions.partialErrors.join(' · ')}
            </p>
          {/if}
          <p class="interactions-line">
            <span class="interactions-k">Likes</span>
            <span class="interactions-v"
              >{interactions.likesTotal ?? '—'}{interactions.likeSamples.length ? ` · sample` : ''}</span
            >
          </p>
          {#if interactions.likeSamples.length}
            <ul class="interactions-list">
              {#each interactions.likeSamples as s (s.ref.uri + '::' + s.ref.cid)}
                <li>
                  <code class="interactions-ref">{s.titleHint ?? truncateCid(s.ref.cid)}</code>
                </li>
              {/each}
            </ul>
          {/if}
          <p class="interactions-line">
            <span class="interactions-k">Replies</span>
            <span class="interactions-v"
              >{interactions.repliesTotal ?? '—'}{interactions.replySamples.length ? ` · sample` : ''}</span
            >
          </p>
          {#if interactions.replySamples.length}
            <ul class="interactions-list">
              {#each interactions.replySamples as s (s.ref.uri + '::' + s.ref.cid)}
                <li>
                  <code class="interactions-ref">{s.titleHint ?? truncateCid(s.ref.cid)}</code>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Tags -->
    {#if record.tags && record.tags.length > 0}
      <div class="tags" role="list" aria-label="Tags">
        {#each record.tags as tag (tag)}
          <span class="tag" role="listitem">#{tag}</span>
        {/each}
      </div>
    {/if}

    <!-- Location (com.example.thing) -->
    {#if record.location}
      <div class="location">
        <span class="location-icon" aria-hidden="true">◎</span>
        {record.location.lat.toFixed(4)}, {record.location.lon.toFixed(4)}
        <span class="geohash">{record.location.geohash}</span>
      </div>
    {/if}

    <!-- Author DID for profiles (shows the actual DID below the bio) -->
    {#if isProfile && record.author?.did}
      <div class="profile-did">
        <span class="meta-label">did</span>
        <code class="meta-value">{truncateDid(record.author.did)}</code>
      </div>
    {/if}

    <!-- Technical metadata -->
    <div class="meta">
      <button
        class="meta-row copyable"
        title="Click to copy URI"
        on:click={() => copy(ref.uri, 'uri')}
        aria-label="Copy URI to clipboard"
      >
        <span class="meta-label">uri</span>
        <code class="meta-value">{truncateUri(ref.uri)}</code>
        <span class="copy-hint" aria-hidden="true">{copied === 'uri' ? '✓' : ''}</span>
      </button>

      <button
        class="meta-row copyable"
        title="Click to copy CID"
        on:click={() => copy(ref.cid, 'cid')}
        aria-label="Copy CID to clipboard"
      >
        <span class="meta-label">cid</span>
        <code class="meta-value">{truncateCid(ref.cid)}</code>
        <span class="copy-hint" aria-hidden="true">{copied === 'cid' ? '✓' : ''}</span>
      </button>

      <div class="meta-row">
        <span class="meta-label">date</span>
        <span class="meta-value">{formatDate(record.createdAt)}</span>
      </div>

      <div class="meta-row meta-score-row">
        <span class="meta-label">score</span>
        <span class="score {score >= 0 ? 'score--pos' : 'score--neg'}">
          {score >= 0 ? '+' : ''}{score}
        </span>

        {#if tagDescriptors.length > 0 || tokenDescriptors.length > 0 || geoDescriptors.length > 0 || langDescriptors.length > 0}
          <span class="descriptors" aria-label="Matched descriptors">
            {#each tagDescriptors as d (d)}
              <span class="descriptor descriptor--tag">{d}</span>
            {/each}
            {#each tokenDescriptors as d (d)}
              <span class="descriptor descriptor--token">{d}</span>
            {/each}
            {#each geoDescriptors as d (d)}
              <span class="descriptor descriptor--geo">{d}</span>
            {/each}
            {#each langDescriptors as d (d)}
              <span class="descriptor descriptor--lang">{d}</span>
            {/each}
          </span>
        {/if}
      </div>
    </div>
  </div>
</article>

<style>
  .result {
    display: grid;
    grid-template-columns: var(--sp-12) 1fr;
    gap: 0 var(--sp-4);
    padding: var(--sp-4) 0;
    border-top: 1px solid var(--border-subtle);
    transition: border-color var(--duration) var(--ease-out);
  }

  .result:hover {
    border-color: var(--border);
  }

  /* ── Rank ─────────────────────────────── */
  .rank {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-dim);
    line-height: 1.7;
    padding-top: 2px;
    user-select: none;
  }

  /* ── Body ─────────────────────────────── */
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .result-header {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }

  .result-open {
    flex: 1;
    min-width: 0;
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: 2px;
    margin: -2px;
    border-radius: 3px;
  }

  .result-open:hover .title,
  .result-open:hover .author-line {
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 3px;
  }

  .result-open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .result-open--static {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .title-group {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.015em;
    line-height: 1.35;
  }

  .author-line {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  /* ── Type chips ───────────────────────── */
  .type-chip {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px var(--sp-2);
    border-radius: 3px;
    flex-shrink: 0;
    user-select: none;
  }

  .type-chip--post {
    color: var(--text-muted);
    background: var(--accent-tint);
  }

  .type-chip--profile {
    color: var(--text-muted);
    background: var(--accent-tint);
  }

  /* ── Status badge ─────────────────────── */
  .status {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px var(--sp-2);
    border-radius: 3px;
  }

  .status--verified   { color: var(--verified);  background: var(--verified-tint); }
  .status--unverified { color: var(--error);      background: var(--error-tint); }
  .status--cache      { color: var(--cache);      background: var(--cache-tint); }

  /* ── Post text ────────────────────────── */
  .interactions {
    margin-top: var(--sp-2);
    padding: var(--sp-3) 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .interactions-status,
  .interactions-err,
  .interactions-partial {
    margin: 0 0 var(--sp-2);
    line-height: 1.45;
  }

  .interactions-err {
    color: var(--error);
  }

  .interactions-partial {
    color: var(--text-dim);
    font-size: var(--text-xs);
  }

  .interactions-line {
    display: flex;
    gap: var(--sp-2);
    margin: var(--sp-1) 0;
    align-items: baseline;
  }

  .interactions-k {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 3.5rem;
  }

  .interactions-v {
    font-variant-numeric: tabular-nums;
  }

  .interactions-list {
    margin: 0 0 var(--sp-2);
    padding-left: var(--sp-4);
    list-style: disc;
  }

  .interactions-ref {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    word-break: break-all;
  }

  .post-text {
    font-size: var(--text-base);
    color: var(--text);
    line-height: 1.6;
    max-width: 62ch;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── Description (profiles, com.example.thing) ── */
  .description {
    font-size: var(--text-base);
    color: var(--text-muted);
    line-height: 1.55;
    max-width: 62ch;
  }

  /* ── Tags ─────────────────────────────── */
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-2);
    margin-top: var(--sp-1);
  }

  .tag {
    font-size: var(--text-sm);
    color: var(--text-dim);
    letter-spacing: 0.01em;
  }

  .tag:hover { color: var(--text-muted); }

  /* ── Location ─────────────────────────── */
  .location {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--text-sm);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .location-icon {
    color: var(--accent-dim);
    font-size: var(--text-xs);
  }

  .geohash {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent-dim);
    padding: 1px var(--sp-2);
    background: var(--accent-tint);
    border-radius: 3px;
  }

  /* ── Profile DID row ──────────────────── */
  .profile-did {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }

  /* ── Technical metadata ───────────────── */
  .meta {
    margin-top: var(--sp-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .meta-row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    min-height: 22px;
  }

  .meta-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    width: 2.5rem;
    flex-shrink: 0;
    user-select: none;
    padding-top: 1px;
  }

  .meta-value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    word-break: break-all;
    line-height: 1.5;
  }

  /* Copyable rows */
  .copyable {
    all: unset;
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    cursor: pointer;
    border-radius: 2px;
    transition: color var(--duration) var(--ease-out);
  }

  .copyable:hover .meta-value { color: var(--text); }

  .copyable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .copy-hint {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--verified);
    min-width: 1ch;
  }

  /* Score row */
  .meta-score-row {
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .score {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .score--pos { color: var(--accent); }
  .score--neg { color: var(--text-dim); }

  /* ── Descriptor pills ─────────────────── */
  .descriptors {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-2);
    align-items: center;
  }

  .descriptor {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .descriptor--tag {
    color: var(--d-tag);
    background: var(--accent-tint);
  }

  .descriptor--token {
    color: var(--d-token);
    background: var(--accent-tint);
  }

  .descriptor--geo {
    color: var(--d-geo);
    background: var(--accent-tint);
  }
  .descriptor--lang  { color: var(--text-dim); background: var(--surface-raised); }

  /* ── Responsive ───────────────────────── */
  @media (max-width: 560px) {
    .result {
      grid-template-columns: var(--sp-8) 1fr;
      gap: 0 var(--sp-4);
    }

    .rank { font-size: var(--text-xs); }
    .title { font-size: var(--text-base); }
    .post-text { font-size: var(--text-sm); }
  }
</style>

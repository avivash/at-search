<script lang="ts">
  import { search, type SearchResponse, type SearchResult } from "$lib/api";
  import SearchInput from "$lib/components/SearchInput.svelte";
  import ResultItem from "$lib/components/ResultItem.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";

  const PAGE_SIZE = 10;

  let query = "";
  let loading = false;
  let error: string | null = null;
  let response: SearchResponse | null = null;
  let hasSearched = false;
  let allResults: SearchResult[] = [];
  let pageIndex = 0;

  let inputValue = "";

  async function handleSearch(q: string) {
    if (!q.trim()) return;
    inputValue = q.trim();
    query = q.trim();
    loading = true;
    error = null;

    try {
      response = await search(query);
      hasSearched = true;
      allResults = response?.results ?? [];
      pageIndex = 0;
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      response = null;
      allResults = [];
      pageIndex = 0;
    } finally {
      loading = false;
    }
  }

  $: totalCount = allResults.length;
  $: pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  $: pageStart = totalCount === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  $: pageEnd = Math.min(totalCount, (pageIndex + 1) * PAGE_SIZE);
  $: pageResults = allResults.slice(
    pageIndex * PAGE_SIZE,
    (pageIndex + 1) * PAGE_SIZE,
  );
  $: took = response?.took ?? 0;

  function goToPage(p: number) {
    const next = Math.max(0, Math.min(p, pageCount - 1));
    pageIndex = next;
    const main = document.getElementById("main");
    main?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

<svelte:head>
  <title>AT Search{query ? ` — ${query}` : ""}</title>
</svelte:head>

<div class="shell">
  <header class="top">
    <a href="/" class="wordmark" aria-label="AT Search home">
      <span class="wordmark-at">AT Search</span>
    </a>
    <ThemeToggle />
  </header>

  <main class="main" id="main">
    <div class="search-block">
      <SearchInput
        bind:value={inputValue}
        {loading}
        on:submit={(e) => handleSearch(e.detail)}
      />

      {#if error}
        <p class="error-banner" role="alert">{error}</p>
      {/if}
    </div>

    {#if response && totalCount > 0}
      <p class="results-meta" aria-live="polite">
        <span class="meta-strong">{totalCount}</span>
        <span class="meta-rest">
          results · {pageStart}–{pageEnd} · {took} ms</span
        >
      </p>

      <ol class="results" aria-label="Search results">
        {#each pageResults as result, i (result.ref.uri + "::" + result.ref.cid)}
          <li>
            <ResultItem {result} rank={pageIndex * PAGE_SIZE + i + 1} />
          </li>
        {/each}
      </ol>

      {#if pageCount > 1}
        <nav class="pagination" aria-label="Pages">
          <button
            type="button"
            class="page-btn"
            disabled={pageIndex <= 0}
            on:click={() => goToPage(pageIndex - 1)}
          >
            Previous
          </button>
          <span class="page-indicator">{pageIndex + 1} / {pageCount}</span>
          <button
            type="button"
            class="page-btn"
            disabled={pageIndex >= pageCount - 1}
            on:click={() => goToPage(pageIndex + 1)}
          >
            Next
          </button>
        </nav>
      {/if}
    {:else if !loading}
      <EmptyState {query} {hasSearched} />
    {/if}
  </main>
</div>

<style>
  .shell {
    min-height: 100dvh;
    max-width: 44rem;
    margin: 0 auto;
    padding: var(--sp-6) var(--sp-6) var(--sp-12);
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    margin-bottom: var(--sp-4);
  }

  .wordmark {
    display: inline-flex;
    align-items: baseline;
    text-decoration: none;
    line-height: 1;
    letter-spacing: -0.04em;
    font-weight: 700;
    font-size: var(--text-lg);
  }

  .wordmark-at {
    color: var(--accent);
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .search-block {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .error-banner {
    font-size: var(--text-sm);
    color: var(--error);
    line-height: 1.45;
    max-width: none;
  }

  .results-meta {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--text-dim);
    letter-spacing: 0.01em;
  }

  .meta-strong {
    font-weight: 600;
    color: var(--text-muted);
  }

  .meta-rest {
    font-weight: 400;
  }

  .results {
    list-style: none;
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-6);
    padding: var(--sp-4) 0;
  }

  .page-btn {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    padding: var(--sp-2) var(--sp-4);
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color var(--duration) var(--ease-out),
      border-color var(--duration) var(--ease-out),
      background var(--duration) var(--ease-out);
  }

  .page-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border);
    background: var(--surface);
  }

  .page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .page-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .page-indicator {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 4rem;
    text-align: center;
  }

  @media (max-width: 520px) {
    .shell {
      padding: var(--sp-4) var(--sp-4) var(--sp-8);
    }

    .top {
      margin-bottom: var(--sp-3);
    }
  }
</style>

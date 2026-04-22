<script lang="ts">
  export let query: string = ''
  export let hasSearched: boolean = false
</script>

{#if hasSearched}
  <div class="no-results" role="status">
    <p class="headline">No results for <span class="query-echo">"{query}"</span></p>
    <p class="sub">Try another keyword or handle.</p>
  </div>
{/if}

<style>
  .no-results {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-4) 0 0;
    max-width: 36rem;
  }

  .headline {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
    line-height: 1.4;
    max-width: none;
  }

  .sub {
    font-size: var(--text-sm);
    color: var(--text-dim);
    max-width: 40ch;
    line-height: 1.5;
  }

  .query-echo {
    color: var(--text-muted);
    font-weight: 500;
  }
</style>

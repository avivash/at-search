<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  export let value: string = ''
  export let loading: boolean = false
  export let placeholder: string = 'Search…'

  const dispatch = createEventDispatcher<{ submit: string }>()

  let inputEl: HTMLInputElement

  function handleSubmit(e: Event) {
    e.preventDefault()
    const q = value.trim()
    if (q) dispatch('submit', q)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      value = ''
      inputEl?.blur()
    }
  }
</script>

<form class="search-form" on:submit={handleSubmit} role="search">
  <div class="input-wrap" class:loading>
    <span class="search-icon" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    </span>

    <input
      bind:this={inputEl}
      bind:value
      type="search"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      {placeholder}
      aria-label="Search"
      class="input"
      on:keydown={handleKeydown}
    />

    {#if loading}
      <span class="spinner" aria-hidden="true"></span>
    {:else if value}
      <button
        type="button"
        class="icon-btn clear-btn"
        aria-label="Clear"
        on:click={() => { value = ''; inputEl?.focus() }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    {/if}

    <button type="submit" class="submit-btn" disabled={!value.trim() || loading} aria-label="Search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  </div>
</form>

<style>
  .search-form {
    width: 100%;
    max-width: 42rem;
  }

  .input-wrap {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    transition: border-color var(--duration) var(--ease-out);
  }

  .input-wrap:focus-within {
    border-color: var(--border);
  }

  .input-wrap.loading {
    opacity: 0.65;
    pointer-events: none;
  }

  .search-icon {
    display: flex;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 450;
    letter-spacing: -0.02em;
    color: var(--text);
    padding: var(--sp-3) var(--sp-1) var(--sp-3) 0;
    min-width: 0;
    appearance: none;
  }

  .input::placeholder {
    color: var(--text-dim);
    font-weight: 400;
  }

  .input::-webkit-search-cancel-button,
  .input::-webkit-search-decoration {
    appearance: none;
  }

  .icon-btn {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-dim);
    cursor: pointer;
    padding: var(--sp-2);
    border-radius: 4px;
    transition:
      color var(--duration) var(--ease-out),
      background var(--duration) var(--ease-out);
  }

  .clear-btn:hover {
    color: var(--text-muted);
    background: var(--accent-tint);
  }

  .submit-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    margin: var(--sp-1) 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color var(--duration) var(--ease-out),
      background var(--duration) var(--ease-out);
  }

  .submit-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-tint);
  }

  .submit-btn:active:not(:disabled) {
    background: var(--surface-raised);
  }

  .submit-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .submit-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .spinner {
    flex-shrink: 0;
    width: 1.0625rem;
    height: 1.0625rem;
    margin-right: var(--sp-1);
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.65s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-top-color: var(--accent);
    }
  }
</style>

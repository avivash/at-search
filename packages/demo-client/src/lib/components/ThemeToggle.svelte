<script lang="ts">
  import { onMount } from 'svelte'
  import { applyTheme, toggleTheme, type Theme } from '$lib/theme'

  let theme: Theme = 'light'

  onMount(() => {
    const t = document.documentElement.dataset.theme
    theme = t === 'dark' ? 'dark' : 'light'
  })

  function onClick() {
    theme = toggleTheme(theme)
  }
</script>

<button
  type="button"
  class="theme-toggle"
  on:click={onClick}
  aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
  title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
>
  {#if theme === 'dark'}
    <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke-linecap="round" />
    </svg>
  {:else}
    <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
      <path d="M21 14.5A8.5 8.5 0 0111.5 3a6.5 6.5 0 109.5 11.5z" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {/if}
</button>

<style>
  .theme-toggle {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color var(--duration) var(--ease-out),
      background var(--duration) var(--ease-out);
  }

  .theme-toggle:hover {
    color: var(--text);
    background: var(--accent-tint);
  }

  .theme-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .icon {
    display: block;
  }
</style>

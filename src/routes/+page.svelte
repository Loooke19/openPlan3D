<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { t } from '$lib/i18n';
  import ImportedProjectCards from '$lib/components/ImportedProjectCards.svelte';
  import { importOrigin } from '$lib/utils/importOrigin';
  import { fetchImportedProjects, type ImportedProject } from '$lib/utils/importedProjects';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let projects = $state<ImportedProject[]>([]);
  let apiOrigin = $state('');

  async function refresh() {
    loading = true;
    error = null;
    try {
      apiOrigin = importOrigin().replace(/\/$/, '');
      projects = await fetchImportedProjects(apiOrigin);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      projects = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    const hash = window.location.hash;
    if (hash) requestAnimationFrame(() => document.querySelector(hash)?.scrollIntoView({ block: 'center' }));
  });
</script>

<div class="min-h-screen bg-gray-50" data-testid="imported-project-home">
  <div class="bg-gradient-to-r from-slate-800 to-slate-700 shadow-sm">
    <div class="max-w-5xl mx-auto px-6 py-5 flex flex-wrap gap-4 items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{$t('library.importedTitle')}</h1>
        <p class="text-sm text-white/50 mt-0.5">
          {loading ? $t('library.loading') : $t(projects.length === 1 ? 'library.countOne' : 'library.countMany', { count: projects.length })}
        </p>
      </div>
    </div>
  </div>

  <div class="max-w-5xl mx-auto px-6 py-8">
    <p class="mb-5 text-sm text-gray-500">{$t('library.importedHelp')}</p>
    {#if error}
      <div role="alert" class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p>{error}</p>
        <button class="mt-3 font-semibold underline" onclick={() => void refresh()}>{$t('library.retry')}</button>
      </div>
    {:else if loading}
      <p role="status" class="py-12 text-center text-gray-500">{$t('library.loadingSaved')}</p>
    {:else if projects.length === 0}
      <p class="py-12 text-center text-gray-500">{$t('library.importedEmpty')}</p>
    {:else}
      <ImportedProjectCards {projects} {apiOrigin} appBase={base} />
    {/if}
  </div>
</div>

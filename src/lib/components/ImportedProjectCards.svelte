<script lang="ts">
  import { t } from '$lib/i18n';
  import { editorProjectHref, navProjectHref } from '$lib/utils/importedProjectLinks';
  import type { ImportedProject } from '$lib/utils/importedProjects';

  let {
    projects,
    apiOrigin,
    appBase = '',
  }: {
    projects: ImportedProject[];
    apiOrigin: string;
    appBase?: string;
  } = $props();
</script>

<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
  {#each projects as project (project.id)}
    <article
      class="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-gray-300 transition-all duration-200"
      id={`p-${project.id}`}
      data-testid="imported-project-card"
      data-project-id={project.id}
      data-project-name={project.name}
    >
      <div class="p-4">
        <h3 class="font-semibold text-gray-800 text-sm truncate">{project.name}</h3>
        <p class="text-xs text-gray-400 mt-1">
          {#if project.floorCount}{project.floorCount} 层 · {/if}{project.id}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={navProjectHref(appBase, apiOrigin, project.id)}
            class="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            data-testid="nav-browse"
          >{$t('library.navBrowse')}</a>
          <a
            href={editorProjectHref(appBase, apiOrigin, project.id)}
            class="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            data-testid="edit-project"
          >{$t('library.edit')}</a>
        </div>
      </div>
    </article>
  {/each}
</div>

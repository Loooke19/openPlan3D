<script lang="ts">
  import { onMount } from 'svelte';
  import { importOrigin } from '$lib/utils/importOrigin';
  import { filesPageUrl } from '$lib/utils/importedProjectLinks';

  /** Default home is the import-service file cards (`/files`), not the local IndexedDB library. */
  onMount(() => {
    const hash = window.location.hash;
    window.location.replace(`${filesPageUrl(importOrigin())}${hash || ''}`);
  });
</script>

<p data-testid="imported-project-home">正在打开文件…</p>

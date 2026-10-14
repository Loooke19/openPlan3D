<script lang="ts">
  import { onMount } from 'svelte';
  import { importOrigin } from '$lib/utils/importOrigin';
  import { projectHomeUrl } from '$lib/utils/projectLibraryUrl';

  /** Default home is the import-service file cards, not the local IndexedDB library. */
  onMount(() => {
    const hash = window.location.hash.match(/^#p-(.+)$/)?.[1];
    window.location.replace(projectHomeUrl(hash ? decodeURIComponent(hash) : null, importOrigin()));
  });
</script>

<p>正在打开文件…</p>

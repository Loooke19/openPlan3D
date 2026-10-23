<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  onMount(() => {
    goto("/nav", { replaceState: true });
  });
</script>
<main style="font-family:system-ui;padding:2rem;color:#333">
  <p>merge-8 测试入口请使用 <code>/nav?projectUrl=...</code></p>
  <p>正在转到 <a href="/nav">/nav</a>。</p>
</main>

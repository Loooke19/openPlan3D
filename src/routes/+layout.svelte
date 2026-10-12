<script>
  import '../app.css';
  import { initializeLocale } from '$lib/i18n';
  onMount(initializeLocale);
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { themePreference } from '$lib/stores/theme';
  import DeploymentNotice from '$lib/components/DeploymentNotice.svelte';
  // Loopback defaults off analytics (adblockers trip ERR_BLOCKED_BY_CONTENT_BLOCKER on GTM/GA).
  // Set PUBLIC_ENABLE_ANALYTICS=true to force on; =false always disables (incl. non-loopback).
  onMount(() => {
    if (window.location.pathname === '/render-lab') return;
    const host = window.location.hostname;
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    const flag = env.PUBLIC_ENABLE_ANALYTICS;
    const enabled = flag === 'true' || (!loopback && flag !== 'false');
    if (enabled) void import('$lib/firebase');
  });
  let { children } = $props();
</script>

{@render children()}
<DeploymentNotice />

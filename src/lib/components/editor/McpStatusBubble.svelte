<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { currentProject } from '$lib/stores/project';
  import { applyEditorCommand, type EditorCommand } from '$lib/editorMcp/apply';

  const DEFAULT_ORIGIN = 'http://127.0.0.1:8879';

  let open = $state(false);
  let status = $state<'offline' | 'token' | 'online'>('offline');
  let linked = $state(false);
  let tokenRequired = $state(false);
  let copying = $state('');
  let token = $state('');
  let origin = $state(DEFAULT_ORIGIN);
  let configText = $state('');
  let root: HTMLDivElement | undefined = $state();

  function loopbackOrigin(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || url.username) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function readOrigin() {
    const query = new URL(window.location.href).searchParams.get('mcpOrigin');
    const fromQuery = query ? loopbackOrigin(query) : null;
    if (fromQuery) sessionStorage.setItem('openplan-editor-mcp-origin', fromQuery);
    origin = fromQuery || loopbackOrigin(sessionStorage.getItem('openplan-editor-mcp-origin') || '') || DEFAULT_ORIGIN;
    token = sessionStorage.getItem('openplan-editor-mcp-token') || '';
  }

  function sessionId() {
    let id = sessionStorage.getItem('openplan-editor-mcp-session');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('openplan-editor-mcp-session', id);
    }
    return id;
  }

  function headers() {
    const next: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) next['X-OpenPlan-Token'] = token;
    return next;
  }

  function fallbackConfig() {
    const port = new URL(origin).port || '80';
    const server: Record<string, unknown> = { url: `${origin}/mcp` };
    if (tokenRequired) server.headers = { Authorization: 'Bearer YOUR_TOKEN' };
    return {
      host: '127.0.0.1',
      port: Number(port),
      mcpPath: '/mcp',
      mcpUrl: `${origin}/mcp`,
      env: { OPENPLAN_MCP_HOST: '127.0.0.1', OPENPLAN_MCP_PORT: port, OPENPLAN_MCP_TOKEN: '可选，留空则不校验' },
      start: ['python3 scripts/openplan_editor_mcp.py', 'py -3 scripts/openplan_editor_mcp.py'],
      notes: [
        '在 gifu-hospital-3d-tour 仓库里启动，进程只听 127.0.0.1。',
        'Cursor 使用下面的 mcp.json。编辑器页保持打开，气泡为绿色后再改工程。',
      ],
      mcpJson: { mcpServers: { 'openplan-editor': server } },
    };
  }

  let shown = $state(fallbackConfig());
  let lastProject = '';
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const health = await fetch(`${origin}/bridge/health`, { signal: AbortSignal.timeout(2000) });
      if (!health.ok) throw new Error('health');
      const info = await health.json();
      tokenRequired = Boolean(info.tokenRequired);
      const project = get(currentProject);
      if (!project) {
        status = 'online';
        linked = false;
        return;
      }
      const body = JSON.stringify(project);
      const sendHeartbeat = linked && body === lastProject;
      const posted = await fetch(`${origin}/bridge/session`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sessionId: sessionId(),
          editor: `${location.origin}${location.pathname}`,
          heartbeat: sendHeartbeat,
          project: sendHeartbeat ? undefined : JSON.parse(body),
        }),
      });
      if (posted.status === 401) {
        status = 'token';
        linked = false;
        return;
      }
      if (!posted.ok) {
        linked = false;
        lastProject = '';
        status = 'online';
        return;
      }
      lastProject = body;
      linked = true;
      status = 'online';
      const pending = await fetch(`${origin}/bridge/commands?sessionId=${encodeURIComponent(sessionId())}`, { headers: headers() });
      if (pending.status === 401) {
        status = 'token';
        return;
      }
      if (!pending.ok) return;
      const commands = (await pending.json()).commands as EditorCommand[];
      for (const command of commands || []) {
        const result = await applyEditorCommand(command);
        if (result.ok) lastProject = '';
        await fetch(`${origin}/bridge/ack`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            sessionId: sessionId(),
            id: command.id,
            ok: result.ok,
            error: result.error,
            summary: result.summary,
            project: result.project,
          }),
        });
      }
    } catch {
      status = 'offline';
      linked = false;
    } finally {
      busy = false;
    }
  }

  async function refreshConfig() {
    try {
      const response = await fetch(`${origin}/bridge/config`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) shown = await response.json();
      else shown = fallbackConfig();
    } catch {
      shown = fallbackConfig();
    }
    configText = JSON.stringify(shown.mcpJson, null, 2);
  }

  function saveToken(value: string) {
    token = value.trim();
    if (token) sessionStorage.setItem('openplan-editor-mcp-token', token);
    else sessionStorage.removeItem('openplan-editor-mcp-token');
    linked = false;
    lastProject = '';
    void tick();
  }

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copying = label;
      setTimeout(() => { if (copying === label) copying = ''; }, 1200);
    } catch {
      copying = '';
    }
  }

  function onWindowClick(event: MouseEvent) {
    if (!open || !root || root.contains(event.target as Node)) return;
    open = false;
  }

  onMount(() => {
    readOrigin();
    shown = fallbackConfig();
    configText = JSON.stringify(shown.mcpJson, null, 2);
    void tick();
    const timer = setInterval(() => { void tick(); }, 800);
    window.addEventListener('click', onWindowClick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('click', onWindowClick);
    };
  });

  function toggle() {
    open = !open;
    if (open) void refreshConfig();
  }

  let label = $derived(status === 'online' ? (linked ? '在线' : '等待工程') : status === 'token' ? '需要 token' : '离线');
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') open = false; }} />

<div class="mcp-bubble" bind:this={root} data-mcp-status={status} data-mcp-linked={linked ? 'yes' : 'no'}>
  <button
    type="button"
    class="pill"
    data-testid="mcp-status-bubble"
    aria-expanded={open}
    aria-controls="mcp-status-popover"
    title="MCP {label}"
    onclick={(event) => { event.stopPropagation(); toggle(); }}
  >
    <span class="dot" data-state={status}></span>
    <span>MCP {label}</span>
  </button>
  {#if open}
    <div class="panel" id="mcp-status-popover" data-testid="mcp-status-popover" role="dialog" aria-label="MCP 部署">
      <header>
        <strong>MCP</strong>
        <span data-state={status}>{label}</span>
      </header>
      <section>
        <h2>部署</h2>
        <ol>
          {#each shown.notes as note}
            <li>{note}</li>
          {/each}
          <li>启动：<code>{shown.start[0]}</code></li>
        </ol>
      </section>
      <section>
        <h2>参数</h2>
        <dl>
          <div><dt>host</dt><dd>127.0.0.1</dd></div>
          <div><dt>port</dt><dd>{shown.port}</dd></div>
          <div><dt>path</dt><dd>{shown.mcpPath}</dd></div>
          <div><dt>url</dt><dd>{shown.mcpUrl}</dd></div>
        </dl>
        <p class="env">OPENPLAN_MCP_HOST=127.0.0.1
OPENPLAN_MCP_PORT={shown.port}
OPENPLAN_MCP_TOKEN=</p>
        <label>
          本机 token
          <input
            type="password"
            autocomplete="off"
            value={token}
            placeholder="可选"
            onchange={(event) => saveToken(event.currentTarget.value)}
          />
        </label>
        <div class="copybar">
          <span>mcp.json</span>
          <button type="button" data-testid="mcp-copy-config" onclick={() => copy('json', configText)}>{copying === 'json' ? '已复制' : '复制'}</button>
        </div>
        <pre>{configText}</pre>
      </section>
    </div>
  {/if}
</div>

<style>
  .mcp-bubble {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 80;
    font-size: 12px;
    color: #334155;
  }
  .pill {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid #d6d3d1;
    border-radius: 999px;
    background: #fff;
    color: #334155;
    box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
    cursor: pointer;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #a8a29e;
  }
  .dot[data-state='online'] { background: #16a34a; }
  .dot[data-state='token'] { background: #d97706; }
  .panel {
    position: absolute;
    right: 0;
    bottom: 36px;
    width: min(360px, calc(100vw - 32px));
    max-height: min(70vh, 520px);
    overflow: auto;
    padding: 12px 14px;
    border: 1px solid #e7e5e4;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
  }
  header, .copybar, label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  header span[data-state='online'] { color: #15803d; }
  header span[data-state='token'] { color: #b45309; }
  header span[data-state='offline'] { color: #78716c; }
  section { margin-top: 12px; }
  h2 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #78716c;
  }
  ol { margin: 0; padding-left: 1.1rem; }
  li { margin: 4px 0; line-height: 1.45; }
  code, pre, .env {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
  }
  dl { margin: 0; }
  dl div { display: grid; grid-template-columns: 52px 1fr; gap: 8px; margin: 2px 0; }
  dt { color: #78716c; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .env {
    margin: 8px 0;
    white-space: pre-wrap;
    color: #44403c;
  }
  input {
    width: 180px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid #d6d3d1;
    border-radius: 4px;
    font: inherit;
  }
  .copybar { margin-top: 8px; }
  .copybar button, .pill { font: inherit; }
  .copybar button {
    height: 24px;
    padding: 0 8px;
    border: 1px solid #d6d3d1;
    border-radius: 4px;
    background: #fafaf9;
    cursor: pointer;
  }
  pre {
    margin: 6px 0 0;
    padding: 8px;
    overflow: auto;
    border-radius: 4px;
    background: #fafaf9;
    white-space: pre-wrap;
  }
</style>

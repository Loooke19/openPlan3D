<script lang="ts">
  import { searchPlaces, isCommon, type IndexedPlace } from '$lib/utils/placeSearch';
  let { value = $bindable(''), places, label, placeholder = '选择', onchange }: {
    value: string; places: IndexedPlace[]; label: string; placeholder?: string; onchange?: () => void;
  } = $props();
  let open = $state(false);
  let q = $state('');
  let input: HTMLInputElement | undefined = $state();
  const current = $derived(places.find(p => p.key === value));
  const results = $derived(searchPlaces(places, q));
  const common = $derived(q ? [] : results.filter(isCommon).slice(0, 8));
  const groups = $derived.by(() => {
    const m = new Map<string, IndexedPlace[]>();
    for (const p of results) { if (!m.has(p.floorLabel)) m.set(p.floorLabel, []); m.get(p.floorLabel)!.push(p); }
    return [...m.entries()];
  });
  function pick(p: IndexedPlace) { value = p.key; open = false; q = ''; onchange?.(); }
  function show() { open = true; setTimeout(() => input?.focus(), 30); }
</script>

<button type="button" class="pp-field" aria-label={label} aria-haspopup="dialog" onclick={show}>
  {current ? `${current.floorLabel} · ${current.name}` : placeholder}
</button>
{#if open}
  <div class="pp-backdrop" role="presentation" onclick={() => (open = false)}></div>
  <div class="pp-sheet" role="dialog" aria-label={label}>
    <div class="pp-head">
      <input bind:this={input} bind:value={q} type="search" placeholder="搜索科室 / 拼音 / 首字母，如 kqb" aria-label="搜索地点" />
      <button type="button" class="pp-close" onclick={() => (open = false)}>取消</button>
    </div>
    <div class="pp-list">
      {#if common.length}
        <div class="pp-group">常用</div>
        {#each common as p (p.key + 'c')}
          <button type="button" class="pp-item" onclick={() => pick(p)}><span>{p.name}</span><small>{p.floorLabel}</small></button>
        {/each}
      {/if}
      {#each groups as [floor, list] (floor)}
        <div class="pp-group">{floor}</div>
        {#each list as p (p.key)}
          <button type="button" class="pp-item" class:sel={p.key === value} onclick={() => pick(p)}>
            <span>{p.name}{#if p.originalName}<em>（图上：{p.originalName}）</em>{/if}</span><small>{p.floorLabel}</small>
          </button>
        {/each}
      {/each}
      {#if !results.length}<p class="pp-empty">没有找到「{q}」</p>{/if}
    </div>
  </div>
{/if}

<style>
  .pp-field { flex: 1; min-width: 0; min-height: 44px; text-align: left; padding: 6px 10px; border: 1px solid #ccd; border-radius: 6px; background: #fff; font: inherit; white-space: normal; word-break: break-all; line-height: 1.3; }
  .pp-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 90; }
  .pp-sheet { position: fixed; z-index: 91; left: 50%; top: 10vh; transform: translateX(-50%); width: min(460px, 92vw); max-height: 76vh; display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
  .pp-head { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid #eee; }
  .pp-head input { flex: 1; min-height: 44px; font-size: 16px; padding: 0 10px; border: 1px solid #ccd; border-radius: 8px; }
  .pp-close { min-height: 44px; padding: 0 12px; border: 0; background: none; color: #1f7cf2; font-size: 15px; }
  .pp-list { overflow-y: auto; padding-bottom: 10px; }
  .pp-group { position: sticky; top: 0; background: #f4f5f7; padding: 6px 12px; font-size: 12px; color: #667; font-weight: 600; }
  .pp-item { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 10px; min-height: 48px; padding: 8px 12px; border: 0; border-bottom: 1px solid #f0f0f0; background: #fff; text-align: left; font-size: 15px; }
  .pp-item span { white-space: normal; word-break: break-all; }
  .pp-item em { font-style: normal; color: #889; font-size: 12px; }
  .pp-item small { color: #889; flex: none; }
  .pp-item.sel { background: #eef5ff; }
  .pp-empty { padding: 16px; color: #889; }
  @media (max-width: 720px) {
    .pp-sheet { inset: 0; top: 0; left: 0; transform: none; width: 100vw; max-height: none; height: 100dvh; border-radius: 0; }
  }
</style>

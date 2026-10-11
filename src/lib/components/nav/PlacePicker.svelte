<script lang="ts">
  import { searchPlaces, isCommon, commonRank, searchExample, nearestToilets, toiletLabel, floorShort, relativeSide, type IndexedPlace, type Origin } from '$lib/utils/placeSearch';
  let { value = $bindable(''), places, label, placeholder = '选择', onchange, origin = null, floorIndex = () => 0, accessible = false, hasLift = true }: {
    value: string; places: IndexedPlace[]; label: string; placeholder?: string; onchange?: () => void;
    origin?: Origin; floorIndex?: (id: string) => number; accessible?: boolean; hasLift?: boolean;
  } = $props();
  let open = $state(false);
  let q = $state('');
  let input: HTMLInputElement | undefined = $state();
  const current = $derived(places.find(p => p.key === value));
  const results = $derived(searchPlaces(places, q));
  const common = $derived(q ? [] : [...results.filter(isCommon)].sort((a, b) => commonRank(a) - commonRank(b)).slice(0, 8));
  const hint = $derived(searchExample(places));
  // Toilets: nearest first, one-line label 「卫生间（女）· 1F · 约 20 米」 (en-suites never listed).
  // 只乘电梯 without a lift: toilets on other floors are unreachable — never recommend them.
  const toilets = $derived(nearestToilets(results, origin, floorIndex, accessible)
    .filter(t => !(accessible && !hasLift && origin && t.p.floorId !== origin.floorId)));
  const accessibleFloors = $derived([...new Set(nearestToilets(places, null, floorIndex).filter(t => t.kind === 'accessible').map(t => floorShort(t.p.floorLabel)))]);
  const accessibleNote = $derived(accessible && origin && !toilets.some(t => t.kind === 'accessible')
    ? (accessibleFloors.length ? `本楼仅 ${accessibleFloors.join('、').replace(/(\d+)F/g, '$1 楼')} 设有无障碍卫生间` : '本楼没有无障碍卫生间') : '');
  // Identical rows (same kind, same floor) get a building-relative side: 卫生间（右侧）· 2F · 约 15 米.
  const toiletRow = (t: (typeof toilets)[number]) => {
    const peers = toilets.filter(o => o.kind === t.kind && o.p.floorId === t.p.floorId).map(o => o.p);
    const side = peers.length > 1 ? relativeSide(t.p, places, peers) : '';
    const base = toiletLabel(t.kind);
    const lab = side ? (base.endsWith('）') ? base.replace(/）$/, `·${side}）`) : `${base}（${side}）`) : base;
    return `${lab} · ${floorShort(t.p.floorLabel)}${t.m !== null ? ` · 约 ${t.m} 米` : ''}`;
  };
  const showToilets = $derived(!q || /卫|厕|洗手|wc|wsj|cs/i.test(q));
  const groups = $derived.by(() => {
    const m = new Map<string, IndexedPlace[]>();
    for (const p of results) { if (!m.has(p.floorLabel)) m.set(p.floorLabel, []); m.get(p.floorLabel)!.push(p); }
    return [...m.entries()];
  });
  function pick(p: IndexedPlace) { value = p.key; open = false; q = ''; onchange?.(); }
  // Render the sheet on <body>: the side panel is its own stacking context (3D toolbar showed through).
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  // On touch, don't pop the keyboard on open: the viewport resize it causes swallowed the first
  // tap on a list item. Desktop still focuses the search box.
  function show() { open = true; if (!window.matchMedia?.('(pointer: coarse)').matches) setTimeout(() => input?.focus(), 30); }
  const keepFocus = (e: PointerEvent) => { if (e.pointerType === 'mouse') e.preventDefault(); };
</script>

<button type="button" class="pp-field" aria-label={label} aria-haspopup="dialog" onclick={show}>
  {current ? `${current.floorLabel} · ${current.name}` : placeholder}
</button>
{#if open}
  <div class="pp-backdrop" use:portal role="presentation" onclick={() => (open = false)}></div>
  <div class="pp-sheet" use:portal role="dialog" aria-label={label}>
    <div class="pp-head">
      <input bind:this={input} bind:value={q} type="search" placeholder={hint} aria-label="搜索地点" />
      <button type="button" class="pp-close" onclick={() => (open = false)}>取消</button>
    </div>
    <div class="pp-list">
      {#if accessibleNote && !q}<p class="pp-note">{accessibleNote}</p>{/if}
      {#if toilets.length && !q}
        <button type="button" class="pp-nearest" onpointerdown={keepFocus} onclick={() => pick(toilets[0].p)}>
          最近的{accessible && toilets[0].kind === 'accessible' ? '无障碍' : ''}卫生间<small>{toiletRow(toilets[0])}</small>
        </button>
      {/if}
      {#if toilets.length && showToilets && q}
        <div class="pp-group">卫生间（由近到远）</div>
        {#each toilets.slice(0, 8) as t (t.p.key + 't')}
          <button type="button" class="pp-item pp-toilet" onpointerdown={keepFocus} onclick={() => pick(t.p)}><span>{toiletRow(t)}</span></button>
        {/each}
      {/if}
      {#if common.length}
        <div class="pp-group">常用</div>
        {#each common as p (p.key + 'c')}
          <button type="button" class="pp-item" onpointerdown={keepFocus} onclick={() => pick(p)}><span>{p.name}</span><small>{p.floorLabel}</small></button>
        {/each}
      {/if}
      {#each groups as [floor, list] (floor)}
        <div class="pp-group">{floor}</div>
        {#each list as p (p.key)}
          <button type="button" class="pp-item" class:sel={p.key === value} onpointerdown={keepFocus} onclick={() => pick(p)}>
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
  .pp-nearest { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin: 8px 12px; padding: 12px 14px; min-height: 56px; border: 0; border-radius: 10px; background: #1f7a4d; color: #fff; font: inherit; font-size: 17px; font-weight: 700; text-align: left; }
  .pp-nearest small { font-size: 13px; font-weight: 400; opacity: .9; }
  .pp-toilet span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pp-note { margin: 8px 12px 0; padding: 8px 10px; border-radius: 8px; background: #fff4e5; color: #8a4b00; font-size: 14px; }
  .pp-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 9990; }
  .pp-sheet { position: fixed; z-index: 9991; left: 50%; top: 10vh; transform: translateX(-50%); width: min(460px, 92vw); max-height: 76vh; display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
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

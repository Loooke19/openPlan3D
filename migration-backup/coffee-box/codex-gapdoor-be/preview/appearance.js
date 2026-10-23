export const APPEARANCE_DEFAULTS = Object.freeze({ accent:'#306048',wall:'#e2e6e3',floor:'#fbfcfa',exposure:1,ambient:1.8,sun:2.2,roughness:.88,grain:1,tileSize:12,skirtHeight:7 });
export const APPEARANCE_SLIDERS = [
  ['exposure','画面亮度',.5,1.8,.05],['ambient','环境光',.3,3,.1],['sun','主光强度',0,4,.1],
  ['roughness','墙面哑光程度',.3,1,.02],['grain','颗粒强度',0,2,.1],['tileSize','地砖尺寸（图纸单位）',6,30,1],['skirtHeight','墙裙高度（图纸单位）',2,11,.5]
];
export function sanitizeAppearance(value={}) {
  const result={...APPEARANCE_DEFAULTS};
  for(const key of ['accent','wall','floor']) if(/^#[0-9a-f]{6}$/i.test(value?.[key]))result[key]=value[key];
  for(const [key,,min,max] of APPEARANCE_SLIDERS)if(typeof value?.[key]==='number'&&Number.isFinite(value[key]))result[key]=Math.min(max,Math.max(min,value[key]));
  return result;
}

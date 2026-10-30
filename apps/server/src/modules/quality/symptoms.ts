const GROUPS = [
  ['闪屏', '一闪一闪', '闪来闪去', '画面抖闪', '闪烁'],
  ['气泡', '起泡', '鼓包', '有泡', '冒泡'],
  ['亮度不均', '明暗不一', '一块亮一块暗', '一块暗', '局部发暗', '暗角'],
  ['触控失灵', '点不动', '点了没反应', '触摸没反应', '触控无响应'],
  ['黑屏', '黑一下', '间歇黑屏'],
  ['无显示', '完全不亮', '上电不亮', '没有画面'],
  ['金手指氧化', '金手指发黑'],
] as const;

export function normalizeSymptom(text: string): string {
  let clean = text;
  const terms = [...new Set(GROUPS.flat())].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    clean = clean.replace(new RegExp(`(?:没有|不是|未见|未出现|并非|已排除|不再|无)(?:任何|明显|发生)?${term}`, 'g'), ' ');
  }
  for (const group of GROUPS) {
    for (const alias of [...group].sort((a, b) => b.length - a.length)) clean = clean.replaceAll(alias, group[0]);
  }
  return clean.trim();
}

/** These terms alone cannot establish a recurrence or its cause. */
export const GENERIC_SYMPTOMS = new Set(['黑屏', '黑一下', '时好时坏', '不亮', '无显示', '边上', '触摸', '触控']);

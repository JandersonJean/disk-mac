export interface Tile<T> { item: T; x: number; y: number; width: number; height: number }
/** Balanced binary treemap. All coordinates are percentages of the containing rectangle. */
export function treemap<T extends { bytes: number }>(items: T[]): Tile<T>[] {
  const tiles: Tile<T>[] = [];
  function split(group: T[], x: number, y: number, width: number, height: number): void {
    if (!group.length) return;
    if (group.length === 1) { tiles.push({ item: group[0], x, y, width, height }); return; }
    const total = group.reduce((sum, item) => sum + item.bytes, 0);
    let sum = 0, index = 0;
    while (index < group.length - 1 && sum < total / 2) sum += group[index++].bytes;
    const ratio = sum / total;
    if (width >= height) {
      split(group.slice(0, index), x, y, width * ratio, height);
      split(group.slice(index), x + width * ratio, y, width * (1 - ratio), height);
    } else {
      split(group.slice(0, index), x, y, width, height * ratio);
      split(group.slice(index), x, y + height * ratio, width, height * (1 - ratio));
    }
  }
  split(items.filter((item) => Number.isFinite(item.bytes) && item.bytes > 0).sort((a, b) => b.bytes - a.bytes), 0, 0, 100, 100);
  return tiles;
}

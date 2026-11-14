import { describe, expect, it } from 'vitest';
import { treemap } from './treemap.js';

describe('disk treemap', () => {
  it('fills the available area with proportional, non-overlapping rectangles', () => {
    const sizes = [50, 30, 10, 7, 3];
    const tiles = treemap(sizes.map((bytes) => ({ bytes })));
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBeCloseTo(10_000);
    for (const tile of tiles) {
      expect(tile.width * tile.height / 100).toBeCloseTo(tile.item.bytes);
      expect(tile.x + tile.width).toBeLessThanOrEqual(100.00001);
      expect(tile.y + tile.height).toBeLessThanOrEqual(100.00001);
      for (const other of tiles) {
        if (other === tile) continue;
        const overlapX = Math.max(0, Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x));
        const overlapY = Math.max(0, Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y));
        expect(overlapX * overlapY).toBeCloseTo(0);
      }
    }
  });
  it('handles empty and unmeasurable items without invalid coordinates', () => {
    expect(treemap([{ bytes: 0 }, { bytes: NaN }, { bytes: -1 }, { bytes: Infinity }])).toEqual([]);
    expect(treemap([{ bytes: 1024 }])[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
  });
});

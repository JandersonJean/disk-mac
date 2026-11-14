import { expect, it, vi } from 'vitest';

const { createFromBitmap, setTemplateImage } = vi.hoisted(() => {
  const setTemplateImage = vi.fn();
  const createFromBitmap = vi.fn((_pixels: Buffer, _options: unknown) => ({ setTemplateImage }));
  return { createFromBitmap, setTemplateImage };
});
vi.mock('electron', () => ({ nativeImage: { createFromBitmap } }));
import { createTrayChart } from './tray-chart.js';

it('creates a transparent monochrome Retina template for the menu bar', () => {
  createTrayChart();
  expect(createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), { width: 44, height: 36, scaleFactor: 2 });
  const [pixels] = createFromBitmap.mock.calls[0];
  expect(pixels.some((channel, i) => i % 4 !== 3 && channel !== 0)).toBe(false);
  expect(pixels.some((channel, i) => i % 4 === 3 && channel > 0)).toBe(true);
  expect(pixels[3]).toBe(0);
  expect(setTemplateImage).toHaveBeenCalledWith(true);
});

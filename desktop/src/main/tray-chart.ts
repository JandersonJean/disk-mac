import { nativeImage, type NativeImage } from 'electron';

const WIDTH = 44;
const HEIGHT = 36;
const SCALE = 2;
const POINTS = [[5, 24], [13, 17], [20, 22], [30, 10], [39, 13]] as const;

/** Draw a single antialiased stroke in the alpha channel of a macOS template image. */
export function createTrayChart(): NativeImage {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let distance = Infinity;
      for (let i = 1; i < POINTS.length; i++) {
        const [startX, startY] = POINTS[i - 1];
        const [endX, endY] = POINTS[i];
        const dx = endX - startX;
        const dy = endY - startY;
        const fromX = x + 0.5 - startX;
        const fromY = y + 0.5 - startY;
        const position = Math.max(0, Math.min(1, (fromX * dx + fromY * dy) / (dx * dx + dy * dy)));
        distance = Math.min(distance, Math.hypot(fromX - position * dx, fromY - position * dy));
      }
      pixels[(y * WIDTH + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 2 - distance)));
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: WIDTH, height: HEIGHT, scaleFactor: SCALE });
  icon.setTemplateImage(true);
  return icon;
}

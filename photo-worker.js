// Photo processing on a background thread (used by game.html).
//
// Re-encoding a camera photo on the page itself (canvas.toBlob) turned out to stall at
// random, sometimes for several seconds, and a slow encode also held up the next
// photo. Here the work runs on its own thread, so nothing on the page can delay it.
//
// Message in:  { id, file, sizes: [[maxLong, quality, maxShort], ...] }
// Messages out, one per size in the order given (so the small copies can be shown
// before the big one is ready):
//   { id, index, blob }   — or { id, error } if anything fails

self.onmessage = async (e) => {
  const { id, file, sizes } = e.data;
  let src = null;
  try {
    // Respects the photo's EXIF rotation; the re-encoded JPEGs carry no EXIF (no location).
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    for (let index = 0; index < sizes.length; index++) {
      const [maxLong, quality, maxShort] = sizes[index];
      const scale = Math.min(1, maxLong / Math.max(src.width, src.height), maxShort / Math.min(src.width, src.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(src.width * scale)),
        Math.max(1, Math.round(src.height * scale)));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      canvas.width = canvas.height = 0; // free memory promptly
      self.postMessage({ id, index, blob });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  } finally {
    if (src) src.close();
  }
};

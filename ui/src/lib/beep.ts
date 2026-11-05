// Tiny 8-bit WAV generator: gives the mock MyInstants results something to preview offline.
const cache = new Map<number, string>();

export function beepWavDataUri(freq: number, durationMs = 450, sampleRate = 8000): string {
  const hit = cache.get(freq);
  if (hit) return hit;
  const n = Math.floor((sampleRate * durationMs) / 1000);
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, n, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, (n - i) / (n * 0.6));
    const square = Math.sin((2 * Math.PI * freq * i) / sampleRate) >= 0 ? 1 : -1;
    bytes[44 + i] = 128 + Math.round(square * 40 * env);
  }
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const uri = `data:audio/wav;base64,${btoa(bin)}`;
  cache.set(freq, uri);
  return uri;
}

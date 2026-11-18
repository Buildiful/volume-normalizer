/**
 * Loudness analysis: ITU-R BS.1770 K-weighting, EBU R128 400 ms / 100 ms
 * overlapping blocks, absolute -70 LUFS and relative -10 LU gating.
 * Mono and stereo material only; LFE and surround channel layouts need
 * explicit channel-weight handling and are intentionally not guessed.
 *
 * Export applies one fixed gain per track. We enforce a sample peak ceiling,
 * not a certified oversampled true-peak limit. No dynamic compression.
 */
const SHELF_HZ = 1681.974450955533;
const SHELF_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const HP_HZ = 38.13547087602444;
const HP_Q = 0.5003270373238773;
const LUFS_OFFSET = -0.691;
const MAX_CHANNELS = 2;
const TINY = 1e-20;

export function kWeightCoefficients(fs) {
  const K = Math.tan(Math.PI * SHELF_HZ / fs);
  const Vh = Math.pow(10, SHELF_DB / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const d = 1 + K / SHELF_Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / SHELF_Q + K * K) / d,
    b1: 2 * (K * K - Vh) / d,
    b2: (Vh - Vb * K / SHELF_Q + K * K) / d,
    a1: 2 * (K * K - 1) / d,
    a2: (1 - K / SHELF_Q + K * K) / d,
  };
  const H = Math.tan(Math.PI * HP_HZ / fs);
  const hden = 1 + H / HP_Q + H * H;
  // b0 = 1 is intentional: BS.1770's RLB weighting filter has unity numerator.
  const highpass = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (H * H - 1) / hden,
    a2: (1 - H / HP_Q + H * H) / hden,
  };
  return { shelf, highpass };
}

function biquad(coeff) {
  let z1 = 0, z2 = 0;
  return (x) => {
    const y = coeff.b0 * x + z1;
    z1 = coeff.b1 * x - coeff.a1 * y + z2;
    z2 = coeff.b2 * x - coeff.a2 * y;
    return y;
  };
}

export function integratedFromBlocks(blockEnergies) {
  const candidate = blockEnergies.filter(p => p > 0 && LUFS_OFFSET + 10 * Math.log10(p) >= -70);
  if (!candidate.length) return -Infinity;
  const absMean = candidate.reduce((s, p) => s + p, 0) / candidate.length;
  const relativeLimit = absMean / 10; // -10 LU relative gate
  const gated = candidate.filter(p => p >= relativeLimit);
  if (!gated.length) return -Infinity;
  const finalPower = gated.reduce((s, p) => s + p, 0) / gated.length;
  return LUFS_OFFSET + 10 * Math.log10(finalPower);
}

export async function analyzeBuffer(buffer, { isCancelled = () => false, yieldToBrowser = defaultYield } = {}) {
  const channels = buffer.numberOfChannels;
  if (channels < 1 || channels > MAX_CHANNELS) throw new Error('Only mono and stereo audio is supported in this release.');
  const fs = buffer.sampleRate;
  if (fs < 8000 || fs > 192000) throw new Error('Unsupported audio sample rate.');
  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  const { shelf, highpass } = kWeightCoefficients(fs);
  const filters = samples.map(() => ({ s: biquad(shelf), h: biquad(highpass) }));
  const hop = Math.max(1, Math.round(fs / 10));
  const blocks = [];
  const buckets = [];
  let sum = 0, bucketSum = 0, count = 0, peak = 0, weightedSum = 0;
  for (let i = 0; i < buffer.length; i++) {
    let energy = 0;
    for (let c = 0; c < channels; c++) {
      const x = samples[c][i];
      const a = Math.abs(x);
      if (a > peak) peak = a;
      const y = filters[c].h(filters[c].s(x));
      energy += y * y;
    }
    bucketSum += energy;
    weightedSum += energy;
    count++;
    if (count === hop) {
      buckets.push(bucketSum);
      if (buckets.length > 4) buckets.shift();
      if (buckets.length === 4) {
        // All four buckets have equal lengths: overlapping 400 ms blocks.
        blocks.push(buckets.reduce((a, b) => a + b, 0) / (hop * 4));
      }
      count = 0; bucketSum = 0;
    }
    // Yield periodically, even for very long individual files.
    if ((i + 1) % 262144 === 0) {
      if (isCancelled()) throw new DOMException('Cancelled', 'AbortError');
      await yieldToBrowser();
    }
  }
  if (isCancelled()) throw new DOMException('Cancelled', 'AbortError');
  // For sub-400 ms clips, EBU gating is undefined; report estimated full-clip loudness.
  const shortClip = blocks.length === 0;
  const raw = shortClip ? weightedSum / Math.max(1, buffer.length) : 0;
  const lufs = shortClip
    ? (raw > TINY ? LUFS_OFFSET + 10 * Math.log10(raw) : -Infinity)
    : integratedFromBlocks(blocks);
  return { lufs, peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    duration: buffer.duration, sampleRate: fs, channels, shortClip };
}

export function calculateGain(analysis, targetLufs, ceilingDbfs) {
  if (!Number.isFinite(analysis.lufs)) {
    return { gainDb: 0, achievedLufs: -Infinity, limited: false, silent: true };
  }
  const requestedDb = targetLufs - analysis.lufs;
  const headroomDb = ceilingDbfs - analysis.peakDbfs;
  const gainDb = Math.min(requestedDb, headroomDb);
  return { gainDb, achievedLufs: analysis.lufs + gainDb,
    limited: gainDb < requestedDb - 0.05, silent: false };
}

export function formatLufs(value) { return Number.isFinite(value) ? `${value.toFixed(1)} LUFS` : 'Silent'; }
export function formatDb(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB` : '—'; }
const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0));

function wavHeader(sampleRate, channels, frames, bits) {
  const bytesPerSample = bits / 8;
  const audioFormat = bits === 32 ? 3 : 1;
  const dataSize = frames * channels * bytesPerSample;
  if (dataSize + 44 >= 0xffffffff) throw new Error('WAV exceeds the 4 GB format limit.');
  const bytes = new ArrayBuffer(44);
  const view = new DataView(bytes);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bits, true);
  text(36, 'data'); view.setUint32(40, dataSize, true);
  return new Uint8Array(bytes);
}

export async function encodeWav(buffer, gainDb, bits, sink, { isCancelled = () => false, yieldToBrowser = defaultYield } = {}) {
  if (![16, 24, 32].includes(bits)) throw new Error('Invalid WAV output depth.');
  const channels = buffer.numberOfChannels;
  if (channels < 1 || channels > 2) throw new Error('Only mono and stereo supported.');
  const scale = Math.pow(10, gainDb / 20);
  const bytesPerSample = bits / 8;
  const chunkFrames = 16384;
  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  await sink.write(wavHeader(buffer.sampleRate, channels, buffer.length, bits));
  for (let offset = 0; offset < buffer.length; offset += chunkFrames) {
    if (isCancelled()) throw new DOMException('Cancelled', 'AbortError');
    const size = Math.min(chunkFrames, buffer.length - offset);
    const bytes = new Uint8Array(size * channels * bytesPerSample);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (let i = 0; i < size; i++) {
      for (let c = 0; c < channels; c++) {
        const value = Math.max(-1, Math.min(1, samples[c][offset + i] * scale));
        if (bits === 16) { view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(value * 32767))), true); at += 2; }
        else if (bits === 24) {
          const sample = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388607)));
          bytes[at++] = sample & 255; bytes[at++] = (sample >> 8) & 255; bytes[at++] = (sample >> 16) & 255;
        } else { view.setFloat32(at, value, true); at += 4; }
      }
    }
    await sink.write(bytes);
    await yieldToBrowser();
  }
}

/** MP3 uses optional separate LGPL-3.0 lamejs encoder (loaded only on request). */
export async function encodeMp3(buffer, gainDb, sink, { isCancelled = () => false, yieldToBrowser = defaultYield } = {}) {
  if (!globalThis.lamejs?.Mp3Encoder) throw new Error('MP3 encoder is not available. Choose WAV or retry while online.');
  const channels = buffer.numberOfChannels;
  if (channels < 1 || channels > 2) throw new Error('Only mono and stereo supported.');
  const supported = new Set([8000,11025,12000,16000,22050,24000,32000,44100,48000]);
  if (!supported.has(buffer.sampleRate)) throw new Error('MP3 encoding does not support this sample rate. Try WAV.');
  const encoder = new globalThis.lamejs.Mp3Encoder(channels, buffer.sampleRate, 320);
  const source = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  const scale = Math.pow(10, gainDb / 20);
  const block = 1152;
  for (let pos = 0; pos < buffer.length; pos += block) {
    if (isCancelled()) throw new DOMException('Cancelled', 'AbortError');
    const n = Math.min(block, buffer.length - pos);
    const pcm = source.map(data => {
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, data[pos + i] * scale)) * 32767)));
      return out;
    });
    const encoded = channels === 1 ? encoder.encodeBuffer(pcm[0]) : encoder.encodeBuffer(pcm[0], pcm[1]);
    if (encoded.length) await sink.write(new Uint8Array(encoded));
    if ((pos / block) % 96 === 0) await yieldToBrowser();
  }
  const last = encoder.flush();
  if (last.length) await sink.write(new Uint8Array(last));
}

export async function originalId3v2(file) {
  if (!/\.mp3$/i.test(file.name)) return null;
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.length !== 10 || String.fromCharCode(...head.slice(0, 3)) !== 'ID3') return null;
  if (head.slice(6, 10).some(x => x & 0x80)) return null;
  const length = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
  const total = 10 + length + ((head[5] & 0x10) ? 10 : 0);
  if (total > 16 * 1024 * 1024 || total > file.size) return null;
  return new Uint8Array(await file.slice(0, total).arrayBuffer());
}

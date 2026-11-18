import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBuffer, kWeightCoefficients, integratedFromBlocks, calculateGain, encodeWav } from '../js/audio.js';
import { ZipArchive, crcStart, crcUpdate, crcFinish } from '../js/zip.js';

function signal(frequency, amplitude, rate = 48000, seconds = 2, channels = 2) {
  const length = Math.round(rate * seconds);
  const arrays = Array.from({ length: channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) arrays[c][i] = amplitude * Math.sin(2 * Math.PI * frequency * i / rate);
  return { length, numberOfChannels: channels, sampleRate: rate, duration: seconds, getChannelData: c => arrays[c] };
}
const yieldFn = async () => {};

test('48 kHz BS.1770 shelf coefficients match reference values', () => {
  const {shelf,highpass} = kWeightCoefficients(48000);
  assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-12);
  assert.ok(Math.abs(shelf.a1 + 1.69065929318241) < 1e-12);
  assert.ok(Math.abs(highpass.a2 - 0.99007225036621) < 1e-12);
  assert.equal(highpass.b0, 1);
});
test('integrated gating filters quiet sections', () => {
  const blocks = [1e-2, 1e-2, 1e-2, 1e-7];
  const lufs = integratedFromBlocks(blocks);
  assert.ok(lufs > -21 && lufs < -20);
});
test('loudness changes by ~6 dB when amplitude doubles', async () => {
  const a = await analyzeBuffer(signal(1000, 0.1), { yieldToBrowser: yieldFn });
  const b = await analyzeBuffer(signal(1000, 0.2), { yieldToBrowser: yieldFn });
  assert.ok(Math.abs((b.lufs - a.lufs) - 6.0206) < 0.05);
  assert.ok(Math.abs(a.peakDbfs + 20) < 0.01);
  assert.ok(a.lufs < -16 && a.lufs > -25, String(a.lufs));
});
test('gain caps output sample peak and reports target limitation', () => {
  const gain = calculateGain({lufs:-23,peakDbfs:-1}, -14, -2);
  assert.equal(gain.gainDb, -1);
  assert.equal(gain.achievedLufs, -24);
  assert.equal(gain.limited, true);
});
test('silent audio has no infinite gain', async () => {
  const buffer = signal(1000, 0, 44100, .5, 1);
  const a = await analyzeBuffer(buffer, { yieldToBrowser: yieldFn });
  assert.equal(a.lufs, -Infinity);
  assert.equal(calculateGain(a, -14, -2).gainDb, 0);
});
test('WAV header, file size and PCM sample values for each depth', async () => {
  const buffer = signal(1000, 0.3, 48000, .5, 1);
  for (const bits of [16,24,32]) {
    const segments = [];
    await encodeWav(buffer, 0, bits, { write: async b => segments.push(b) }, { yieldToBrowser: yieldFn });
    const bytes = Buffer.concat(segments.map(x=>Buffer.from(x)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
    assert.equal(bytes.toString('ascii',8,12),'WAVE');
    assert.equal(view.getUint16(20,true), bits===32?3:1);
    assert.equal(view.getUint16(34,true),bits);
    assert.equal(view.getUint32(24,true),48000);
    assert.equal(bytes.byteLength,44+buffer.length*(bits/8));
    const sampleIndex = 12; // peak quarter cycle
    const offset = 44 + sampleIndex*(bits/8);
    const value = bits===16 ? view.getInt16(offset,true)/32767 : bits===24 ? (()=>{ const x=bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16);return (x<<8>>8)/8388607; })():view.getFloat32(offset,true);
    assert.ok(Math.abs(value-0.3)<0.001);
  }
});
test('ZIP stored file central directory and CRC', async () => {
  const data = new TextEncoder().encode('hello world');
  const crc = crcFinish(crcUpdate(crcStart(), data));
  assert.equal(crc, 0x0d4a1185);
  const zip = new ZipArchive();
  zip.add('sub/test.txt', [data], data.length, crc);
  const out = Buffer.from(await zip.finish().arrayBuffer());
  assert.equal(out.readUInt32LE(0),0x04034b50);
  assert.equal(out.readUInt32LE(out.length-22),0x06054b50);
  assert.equal(out.readUInt16LE(out.length-22+10),1);
});

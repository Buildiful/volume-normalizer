import { analyzeBuffer, calculateGain, encodeWav, encodeMp3, originalId3v2, formatDb, formatLufs } from './audio.js';
import { ZipArchive, crcStart, crcUpdate, crcFinish } from './zip.js';
import { initializeAnalytics, setAnalyticsConsent, analyticsConsent, track } from './analytics.js';

const $ = id => document.getElementById(id);
const SUPPORTED = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|webm)$/i;
const MAX_DISPLAY = 75;
let entries = [];
let sourceHandle = null;
let destinationHandle = null;
let sourceLabel = '';
let destinationLabel = '';
let busy = false;
let cancelRequested = false;
let completedExports = 0;
let activeAudioContext = null;
const settings = () => ({
  target: Number($('target').value),
  ceiling: Number($('ceiling').value),
  format: $('format').value,
  preserve: $('preserve').checked,
});
const text = (id, value) => { $(id).textContent = value; };

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${level}`; el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 350); }, 5200);
}
function showError(error) { console.error(error); toast(error?.message || String(error), 'error'); }
const bytes = size => size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const isCancelled = () => cancelRequested;
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
function validTarget() { const v = settings(); return Number.isFinite(v.target) && v.target >= -30 && v.target <= -8 && Number.isFinite(v.ceiling) && v.ceiling <= -0.5 && v.ceiling >= -9; }
function basename(path) { return path.split('/').at(-1); }
function relativePath(path) { return path.split('/').slice(1).join('/'); }
function cleanRel(path) { return path.split('/').filter(v => v && v !== '.' && v !== '..').join('/'); }
function normalizeOutputPath(entry) {
  const name = settings().preserve ? entry.relative : basename(entry.relative);
  const stem = name.replace(/\.[^.]+$/, '');
  return cleanRel(stem + ' [normalized].' + (settings().format === 'mp3' ? 'mp3' : 'wav'));
}

async function walkFolder(folder, prefix, deep, list) {
  for await (const [name, handle] of folder.entries()) {
    if (handle.kind === 'file') {
      if (SUPPORTED.test(name)) list.push({ fileHandle: handle, relative: prefix + name });
    } else if (deep && handle.kind === 'directory') {
      await walkFolder(handle, prefix + name + '/', deep, list);
    }
    if (list.length % 150 === 0) await yieldToBrowser();
  }
}
function resetSource(records, label, folderHandle = null) {
  entries = records.filter(v => SUPPORTED.test(v.relative)).sort((a, b) => a.relative.localeCompare(b.relative)).map((entry, i) => ({ ...entry, id: i, selected: true, analysis: null, error: '', status: 'Ready' }));
  sourceHandle = folderHandle;
  sourceLabel = label;
  text('source-name', label || 'No folder selected');
  text('source-sub', entries.length ? `${entries.length.toLocaleString()} supported audio files found` : 'No supported audio found.');
  completedExports = 0;
  render();
  if (entries.length) track('folder_selected', { source_type: folderHandle ? 'directory_picker' : 'file_picker', audio_count: entries.length });
}
async function chooseSource() {
  if (busy) return;
  if (window.showDirectoryPicker) {
    try {
      const folder = await window.showDirectoryPicker({ mode: 'read' });
      text('source-sub', 'Scanning folder…');
      const list = [];
      await walkFolder(folder, '', $('include-subfolders').checked, list);
      resetSource(list, folder.name, folder);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Folder API unavailable; using file input', e);
    }
  }
  $('folder-fallback').click();
}
async function importFromInput(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  const deep = $('include-subfolders').checked;
  const root = files[0].webkitRelativePath?.split('/')[0] || 'Selected files';
  const records = files.filter(f => SUPPORTED.test(f.name)).map(file => {
    const raw = file.webkitRelativePath || file.name;
    const relative = file.webkitRelativePath ? raw.split('/').slice(1).join('/') : raw;
    return { file, relative };
  }).filter(v => deep || !v.relative.includes('/'));
  resetSource(records, root);
  e.target.value = '';
}
async function rescanSource() {
  if (!sourceHandle || busy) return;
  const list = [];
  try { await walkFolder(sourceHandle, '', $('include-subfolders').checked, list); resetSource(list, sourceHandle.name, sourceHandle); }
  catch (e) { showError(e); }
}
async function chooseDestination() {
  if (busy) return;
  if (!window.showDirectoryPicker) {
    toast('Folder saving requires Chrome or Edge. ZIP export is available instead.'); return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    destinationHandle = handle; destinationLabel = handle.name;
    text('destination-name', handle.name);
    text('destination-sub', 'New files will be created here. Existing files are not overwritten.');
    render();
  } catch (e) { if (e.name !== 'AbortError') showError(e); }
}
function useZip() {
  destinationHandle = null; destinationLabel = '';
  text('destination-name', 'Download a ZIP instead');
  text('destination-sub', 'The archive will be downloaded through your browser. Smaller batches work best.');
  render();
}
function reflectSettings() {
  const v = settings();
  completedExports = 0;
  const formatLabels = { 'wav16': 'WAV · 16-bit PCM', 'wav24': 'WAV · 24-bit PCM', 'wav32': 'WAV · 32-bit float', 'mp3': 'MP3 · 320 kbps' };
  text('target-display', Number.isFinite(v.target) ? `${v.target} LUFS` : '—');
  text('format-detail', formatLabels[v.format]);
  text('format-help', v.format === 'mp3' ? 'MP3 exports use a separately loaded LGPL-licensed encoder. An internet connection is required to fetch it.' : 'WAV exports do not retain embedded artwork or music tags. WAV files can be much larger than MP3s.');
  for (const e of entries) if (e.status === 'Exported') e.status = 'Ready';
  render();
}
function planned(e) { return e.analysis ? calculateGain(e.analysis, settings().target, settings().ceiling) : null; }
function render() {
  const selected = entries.filter(e => e.selected);
  const analyzed = selected.filter(e => e.analysis).length;
  const failed = selected.filter(e => e.error).length;
  text('stat-total', entries.length.toLocaleString());
  text('stat-selected', selected.length.toLocaleString());
  text('stat-analyzed', analyzed.toLocaleString());
  text('stat-exported', completedExports.toLocaleString());
  text('results-label', entries.length ? `${entries.length.toLocaleString()} files in source` : 'Your audio files will appear here');
  const term = $('file-filter').value.trim().toLocaleLowerCase();
  const matching = term ? entries.filter(e => e.relative.toLocaleLowerCase().includes(term)) : entries;
  text('queue-note', matching.length > MAX_DISPLAY ? `Showing the first ${MAX_DISPLAY} of ${matching.length.toLocaleString()} matching files. All selected files are included in batch processing.` : term ? `${matching.length.toLocaleString()} matching files. Filtering does not change the batch selection.` : '');
  const tbody = $('file-rows');
  tbody.replaceChildren();
  if (!entries.length) { $('empty-state').hidden = false; $('results-table').hidden = true; }
  else {
    $('empty-state').hidden = true; $('results-table').hidden = false;
    for (const e of matching.slice(0, MAX_DISPLAY)) {
      const tr = document.createElement('tr');
      const tdSelect = tr.insertCell();
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = e.selected; check.disabled = busy; check.setAttribute('aria-label', `Include ${e.relative}`);
      check.addEventListener('change', () => { e.selected = check.checked; render(); }); tdSelect.append(check);
      const name = tr.insertCell(); name.className = 'name-cell';
      const label = document.createElement('div'); label.className = 'filename'; label.textContent = basename(e.relative);
      const path = document.createElement('div'); path.className = 'filepath'; path.textContent = e.relative.includes('/') ? e.relative.slice(0, -basename(e.relative).length - 1) : (e.size ? bytes(e.size) : 'Local audio');
      name.append(label, path);
      const loud = tr.insertCell(); loud.textContent = e.analysis ? formatLufs(e.analysis.lufs) : '—';
      const gain = tr.insertCell(); gain.textContent = e.analysis ? formatDb(planned(e).gainDb) : '—';
      const after = tr.insertCell(); after.textContent = e.analysis ? formatLufs(planned(e).achievedLufs) : '—';
      const status = tr.insertCell();
      const s = document.createElement('span');
      const isErr = !!e.error;
      const limit = e.analysis && planned(e).limited;
      s.className = `status-pill ${isErr ? 'status-error' : e.status === 'Exported' ? 'status-done' : limit ? 'status-limit' : e.analysis ? 'status-ready' : ''}`;
      s.textContent = isErr ? 'Error' : e.status === 'Exported' ? 'Exported' : limit ? 'Peak limited' : e.analysis ? 'Analyzed' : e.status;
      if (isErr) s.title = e.error;
      else if (limit) s.title = 'Peak ceiling prevents reaching the requested LUFS target.';
      status.append(s);
      tbody.append(tr);
    }
  }
  const hasDestination = !!destinationHandle;
  text('destination-mode', hasDestination ? 'Save files to folder' : 'Download ZIP');
  $('destination-browse').disabled = busy || !window.showDirectoryPicker;
  $('source-browse').disabled = busy;
  $('source-refresh').disabled = busy || !sourceHandle;
  $('source-refresh').hidden = !sourceHandle;
  $('subfolders-help').textContent = sourceHandle ? 'Change this setting and rescan to update the source.' : 'Choose this before browsing. Re-select to change the imported set.';
  $('include-subfolders').disabled = busy;
  $('file-filter').disabled = busy;
  $('select-all').disabled = busy || !entries.length;
  $('select-none').disabled = busy || !entries.length;
  $('analyze-btn').disabled = busy || !selected.length || !validTarget();
  $('export-btn').disabled = busy || !selected.length || analyzed !== selected.length || !validTarget();
  $('cancel-btn').hidden = !busy;
  $('cancel-btn').disabled = cancelRequested;
  $('target').disabled = busy;
  $('ceiling').disabled = busy;
  $('format').disabled = busy;
  $('preserve').disabled = busy;
  $('zip-mode').disabled = busy;
  $('analyze-btn').textContent = analyzed === selected.length && !failed && selected.length ? 'Re-analyze selection' : 'Analyze selected';
  text('analyze-helper', selected.length && analyzed === selected.length ? 'Ready to export. Your original audio stays unchanged.' : 'Analyzing does not modify your files.');
}
function showProgress(message, completed, total) {
  $('progress-panel').hidden = false;
  text('progress-message', message);
  text('progress-count', `${completed.toLocaleString()} / ${total.toLocaleString()}`);
  $('progress-bar').style.width = `${total ? Math.round(100 * completed / total) : 0}%`;
}
function doneProgress(message) { text('progress-message', message); }
async function getFile(e) { return e.file || await e.fileHandle.getFile(); }
async function context() { return activeAudioContext ||= new AudioContext(); }
async function decode(file) {
  const ctx = await context();
  // decodeAudioData detaches its input buffer; always give it a disposable copy.
  return await ctx.decodeAudioData(await file.arrayBuffer());
}
async function batchAnalyze() {
  if (busy) return;
  const selected = entries.filter(e => e.selected);
  if (!selected.length) return;
  busy = true; cancelRequested = false; render();
  track('analysis_started', { file_count: selected.length });
  let passed = 0, failed = 0;
  for (let i = 0; i < selected.length; i++) {
    if (cancelRequested) break;
    const e = selected[i];
    showProgress(`Analyzing ${basename(e.relative)}`, i, selected.length);
    try {
      const file = await getFile(e);
      e.size = file.size;
      const audio = await decode(file);
      e.analysis = await analyzeBuffer(audio, { isCancelled, yieldToBrowser });
      e.error = ''; e.status = 'Analyzed'; passed++;
    } catch (err) {
      if (err.name === 'AbortError') break;
      e.error = err.message || String(err); e.analysis = null; e.status = 'Error'; failed++;
    }
    showProgress(`Analyzed ${i + 1} of ${selected.length}`, i + 1, selected.length);
    if (i % 4 === 0) render();
  }
  busy = false;
  doneProgress(cancelRequested ? 'Analysis cancelled. Completed results are retained.' : `Analysis complete: ${passed} succeeded, ${failed} failed.`);
  track('analysis_completed', { analyzed_count: passed, error_count: failed, cancelled: cancelRequested });
  render();
}

function uniquePathFactory() {
  const used = new Set();
  return value => {
    const slash = value.lastIndexOf('/');
    const dir = slash < 0 ? '' : value.slice(0, slash + 1);
    const name = value.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = name.slice(0, dot); const ext = name.slice(dot);
    let path = value, n = 2;
    while (used.has(path.toLowerCase())) path = `${dir}${stem} (${n++})${ext}`;
    used.add(path.toLowerCase());
    return path;
  };
}
async function uniqueFolderFilePath(folder, path) {
  const parts = path.split('/');
  let directory = folder;
  for (const p of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(p, { create: true });
  const name = parts.at(-1), dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot), ext = name.slice(dot);
  for (let i = 1; i < 100000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try { await directory.getFileHandle(candidate); }
    catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      return { directory, filename: candidate };
    }
  }
  throw new Error('Could not find an unused output filename.');
}
function memorySink() {
  const parts = []; let size = 0, crc = crcStart();
  return { async write(chunk) { const data = new Uint8Array(chunk); parts.push(data); size += data.byteLength; crc = crcUpdate(crc, data); },
    result() { return { parts, size, crc: crcFinish(crc) }; } };
}
async function ensureEncoder() {
  if (window.lamejs?.Mp3Encoder) return;
  const src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js';
  const el = document.createElement('script'); el.src = src; el.async = true;
  await new Promise((resolve, reject) => {
    el.onload = resolve;
    el.onerror = () => reject(new Error('MP3 encoder could not load. An internet connection is needed. Switch to WAV to export without it.'));
    document.head.append(el);
  });
  if (!window.lamejs?.Mp3Encoder) throw new Error('MP3 encoder did not initialize. Choose WAV export.');
}
async function batchExport() {
  if (busy || !validTarget()) return;
  const selected = entries.filter(e => e.selected);
  if (!selected.length || selected.some(e => !e.analysis)) return;
  const v = settings();
  const viaFolder = !!destinationHandle;
  busy = true; cancelRequested = false; completedExports = 0; render();
  const zip = viaFolder ? null : new ZipArchive();
  const unique = uniquePathFactory();
  let failed = 0, exported = 0;
  track('export_started', { file_count: selected.length, output_format: v.format, destination_type: viaFolder ? 'folder' : 'zip' });
  if (v.format === 'mp3') {
    try { showProgress('Loading optional MP3 encoder…', 0, selected.length); await ensureEncoder(); }
    catch (e) { busy = false; doneProgress(e.message); render(); showError(e); return; }
  }
  for (let i = 0; i < selected.length; i++) {
    if (cancelRequested) break;
    const e = selected[i];
    showProgress(`Exporting ${basename(e.relative)}`, i, selected.length);
    let writable = null;
    try {
      const file = await getFile(e);
      e.size = file.size;
      const audio = await decode(file);
      const gain = calculateGain(e.analysis, v.target, v.ceiling);
      const plannedName = unique(normalizeOutputPath(e));
      let sink, filename;
      if (viaFolder) {
        const output = await uniqueFolderFilePath(destinationHandle, plannedName);
        filename = output.filename;
        writable = await (await output.directory.getFileHandle(filename, { create: true })).createWritable();
        sink = { write: chunk => writable.write(chunk) };
      } else { sink = memorySink(); filename = plannedName; }
      if (v.format === 'mp3') {
        // Same-format MP3 exports retain a copy of the original ID3v2 prefix.
        const tag = await originalId3v2(file);
        if (tag) await sink.write(tag);
        await encodeMp3(audio, gain.gainDb, sink, { isCancelled, yieldToBrowser });
      } else {
        await encodeWav(audio, gain.gainDb, Number(v.format.slice(3)), sink, { isCancelled, yieldToBrowser });
      }
      if (writable) { await writable.close(); writable = null; }
      else {
        const data = sink.result();
        zip.add(filename, data.parts, data.size, data.crc);
      }
      e.status = 'Exported'; e.error = ''; exported++; completedExports++;
    } catch (err) {
      if (writable) { try { await writable.abort(); } catch { /* ignore */ } }
      if (err.name === 'AbortError') break;
      e.error = err.message || String(err); e.status = 'Error'; failed++;
    }
    showProgress(`Exported ${i + 1} of ${selected.length}`, i + 1, selected.length);
    render();
  }
  if (zip && exported) {
    try {
      const blob = zip.finish();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'volume-normalizer-exports.zip';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { showError(err); failed += exported; exported = 0; completedExports = 0; }
  }
  busy = false;
  doneProgress(cancelRequested ? `Stopped. ${exported} file(s) exported so far.` : `Finished: ${exported} file(s) exported, ${failed} failed.`);
  track('export_completed', { exported_count: exported, failed_count: failed, cancelled: cancelRequested, output_format: v.format, destination_type: viaFolder ? 'folder' : 'zip' });
  render();
}
function initConsent() {
  initializeAnalytics();
  const banner = $('consent-banner');
  const show = () => { banner.hidden = false; };
  const hide = () => { banner.hidden = true; };
  if (analyticsConsent() === 'unknown') show();
  $('analytics-allow').addEventListener('click', () => { setAnalyticsConsent('allow'); hide(); });
  $('analytics-decline').addEventListener('click', () => { setAnalyticsConsent('decline'); hide(); });
  $('analytics-settings').addEventListener('click', show);
  $('analytics-close').addEventListener('click', hide);
}
function attach() {
  $('source-browse').addEventListener('click', chooseSource);
  $('source-refresh').addEventListener('click', rescanSource);
  $('folder-fallback').addEventListener('change', importFromInput);
  $('destination-browse').addEventListener('click', chooseDestination);
  $('zip-mode').addEventListener('click', useZip);
  $('include-subfolders').addEventListener('change', () => { if (sourceHandle) rescanSource(); });
  $('analyze-btn').addEventListener('click', batchAnalyze);
  $('export-btn').addEventListener('click', batchExport);
  $('cancel-btn').addEventListener('click', () => { cancelRequested = true; $('cancel-btn').disabled = true; doneProgress('Finishing the current operation, then stopping…'); });
  $('select-all').addEventListener('click', () => { if (!busy) { entries.forEach(e => e.selected = true); render(); } });
  $('select-none').addEventListener('click', () => { if (!busy) { entries.forEach(e => e.selected = false); render(); } });
  $('file-filter').addEventListener('input', render);
  $('target').addEventListener('input', () => { if ($('target-presets').value !== $('target').value) $('target-presets').value = 'custom'; reflectSettings(); });
  $('ceiling').addEventListener('change', reflectSettings);
  $('format').addEventListener('change', reflectSettings);
  $('preserve').addEventListener('change', reflectSettings);
  $('target-presets').addEventListener('change', e => { if (e.target.value !== 'custom') { $('target').value = e.target.value; reflectSettings(); } });
  addEventListener('beforeunload', () => { if (activeAudioContext) activeAudioContext.close(); });
}
function startup() { initConsent(); attach(); reflectSettings(); render(); }
startup();

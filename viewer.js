// Side panel that shows a cited page with the cited passage highlighted.
// PDFs are rendered with pdf.js; other files show the text Eigen read from that slide/section.
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('doc-viewer');
  const titleEl = $('viewer-title');
  const pageEl = $('viewer-page');
  const body = $('viewer-body');
  const noteEl = $('viewer-note');
  const prevBtn = $('viewer-prev');
  const nextBtn = $('viewer-next');
  const main = document.querySelector('.main');
  const { el, toast } = window.eigenUI;
  const db = () => window.eigen.supabase;

  const fileCache = new Map();   // fileId -> { file, pdf, pages }
  let current = null;            // { fileId, fileName, page, quote, approximate, total }
  let renderToken = 0;

  // ---------- Text matching (whitespace- and case-insensitive) ----------
  // Returns [start, end) in the original string for the quote, or null.
  function findQuote(text, quote) {
    if (!quote) return null;
    const norm = [], map = [];
    let prevSpace = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) { if (!prevSpace) { norm.push(' '); map.push(i); } prevSpace = true; }
      else { norm.push(ch.toLowerCase()); map.push(i); prevSpace = false; }
    }
    const hay = norm.join('');
    const needle = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!needle) return null;
    const tryFind = n => { const i = hay.indexOf(n); return i < 0 ? null : [map[i], map[i + n.length - 1] + 1]; };
    let hit = tryFind(needle);
    if (hit) return hit;
    // Fall back to the start and end of the quote (text extraction can differ slightly in the middle).
    if (needle.length > 60) {
      const a = tryFind(needle.slice(0, 40)), b = tryFind(needle.slice(-40));
      if (a && b && b[1] > a[0]) return [a[0], b[1]];
      return a || b;
    }
    return null;
  }

  // ---------- Loading ----------
  async function loadFile(fileId) {
    if (fileCache.has(fileId)) return fileCache.get(fileId);
    const { data: file, error } = await db().from('files').select('id, name, mime_type, storage_path').eq('id', fileId).maybeSingle();
    if (error || !file) throw new Error('That file has been deleted.');
    const entry = { file, pdf: null, pages: null };
    if (/\.pdf$/i.test(file.name) || file.mime_type === 'application/pdf') {
      const { data: blob, error: dlErr } = await db().storage.from('files').download(file.storage_path);
      if (dlErr || !blob) throw new Error('Couldn’t download that file.');
      const lib = await window.eigenReader.pdfjs();
      entry.pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      entry.lib = lib;
    } else {
      const { data } = await db().from('file_texts').select('pages').eq('file_id', fileId).maybeSingle();
      entry.pages = Array.isArray(data?.pages) ? data.pages : [];
    }
    fileCache.set(fileId, entry);
    return entry;
  }

  // ---------- Rendering ----------
  const unitName = name => (/\.pdf$/i.test(name) ? 'Page' : /\.pptx?$/i.test(name) ? 'Slide' : 'Section');

  async function render() {
    const token = ++renderToken;
    const c = current;
    titleEl.textContent = c.fileName;
    titleEl.title = c.fileName;
    pageEl.textContent = '';
    noteEl.hidden = true;
    body.replaceChildren(el(`<p class="viewer-status">Loading…</p>`));
    let entry;
    try { entry = await loadFile(c.fileId); }
    catch (err) {
      if (token === renderToken) body.replaceChildren(el(`<p class="viewer-status"></p>`)), body.firstChild.textContent = err.message;
      return;
    }
    if (token !== renderToken) return;
    c.total = entry.pdf ? entry.pdf.numPages : Math.max(entry.pages.length, 1);
    c.page = Math.min(Math.max(c.page || 1, 1), c.total);
    pageEl.textContent = `${unitName(c.fileName)} ${c.page} of ${c.total}`;
    prevBtn.disabled = c.page <= 1;
    nextBtn.disabled = c.page >= c.total;
    const highlightHere = c.page === c.citedPage;

    if (entry.pdf) await renderPdfPage(entry, c, highlightHere, token);
    else renderTextPage(entry, c, highlightHere);

    if (token !== renderToken) return;
    if (highlightHere && c.approximate) showNote('Approximate reference: the AI pointed to this page but didn’t quote the exact passage.');
    else if (highlightHere && c.quote && !body.querySelector('.hl, mark')) showNote('Couldn’t pinpoint the quoted text on this page. It may be in an image or laid out differently.');
  }

  function showNote(text) { noteEl.textContent = text; noteEl.hidden = false; }

  async function renderPdfPage(entry, c, highlightHere, token) {
    const page = await entry.pdf.getPage(c.page);
    if (token !== renderToken) return;
    const width = Math.max(body.clientWidth - 32, 200);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    const wrap = el(`<div class="pdf-page"><canvas></canvas><div class="hl-layer"></div></div>`);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    const canvas = wrap.querySelector('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    body.replaceChildren(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    if (token !== renderToken || !highlightHere || !c.quote) return;

    // Build the page text from its items (as when the file was read), remembering where each item sits.
    const tc = await page.getTextContent();
    let full = '';
    const spans = []; // { start, end, item }
    for (const item of tc.items) {
      const str = item.str ?? '';
      spans.push({ start: full.length, end: full.length + str.length, item });
      full += str + (item.hasEOL ? '\n' : ' ');
    }
    const hit = findQuote(full, c.quote);
    if (!hit) return;
    const layer = wrap.querySelector('.hl-layer');
    let first = null;
    for (const { start, end, item } of spans) {
      if (end <= hit[0] || start >= hit[1] || !item.str) continue;
      const tx = entry.lib.Util.transform(viewport.transform, item.transform);
      const h = Math.hypot(tx[2], tx[3]);
      const w = item.width * scale;
      // Only the matched part of a partly matched item.
      const from = Math.max(hit[0], start) - start, to = Math.min(hit[1], end) - start;
      const left = tx[4] + w * (from / item.str.length);
      const right = tx[4] + w * (to / item.str.length);
      const box = el(`<div class="hl"></div>`);
      Object.assign(box.style, { left: `${left - 1}px`, top: `${tx[5] - h * 0.85}px`, width: `${right - left + 2}px`, height: `${h * 1.1}px` });
      layer.append(box);
      first ??= box;
    }
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function renderTextPage(entry, c, highlightHere) {
    const text = entry.pages[c.page - 1] ?? '';
    const box = el(`<div class="text-page"></div>`);
    if (!text.trim()) {
      box.append(el(`<p class="viewer-status">No text on this ${unitName(c.fileName).toLowerCase()}.</p>`));
    } else {
      const hit = highlightHere ? findQuote(text, c.quote) : null;
      if (hit) {
        box.append(document.createTextNode(text.slice(0, hit[0])));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(hit[0], hit[1]);
        box.append(mark, document.createTextNode(text.slice(hit[1])));
      } else {
        box.textContent = text;
      }
    }
    body.replaceChildren(box);
    box.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------- Opening & closing ----------
  function open(cite) {
    current = { fileId: cite.fileId, fileName: cite.fileName, page: cite.page || 1, citedPage: cite.page || 1, quote: cite.quote || '', approximate: !!cite.approximate };
    panel.hidden = false;
    main.classList.add('with-viewer');
    render();
  }
  function close() {
    panel.hidden = true;
    main.classList.remove('with-viewer');
    current = null;
    renderToken++;
  }

  prevBtn.addEventListener('click', () => { if (current && current.page > 1) { current.page--; render(); } });
  nextBtn.addEventListener('click', () => { if (current && current.page < current.total) { current.page++; render(); } });
  $('viewer-close').addEventListener('click', close);
  $('viewer-open').addEventListener('click', async () => {
    if (!current) return;
    const win = window.open('', '_blank');
    try {
      const { file } = await loadFile(current.fileId);
      const { data } = await db().storage.from('files').createSignedUrl(file.storage_path, 300);
      const url = data.signedUrl + (/\.pdf$/i.test(file.name) ? `#page=${current.page}` : '');
      if (win) win.location = url; else location.assign(url);
    } catch { win?.close(); toast('Couldn’t open that file.'); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) close(); });
  // Leaving the chat closes the viewer; a resize re-fits the page.
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#course/')) close(); });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (current) render(); }, 200); });
  // Files can change while the viewer is open.
  document.addEventListener('eigen:files-changed', () => fileCache.clear());

  window.eigenViewer = { open, close, _findQuote: findQuote };
})();

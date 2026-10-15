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

  // When there's no exact quote: the sentence on the page that best matches the sentence the citation
  // was attached to (shared meaningful words, favouring shorter sentences). Returns [start, end) or null.
  const STOP = new Set('the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when your into than then them these some such only also more most other been were each over very just like using used use its it\'s may might must shall should could does did done how why who whom where while because between both after before during under above below again further same few own too off per via is be as an at by of on or in to a'.split(' '));
  // Light stemming so "queue"/"queues", "sort"/"sorting" and "store"/"stored" match.
  const stem = w => w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1').replace(/e$/, '');
  const words = t => (t.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || []).filter(w => w.length > 2 && !STOP.has(w)).map(stem);
  function bestPassage(text, claim) {
    const want = new Set(words(claim));
    if (!want.size) return null;
    // Split the page into sentences / lines, remembering where each one is.
    const segs = [];
    const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      if (m[0].trim().length < 12) continue;
      const w = words(m[0]);
      if (!w.length) continue;
      const lead = m[0].length - m[0].trimStart().length;
      segs.push({ w, set: new Set(w), range: [m.index + lead, m.index + m[0].trimEnd().length] });
    }
    if (!segs.length) return null;
    // Words that appear in few sentences on this page say more about which one is meant.
    const df = new Map();
    for (const s of segs) for (const w of s.set) df.set(w, (df.get(w) || 0) + 1);
    const idf = w => Math.log(1 + segs.length / df.get(w));
    let best = null;
    for (const s of segs) {
      const shared = [...s.set].filter(w => want.has(w));
      if (!shared.length) continue;
      const score = shared.reduce((t, w) => t + idf(w), 0) / Math.sqrt(s.w.length);
      // Two shared words, or one when the line is short and mostly about it (e.g. a slide bullet).
      const enough = shared.length >= Math.min(2, want.size) || shared.length / s.set.size >= 0.5;
      if (enough && (!best || score > best.score)) best = { score, range: s.range };
    }
    return best?.range ?? null;
  }

  // What to highlight on the cited page: every exact quote, otherwise the closest matching passage.
  function highlightRanges(text, c) {
    const quotes = c.quotes?.length ? c.quotes : c.quote ? [c.quote] : [];
    const exact = quotes.map(q => findQuote(text, q)).filter(Boolean);
    if (exact.length) return { kind: 'exact', ranges: exact };
    const near = bestPassage(text, c.claim || '');
    return near ? { kind: 'closest', ranges: [near] } : { kind: 'none', ranges: [] };
  }

  // ---------- Loading ----------
  async function loadFile(fileId) {
    if (fileCache.has(fileId)) return fileCache.get(fileId);
    const { data: file, error } = await db().from('files').select('id, name, mime_type, storage_path').eq('id', fileId).maybeSingle();
    if (error || !file) throw new Error('That file has been deleted.');
    const entry = { file, pdf: null, pages: null };
    if (/\.pdf$/i.test(file.name) || file.mime_type === 'application/pdf') {
      try {
        const { data: blob, error: dlErr } = await db().storage.from('files').download(file.storage_path);
        if (dlErr || !blob) throw dlErr || new Error('no file');
        const lib = await window.eigenReader.pdfjs();
        entry.pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        entry.lib = lib;
      } catch (err) {
        console.error(err); // couldn't show the PDF itself: fall back to the text Eigen read from it
        entry.pdf = null;
        entry.fallback = true;
      }
    }
    if (!entry.pdf) {
      const { data } = await db().from('file_texts').select('pages').eq('file_id', fileId).maybeSingle();
      entry.pages = Array.isArray(data?.pages) ? data.pages : [];
      if (entry.fallback && !entry.pages.length) throw new Error('Couldn’t open that file.');
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

    const kind = entry.pdf ? await renderPdfPage(entry, c, highlightHere, token) : renderTextPage(entry, c, highlightHere);

    if (token !== renderToken) return;
    if (entry.fallback) showNote('Showing the text of this page (the PDF itself couldn’t be loaded).');
    if (!highlightHere) return;
    if (kind === 'closest') showNote('Closest matching passage: the AI didn’t give an exact quote here, so this is the part of the page that best matches its answer.');
    else if (kind === 'none' && c.approximate) showNote('Approximate reference: the AI pointed to this page, but no matching passage could be found. It may be in an image.');
    else if (kind === 'none') showNote('Couldn’t pinpoint the passage on this page. It may be in an image or laid out differently.');
  }

  function showNote(text) { noteEl.textContent = noteEl.hidden ? text : `${noteEl.textContent} ${text}`; noteEl.hidden = false; }

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
    if (token !== renderToken || !highlightHere) return null;

    // Build the page text from its items (as when the file was read), remembering where each item sits.
    const tc = await page.getTextContent();
    let full = '';
    const spans = []; // { start, end, item }
    for (const item of tc.items) {
      const str = item.str ?? '';
      spans.push({ start: full.length, end: full.length + str.length, item });
      full += str + (item.hasEOL ? '\n' : ' ');
    }
    const { kind, ranges } = highlightRanges(full, c);
    const layer = wrap.querySelector('.hl-layer');
    let first = null;
    for (const hit of ranges) for (const { start, end, item } of spans) {
      if (end <= hit[0] || start >= hit[1] || !item.str) continue;
      const tx = entry.lib.Util.transform(viewport.transform, item.transform);
      const h = Math.hypot(tx[2], tx[3]);
      const w = item.width * scale;
      // Only the matched part of a partly matched item.
      const from = Math.max(hit[0], start) - start, to = Math.min(hit[1], end) - start;
      const left = tx[4] + w * (from / item.str.length);
      const right = tx[4] + w * (to / item.str.length);
      const box = el(`<div class="hl ${kind === 'closest' ? 'closest' : ''}"></div>`);
      Object.assign(box.style, { left: `${left - 1}px`, top: `${tx[5] - h * 0.85}px`, width: `${right - left + 2}px`, height: `${h * 1.1}px` });
      layer.append(box);
      first ??= box;
    }
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return first ? kind : 'none';
  }

  function renderTextPage(entry, c, highlightHere) {
    const text = entry.pages[c.page - 1] ?? '';
    const box = el(`<div class="text-page"></div>`);
    if (!text.trim()) {
      box.append(el(`<p class="viewer-status">No text on this ${unitName(c.fileName).toLowerCase()}.</p>`));
    } else {
      const { kind, ranges } = highlightHere ? highlightRanges(text, c) : { kind: null, ranges: [] };
      // Merge overlapping ranges, then wrap each in a <mark>.
      const sorted = ranges.slice().sort((a, b) => a[0] - b[0]).reduce((acc, r) => {
        const last = acc[acc.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else acc.push([...r]);
        return acc;
      }, []);
      let pos = 0;
      for (const [a, b] of sorted) {
        box.append(document.createTextNode(text.slice(pos, a)));
        const mark = document.createElement('mark');
        if (kind === 'closest') mark.className = 'closest';
        mark.textContent = text.slice(a, b);
        box.append(mark);
        pos = b;
      }
      box.append(document.createTextNode(text.slice(pos)));
      body.replaceChildren(box);
      box.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return highlightHere ? (sorted.length ? kind : 'none') : null;
    }
    body.replaceChildren(box);
    return highlightHere ? 'none' : null;
  }

  // ---------- Opening & closing ----------
  function open(cite) {
    current = {
      fileId: cite.fileId, fileName: cite.fileName, page: cite.page || 1, citedPage: cite.page || 1,
      quote: cite.quote || '', quotes: cite.quotes || [], claim: cite.claim || '', approximate: !!cite.approximate,
    };
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

  window.eigenViewer = { open, close, _findQuote: findQuote, _bestPassage: bestPassage };
})();

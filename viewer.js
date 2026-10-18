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
  const openBtn = $('viewer-open');
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

  // When there's no exact quote, look for the passage the citation most likely points at. This is
  // only a guess, so it must be a confident one: an unrelated highlight is worse than none.
  const STOP = new Set('the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when your into than then them these some such only also more most other been were each over very just like using used use its it\'s may might must shall should could does did done how why who whom where while because between both after before during under above below again further same few own too off per via is be as an at by of on or in to a means called known example examples following given gives make makes made way ways thing things part parts form'.split(' '));
  // Light stemming so "queue"/"queues", "sort"/"sorting" and "store"/"stored" match.
  const stem = w => w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1').replace(/e$/, '');
  const words = t => (t.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || []).filter(w => w.length > 2 && !STOP.has(w)).map(stem);

  // The page as sentences / lines, each with its keywords and where it is.
  function segments(text) {
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
    return segs;
  }

  // A quote the AI meant to copy from the page but didn't get word for word: the run of one to three
  // consecutive sentences that contains most of its words.
  function fuzzyQuote(text, quote) {
    const want = [...new Set(words(quote))];
    if (want.length < 3) return null;
    const segs = segments(text);
    let best = null;
    for (let i = 0; i < segs.length; i++) {
      const have = new Set();
      for (let j = i; j < Math.min(i + 3, segs.length); j++) {
        segs[j].set.forEach(w => have.add(w));
        const hit = want.filter(w => have.has(w)).length;
        const cover = hit / want.length;
        // Prefer more coverage, then the shortest stretch of the page.
        const range = [segs[i].range[0], segs[j].range[1]];
        const better = !best || cover > best.cover + 1e-9 || (Math.abs(cover - best.cover) < 1e-9 && range[1] - range[0] < best.range[1] - best.range[0]);
        if (cover >= 0.6 && hit >= 3 && better) best = { cover, range };
      }
    }
    return best?.range ?? null;
  }

  // No quote at all: the sentence on the page that best matches the answer's sentence. It must share
  // several distinctive words with it (rare words on the page count most), and clearly beat the
  // runner-up; otherwise there's no highlight.
  function bestPassage(text, claim) {
    const want = new Set(words(claim));
    const segs = segments(text);
    if (!segs.length || !want.size) return null;
    // On a page of only a line or two (a slide title and bullet) one shared word is enough: there's
    // nothing else on it to confuse it with.
    const minShared = segs.length <= 2 ? 1 : 2;
    const df = new Map();
    for (const s of segs) for (const w of s.set) df.set(w, (df.get(w) || 0) + 1);
    const idf = w => Math.log(1 + segs.length / (df.get(w) || segs.length));
    // Only the claim's words that appear on this page can be matched at all.
    const reachable = [...want].filter(w => df.has(w));
    const reachWeight = reachable.reduce((t, w) => t + idf(w), 0);
    if (reachable.length < minShared) return null;
    const scored = segs.map(s => {
      const shared = [...s.set].filter(w => want.has(w));
      const weight = shared.reduce((t, w) => t + idf(w), 0);
      return { shared, cover: weight / reachWeight, score: weight / Math.sqrt(s.w.length), range: s.range };
    }).filter(s => s.shared.length >= minShared && s.cover >= 0.45)
      .sort((a, b) => b.score - a.score);
    const [first, second] = scored;
    if (!first) return null;
    if (second && second.score > first.score * 0.85) return null; // too close to call
    return first.range;
  }

  // What to highlight on the cited page: every exact quote; otherwise the passage the AI's near-quote
  // came from; otherwise a confident match for the answer's sentence; otherwise nothing.
  function highlightRanges(text, c) {
    const quotes = c.quotes?.length ? c.quotes : c.quote ? [c.quote] : [];
    const exact = quotes.map(q => findQuote(text, q)).filter(Boolean);
    if (exact.length) return { kind: 'exact', ranges: exact };
    const near = (c.hints || []).map(h => fuzzyQuote(text, h)).find(Boolean) ?? bestPassage(text, c.claim || '');
    return near ? { kind: 'closest', ranges: [near] } : { kind: 'none', ranges: [] };
  }

  // ---------- Loading ----------
  const isNote = id => id.startsWith('note:');
  async function loadFile(fileId) {
    if (fileCache.has(fileId)) return fileCache.get(fileId);
    // A note written in Eigen: shown as text.
    if (isNote(fileId)) {
      const { data: note } = await db().from('notes').select('id, title, body').eq('id', fileId.slice(5)).maybeSingle();
      if (!note) throw new Error('That note has been deleted.');
      return { file: { name: note.title }, note, pdf: null, pages: [note.body] }; // not cached: notes change as you type
    }
    const { data: file, error } = await db().from('files').select('id, name, mime_type, storage_path').eq('id', fileId).maybeSingle();
    if (error || !file) throw new Error('That file has been deleted.');
    const entry = { file, pdf: null, pages: null };
    // Images and videos are shown as they are.
    const media = /^image\//.test(file.mime_type || '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name) ? 'image'
      : /^video\//.test(file.mime_type || '') || /\.(mp4|mov|m4v|webm)$/i.test(file.name) ? 'video' : null;
    if (media) {
      const { data } = await db().storage.from('files').createSignedUrl(file.storage_path, 3600);
      if (!data?.signedUrl) throw new Error('Couldn’t open that file.');
      entry.media = { type: media, url: data.signedUrl };
      entry.pages = [];
      fileCache.set(fileId, entry);
      return entry;
    }
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
  const NOTES = {
    closest: 'Likely passage: the AI didn’t quote this page word for word, so this is the part that best matches what it said.',
    approx: 'Approximate reference: the AI pointed to this page, but no matching passage could be found. It may be in an image.',
    none: 'Couldn’t pinpoint the passage on this page. It may be in an image or laid out differently.',
  };
  const noteFor = (kind, c) => (kind === 'closest' ? NOTES.closest : kind === 'none' ? (c.approximate ? NOTES.approx : NOTES.none) : null);

  function render() {
    return current.items.length > 1 ? renderMany() : renderOne();
  }

  // One cited page, with page-by-page navigation.
  async function renderOne() {
    const token = ++renderToken;
    const c = current.items[0];
    titleEl.textContent = c.fileName;
    titleEl.title = c.fileName;
    pageEl.textContent = '';
    noteEl.hidden = true;
    prevBtn.hidden = nextBtn.hidden = false;
    body.replaceChildren(el(`<p class="viewer-status">Loading…</p>`));
    let entry;
    try { entry = await loadFile(c.fileId); }
    catch (err) {
      if (token === renderToken) { body.replaceChildren(el(`<p class="viewer-status"></p>`)); body.firstChild.textContent = err.message; }
      return;
    }
    if (token !== renderToken) return;
    if (entry.note) return renderNoteEditor(entry.note, c);
    if (entry.media || (!entry.pdf && !entry.pages.some(t => t.trim()) && c.preview)) {
      // Nothing to page through: an image, a video, or a file Eigen has no text for.
      prevBtn.hidden = nextBtn.hidden = true;
      pageEl.textContent = entry.media ? (entry.media.type === 'image' ? 'Image' : 'Video') : '';
      if (entry.media?.type === 'image') body.replaceChildren(Object.assign(el(`<img class="viewer-media" alt="">`), { src: entry.media.url, alt: c.fileName }));
      else if (entry.media) body.replaceChildren(Object.assign(el(`<video class="viewer-media" controls></video>`), { src: entry.media.url }));
      else body.replaceChildren(el(`<p class="viewer-status">No preview for this kind of file yet. Use the open button above to view it in a new tab.</p>`));
      return;
    }
    const total = entry.pdf ? entry.pdf.numPages : Math.max(entry.pages.length, 1);
    current.total = total;
    current.page = Math.min(Math.max(current.page || 1, 1), total);
    pageEl.textContent = entry.note ? 'Note' : `${unitName(c.fileName)} ${current.page} of ${total}`;
    prevBtn.hidden = nextBtn.hidden = total <= 1;
    prevBtn.disabled = current.page <= 1;
    nextBtn.disabled = current.page >= total;
    const highlightHere = !c.preview && current.page === c.page; // a preview shows the file without highlights
    body.replaceChildren();
    const kind = await renderPage(entry, c, current.page, highlightHere, token, body);
    if (token !== renderToken) return;
    if (entry.fallback) showNote('Showing the text of this page (the PDF itself couldn’t be loaded).');
    if (highlightHere && noteFor(kind, c)) showNote(noteFor(kind, c));
  }

  // Several cited pages at once (e.g. a sentence that drew on pages 7 and 10), stacked one under another.
  async function renderMany() {
    const token = ++renderToken;
    const items = current.items;
    const files = [...new Set(items.map(c => c.fileName))];
    titleEl.textContent = files.length === 1 ? files[0] : `${items.length} sources`;
    titleEl.title = files.join(', ');
    pageEl.textContent = files.length === 1
      ? `${unitName(files[0])}s ${items.map(c => c.page).join(', ')}`
      : items.map(c => `${c.fileName} ${unitName(c.fileName).toLowerCase()} ${c.page}`).join(' · ');
    noteEl.hidden = true;
    prevBtn.hidden = nextBtn.hidden = true;
    const sections = items.map((c, i) => {
      const sec = el(`<section class="viewer-section${i === current.focus ? ' focus' : ''}"><p class="viewer-section-label"><span class="src-n"></span><span class="label"></span></p><div class="viewer-section-body"><p class="viewer-status">Loading…</p></div></section>`);
      sec.querySelector('.src-n').textContent = c.n ?? i + 1;
      sec.querySelector('.label').textContent = `${files.length > 1 ? c.fileName + ' · ' : ''}${unitName(c.fileName)} ${c.page}`;
      return sec;
    });
    body.replaceChildren(...sections);
    // Render the clicked one first so it appears straight away, then the rest.
    const order = [current.focus, ...items.keys()].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of order) {
      const c = items[i], target = sections[i].querySelector('.viewer-section-body');
      try {
        const entry = await loadFile(c.fileId);
        if (token !== renderToken) return;
        target.replaceChildren();
        const kind = await renderPage(entry, c, c.page, true, token, target, false);
        if (token !== renderToken) return;
        const note = entry.fallback ? 'Showing this page’s text (the PDF couldn’t be loaded).' : noteFor(kind, c);
        if (note) target.prepend(Object.assign(el(`<p class="viewer-note small"></p>`), { textContent: note }));
      } catch (err) {
        if (token !== renderToken) return;
        target.replaceChildren(Object.assign(el(`<p class="viewer-status"></p>`), { textContent: err.message }));
      }
      if (i === current.focus) reveal(sections[i].querySelector('.hl, mark') || sections[i]);
    }
  }

  // A note written in Eigen is edited right in the panel; it saves as you type.
  let flushNote = () => {};
  function renderNoteEditor(note, c) {
    const place = () => {
      const meta = window.eigenNotes.find(note.id);
      const course = window.eigenClasses.findClass(meta?.class_id);
      const folder = meta?.folder_id && course?.folders.find(f => f.id === meta.folder_id);
      return [course?.name, folder?.name].filter(Boolean).join(' / ') || 'Note';
    };
    titleEl.textContent = note.title;
    titleEl.title = note.title;
    pageEl.textContent = place();
    prevBtn.hidden = nextBtn.hidden = true;
    noteEl.hidden = true;
    const box = el(`
      <div class="panel-note">
        <input class="panel-note-title" maxlength="200" placeholder="Untitled note" aria-label="Note title" spellcheck="false">
        <textarea class="panel-note-body" placeholder="Start writing…" aria-label="Note"></textarea>
        <p class="panel-note-status"></p>
      </div>`);
    const [title, text, status] = [box.querySelector('input'), box.querySelector('textarea'), box.querySelector('p')];
    title.value = note.title;
    text.value = note.body;
    status.textContent = 'Saved';
    body.replaceChildren(box);
    let timer = 0, pending = null;
    const save = async () => {
      clearTimeout(timer);
      if (!pending) return;
      const patch = pending;
      pending = null;
      const ok = await window.eigenNotes.save(note.id, patch);
      if (status.isConnected) status.textContent = ok ? 'Saved' : 'Not saved';
    };
    flushNote = save;
    const edited = patch => {
      pending = { ...pending, ...patch };
      status.textContent = 'Saving…';
      clearTimeout(timer);
      timer = setTimeout(save, 600);
    };
    title.addEventListener('input', () => { titleEl.textContent = title.value || 'Untitled note'; edited({ title: title.value }); });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); text.focus(); } });
    text.addEventListener('input', () => edited({ body: text.value }));
    if (c.focusTitle) requestAnimationFrame(() => { title.focus(); title.select(); });
  }

  // Scrolls the panel (and only the panel) so `target` is in the middle of it. scrollIntoView would also
  // scroll the page behind the panel when the passage is near the bottom of a page, pushing the chat up.
  function reveal(target, smooth = false) {
    const box = body.getBoundingClientRect(), r = target.getBoundingClientRect();
    const top = body.scrollTop + (r.top - box.top) - (body.clientHeight - Math.min(r.height, body.clientHeight)) / 2;
    body.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    unscrollPage();
  }
  // The page behind the panel never scrolls in chat view; undo it if anything did.
  function unscrollPage() {
    for (const el of [document.scrollingElement, document.getElementById('app'), main]) if (el && el.scrollTop) el.scrollTop = 0;
  }

  function showNote(text) { noteEl.textContent = noteEl.hidden ? text : `${noteEl.textContent} ${text}`; noteEl.hidden = false; }

  // Draws one page into `target` and highlights the cited passage. Returns 'exact' | 'closest' | 'none' | null.
  function renderPage(entry, c, pageNo, highlightHere, token, target, scroll = true) {
    if (entry.pdf) return renderPdfPage(entry, c, pageNo, highlightHere, token, target, scroll);
    return renderTextPage(entry, c, pageNo, highlightHere, target, scroll);
  }

  async function renderPdfPage(entry, c, pageNo, highlightHere, token, target, scroll) {
    const page = await entry.pdf.getPage(pageNo);
    if (token !== renderToken) return null;
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
    target.append(wrap);
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
    if (scroll && first) reveal(first, true);
    return first ? kind : 'none';
  }

  function renderTextPage(entry, c, pageNo, highlightHere, target, scroll) {
    const text = entry.pages[pageNo - 1] ?? '';
    const box = el(`<div class="text-page"></div>`);
    target.append(box);
    if (!text.trim()) {
      box.append(el(`<p class="viewer-status">No text on this ${unitName(c.fileName).toLowerCase()}.</p>`));
      return highlightHere ? 'none' : null;
    }
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
    if (scroll && box.querySelector('mark')) reveal(box.querySelector('mark'), true);
    return highlightHere ? (sorted.length ? kind : 'none') : null;
  }

  // ---------- Opening & closing ----------
  const asItem = cite => ({
    n: cite.n, fileId: cite.fileId, fileName: cite.fileName, page: cite.page || 1, preview: !!cite.preview, focusTitle: !!cite.focusTitle,
    quote: cite.quote || '', quotes: cite.quotes || [], hints: cite.hints || [], claim: cite.claim || '', approximate: !!cite.approximate,
  });
  // preview(file) shows a whole file (or a note, fileId 'note:<id>') from its first page, without highlights.
  const preview = ({ fileId, fileName, focusTitle = false }) => open({ fileId, fileName, page: 1, preview: true, focusTitle });
  // open(cite) shows one page; open([cites], focusIndex) shows several cited pages together.
  function open(cites, focus = 0) {
    flushNote(); // save a note being typed in the panel before showing something else
    flushNote = () => {};
    const items = (Array.isArray(cites) ? cites : [cites]).map(asItem);
    current = { items, focus: Math.max(0, Math.min(focus, items.length - 1)), page: items[0].page };
    const note = items.length === 1 && isNote(items[0].fileId);
    openBtn.title = note ? 'Open full page' : 'Open in a new tab';
    openBtn.setAttribute('aria-label', openBtn.title);
    panel.hidden = false;
    main.classList.add('with-viewer');
    render();
    requestAnimationFrame(unscrollPage);
  }
  function close() {
    flushNote();
    flushNote = () => {};
    panel.hidden = true;
    main.classList.remove('with-viewer');
    current = null;
    renderToken++;
  }

  prevBtn.addEventListener('click', () => { if (current && current.page > 1) { current.page--; render(); } });
  nextBtn.addEventListener('click', () => { if (current && current.page < current.total) { current.page++; render(); } });
  $('viewer-close').addEventListener('click', close);
  openBtn.addEventListener('click', async () => {
    if (!current) return;
    if (current.items.length === 1 && isNote(current.items[0].fileId)) { await flushNote(); location.hash = '#note/' + current.items[0].fileId.slice(5); return; }
    const win = window.open('', '_blank');
    try {
      const item = current.items.length > 1 ? current.items[current.focus] : current.items[0];
      const pageNo = current.items.length > 1 ? item.page : current.page;
      const { file } = await loadFile(item.fileId);
      const { data } = await db().storage.from('files').createSignedUrl(file.storage_path, 300);
      const url = data.signedUrl + (/\.pdf$/i.test(file.name) ? `#page=${pageNo}` : '');
      if (win) win.location = url; else location.assign(url);
    } catch { win?.close(); toast('Couldn’t open that file.'); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) close(); });
  // Going to another page closes the viewer; a resize re-fits the page.
  window.addEventListener('hashchange', close);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (current && !(current.items.length === 1 && isNote(current.items[0].fileId))) render(); }, 200); });
  // Files can change while the viewer is open.
  document.addEventListener('eigen:files-changed', () => fileCache.clear());

  window.eigenViewer = { open, preview, close, isOpen: id => !!current && current.items.some(c => c.fileId === id), _findQuote: findQuote, _bestPassage: bestPassage, _fuzzyQuote: fuzzyQuote };
})();

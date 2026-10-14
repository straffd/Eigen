// Reads the text out of uploaded files so the course AI can use them.
// Runs in the browser right after upload (and for older files the first time they're needed),
// then saves the text to public.file_texts as an array of pages / slides / sections.
(() => {
  const CDN = 'https://cdn.jsdelivr.net/npm';
  const PDFJS = `${CDN}/pdfjs-dist@4.10.38/build`;
  const SECTION_CHARS = 4000;

  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|scala|r|m|sql|sh|yaml|yml|toml|ini|tex|bib|log)$/i;
  const VIDEO = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

  function kindOf(name, mime = '') {
    if (VIDEO.test(name) || mime.startsWith('video/')) return 'video';
    if (/\.pdf$/i.test(name) || mime === 'application/pdf') return 'pdf';
    if (/\.docx$/i.test(name)) return 'docx';
    if (/\.pptx$/i.test(name)) return 'pptx';
    if (/\.xlsx$/i.test(name)) return 'xlsx';
    if (/\.ipynb$/i.test(name)) return 'ipynb';
    if (TEXT_EXT.test(name) || mime.startsWith('text/')) return 'text';
    return 'other';
  }
  const canRead = (name, mime) => !['video', 'other'].includes(kindOf(name, mime));

  // ---------- Library loading ----------
  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { scripts.delete(src); reject(new Error('Could not load ' + src)); };
        document.head.append(s);
      }));
    }
    return scripts.get(src);
  }

  let pdfjsPromise;
  function loadPdfjs() {
    pdfjsPromise ??= import(`${PDFJS}/pdf.min.mjs`).then(lib => {
      // Browsers won't start a worker straight from another site, so start it from a tiny local module.
      try {
        const boot = URL.createObjectURL(new Blob([`import "${PDFJS}/pdf.worker.min.mjs";`], { type: 'text/javascript' }));
        lib.GlobalWorkerOptions.workerPort = new Worker(boot, { type: 'module' });
      } catch {
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
      }
      return lib;
    }).catch(err => { pdfjsPromise = null; throw err; });
    return pdfjsPromise;
  }
  const loadJSZip = () => loadScript(`${CDN}/jszip@3.10.1/dist/jszip.min.js`).then(() => window.JSZip);
  const loadMammoth = () => loadScript(`${CDN}/mammoth@1.13.0/mammoth.browser.min.js`).then(() => window.mammoth);

  // ---------- Extractors (each returns an array of page strings) ----------
  const clean = s => s.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  function sections(text) {
    const out = [];
    let cur = '';
    for (const para of text.split(/\n{2,}/)) {
      if (cur && cur.length + para.length > SECTION_CHARS) { out.push(cur); cur = ''; }
      if (para.length > SECTION_CHARS) {
        for (let i = 0; i < para.length; i += SECTION_CHARS) out.push(para.slice(i, i + SECTION_CHARS));
      } else {
        cur += (cur ? '\n\n' : '') + para;
      }
    }
    if (cur) out.push(cur);
    return out.map(clean);
  }

  async function readPdf(buf) {
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) text += (item.str ?? '') + (item.hasEOL ? '\n' : ' ');
      pages.push(clean(text));
      page.cleanup();
    }
    await doc.destroy();
    return pages;
  }

  const xmlText = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(m => m[1].replace(/<[^>]+>/g, ''))
    .map(s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  const byNumber = (re) => (a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]);

  async function readPptx(buf) {
    const zip = await (await loadJSZip()).loadAsync(buf);
    const re = /slides\/slide(\d+)\.xml$/;
    const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(re));
    const pages = [];
    for (const name of slides) {
      const n = name.match(re)[1];
      const xml = await zip.file(name).async('string');
      const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(p => xmlText(p[1], 'a:t').join('')).filter(Boolean);
      let text = paras.join('\n');
      // Notes files aren't numbered like slides; follow the slide's relationship to find its notes.
      const rels = zip.file(`ppt/slides/_rels/slide${n}.xml.rels`);
      const target = rels && (await rels.async('string')).match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/);
      const notes = target && zip.file(`ppt/notesSlides/${target[1]}`);
      if (notes) {
        const nx = await notes.async('string');
        const nt = [...nx.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(p => xmlText(p[1], 'a:t').join('')).filter(Boolean)
          .filter(t => !/^\d+$/.test(t)).join('\n');
        if (nt) text += `\n\nSpeaker notes:\n${nt}`;
      }
      pages.push(clean(text));
    }
    return pages;
  }

  async function readXlsx(buf) {
    const zip = await (await loadJSZip()).loadAsync(buf);
    const shared = zip.file('xl/sharedStrings.xml')
      ? [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1], 't').join(''))
      : [];
    const re = /sheet(\d+)\.xml$/;
    const sheets = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber(re));
    const pages = [];
    for (const name of sheets) {
      const xml = await zip.file(name).async('string');
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(r =>
        [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, inner]) => {
          if (/t="s"/.test(attrs)) return shared[Number(xmlText(inner, 'v')[0])] ?? '';
          if (/t="inlineStr"/.test(attrs)) return xmlText(inner, 't').join('');
          return xmlText(inner, 'v')[0] ?? '';
        }).join('\t'));
      pages.push(...sections(rows.join('\n')).map((s, i) => (i ? s : `Sheet ${name.match(re)[1]}\n${s}`)));
    }
    return pages;
  }

  async function readDocx(buf) {
    const { value } = await (await loadMammoth()).extractRawText({ arrayBuffer: buf });
    return sections(value);
  }

  function readIpynb(text) {
    const nb = JSON.parse(text);
    const cells = (nb.cells || []).map(c => {
      const src = Array.isArray(c.source) ? c.source.join('') : c.source || '';
      return c.cell_type === 'code' ? '```\n' + src + '\n```' : src;
    });
    return sections(cells.join('\n\n'));
  }

  // Returns { pages, status } where status is 'ready' | 'empty' | 'unsupported' | 'failed'.
  async function extract(blob, name, mime) {
    const kind = kindOf(name, mime);
    if (kind === 'video' || kind === 'other') return { pages: [], status: 'unsupported' };
    try {
      let pages;
      if (kind === 'pdf') pages = await readPdf(await blob.arrayBuffer());
      else if (kind === 'pptx') pages = await readPptx(await blob.arrayBuffer());
      else if (kind === 'xlsx') pages = await readXlsx(await blob.arrayBuffer());
      else if (kind === 'docx') pages = await readDocx(await blob.arrayBuffer());
      else if (kind === 'ipynb') pages = readIpynb(await blob.text());
      else pages = sections(await blob.text());
      const chars = pages.reduce((s, p) => s + p.length, 0);
      return { pages, status: chars > 0 ? 'ready' : 'empty' };
    } catch (err) {
      console.error('Could not read', name, err);
      return { pages: [], status: 'failed' };
    }
  }

  // ---------- Reading + saving, one file at a time ----------
  const db = () => window.eigen?.supabase;
  const inProgress = new Map(); // fileId -> promise
  let queue = Promise.resolve();

  // file: { id, name, mime_type, storage_path }. blob is optional (downloaded if missing).
  function readFile(file, blob) {
    if (inProgress.has(file.id)) return inProgress.get(file.id);
    const job = queue.then(async () => {
      document.dispatchEvent(new CustomEvent('eigen:file-reading', { detail: { id: file.id } }));
      let result;
      if (!canRead(file.name, file.mime_type)) {
        result = { pages: [], status: 'unsupported' };
      } else {
        try {
          if (!blob) {
            const { data, error } = await db().storage.from('files').download(file.storage_path);
            if (error) throw error;
            blob = data;
          }
          result = await extract(blob, file.name, file.mime_type || blob.type);
        } catch (err) {
          console.error(err);
          result = { pages: [], status: 'failed' };
        }
      }
      const charCount = result.pages.reduce((s, p) => s + p.length, 0);
      const { error } = await db().from('file_texts').upsert({ file_id: file.id, pages: result.pages, char_count: charCount, status: result.status });
      if (error) { console.error(error); result.status = 'failed'; }
      document.dispatchEvent(new CustomEvent('eigen:file-read', { detail: { id: file.id, status: result.status, chars: charCount } }));
      return result.status;
    }).finally(() => inProgress.delete(file.id));
    inProgress.set(file.id, job);
    queue = job.catch(() => {});
    return job;
  }

  window.eigenReader = { readFile, canRead, kindOf, extract, isReading: id => inProgress.has(id) };
})();

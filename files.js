// Folder page: files stored in Supabase Storage (bucket "files", path <user_id>/<file_id>).
// Each file has a row in public.files, created before upload so the database can enforce the quota.
// After upload the file's text is read (extract.js) so the course AI can use it straight away.
(() => {
  const MAX_FILE = 50 * 1024 * 1024;   // 50 MB per file
  const QUOTA = 250 * 1024 * 1024;     // 250 MB per user (free plan; also enforced by the database)
  const BUCKET = 'files';

  const $ = id => document.getElementById(id);
  const view = document.querySelector('.folder-view');
  const titleEl = $('folder-title');
  const crumbEl = $('folder-crumb');
  const content = $('folder-content');
  const uploadBtn = $('upload-btn');
  const fileInput = $('file-input');
  const usageEl = $('usage');
  const overlay = $('drop-overlay');
  const askBtn = $('ask-folder');
  const { el, icon, toast, confirmDelete, openMenu, inlineInput } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null; // may already be signed in by the time this loads
  let folderId = null;
  let files = [];        // uploaded files in the open folder
  let uploads = [];      // [{ id, name, size }] in progress
  let usage = 0;         // bytes used across all folders
  let status = 'idle';   // 'idle' | 'loading' | 'ready' | 'error'
  let loadToken = 0;

  const db = () => window.eigen?.supabase;
  const bucket = () => db().storage.from(BUCKET);

  // ---------- Formatting ----------
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  function formatDate(t) {
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function extension(name) {
    const m = /\.([a-z0-9]{1,5})$/i.exec(name);
    return m ? m[1].toUpperCase() : 'FILE';
  }
  function describeError(err) {
    const msg = err?.message || '';
    if (/storage_quota/.test(msg)) return `You’ve used your ${formatSize(QUOTA)} of storage. Delete some files to make room.`;
    if (/failed to fetch|network/i.test(msg)) return 'Couldn’t reach Eigen’s servers. Check your connection.';
    if (/exceeded the maximum allowed size|payload too large|413/i.test(msg)) return `Files can be up to ${formatSize(MAX_FILE)}.`;
    if (err?.code === 'PGRST205' || err?.code === '42P01' || /bucket not found/i.test(msg)) return 'File storage isn’t set up in the database yet.';
    return 'Something went wrong with your files.';
  }

  // ---------- Data ----------
  async function load() {
    window.eigenReader.warmUp();
    const token = ++loadToken;
    status = 'loading';
    files = [];
    render();
    try {
      const select = cols => db().from('files').select(cols).eq('folder_id', folderId).eq('uploaded', true);
      let [list, all] = await Promise.all([
        select('id, name, size, mime_type, storage_path, created_at, file_texts(status)'),
        db().from('files').select('size'),
      ]);
      if (list.error) list = await select('id, name, size, mime_type, storage_path, created_at'); // AI tables not set up yet
      if (list.error) throw list.error;
      if (all.error) throw all.error;
      if (token !== loadToken) return;
      files = list.data
        .map(f => {
          const t = Array.isArray(f.file_texts) ? f.file_texts[0] : f.file_texts;
          return { ...f, createdAt: Date.parse(f.created_at), aiStatus: 'file_texts' in f ? (t?.status ?? null) : 'n/a' };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      usage = all.data.reduce((sum, r) => sum + Number(r.size), 0);
      status = 'ready';
      cleanUpStalled();
      // Read any files uploaded before the AI could read them.
      for (const f of files) if (f.aiStatus === null) window.eigenReader.readFile(f);
    } catch (err) {
      if (token !== loadToken) return;
      console.error(err);
      status = 'error';
      toast(describeError(err));
    }
    render();
  }

  // Rows left behind by uploads that never finished (tab closed mid-upload) still count toward the
  // quota, so clear any older than an hour.
  async function cleanUpStalled() {
    const cutoff = new Date(Date.now() - 3600000).toISOString();
    const { data } = await db().from('files').select('id, storage_path').eq('uploaded', false).lt('created_at', cutoff);
    if (!data?.length) return;
    await bucket().remove(data.map(r => r.storage_path));
    await db().from('files').delete().in('id', data.map(r => r.id));
  }

  async function uploadFiles(list) {
    if (!user || !folderId || status !== 'ready') return;
    const targetFolder = folderId;
    for (const file of list) {
      if (file.size > MAX_FILE) { toast(`${file.name} is over ${formatSize(MAX_FILE)}.`); continue; }
      if (usage + file.size > QUOTA) { toast(describeError({ message: 'storage_quota' })); break; }

      const id = crypto.randomUUID();
      const path = `${user.id}/${id}`;
      const pending = { id, name: file.name, size: file.size };
      uploads.push(pending);
      usage += file.size;
      render();
      let rowCreated = false;
      try {
        const insert = await db().from('files').insert({
          id, folder_id: targetFolder, name: file.name.slice(0, 200), size: file.size,
          mime_type: file.type || null, storage_path: path,
        });
        if (insert.error) throw insert.error;
        rowCreated = true;
        // Start reading now, from the copy already in the browser, while the upload runs.
        const row = { id, name: file.name, size: file.size, mime_type: file.type, storage_path: path, createdAt: Date.now(), aiStatus: null };
        window.eigenReader.readFile(row, file).catch(() => {});
        const up = await bucket().upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (up.error) throw up.error;
        const mark = await db().from('files').update({ uploaded: true }).eq('id', id);
        if (mark.error) throw mark.error;
        row.aiStatus = window.eigenReader.statusOf(id); // it may already have been read during the upload
        if (folderId === targetFolder) files.unshift(row);
        announce();
      } catch (err) {
        console.error(err);
        usage -= file.size;
        if (rowCreated) {
          await bucket().remove([path]);
          await db().from('files').delete().eq('id', id);
        }
        toast(`${file.name}: ${describeError(err)}`);
      } finally {
        uploads = uploads.filter(u => u !== pending);
        render();
      }
    }
  }

  const findFile = id => files.find(f => f.id === id);
  const announce = () => document.dispatchEvent(new CustomEvent('eigen:files-changed'));

  async function openFile(id) {
    const f = findFile(id);
    if (!f) return;
    const win = window.open('', '_blank'); // open now so pop-up blockers allow it
    const { data, error } = await bucket().createSignedUrl(f.storage_path, 300);
    if (error || !data?.signedUrl) { win?.close(); return toast(describeError(error)); }
    if (win) win.location = data.signedUrl; else location.assign(data.signedUrl);
  }

  async function downloadFile(id) {
    const f = findFile(id);
    if (!f) return;
    const { data, error } = await bucket().createSignedUrl(f.storage_path, 60, { download: f.name });
    if (error || !data?.signedUrl) return toast(describeError(error));
    const a = el(`<a hidden></a>`);
    a.href = data.signedUrl;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function renameFile(id) {
    const f = findFile(id);
    const nameEl = content.querySelector(`[data-file-id="${id}"] .file-name`);
    if (!f || !nameEl) return;
    const name = await inlineInput(nameEl, { value: f.name, maxLength: 200 });
    if (!name || name === f.name) return render();
    const old = f.name;
    f.name = name;
    render();
    const { error } = await db().from('files').update({ name }).eq('id', id);
    if (error) { f.name = old; render(); toast(describeError(error)); }
  }

  async function deleteFile(id) {
    const f = findFile(id);
    if (!f) return;
    const ok = await confirmDelete(`Delete ${f.name}?`, 'This can’t be undone.');
    if (!ok) return;
    const removed = await bucket().remove([f.storage_path]);
    if (removed.error) return toast(describeError(removed.error));
    const { error } = await db().from('files').delete().eq('id', id);
    if (error) return toast(describeError(error));
    files = files.filter(x => x.id !== id);
    usage -= Number(f.size);
    render();
    announce();
  }

  // ---------- Render ----------
  function render() {
    const found = folderId && window.eigenClasses.findFolder(folderId);
    const classesReady = window.eigenClasses.status() === 'ready';

    if (!found) {
      crumbEl.textContent = '';
      titleEl.textContent = classesReady ? 'Folder not found' : '';
      uploadBtn.hidden = true;
      usageEl.hidden = true;
      askBtn.hidden = true;
      content.replaceChildren(classesReady
        ? el(`<div class="files-empty"><p class="files-empty-title">This folder doesn’t exist anymore.</p><a class="link" href="#">Go home</a></div>`)
        : el(`<p class="files-status">Loading…</p>`));
      return;
    }

    const { c, f } = found;
    crumbEl.textContent = c.name + (c.archivedAt || f.archivedAt ? ' · Archived' : '');
    titleEl.textContent = f.name;
    document.title = `${f.name} · Eigen`;

    if (!user || !db()) {
      uploadBtn.hidden = true;
      usageEl.hidden = true;
      askBtn.hidden = true;
      content.replaceChildren(el(`
        <div class="files-empty">
          ${icon('lock')}
          <p class="files-empty-title">Sign in to add files</p>
          <p class="files-empty-text">Files are saved to your account so you can open them on any device.</p>
          <button class="btn-primary" type="button" data-action="signin">Sign in</button>
        </div>`));
      return;
    }

    uploadBtn.hidden = status !== 'ready';
    usageEl.hidden = status !== 'ready';
    askBtn.hidden = c.archivedAt != null;
    askBtn.href = `#course/${c.id}/f/${f.id}`;
    const pct = Math.min(100, (usage / QUOTA) * 100);
    $('usage-fill').style.width = pct + '%';
    $('usage-fill').classList.toggle('warn', pct >= 90);
    $('usage-text').textContent = `${formatSize(usage)} of ${formatSize(QUOTA)} used`;

    if (status === 'loading') return content.replaceChildren(el(`<p class="files-status">Loading files…</p>`));
    if (status === 'error') return content.replaceChildren(el(`<p class="files-status">Couldn’t load files.</p>`));

    if (!files.length && !uploads.length) {
      content.replaceChildren(el(`
        <button class="drop-zone" type="button" data-action="pick">
          ${icon('upload')}
          <span class="files-empty-title">Drop files here</span>
          <span class="files-empty-text">or click to choose. PDFs, slides, notes, up to ${formatSize(MAX_FILE)} each.</span>
        </button>`));
      return;
    }

    const ul = el(`<ul class="file-list"></ul>`);
    for (const u of uploads) {
      const li = el(`
        <li class="file-item uploading">
          <span class="file-badge"></span>
          <div class="file-text"><span class="file-name"></span><span class="file-meta"></span></div>
          <span class="spinner" aria-label="Uploading"></span>
        </li>`);
      li.querySelector('.file-badge').textContent = extension(u.name);
      li.querySelector('.file-name').textContent = u.name;
      li.querySelector('.file-meta').textContent = `${formatSize(u.size)} · Uploading…`;
      ul.append(li);
    }
    for (const f of files) {
      const li = el(`
        <li class="file-item" data-file-id="${f.id}">
          <button class="file-open" type="button" data-action="open">
            <span class="file-badge"></span>
            <span class="file-text"><span class="file-name"></span><span class="file-meta"></span></span>
          </button>
          <div class="file-actions">
            <button class="icon-btn" type="button" data-action="download" aria-label="Download">${icon('download')}</button>
            <button class="icon-btn danger" type="button" data-action="delete" aria-label="Delete">${icon('trash')}</button>
          </div>
        </li>`);
      const ext = extension(f.name);
      const badge = li.querySelector('.file-badge');
      badge.textContent = ext;
      badge.dataset.ext = ext;
      li.querySelector('.file-name').textContent = f.name;
      li.querySelector('.file-meta').textContent = `${formatSize(Number(f.size))} · Added ${formatDate(f.createdAt)}`;
      const chip = aiChip(f);
      if (chip) li.querySelector('.file-text').append(chip);
      ul.append(li);
    }
    content.replaceChildren(ul);
  }

  // Small label showing whether the course AI has read the file.
  function aiChip(f) {
    if (f.aiStatus === 'n/a') return null;
    const kind = window.eigenReader.kindOf(f.name, f.mime_type || '');
    const readable = window.eigenReader.canRead(f.name, f.mime_type || '');
    const reading = readable && (f.aiStatus === null || window.eigenReader.isReading(f.id));
    const pct = window.eigenReader.progress(f.id);
    const [cls, text, title] = reading ? ['reading', pct ? `Reading… ${Math.round(pct * 100)}%` : 'Reading…', 'The AI is reading this file']
      : f.aiStatus === 'ready' ? ['ready', 'AI ready', 'The course AI can answer questions from this file']
      : f.aiStatus === 'empty' ? ['muted', 'No text found', 'No selectable text (scanned PDFs and images aren’t read yet)']
      : f.aiStatus === 'failed' ? ['muted', 'Couldn’t read', 'Something went wrong reading this file']
      : kind === 'video' ? ['muted', 'Video · skipped', 'The AI can’t watch videos. Upload a transcript to include it']
      : ['muted', 'AI can’t read this type', 'Supported: PDF, Word, PowerPoint, Excel, text and code files'];
    const chip = el(`<span class="ai-chip ${cls}"></span>`);
    chip.textContent = text;
    chip.title = title;
    return chip;
  }

  document.addEventListener('eigen:file-read', e => {
    const f = findFile(e.detail.id);
    if (!f) return;
    f.aiStatus = e.detail.status;
    render();
  });
  document.addEventListener('eigen:file-reading', e => { if (findFile(e.detail.id)) render(); });
  // Update just the label while a file is being read (no full re-render on every page).
  document.addEventListener('eigen:file-progress', e => {
    const chip = content.querySelector(`[data-file-id="${e.detail.id}"] .ai-chip.reading`);
    if (chip) chip.textContent = `Reading… ${Math.round(e.detail.progress * 100)}%`;
  });

  // ---------- Events ----------
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });

  content.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'pick') return fileInput.click();
    if (action === 'signin') return $('signin-open').click();
    const id = e.target.closest('[data-file-id]')?.dataset.fileId;
    if (action === 'open') openFile(id);
    if (action === 'download') downloadFile(id);
    if (action === 'delete') deleteFile(id);
  });

  content.addEventListener('contextmenu', e => {
    const li = e.target.closest('[data-file-id]');
    if (!li || e.target.closest('.inline-input')) return;
    e.preventDefault();
    const id = li.dataset.fileId;
    openMenu(e.clientX || li.getBoundingClientRect().left, e.clientY || li.getBoundingClientRect().bottom, [
      { label: 'Open', icon: 'external', run: () => openFile(id) },
      { label: 'Download', icon: 'download', run: () => downloadFile(id) },
      { label: 'Rename', icon: 'pencil', run: () => renameFile(id) },
      ...(['failed', 'empty'].includes(findFile(id)?.aiStatus) && window.eigenReader.canRead(findFile(id).name, findFile(id).mime_type || '')
        ? [{ label: 'Read again', icon: 'restore', run: () => { const f = findFile(id); f.aiStatus = null; render(); window.eigenReader.readFile(f); } }]
        : []),
      '-',
      { label: 'Delete file', icon: 'trash', danger: true, run: () => deleteFile(id) },
    ]);
  });

  // Drag and drop anywhere on the folder page.
  let dragDepth = 0;
  const canDrop = e => !view.hidden && user && status === 'ready' && [...(e.dataTransfer?.types || [])].includes('Files');
  view.addEventListener('dragenter', e => { if (!canDrop(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
  view.addEventListener('dragover', e => { if (canDrop(e)) e.preventDefault(); });
  view.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  view.addEventListener('drop', e => {
    dragDepth = 0;
    overlay.hidden = true;
    if (!canDrop(e)) return;
    e.preventDefault();
    uploadFiles([...e.dataTransfer.files]);
  });

  // ---------- Routing ----------
  function sync() {
    const next = location.hash.startsWith('#folder/') ? location.hash.slice(8) : null;
    if (!next) { folderId = null; document.title = 'Eigen'; return; }
    const changed = next !== folderId;
    folderId = next;
    const canLoad = user && db() && window.eigenClasses.findFolder(folderId);
    if (canLoad && (changed || status === 'idle')) load();
    else if (!canLoad) { status = 'idle'; render(); }
    else render();
  }

  window.addEventListener('hashchange', sync);
  document.addEventListener('eigen:classes', sync);
  document.addEventListener('eigen:user', e => {
    const next = e.detail || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    status = 'idle';
    files = [];
    usage = 0;
    sync();
  });
  sync();
})();

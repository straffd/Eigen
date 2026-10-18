// Folder page: files stored in Supabase Storage (bucket "files", path <user_id>/<file_id>).
// Each file has a row in public.files, created before upload so the database can enforce the quota.
// After upload the file's text is read (extract.js) so the course AI can use it straight away.
// Files can also be kept on a course itself, outside any folder: those are listed under the course
// in the sidebar and open when clicked.
// The folder page is split in two: Context (course material: slides, readings) and Notes & docs
// (the student's own documents, plus notes written in Eigen, see notes.js).
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
  const askBtn = $('ask-folder');
  const { el, icon, toast, confirmDelete, openMenu, inlineInput } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null; // may already be signed in by the time this loads
  let folderId = null;
  let files = [];        // uploaded files in the open folder ({ ..., kind: 'context' | 'notes' })
  let notes = [];        // notes written in Eigen, in the open folder
  let courseFiles = [];  // files kept on a course, outside any folder: [{ ...row, class_id }]
  let uploads = [];      // [{ id, name, size, folderId, classId }] in progress
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
      let [list, all, written] = await Promise.all([
        select('id, name, size, mime_type, storage_path, kind, created_at, file_texts(status)'),
        db().from('files').select('size'),
        window.eigenNotes.list({ folderId }),
      ]);
      if (list.error) list = await select('id, name, size, mime_type, storage_path, created_at'); // AI tables not set up yet
      if (list.error) throw list.error;
      if (all.error) throw all.error;
      if (token !== loadToken) return;
      notes = written;
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

  // Documents you write and edit yourself (Word, text, Markdown…) go on the Notes & docs side; course
  // material (PDFs, slides, spreadsheets, everything else) goes on the Context side.
  const EDITABLE = /\.(docx?|docm|dotx?|odt|ott|rtf|txt|md|markdown|tex|pages)$/i;
  const EDITABLE_TYPES = /^(text\/(plain|markdown|rtf)|application\/(msword|rtf|vnd\.openxmlformats-officedocument\.wordprocessingml\..*|vnd\.oasis\.opendocument\.text.*))$/;
  const kindFor = file => (EDITABLE.test(file.name) || EDITABLE_TYPES.test(file.type || '') ? 'notes' : 'context');

  // Uploads into the open folder, or (dropped in the sidebar) into any folder or straight onto a course.
  // kind 'auto' picks the side from each file's type; a side's own Upload button passes that side.
  async function uploadFiles(list, { folderId: targetFolder = folderId, classId: targetClass = null, kind: side = 'auto' } = {}) {
    if (targetClass) targetFolder = null;
    if (!user || (!targetFolder && !targetClass)) return;
    if (targetFolder && targetFolder === folderId ? status !== 'ready' : !await refreshUsage()) return;
    let done = 0, toNotes = 0;
    for (const file of list) {
      if (file.size > MAX_FILE) { toast(`${file.name} is over ${formatSize(MAX_FILE)}.`); continue; }
      if (usage + file.size > QUOTA) { toast(describeError({ message: 'storage_quota' })); break; }

      const kind = side === 'auto' ? kindFor(file) : side;
      const id = crypto.randomUUID();
      const path = `${user.id}/${id}`;
      const pending = { id, name: file.name, size: file.size, folderId: targetFolder, classId: targetClass, kind };
      uploads.push(pending);
      usage += file.size;
      render();
      if (targetClass) announceCourse();
      let rowCreated = false;
      try {
        const insert = await db().from('files').insert({
          id, folder_id: targetFolder, class_id: targetClass, kind, name: file.name.slice(0, 200), size: file.size,
          mime_type: file.type || null, storage_path: path,
        });
        if (insert.error) throw insert.error;
        rowCreated = true;
        // Start reading now, from the copy already in the browser, while the upload runs.
        const row = { id, name: file.name, size: file.size, mime_type: file.type, storage_path: path, kind, createdAt: Date.now(), aiStatus: null };
        window.eigenReader.readFile(row, file).catch(() => {});
        const up = await bucket().upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (up.error) throw up.error;
        const mark = await db().from('files').update({ uploaded: true }).eq('id', id);
        if (mark.error) throw mark.error;
        row.aiStatus = window.eigenReader.statusOf(id); // it may already have been read during the upload
        if (targetClass) courseFiles.unshift({ ...row, class_id: targetClass });
        else if (folderId === targetFolder) files.unshift(row);
        done++;
        if (kind === 'notes' && !targetClass) toNotes++;
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
        if (targetClass) announceCourse();
      }
    }
    // Dropped in the sidebar: say where the files went.
    const n = `${done} file${done === 1 ? '' : 's'}`;
    if (done && targetClass) toast(`Added ${n} to ${window.eigenClasses.findClass(targetClass)?.name ?? 'the course'}.`);
    else if (done && targetFolder !== folderId) {
      const where = window.eigenClasses.findFolder(targetFolder);
      const sides = toNotes === done ? ' (Notes & docs)' : toNotes ? ` (${toNotes} in Notes & docs)` : '';
      toast(`Uploaded ${n} to ${where?.f.name ?? 'the folder'}${sides}.`,
        { label: 'Open', run: () => { location.hash = '#folder/' + targetFolder; } });
    }
  }

  // ---------- Files kept on a course ----------
  async function loadCourseFiles() {
    const { data, error } = await db().from('files')
      .select('id, name, size, mime_type, storage_path, class_id, created_at, file_texts(status)')
      .is('folder_id', null).eq('uploaded', true);
    courseFiles = error ? [] : data // error: course files not set up in the database yet
      .map(f => {
        const t = Array.isArray(f.file_texts) ? f.file_texts[0] : f.file_texts;
        return { ...f, createdAt: Date.parse(f.created_at), aiStatus: t?.status ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    announceCourse();
  }
  const announceCourse = () => document.dispatchEvent(new CustomEvent('eigen:course-files'));

  // Sidebar rows for a course's own files (and any still uploading to it).
  function courseRows(classId) {
    const row = (f, uploading) => {
      const li = el(`
        <li class="course-file" ${uploading ? '' : `data-file-id="${f.id}"`}>
          <button class="row file-row ${uploading ? 'uploading' : ''}" type="button" ${uploading ? '' : 'draggable="true"'} title="${uploading ? 'Uploading…' : 'Open'}">${icon('file')}<span class="file-name"></span><span class="folder-size"></span></button>
        </li>`);
      li.querySelector('.file-name').textContent = f.name;
      li.querySelector('.folder-size').textContent = uploading ? 'Uploading…' : formatSize(Number(f.size));
      return li;
    };
    return [
      ...courseFiles.filter(f => f.class_id === classId).map(f => row(f, false)),
      ...uploads.filter(u => u.classId === classId).map(u => row(u, true)),
    ];
  }

  async function refreshUsage() {
    const { data, error } = await db().from('files').select('size');
    if (error) { toast(describeError(error)); return false; }
    usage = data.reduce((sum, r) => sum + Number(r.size), 0);
    return true;
  }

  const findFile = id => files.find(f => f.id === id) ?? courseFiles.find(f => f.id === id);
  const announce = () => document.dispatchEvent(new CustomEvent('eigen:files-changed'));

  async function openFile(id) { return openRow(findFile(id)); }
  // Clicking a file shows it in the side panel (like a reference), rather than a new tab.
  function previewFile(id) {
    const f = findFile(id);
    if (f) window.eigenViewer.preview({ fileId: f.id, fileName: f.name });
  }
  // Opens any file row (also used by the course library) in a new tab.
  async function openRow(f) {
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
    const onCourse = courseFiles.includes(f);
    const nameEl = onCourse
      ? document.querySelector(`.sidebar .course-file[data-file-id="${id}"] .file-name`)
      : content.querySelector(`[data-file-id="${id}"] .file-name`);
    if (!f || !nameEl) return;
    const done = () => (onCourse ? announceCourse() : render());
    const name = await inlineInput(nameEl, { value: f.name, maxLength: 200 });
    if (!name || name === f.name) return done();
    const old = f.name;
    f.name = name;
    done();
    const { error } = await db().from('files').update({ name }).eq('id', id);
    if (error) { f.name = old; done(); toast(describeError(error)); }
  }

  // Moves a file between the Context and Notes & docs sides.
  async function setKind(id, kind) {
    const f = findFile(id);
    if (!f || (f.kind ?? 'context') === kind) return;
    const old = f.kind;
    f.kind = kind;
    render();
    const { error } = await db().from('files').update({ kind }).eq('id', id);
    if (error) { f.kind = old; render(); toast(describeError(error)); }
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
    if (courseFiles.includes(f)) { courseFiles = courseFiles.filter(x => x !== f); announceCourse(); }
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

    uploadBtn.hidden = true; // each side of the page has its own Upload button
    usageEl.hidden = status !== 'ready';
    askBtn.hidden = c.archivedAt != null;
    askBtn.href = `#course/${c.id}/f/${f.id}`;
    const pct = Math.min(100, (usage / QUOTA) * 100);
    $('usage-fill').style.width = pct + '%';
    $('usage-fill').classList.toggle('warn', pct >= 90);
    $('usage-text').textContent = `${formatSize(usage)} of ${formatSize(QUOTA)} used`;

    if (status === 'loading') return content.replaceChildren(el(`<p class="files-status">Loading files…</p>`));
    if (status === 'error') return content.replaceChildren(el(`<p class="files-status">Couldn’t load files.</p>`));

    const pane = (kind, title, text, extra) => {
      const sec = el(`
        <section class="folder-pane" data-kind="${kind}">
          <header class="pane-head">
            <div><h2 class="pane-title"></h2><p class="pane-text"></p></div>
            <div class="pane-actions">${extra}<button class="btn-secondary btn-sm" type="button" data-action="pick" data-kind="${kind}">${icon('upload')}Upload</button></div>
          </header>
        </section>`);
      sec.querySelector('.pane-title').textContent = title;
      sec.querySelector('.pane-text').textContent = text;
      const here = uploads.filter(u => u.folderId === folderId && u.kind === kind);
      const mine = files.filter(f => (f.kind ?? 'context') === kind);
      const written = kind === 'notes' ? notes : [];
      if (!here.length && !mine.length && !written.length) {
        sec.append(el(`
          <button class="drop-zone" type="button" data-action="pick" data-kind="${kind}">
            ${icon(kind === 'notes' ? 'pencil' : 'upload')}
            <span class="files-empty-title">${kind === 'notes' ? 'Your notes go here' : 'Drop course material here'}</span>
            <span class="files-empty-text">${kind === 'notes'
              ? 'Write a note, or drop your own documents. The AI reads these too.'
              : `Lecture slides, readings, past papers. Up to ${formatSize(MAX_FILE)} each.`}</span>
          </button>`));
        return sec;
      }
      const ul = el(`<ul class="file-list"></ul>`);
      for (const n of written) {
        const li = el(`
          <li class="file-item note-item" data-note-id="${n.id}" draggable="true">
            <a class="file-open" href="#note/${n.id}">
              <span class="file-badge note-badge">${icon('pencil')}</span>
              <span class="file-text"><span class="file-name"></span><span class="file-meta"></span></span>
            </a>
          </li>`);
        li.querySelector('.file-name').textContent = n.title;
        const words = n.body.trim() ? n.body.trim().split(/\s+/).length : 0;
        li.querySelector('.file-meta').textContent = `Note · ${words} word${words === 1 ? '' : 's'} · Edited ${formatDate(Date.parse(n.updated_at))}`;
        ul.append(li);
      }
      for (const u of here) {
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
      for (const f of mine) {
        const li = el(`
          <li class="file-item" data-file-id="${f.id}" draggable="true">
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
      sec.append(ul);
      return sec;
    };
    const split = el(`<div class="folder-split"></div>`);
    split.append(
      pane('context', 'Context', 'Course material the AI answers from: slides, readings, past papers.', ''),
      pane('notes', 'Notes & docs', 'Your own notes and documents.', `<button class="btn-secondary btn-sm" type="button" data-action="new-note">${icon('pencil')}New note</button>`),
    );
    content.replaceChildren(split);
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
  let pickKind = 'context';
  uploadBtn.addEventListener('click', () => { pickKind = 'context'; fileInput.click(); });
  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files], { kind: pickKind });
    fileInput.value = '';
  });

  content.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'pick') { pickKind = e.target.closest('[data-kind]')?.dataset.kind ?? 'context'; return fileInput.click(); }
    if (action === 'new-note') {
      const found = window.eigenClasses.findFolder(folderId);
      return found && window.eigenNotes.create({ classId: found.c.id, folderId });
    }
    if (action === 'signin') return $('signin-open').click();
    const id = e.target.closest('[data-file-id]')?.dataset.fileId;
    if (action === 'open') previewFile(id);
    if (action === 'download') downloadFile(id);
    if (action === 'delete') deleteFile(id);
  });

  // A written note previews in the side panel too; its Edit button (or the menu) opens the editor.
  content.addEventListener('click', e => {
    const noteLi = e.target.closest('[data-note-id]');
    if (!noteLi) return;
    e.preventDefault();
    const n = notes.find(x => x.id === noteLi.dataset.noteId);
    if (n) window.eigenViewer.preview({ fileId: 'note:' + n.id, fileName: n.title });
  });

  content.addEventListener('contextmenu', e => {
    const noteLi = e.target.closest('[data-note-id]');
    if (noteLi) {
      e.preventDefault();
      const id = noteLi.dataset.noteId;
      const n = notes.find(x => x.id === id);
      return openMenu(e.clientX, e.clientY, [
        { label: 'Preview', icon: 'file', run: () => n && window.eigenViewer.preview({ fileId: 'note:' + id, fileName: n.title }) },
        { label: 'Edit', icon: 'pencil', run: () => { location.hash = '#note/' + id; } },
        '-',
        { label: 'Delete note', icon: 'trash', danger: true, run: () => window.eigenNotes.remove(id) },
      ]);
    }
    const li = e.target.closest('[data-file-id]');
    if (!li || e.target.closest('.inline-input')) return;
    e.preventDefault();
    const id = li.dataset.fileId;
    openMenu(e.clientX || li.getBoundingClientRect().left, e.clientY || li.getBoundingClientRect().bottom, [
      { label: 'Preview', icon: 'file', run: () => previewFile(id) },
      { label: 'Open in new tab', icon: 'external', run: () => openFile(id) },
      { label: 'Download', icon: 'download', run: () => downloadFile(id) },
      { label: 'Rename', icon: 'pencil', run: () => renameFile(id) },
      (findFile(id)?.kind ?? 'context') === 'context'
        ? { label: 'Move to Notes & docs', icon: 'pencil', run: () => setKind(id, 'notes') }
        : { label: 'Move to Context', icon: 'file', run: () => setKind(id, 'context') },
      ...(['failed', 'empty'].includes(findFile(id)?.aiStatus) && window.eigenReader.canRead(findFile(id).name, findFile(id).mime_type || '')
        ? [{ label: 'Read again', icon: 'restore', run: () => { const f = findFile(id); f.aiStatus = null; render(); window.eigenReader.readFile(f); } }]
        : []),
      '-',
      { label: 'Delete file', icon: 'trash', danger: true, run: () => deleteFile(id) },
    ]);
  });

  // Drag and drop: files from the desktop upload to the side they're dropped on (Context if dropped
  // elsewhere on the page). Files and notes dragged from anywhere (this page, the sidebar, the
  // library) move into this folder; a file dropped on the other side here switches sides.
  const { drag } = window.eigenUI;
  const types = e => [...(e.dataTransfer?.types || [])];
  const canDrop = e => !view.hidden && user && status === 'ready' && (types(e).includes('Files') || drag.has(e));
  const paneAt = e => e.target.closest?.('.folder-pane');
  const clearPanes = () => content.querySelectorAll('.folder-pane.drop-target').forEach(p => p.classList.remove('drop-target'));
  content.addEventListener('dragstart', e => {
    const li = e.target.closest('.file-item[data-file-id], .file-item[data-note-id]');
    if (!li) return;
    drag.start(e, li.dataset.fileId ? { type: 'file', id: li.dataset.fileId } : { type: 'note', id: li.dataset.noteId });
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  content.addEventListener('dragend', () => { clearPanes(); content.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging')); });
  view.addEventListener('dragover', e => {
    if (!canDrop(e)) return;
    e.preventDefault();
    // Files from the desktop are sorted by type, so the whole page lights up; dragged items go where dropped.
    const targets = drag.has(e) ? [paneAt(e) ?? content.querySelector('.folder-pane[data-kind="notes"]')] : [...content.querySelectorAll('.folder-pane')];
    clearPanes();
    targets.forEach(t => t?.classList.add('drop-target'));
  });
  view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget)) clearPanes(); });
  view.addEventListener('drop', e => {
    clearPanes();
    if (!canDrop(e)) return;
    e.preventDefault();
    const kind = paneAt(e)?.dataset.kind;
    const item = drag.read(e);
    if (!item) return uploadFiles([...e.dataTransfer.files], { kind: 'auto' }); // the file type picks the side
    const found = window.eigenClasses.findFolder(folderId);
    if (item.type === 'note') return found && window.eigenNotes.move(item.id, { classId: found.c.id, folderId });
    if (files.some(f => f.id === item.id)) return kind && setKind(item.id, kind);
    moveFile(item.id, { folderId }, kind);
  });

  // Moves a file into another folder (folderId) or onto a course (classId), optionally to a side.
  async function moveFile(id, { folderId: toFolder = null, classId: toClass = null }, kind = null) {
    const patch = { folder_id: toFolder, class_id: toFolder ? null : toClass, ...(kind ? { kind } : {}) };
    const { data, error } = await db().from('files').update(patch).eq('id', id).select('id, name').maybeSingle();
    if (error || !data) { console.error(error); return toast(describeError(error)); }
    const where = toFolder ? window.eigenClasses.findFolder(toFolder)?.f.name : window.eigenClasses.findClass(toClass)?.name;
    toast(`Moved “${data.name}” to ${where ?? 'the course'}.`);
    // Refresh whatever shows files: this folder page, the course files in the sidebar, sizes, the library.
    if (folderId && (files.some(f => f.id === id) || toFolder === folderId)) await reloadFolder();
    await loadCourseFiles();
    announce();
  }

  // Re-reads the open folder's files without showing "Loading…".
  async function reloadFolder() {
    const target = folderId;
    const { data, error } = await db().from('files').select('id, name, size, mime_type, storage_path, kind, created_at, file_texts(status)')
      .eq('folder_id', target).eq('uploaded', true);
    if (error || target !== folderId) return;
    files = data.map(f => {
      const t = Array.isArray(f.file_texts) ? f.file_texts[0] : f.file_texts;
      return { ...f, createdAt: Date.parse(f.created_at), aiStatus: t?.status ?? null };
    }).sort((a, b) => b.createdAt - a.createdAt);
    render();
  }

  // A note was written, renamed, moved or deleted: refresh the list if it's (or was) in this folder.
  document.addEventListener('eigen:notes-changed', async e => {
    const d = e.detail;
    const here = d.folderId === folderId || d.from?.folderId === folderId || !d.id;
    if (!folderId || !here || status !== 'ready') return;
    const target = folderId;
    const written = await window.eigenNotes.list({ folderId: target });
    if (target !== folderId) return;
    notes = written;
    render();
  });

  // Clicking a course's file in the sidebar opens it; right-click for more.
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('click', e => {
    const item = e.target.closest('.course-file[data-file-id]');
    if (item && !e.target.closest('.inline-input')) previewFile(item.dataset.fileId);
  });
  sidebar.addEventListener('dragstart', e => {
    const item = e.target.closest?.('.course-file[data-file-id]');
    if (item) drag.start(e, { type: 'file', id: item.dataset.fileId });
  });
  sidebar.addEventListener('contextmenu', e => {
    const item = e.target.closest('.course-file[data-file-id]');
    if (!item || e.target.closest('.inline-input')) return;
    e.preventDefault();
    e.stopPropagation();
    const id = item.dataset.fileId;
    const r = item.getBoundingClientRect();
    openMenu(e.clientX || r.left, e.clientY || r.bottom, [
      { label: 'Preview', icon: 'file', run: () => previewFile(id) },
      { label: 'Open in new tab', icon: 'external', run: () => openFile(id) },
      { label: 'Download', icon: 'download', run: () => downloadFile(id) },
      { label: 'Rename', icon: 'pencil', run: () => renameFile(id) },
      '-',
      { label: 'Delete file', icon: 'trash', danger: true, run: () => deleteFile(id) },
    ]);
  }, true);

  window.eigenFiles = {
    upload: uploadFiles,
    openRow,
    canUpload: () => !!user && !!db(),
    courseRows,
    move: moveFile,
    courseFiles: classId => courseFiles.filter(f => f.class_id === classId),
  };

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
    courseFiles = [];
    if (user && db()) loadCourseFiles(); else announceCourse();
    sync();
  });
  if (user && db()) loadCourseFiles();
  sync();
})();

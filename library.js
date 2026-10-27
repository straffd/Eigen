// Course library (#library/<classId>), opened from the document icon next to a course in the
// sidebar: everything in the course in one list (folders, context files, notes and documents,
// written notes, and files kept on the course itself) with filters and search.
(() => {
  const $ = id => document.getElementById(id);
  const titleEl = $('library-title');
  const content = $('library-content');
  const searchEl = $('library-search');
  const folderSel = $('library-folder');
  const formatSel = $('library-format');
  const sortSel = $('library-sort');
  const chipsEl = $('library-types');
  const { el, icon, toast } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null;
  let classId = null;
  let files = [];        // every uploaded file in the course (in its folders or on the course itself)
  let notes = [];        // notes written in Eigen
  let status = 'idle';   // 'idle' | 'loading' | 'ready' | 'error'
  let loadToken = 0;
  const filters = { type: 'all', folder: '', format: '', sort: 'recent', q: '' };
  const openFolders = new Map(); // folderId -> expanded? (unset: closed, or open when filtering finds matches)

  const db = () => window.eigen?.supabase;
  const course = () => (classId ? window.eigenClasses.findClass(classId) : null);

  const TYPES = [
    ['all', 'All'],
    ['folder', 'Folders'],
    ['context', 'Context'],
    ['notes', 'Notes & docs'],
    ['course', 'Course files'],
  ];
  const FORMATS = [
    ['', 'Any format'], ['pdf', 'PDF'], ['slides', 'Slides'], ['doc', 'Documents'], ['sheet', 'Spreadsheets'],
    ['note', 'Written notes'], ['image', 'Images'], ['video', 'Video'], ['other', 'Other'],
  ];
  function formatOf(name, mime = '') {
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (ext === 'pdf' || /pdf/.test(mime)) return 'pdf';
    if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return 'slides';
    if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'].includes(ext)) return 'doc';
    if (['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return 'sheet';
    if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return 'image';
    if (/^video\//.test(mime) || ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
    return 'other';
  }
  const formatSize = b => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`);
  const formatDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

  // Everything in the course as one list of { type, kind, name, where, folderId, format, time, size, open }.
  function items() {
    const c = course();
    if (!c) return [];
    const folders = c.folders.filter(f => !f.archivedAt);
    const folderName = id => folders.find(f => f.id === id)?.name;
    const out = folders.map(f => {
      const n = files.filter(x => x.folder_id === f.id).length + notes.filter(x => x.folder_id === f.id).length;
      return { type: 'folder', kind: 'folder', name: f.name, where: c.name, folderId: f.id, format: '', time: f.createdAt,
        meta: `${n} item${n === 1 ? '' : 's'}`, href: '#folder/' + f.id };
    });
    for (const f of files) {
      if (f.folder_id && !folderName(f.folder_id)) continue; // in an archived folder
      out.push({ type: 'file', kind: f.folder_id ? (f.kind === 'notes' ? 'notes' : 'context') : 'course', name: f.name,
        where: f.folder_id ? folderName(f.folder_id) : 'Course', folderId: f.folder_id, format: formatOf(f.name, f.mime_type || ''),
        time: Date.parse(f.created_at), meta: formatSize(Number(f.size)), file: f });
    }
    for (const n of notes) {
      if (n.folder_id && !folderName(n.folder_id)) continue;
      out.push({ type: 'note', kind: 'notes', name: n.title, where: n.folder_id ? folderName(n.folder_id) : 'Course', folderId: n.folder_id,
        format: 'note', time: Date.parse(n.updated_at), meta: 'Note', href: '#note/' + n.id });
    }
    return out;
  }

  function matches(it, { skipType = false } = {}) {
    if (!skipType && filters.type !== 'all') {
      if (filters.type === 'folder' && it.type !== 'folder') return false;
      if (filters.type === 'context' && it.kind !== 'context') return false;
      if (filters.type === 'notes' && it.kind !== 'notes') return false;
      if (filters.type === 'course' && it.kind !== 'course') return false;
    }
    if (filters.folder === 'course' && it.where !== 'Course') return false;
    if (filters.folder && filters.folder !== 'course' && it.folderId !== filters.folder) return false;
    if (filters.format && it.format !== filters.format) return false;
    if (filters.q && !`${it.name} ${it.where}`.toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  }

  // ---------- Render ----------
  const typeMatch = (it, value) => value === 'folder' ? it.type === 'folder' : it.kind === value;
  function fill(sel, opts, value) {
    sel.replaceChildren(...opts.map(([v, label]) => { const o = el('<option></option>'); o.value = v; o.textContent = label; return o; }));
    sel.value = opts.some(([v]) => v === value) ? value : '';
  }

  function render() {
    const c = course();
    if (!c) {
      titleEl.textContent = window.eigenClasses.status() === 'ready' ? 'Course not found' : '';
      content.replaceChildren();
      return;
    }
    titleEl.textContent = c.name;
    document.title = `${c.name} library · Eigen`;
    if (!user || !db()) {
      content.replaceChildren(el(`<div class="files-empty">${icon('lock')}<p class="files-empty-title">Sign in to see your course library</p></div>`));
      return;
    }
    if (status === 'loading') return content.replaceChildren(el(`<p class="files-status">Loading…</p>`));
    if (status === 'error') return content.replaceChildren(el(`<p class="files-status">Couldn’t load this course.</p>`));

    // Type chip counts honour the other filters; the list honours all of them.
    const all = items();
    const others = all.filter(it => matches(it, { skipType: true }));
    chipsEl.replaceChildren(...TYPES.map(([value, label]) => {
      const n = value === 'all' ? others.length : others.filter(it => typeMatch(it, value)).length;
      const b = el(`<button type="button" class="filter-chip ${filters.type === value ? 'on' : ''}" data-type="${value}"><span></span><span class="chip-count">${n}</span></button>`);
      b.firstElementChild.textContent = label;
      return b;
    }));
    fill(folderSel, [['', 'All folders'], ['course', 'On the course'], ...c.folders.filter(f => !f.archivedAt).map(f => [f.id, f.name])], filters.folder);
    fill(formatSel, FORMATS, filters.format);

    // A tree: folders (click to expand or collapse) with their files and notes inside, then anything
    // kept on the course itself. Filtering or searching opens the folders that have matches.
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    const order = filters.sort === 'name' ? byName : (a, b) => b.time - a.time;
    const q = filters.q.toLowerCase();
    const leaves = all.filter(it => it.type !== 'folder');
    const inFolder = f => leaves.filter(it => it.folderId === f.folderId);
    // With the Folders chip on, a folder still shows everything inside it.
    const kidMatches = it => (filters.type === 'folder' ? matches(it, { skipType: true }) : matches(it));
    const kids = f => inFolder(f).filter(kidMatches).sort(order);
    const folderShown = f => {
      if (filters.folder === 'course' || (filters.folder && f.folderId !== filters.folder)) return false;
      if (kids(f).length) return true;
      return ['all', 'folder'].includes(filters.type) && !filters.format && (!q || f.name.toLowerCase().includes(q));
    };
    const folders = all.filter(it => it.type === 'folder' && folderShown(it)).sort(byName);
    const loose = filters.type === 'folder' ? [] : leaves.filter(it => !it.folderId && matches(it)).sort(order);
    const filtering = !!(q || filters.format || filters.folder || ['context', 'notes'].includes(filters.type));
    const isOpen = f => openFolders.get(f.folderId) ?? (filtering && kids(f).length > 0);

    if (!folders.length && !loose.length) {
      content.replaceChildren(el(`<div class="files-empty">${icon('search')}<p class="files-empty-title">${all.length ? 'Nothing matches these filters' : 'This course is empty'}</p><p class="files-empty-text">${all.length ? 'Try another type, folder or search.' : 'Add folders, files or notes from the sidebar.'}</p></div>`));
      return;
    }
    const BADGE = { context: 'Context', notes: 'Notes & docs', course: 'Course file', folder: 'Folder' };
    const row = (it, nested) => {
      const li = el(`
        <li class="file-item ${nested ? 'nested' : ''}" draggable="true" data-sel="${it.type === 'note' ? 'note:' + it.href.slice(6) : 'file:' + it.file.id}">
          <button class="file-open" type="button">
            <span class="file-badge"></span>
            <span class="file-text"><span class="file-name"></span><span class="file-meta"></span></span>
            <span class="kind-tag" data-kind="${it.kind}"></span>
          </button>
        </li>`);
      const badge = li.querySelector('.file-badge');
      if (it.type === 'note') { badge.innerHTML = icon('pencil'); badge.classList.add('note-badge'); }
      else { const ext = (it.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'FILE').toUpperCase().slice(0, 4); badge.textContent = ext; badge.dataset.ext = ext; }
      li.querySelector('.file-name').textContent = it.name;
      li.querySelector('.file-meta').textContent = [nested ? null : it.where, it.meta, formatDate(it.time)].filter(Boolean).join(' · ');
      li.querySelector('.kind-tag').textContent = BADGE[it.kind];
      // Drag a file or note onto a folder (here or in the sidebar) to move it.
      li.addEventListener('dragstart', e => {
        window.eigenUI.drag.start(e, it.type === 'note' ? { type: 'note', id: it.href.slice(6) } : { type: 'file', id: it.file.id });
        requestAnimationFrame(() => li.classList.add('dragging'));
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      // Files and notes preview in the side panel.
      li.querySelector('.file-open').addEventListener('click', () => {
        if (it.type === 'note') window.eigenViewer.preview({ fileId: 'note:' + it.href.slice(6), fileName: it.name });
        else window.eigenViewer.preview({ fileId: it.file.id, fileName: it.name });
      });
      return li;
    };
    const ul = el(`<ul class="file-list library-list"></ul>`);
    for (const f of folders) {
      const open = isOpen(f);
      const inside = kids(f);
      const total = inFolder(f).length;
      const li = el(`
        <li class="file-item lib-folder" data-sel="folder:${f.folderId}">
          <button class="file-open" type="button" aria-expanded="${open}">
            ${icon('chevron', 'lib-chev')}
            <span class="file-badge">${icon('folder')}</span>
            <span class="file-text"><span class="file-name"></span><span class="file-meta"></span></span>
          </button>
          <a class="icon-btn lib-go" href="${f.href}" aria-label="Open folder" title="Open folder">${icon('external')}</a>
        </li>`);
      li.querySelector('.file-name').textContent = f.name;
      li.querySelector('.file-meta').textContent = (inside.length < total ? `${inside.length} of ${total} items match` : `${total} item${total === 1 ? '' : 's'}`) + ` · ${formatDate(f.time)}`;
      li.querySelector('.file-open').addEventListener('click', () => { openFolders.set(f.folderId, !open); render(); });
      dropTarget(li, () => ({ classId, folderId: f.folderId }));
      ul.append(li);
      if (open) {
        if (inside.length) ul.append(...inside.map(it => row(it, true)));
        else ul.append(el(`<li class="file-item nested lib-empty">Empty folder</li>`));
      }
    }
    const looseRows = loose.map(it => row(it, false));
    looseRows.forEach(li => dropTarget(li, () => ({ classId, folderId: null }))); // dropping among course files moves onto the course
    ul.append(...looseRows);
    content.replaceChildren(ul);
  }

  // A row that files and notes can be dropped on.
  function dropTarget(li, where) {
    const { drag } = window.eigenUI;
    li.addEventListener('dragover', e => { if (!drag.has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; li.classList.add('drop-into'); });
    li.addEventListener('dragleave', e => { if (!li.contains(e.relatedTarget)) li.classList.remove('drop-into'); });
    li.addEventListener('drop', e => {
      li.classList.remove('drop-into');
      if (!drag.has(e)) return;
      e.preventDefault();
      const { classId: c, folderId } = where();
      drag.drop(drag.read(e), c, folderId);
    });
  }

  // ---------- Data ----------
  async function load() {
    const token = ++loadToken;
    status = 'loading';
    render();
    const c = course();
    const folderIds = c.folders.map(f => f.id);
    const cols = 'id, name, size, mime_type, storage_path, folder_id, class_id, kind, created_at';
    const none = { data: [], error: null };
    const [inFolders, onCourse, written] = await Promise.all([
      folderIds.length ? db().from('files').select(cols).in('folder_id', folderIds).eq('uploaded', true) : none,
      db().from('files').select(cols).eq('class_id', classId).eq('uploaded', true).then(r => (r.error ? none : r)),
      window.eigenNotes.list({ classId }),
    ]);
    if (token !== loadToken) return;
    if (inFolders.error) { console.error(inFolders.error); status = 'error'; toast('Couldn’t load this course.'); }
    else { files = [...inFolders.data, ...onCourse.data]; notes = written; status = 'ready'; }
    render();
  }

  // Right-click a row: open it or delete it. (With several selected, select.js offers deleting them all.)
  content.addEventListener('contextmenu', e => {
    const li = e.target.closest('[data-sel]');
    if (!li) return;
    e.preventDefault();
    const key = li.dataset.sel;
    const [type, id] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
    const it = items().find(x => (type === 'folder' ? x.type === 'folder' && x.folderId === id : type === 'note' ? x.type === 'note' && x.href === '#note/' + id : x.file?.id === id));
    if (!it) return;
    const del = { label: `Delete ${type}`, icon: 'trash', danger: true, run: () => window.eigenSelect.deleteItems([key]) };
    window.eigenUI.openMenu(e.clientX, e.clientY, type === 'folder' ? [
      { label: 'Open folder', icon: 'folder', run: () => { location.hash = it.href; } },
      '-', del,
    ] : type === 'note' ? [
      { label: 'Open', icon: 'pencil', run: () => window.eigenViewer.preview({ fileId: 'note:' + id, fileName: it.name }) },
      { label: 'Open full page', icon: 'external', run: () => { location.hash = it.href; } },
      '-', del,
    ] : [
      { label: 'Preview', icon: 'file', run: () => window.eigenViewer.preview({ fileId: id, fileName: it.name }) },
      { label: 'Open in new tab', icon: 'external', run: () => window.eigenFiles.openRow(it.file) },
      '-', del,
    ]);
  });

  // ---------- Events ----------
  chipsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    filters.type = b.dataset.type;
    openFolders.clear();
    render();
  });
  searchEl.addEventListener('input', () => { filters.q = searchEl.value.trim(); openFolders.clear(); render(); });
  folderSel.addEventListener('change', () => { filters.folder = folderSel.value; openFolders.clear(); render(); });
  formatSel.addEventListener('change', () => { filters.format = formatSel.value; openFolders.clear(); render(); });
  sortSel.addEventListener('change', () => { filters.sort = sortSel.value; render(); });
  $('library-new-note').addEventListener('click', () => {
    const folderId = filters.folder && filters.folder !== 'course' ? filters.folder : null;
    if (classId) window.eigenNotes.create({ classId, folderId });
  });

  function sync() {
    const next = location.hash.startsWith('#library/') ? location.hash.slice(9) : null;
    if (!next) { classId = null; return; }
    const changed = next !== classId;
    if (changed) {
      Object.assign(filters, { type: 'all', folder: '', format: '', q: '' });
      openFolders.clear();
      searchEl.value = '';
    }
    classId = next;
    if (user && db() && course() && (changed || status === 'idle' || status === 'stale')) load();
    else render();
  }
  window.addEventListener('hashchange', sync);
  document.addEventListener('eigen:classes', () => { if (classId) sync(); });
  // Files or notes changed elsewhere: reload when the library is next shown (or now, if it's open).
  const stale = () => { if (!classId) return; status = 'stale'; if (location.hash.startsWith('#library/')) sync(); };
  document.addEventListener('eigen:files-changed', stale);
  document.addEventListener('eigen:notes-changed', stale);
  document.addEventListener('eigen:user', e => {
    const next = e.detail || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    status = 'idle';
    sync();
  });
  sync();
})();

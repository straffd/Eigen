// Classes and their folders in the sidebar.
// Signed in: stored in Supabase (tables from supabase/schema.sql).
// Signed out: stored in this browser's localStorage, and moved into the account on first sign-in.
// Archived classes and folders are hidden from the sidebar and listed on the Archive page.
// Folders can be dragged to reorder them or move them to another class. Chats (chats.js) and files
// from the desktop can be dropped on a course or folder too.
(() => {
  const MAX_CLASSES = 4; // Free plan limit (also enforced by the database)
  const MAX_NAME = 40;
  const GUEST_KEY = 'eigen.classes.guest';

  const $ = id => document.getElementById(id);
  const list = $('class-list');
  const addBtn = $('add-class');
  const empty = $('classes-empty');
  const limitNote = $('classes-limit');
  const menu = $('context-menu');
  const confirmDialog = $('confirm-dialog');
  const toastEl = $('toast');
  const archiveEl = $('archive-content');

  let classes = [];   // [{ id, name, createdAt, archivedAt, folders: [{ id, name, createdAt, archivedAt, position }] }]
  let folderSizes = new Map(); // folderId -> bytes of uploaded files (signed in only)
  let store = null;
  let status = 'loading'; // 'loading' | 'ready' | 'error'
  const expanded = new Set();

  const uid = () => crypto.randomUUID();
  const findClass = id => classes.find(c => c.id === id);
  const byCreated = (a, b) => a.createdAt - b.createdAt;
  // Folders without a saved position keep their creation order, after any ordered ones.
  function orderFolders(c) {
    c.folders.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || byCreated(a, b));
    c.folders.forEach((f, i) => { if (f.position == null) { f.position = i + 1; f.unsaved = true; } });
    return c;
  }
  const isActive = x => !x.archivedAt;
  const activeClasses = () => classes.filter(isActive);
  const atLimit = () => activeClasses().length >= MAX_CLASSES;
  const LIMIT_MSG = `Free plan includes up to ${MAX_CLASSES} active courses. Archive one to make room.`;

  // ---------- Storage: browser (guest) ----------
  const localStore = {
    kind: 'local',
    async list() {
      try { return normalize(JSON.parse(localStorage.getItem(GUEST_KEY)) || []); } catch { return []; }
    },
    persist() {
      try { localStorage.setItem(GUEST_KEY, JSON.stringify(classes, (k, v) => (k === 'unsaved' ? undefined : v))); } catch {}
    },
    async addClass() { this.persist(); },
    async renameClass() { this.persist(); },
    async deleteClass() { this.persist(); },
    async addFolder() { this.persist(); },
    async renameFolder() { this.persist(); },
    async deleteFolder() { this.persist(); },
    async setClassArchived() { this.persist(); },
    async setFolderArchived() { this.persist(); },
    async moveFolder() { this.persist(); },
    async folderSizes() { return new Map(); },
  };

  // Older saved data has no archivedAt.
  function normalize(list) {
    return list.map(c => orderFolders({ archivedAt: null, ...c, folders: (c.folders || []).map(f => ({ archivedAt: null, position: null, ...f })) }));
  }

  // ---------- Storage: Supabase (signed in) ----------
  const iso = t => (t ? new Date(t).toISOString() : null);

  function supabaseStore(db) {
    const check = ({ error }) => { if (error) throw error; };
    // Folders created before ordering existed have no stored position. Once a sibling gets one, save
    // theirs too, otherwise they'd sort after it on the next load.
    async function saveUnsaved(c, except) {
      const pending = c.folders.filter(x => x.unsaved && x !== except);
      const results = await Promise.all(pending.map(x => db.from('folders').update({ position: x.position }).eq('id', x.id)));
      results.forEach(check);
      pending.forEach(x => { x.unsaved = false; });
    }

    // Remove stored file bytes before their rows disappear with a folder or class.
    async function removeFiles(folderIds) {
      if (!folderIds.length) return;
      const { data, error } = await db.from('files').select('storage_path').in('folder_id', folderIds);
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') return; // files not set up yet
        throw error;
      }
      if (data.length) check(await db.storage.from('files').remove(data.map(r => r.storage_path)));
    }
    return {
      kind: 'supabase',
      async list() {
        const { data, error } = await db.from('classes')
          .select('id, name, created_at, archived_at, folders(id, name, created_at, archived_at, position)');
        if (error) throw error;
        return data.map(c => orderFolders({
          id: c.id,
          name: c.name,
          createdAt: Date.parse(c.created_at),
          archivedAt: c.archived_at ? Date.parse(c.archived_at) : null,
          folders: (c.folders || [])
            .map(f => ({ id: f.id, name: f.name, createdAt: Date.parse(f.created_at),
                         archivedAt: f.archived_at ? Date.parse(f.archived_at) : null, position: f.position })),
        })).sort(byCreated);
      },
      async addClass(c) { check(await db.from('classes').insert({ id: c.id, name: c.name, archived_at: iso(c.archivedAt) })); },
      async renameClass(c) { check(await db.from('classes').update({ name: c.name }).eq('id', c.id)); },
      async deleteClass(c) {
        await removeFiles(c.folders.map(f => f.id));
        check(await db.from('classes').delete().eq('id', c.id));
      },
      async addFolder(c, f) {
        check(await db.from('folders').insert({ id: f.id, class_id: c.id, name: f.name, archived_at: iso(f.archivedAt), position: f.position }));
        await saveUnsaved(c, f);
      },
      async renameFolder(c, f) { check(await db.from('folders').update({ name: f.name }).eq('id', f.id)); },
      async deleteFolder(c, f) {
        await removeFiles([f.id]);
        check(await db.from('folders').delete().eq('id', f.id));
      },
      async setClassArchived(c) { check(await db.from('classes').update({ archived_at: iso(c.archivedAt) }).eq('id', c.id)); },
      async setFolderArchived(c, f) { check(await db.from('folders').update({ archived_at: iso(f.archivedAt) }).eq('id', f.id)); },
      async moveFolder(c, f) {
        check(await db.from('folders').update({ class_id: c.id, position: f.position }).eq('id', f.id));
        f.unsaved = false;
        await saveUnsaved(c, f);
      },
      async folderSizes() {
        const { data, error } = await db.from('files').select('folder_id, size').eq('uploaded', true);
        if (error) return new Map(); // file storage not set up yet: just show no sizes
        const sizes = new Map();
        for (const r of data) sizes.set(r.folder_id, (sizes.get(r.folder_id) || 0) + Number(r.size));
        return sizes;
      },
    };
  }

  function describeError(err) {
    const msg = err?.message || '';
    if (/class_limit/.test(msg)) return LIMIT_MSG;
    if (/failed to fetch|network/i.test(msg)) return 'Couldn’t reach Eigen’s servers. Check your connection.';
    if (err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist|schema cache/i.test(msg))
      return 'Courses aren’t set up in the database yet.';
    return 'Something went wrong saving your courses.';
  }

  // Apply a change locally right away, then save it. If saving fails, reload from the source of truth.
  async function commit(op, ...args) {
    render();
    try {
      await store[op](...args);
    } catch (err) {
      console.error(err);
      toast(describeError(err));
      await refresh();
    }
  }

  let generation = 0; // ignores results from a store we've since switched away from
  async function refresh() {
    const gen = generation;
    try {
      const data = await store.list();
      if (gen !== generation) return;
      classes = data;
      status = 'ready';
      refreshSizes();
    } catch (err) {
      if (gen !== generation) return;
      console.error(err);
      status = 'error';
      classes = [];
      toast(describeError(err));
    }
    render();
  }

  async function refreshSizes() {
    const gen = generation;
    const sizes = await store.folderSizes();
    if (gen !== generation) return;
    folderSizes = sizes;
    list.querySelectorAll('[data-folder-id]').forEach(li => {
      const el = li.querySelector('.folder-size');
      if (el) el.textContent = sizeLabel(li.dataset.folderId);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  const sizeLabel = folderId => (folderSizes.get(folderId) ? formatSize(folderSizes.get(folderId)) : '');

  // Move classes made while signed out into a newly signed-in account (only if the account has none).
  // Also picks up classes saved per-account in the browser by the previous version of Eigen.
  async function importGuestClasses(userId) {
    const legacyKey = 'eigen.classes.' + userId;
    let guest = await localStore.list();
    if (!guest.length) {
      try { guest = normalize(JSON.parse(localStorage.getItem(legacyKey)) || []); } catch { guest = []; }
    }
    if (!guest.length || classes.length) return;
    try {
      let active = 0;
      for (const c of guest) {
        if (isActive(c) && ++active > MAX_CLASSES) continue;
        await store.addClass(c);
        for (const f of c.folders) await store.addFolder(c, f); // includes position
      }
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(legacyKey);
      toast('Moved your courses into your account.');
    } catch (err) {
      console.error(err);
      toast(describeError(err));
    }
    await refresh();
  }

  async function useStore(next, userId) {
    generation++;
    store = next;
    status = 'loading';
    classes = [];
    folderSizes = new Map();
    expanded.clear();
    render();
    await refresh();
    if (store === next && store.kind === 'supabase' && status === 'ready') await importGuestClasses(userId);
  }

  // ---------- Helpers ----------
  function icon(name, cls = '') {
    return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  let toastTimer;
  function toast(text, action) {
    toastEl.replaceChildren(document.createTextNode(text));
    if (action) {
      const b = el(`<button class="toast-action" type="button"></button>`);
      b.textContent = action.label;
      b.addEventListener('click', () => { toastEl.hidden = true; action.run(); });
      toastEl.append(b);
    }
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 5000 : 2800);
  }

  function confirmDelete(title, text, okLabel = 'Delete') {
    return new Promise(resolve => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      $('confirm-ok').textContent = okLabel;
      const done = result => {
        confirmDialog.close();
        $('confirm-ok').onclick = $('confirm-cancel').onclick = confirmDialog.onclose = null;
        resolve(result);
      };
      $('confirm-ok').onclick = () => done(true);
      $('confirm-cancel').onclick = () => done(false);
      confirmDialog.onclose = () => resolve(false);
      confirmDialog.showModal();
      $('confirm-cancel').focus();
    });
  }

  // Inline text input used for create and rename. Resolves with the trimmed name, or null if cancelled.
  function inlineInput(container, { value = '', placeholder = '', className = '', maxLength = MAX_NAME }) {
    return new Promise(resolve => {
      const input = el(`<input class="inline-input ${className}" maxlength="${maxLength}" spellcheck="false">`);
      input.value = value;
      input.placeholder = placeholder;
      container.replaceChildren(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = commit => {
        if (finished) return;
        finished = true;
        const name = input.value.trim();
        resolve(commit && name ? name : null);
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    });
  }

  // ---------- Render ----------
  // Keep the class holding the open folder expanded, so the folder shows as selected.
  function expandOpenFolder() {
    if (location.hash.startsWith('#chat/')) {
      const chat = window.eigenChats?.find(location.hash.slice(6));
      if (chat?.classId && findClass(chat.classId)) expanded.add(chat.classId);
      return;
    }
    if (!location.hash.startsWith('#folder/')) return;
    const id = location.hash.slice(8);
    const c = classes.find(x => x.folders.some(f => f.id === id));
    if (c) expanded.add(c.id);
  }
  const chatsUnder = (classId, folderId) => (window.eigenChats ? window.eigenChats.under(classId, folderId).map(window.eigenChats.row) : []);

  function render() {
    expandOpenFolder();
    const active = activeClasses();
    list.replaceChildren(...active.map(renderClass));
    empty.hidden = active.length > 0 && status === 'ready';
    empty.textContent = status === 'loading' ? 'Loading courses…'
      : status === 'error' ? 'Couldn’t load your courses.'
      : 'No courses yet. Press + to add one.';
    const full = atLimit() || status !== 'ready';
    addBtn.classList.toggle('is-disabled', full);
    limitNote.hidden = !atLimit();
    addBtn.setAttribute('aria-label', full ? 'Can’t add a course right now' : 'Add course');
    renderArchive();
    document.dispatchEvent(new CustomEvent('eigen:classes'));
  }

  function renderClass(c) {
    const open = expanded.has(c.id);
    const li = el(`
      <li class="class" data-class-id="${c.id}">
        <div class="class-item">
          <a class="row class-toggle ${location.hash.startsWith('#course/' + c.id) ? 'active' : ''}" href="#course/${c.id}" title="Open ${c.name.replace(/"/g, '&quot;')} AI chat">
            <span class="chev-btn" role="button" tabindex="0" aria-label="Show folders" aria-expanded="${open}">${icon('chevron', 'chev')}</span><span class="class-name"></span>
          </a>
          <div class="class-actions">
            <button class="icon-btn" type="button" data-action="add-folder" aria-label="Add folder">${icon('circle-plus', 'sm')}</button>
            <button class="icon-btn" type="button" aria-label="Course settings">${icon('settings', 'sm')}</button>
          </div>
        </div>
        <ul class="folder-list" ${open ? '' : 'hidden'}></ul>
      </li>`);
    li.querySelector('.class-name').textContent = c.name;
    const folders = li.querySelector('.folder-list');
    const shown = c.folders.filter(isActive);
    const chats = chatsUnder(c.id, null);
    if (shown.length) {
      folders.append(...shown.map(f => renderFolder(c, f)));
    } else if (!chats.length) {
      folders.append(el(`<li class="folder-empty">${c.folders.length ? 'All folders archived' : 'No folders yet'}</li>`));
    }
    folders.append(...chats);
    return li;
  }

  function renderFolder(c, f) {
    const li = el(`
      <li class="folder" data-folder-id="${f.id}">
        <a class="row folder-row ${location.hash === '#folder/' + f.id ? 'active' : ''}" href="#folder/${f.id}" draggable="true">${icon('folder')}<span class="folder-name"></span><span class="folder-size"></span></a>
      </li>`);
    li.querySelector('.folder-name').textContent = f.name;
    li.querySelector('.folder-size').textContent = sizeLabel(f.id);
    const chats = chatsUnder(c.id, f.id);
    if (chats.length) {
      const ul = el(`<ul class="folder-chats"></ul>`);
      ul.append(...chats);
      li.append(ul);
    }
    return li;
  }

  // ---------- Actions ----------
  async function addClass() {
    if (status !== 'ready') return;
    if (atLimit()) return toast(LIMIT_MSG);
    const slot = el(`<li class="class"><div class="class-item editing"></div></li>`);
    list.append(slot);
    empty.hidden = true;
    const name = await inlineInput(slot.firstElementChild, { placeholder: 'Course code, e.g. COMP1511' });
    if (!name || atLimit()) return render();
    const c = { id: uid(), name, folders: [], createdAt: Date.now(), archivedAt: null };
    classes.push(c);
    await commit('addClass', c);
  }

  async function addFolder(classId) {
    const c = findClass(classId);
    if (!c) return;
    expanded.add(classId);
    render();
    const folders = list.querySelector(`[data-class-id="${classId}"] .folder-list`);
    folders.querySelector('.folder-empty')?.remove();
    const slot = el(`<li class="folder"><div class="folder-row editing">${icon('folder')}<span class="slot"></span></div></li>`);
    folders.append(slot);
    const name = await inlineInput(slot.querySelector('.slot'), { placeholder: 'Folder name' });
    if (!name || !findClass(classId)) return render();
    const last = c.folders[c.folders.length - 1];
    const f = { id: uid(), name, createdAt: Date.now(), archivedAt: null, position: (last?.position ?? 0) + 1 };
    c.folders.push(f);
    await commit('addFolder', c, f);
  }

  async function renameClass(classId) {
    const c = findClass(classId);
    const row = list.querySelector(`[data-class-id="${classId}"] .class-item`);
    if (!c || !row) return;
    row.classList.add('editing');
    const name = await inlineInput(row, { value: c.name });
    if (!name || name === c.name) return render();
    c.name = name;
    await commit('renameClass', c);
  }

  async function renameFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    const li = list.querySelector(`[data-folder-id="${folderId}"]`);
    if (!f || !li) return;
    li.innerHTML = `<div class="folder-row editing">${icon('folder')}<span class="slot"></span></div>`;
    const name = await inlineInput(li.querySelector('.slot'), { value: f.name });
    if (!name || name === f.name) return render();
    f.name = name;
    await commit('renameFolder', c, f);
  }

  async function deleteClass(classId) {
    const c = findClass(classId);
    if (!c) return;
    const n = c.folders.length;
    const ok = await confirmDelete(`Delete ${c.name}?`,
      n ? `This also deletes its ${n} folder${n === 1 ? '' : 's'} and any files inside. This can’t be undone.` : 'This can’t be undone.');
    if (!ok) return;
    classes = classes.filter(x => x.id !== classId);
    expanded.delete(classId);
    await commit('deleteClass', c);
  }

  async function deleteFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    if (!f) return;
    const ok = await confirmDelete(`Delete ${f.name}?`,
      store.kind === 'supabase' ? 'Any files in this folder will be deleted too. This can’t be undone.' : 'This can’t be undone.');
    if (!ok) return;
    c.folders = c.folders.filter(x => x.id !== folderId);
    await commit('deleteFolder', c, f);
  }

  async function archiveClass(classId) {
    const c = findClass(classId);
    if (!c || c.archivedAt) return;
    c.archivedAt = Date.now();
    expanded.delete(classId);
    toast(`Archived ${c.name}.`, { label: 'Undo', run: () => restoreClass(classId) });
    await commit('setClassArchived', c);
  }

  async function restoreClass(classId) {
    const c = findClass(classId);
    if (!c || !c.archivedAt) return;
    if (atLimit()) return toast(LIMIT_MSG);
    c.archivedAt = null;
    await commit('setClassArchived', c);
  }

  async function archiveFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    if (!f || f.archivedAt) return;
    f.archivedAt = Date.now();
    toast(`Archived ${f.name}.`, { label: 'Undo', run: () => restoreFolder(classId, folderId) });
    await commit('setFolderArchived', c, f);
  }

  async function restoreFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    if (!f || !f.archivedAt) return;
    f.archivedAt = null;
    await commit('setFolderArchived', c, f);
  }

  // ---------- Archive page ----------
  function timeAgo(t) {
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function archiveItem({ kind, iconName, name, meta, classId, folderId }) {
    const li = el(`
      <li class="archive-item" data-kind="${kind}" data-class-id="${classId}" ${folderId ? `data-folder-id="${folderId}"` : ''}>
        <span class="archive-icon">${icon(iconName)}</span>
        <div class="archive-text"><span class="archive-name"></span><span class="archive-meta"></span></div>
        <div class="archive-actions">
          <button class="btn-secondary btn-sm" type="button" data-action="restore">${icon('restore')}Restore</button>
          <button class="icon-btn danger" type="button" data-action="delete" aria-label="Delete permanently">${icon('trash')}</button>
        </div>
      </li>`);
    li.querySelector('.archive-name').textContent = name;
    li.querySelector('.archive-meta').textContent = meta;
    return li;
  }

  function renderArchive() {
    if (status !== 'ready') {
      archiveEl.replaceChildren(el(`<p class="archive-status">${status === 'loading' ? 'Loading…' : 'Couldn’t load your archive.'}</p>`));
      return;
    }
    const archivedClasses = classes.filter(c => c.archivedAt).sort((a, b) => b.archivedAt - a.archivedAt);
    const archivedFolders = classes.filter(isActive)
      .flatMap(c => c.folders.filter(f => f.archivedAt).map(f => ({ c, f })))
      .sort((a, b) => b.f.archivedAt - a.f.archivedAt);

    if (!archivedClasses.length && !archivedFolders.length) {
      archiveEl.replaceChildren(el(`
        <div class="archive-empty">
          ${icon('archive')}
          <p class="archive-empty-title">Nothing archived yet</p>
          <p class="archive-empty-text">Right-click a course or folder in the sidebar and choose Archive to put it away here.</p>
        </div>`));
      return;
    }

    const section = (title, items) => {
      const sec = el(`<section class="archive-section"><h2 class="archive-heading"></h2><ul class="archive-list"></ul></section>`);
      sec.querySelector('h2').textContent = `${title} · ${items.length}`;
      sec.querySelector('ul').append(...items);
      return sec;
    };
    const parts = [];
    if (archivedClasses.length) {
      parts.push(section('Courses', archivedClasses.map(c => {
        const n = c.folders.length;
        return archiveItem({
          kind: 'class', iconName: 'archive', name: c.name, classId: c.id,
          meta: `${n} folder${n === 1 ? '' : 's'} · Archived ${timeAgo(c.archivedAt)}`,
        });
      })));
    }
    if (archivedFolders.length) {
      parts.push(section('Folders', archivedFolders.map(({ c, f }) => archiveItem({
        kind: 'folder', iconName: 'folder', name: f.name, classId: c.id, folderId: f.id,
        meta: `${c.name} · Archived ${timeAgo(f.archivedAt)}`,
      }))));
    }
    archiveEl.replaceChildren(...parts);
  }

  archiveEl.addEventListener('click', e => {
    const item = e.target.closest('.archive-item');
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!item || !action) return;
    const { kind, classId, folderId } = item.dataset;
    if (kind === 'class') action === 'restore' ? restoreClass(classId) : deleteClass(classId);
    else action === 'restore' ? restoreFolder(classId, folderId) : deleteFolder(classId, folderId);
  });

  // ---------- Moving folders ----------
  // Moves a folder into `toClassId` before `beforeFolderId` (or to the end). Only one row is saved:
  // the moved folder gets a position halfway between its new neighbours.
  async function moveFolder(fromClassId, folderId, toClassId, beforeFolderId = null) {
    const from = findClass(fromClassId);
    const to = findClass(toClassId);
    const f = from?.folders.find(x => x.id === folderId);
    if (!f || !to || beforeFolderId === folderId) return;
    const siblings = to.folders.filter(x => x !== f);
    let i = beforeFolderId ? siblings.findIndex(x => x.id === beforeFolderId) : siblings.length;
    if (i < 0) i = siblings.length;
    const prev = siblings[i - 1]?.position;
    const next = siblings[i]?.position;
    const position = prev == null && next == null ? 1 : prev == null ? next - 1 : next == null ? prev + 1 : (prev + next) / 2;
    if (from === to && to.folders.indexOf(f) === i) return; // dropped where it already was
    from.folders = from.folders.filter(x => x !== f);
    f.position = position;
    to.folders.splice(i, 0, f);
    expanded.add(to.id);
    await commit('moveFolder', to, f);
  }

  let drag = null; // { classId, folderId }
  function clearDropMarks() {
    list.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }
  // Where would a drop at this point land? -> { classId, beforeFolderId, mark: [element, cssClass] }
  function dropTarget(e) {
    const folderEl = e.target.closest('[data-folder-id]');
    const classEl = e.target.closest('[data-class-id]');
    if (!classEl) return null;
    const classId = classEl.dataset.classId;
    const c = findClass(classId);
    if (folderEl && folderEl.dataset.folderId !== drag.folderId) {
      const r = folderEl.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const visible = c.folders.filter(isActive);
      const idx = visible.findIndex(x => x.id === folderEl.dataset.folderId);
      const before = after ? visible[idx + 1]?.id ?? null : folderEl.dataset.folderId;
      return { classId, beforeFolderId: before, mark: [folderEl, after ? 'drop-after' : 'drop-before'] };
    }
    if (folderEl) return null; // over itself
    return { classId, beforeFolderId: null, mark: [classEl.querySelector('.class-item'), 'drop-into'] };
  }

  // Chats and desktop files drop *into* a folder, or into a course (chats: the whole course;
  // files: its "Uploads" folder, made if needed).
  const draggingChat = e => ([...(e.dataTransfer?.types || [])].includes('application/x-eigen-chat') && window.eigenChats?.draggingId()) || null;
  const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  function intoTarget(e) {
    const classEl = e.target.closest('[data-class-id]');
    if (!classEl) return null;
    const folderEl = e.target.closest('[data-folder-id]');
    return folderEl
      ? { classId: classEl.dataset.classId, folderId: folderEl.dataset.folderId, mark: [folderEl, 'drop-into'] }
      : { classId: classEl.dataset.classId, folderId: null, mark: [classEl.querySelector('.class-item'), 'drop-into'] };
  }
  // Hovering a closed course while dragging opens it, so its folders can be reached.
  let hoverTimer = 0, hoverClass = null;
  function openOnHover(classId) {
    if (hoverClass === classId) return;
    clearTimeout(hoverTimer);
    hoverClass = classId;
    if (classId && !expanded.has(classId)) hoverTimer = setTimeout(() => { expanded.add(classId); render(); }, 700);
  }

  async function uploadsFolder(c) {
    const existing = c.folders.find(f => isActive(f) && f.name.toLowerCase() === 'uploads');
    if (existing) return existing;
    const last = c.folders[c.folders.length - 1];
    const f = { id: uid(), name: 'Uploads', createdAt: Date.now(), archivedAt: null, position: (last?.position ?? 0) + 1 };
    c.folders.push(f);
    expanded.add(c.id);
    await commit('addFolder', c, f);
    return findClass(c.id)?.folders.find(x => x.id === f.id) ?? null;
  }

  async function dropFiles(files, classId, folderId) {
    if (!files.length) return;
    if (store.kind !== 'supabase' || !window.eigenFiles?.canUpload()) return toast('Sign in to upload files.');
    const c = findClass(classId);
    if (!c) return;
    const folder = folderId ? c.folders.find(f => f.id === folderId) : await uploadsFolder(c);
    if (!folder) return;
    expanded.add(c.id);
    render();
    window.eigenFiles.upload(files, folder.id);
  }

  list.addEventListener('dragstart', e => {
    if (e.target.closest('[data-chat-id]')) return; // chats.js handles those
    const folderEl = e.target.closest('[data-folder-id]');
    const classEl = e.target.closest('[data-class-id]');
    if (!folderEl || !classEl) return;
    drag = { classId: classEl.dataset.classId, folderId: folderEl.dataset.folderId };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-eigen-folder', drag.folderId);
    requestAnimationFrame(() => folderEl.classList.add('dragging'));
  });
  list.addEventListener('dragover', e => {
    if (!drag && (draggingChat(e) || draggingFiles(e))) {
      const t = intoTarget(e);
      clearDropMarks();
      openOnHover(t?.classId ?? null);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = draggingChat(e) ? 'move' : 'copy';
      t.mark[0].classList.add(t.mark[1]);
      return;
    }
    if (!drag) return;
    const t = dropTarget(e);
    clearDropMarks();
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.mark[0].classList.add(t.mark[1]);
  });
  list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) { clearDropMarks(); openOnHover(null); } });
  list.addEventListener('drop', e => {
    openOnHover(null);
    if (!drag && (draggingChat(e) || draggingFiles(e))) {
      const t = intoTarget(e);
      clearDropMarks();
      if (!t) return;
      e.preventDefault();
      if (draggingChat(e)) window.eigenChats.move(draggingChat(e), t.classId, t.folderId);
      else dropFiles([...e.dataTransfer.files], t.classId, t.folderId);
      return;
    }
    if (!drag) return;
    const t = dropTarget(e);
    clearDropMarks();
    if (!t) return;
    e.preventDefault();
    moveFolder(drag.classId, drag.folderId, t.classId, t.beforeFolderId);
  });
  list.addEventListener('dragend', () => {
    drag = null;
    openOnHover(null);
    clearDropMarks();
    list.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging'));
  });

  function toggle(classId) {
    expanded.has(classId) ? expanded.delete(classId) : expanded.add(classId);
    render();
  }

  // ---------- Context menu ----------
  function openMenu(x, y, items) {
    menu.replaceChildren(...items.map(item => {
      if (item === '-') return el('<div class="context-sep" role="separator"></div>');
      const b = el(`<button class="context-item ${item.danger ? 'danger' : ''}" type="button" role="menuitem">${icon(item.icon)}<span></span></button>`);
      b.querySelector('span').textContent = item.label;
      b.addEventListener('click', () => { closeMenu(); item.run(); });
      return b;
    }));
    menu.hidden = false;
    const { innerWidth: w, innerHeight: h } = window;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, w - r.width - 8) + 'px';
    menu.style.top = Math.min(y, h - r.height - 8) + 'px';
    menu.querySelector('button')?.focus();
  }
  function closeMenu() { menu.hidden = true; }

  document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => {
    if (menu.hidden) return;
    if (e.key === 'Escape') closeMenu();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  window.addEventListener('resize', closeMenu);
  document.querySelector('.sidebar').addEventListener('scroll', closeMenu);

  list.addEventListener('contextmenu', e => {
    const folderEl = e.target.closest('[data-folder-id]');
    const classEl = e.target.closest('[data-class-id]');
    if (!classEl || e.target.closest('.inline-input')) return;
    e.preventDefault();
    const classId = classEl.dataset.classId;
    const x = e.clientX || e.target.getBoundingClientRect().left;
    const y = e.clientY || e.target.getBoundingClientRect().bottom;
    if (folderEl) {
      const folderId = folderEl.dataset.folderId;
      openMenu(x, y, [
        { label: 'Rename', icon: 'pencil', run: () => renameFolder(classId, folderId) },
        { label: 'Archive folder', icon: 'archive', run: () => archiveFolder(classId, folderId) },
        ...activeClasses().filter(c => c.id !== classId).map(c => ({
          label: `Move to ${c.name}`, icon: 'folder', run: () => moveFolder(classId, folderId, c.id),
        })),
        '-',
        { label: 'Delete folder', icon: 'trash', danger: true, run: () => deleteFolder(classId, folderId) },
      ]);
    } else {
      openMenu(x, y, [
        { label: 'Open AI chat', icon: 'sparkle', run: () => { location.hash = '#course/' + classId; } },
        { label: 'New folder', icon: 'folder-plus', run: () => addFolder(classId) },
        { label: 'Rename', icon: 'pencil', run: () => renameClass(classId) },
        { label: 'Archive course', icon: 'archive', run: () => archiveClass(classId) },
        '-',
        { label: 'Delete course', icon: 'trash', danger: true, run: () => deleteClass(classId) },
      ]);
    }
  });

  // ---------- Events ----------
  addBtn.addEventListener('click', addClass);
  window.addEventListener('hashchange', () => {
    const hidden = location.hash.startsWith('#folder/') && !list.querySelector(`.folder-row[href="${CSS.escape(location.hash)}"]`);
    if (hidden) return render();
    list.querySelectorAll('.folder-row').forEach(a => a.classList.toggle('active', a.getAttribute('href') === location.hash));
    list.querySelectorAll('.class-toggle').forEach(a => {
      const id = a.closest('[data-class-id]').dataset.classId;
      a.classList.toggle('active', location.hash === '#course/' + id || location.hash.startsWith(`#course/${id}/`));
    });
  });

  list.addEventListener('keydown', e => {
    const chev = e.target.closest('.chev-btn');
    if (chev && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(chev.closest('[data-class-id]').dataset.classId); }
  });

  list.addEventListener('click', e => {
    const classEl = e.target.closest('[data-class-id]');
    if (!classEl) return;
    if (e.target.closest('[data-action="add-folder"]')) return addFolder(classEl.dataset.classId);
    if (e.target.closest('.chev-btn')) { e.preventDefault(); return toggle(classEl.dataset.classId); }
    if (e.target.closest('.class-toggle')) expanded.add(classEl.dataset.classId); // opening the course chat also shows its folders
  });

  document.addEventListener('eigen:files-changed', () => { if (status === 'ready') refreshSizes(); });
  document.addEventListener('eigen:chats', render);

  // Shared with files.js.
  window.eigenUI = { el, icon, toast, confirmDelete, openMenu, closeMenu, inlineInput };
  window.eigenClasses = {
    status: () => status,
    findClass: id => findClass(id),
    findFolder(folderId) {
      for (const c of classes) {
        const f = c.folders.find(x => x.id === folderId);
        if (f) return { c, f };
      }
      return null;
    },
  };

  // Switch storage when the signed-in user changes.
  let currentUser;
  document.addEventListener('eigen:user', e => {
    const user = e.detail;
    const db = window.eigen?.supabase;
    const next = user && db ? user.id : 'guest';
    if (next === currentUser) return;
    currentUser = next;
    useStore(next === 'guest' ? localStore : supabaseStore(db), next);
  });
  // auth.js may have reported the signed-in state before this script loaded.
  if (currentUser === undefined) {
    const u = window.eigen?.currentUser?.();
    const db = window.eigen?.supabase;
    currentUser = u && db ? u.id : 'guest';
    useStore(currentUser === 'guest' ? localStore : supabaseStore(db), currentUser);
  }
})();

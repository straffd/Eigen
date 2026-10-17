// Notes written in Eigen: a title and plain text, saved as you type. A note lives in a folder (on the
// Notes & docs side of the folder page) or on the course itself, shows under it in the sidebar, and
// the course AI reads it along with the files. Notes are edited in the side panel (viewer.js) or
// full page (#note/<id>).
(() => {
  const SAVE_DELAY = 600;
  const $ = id => document.getElementById(id);
  const crumbEl = $('note-crumb');
  const titleEl = $('note-title');
  const bodyEl = $('note-body');
  const statusEl = $('note-status');
  const { toast, confirmDelete } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null;
  let noteId = null;
  let note = null;        // { id, class_id, folder_id, title, body, updated_at }
  let status = 'idle';    // 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  let dirty = false;
  let saveTimer = 0;
  let loadToken = 0;
  let all = [];           // every note's title and place, for the sidebar: [{ id, class_id, folder_id, title, updated_at }]

  const db = () => window.eigen?.supabase;
  const announce = n => {
    const i = all.findIndex(x => x.id === n.id);
    const gone = !n.title; // remove() announces { id } only
    if (gone) { if (i >= 0) all.splice(i, 1); }
    else {
      const meta = { id: n.id, class_id: n.class_id, folder_id: n.folder_id, title: n.title, updated_at: n.updated_at };
      if (i >= 0) all[i] = meta; else all.unshift(meta);
    }
    document.dispatchEvent(new CustomEvent('eigen:notes-changed', { detail: { id: n.id, classId: n.class_id, folderId: n.folder_id, from: n.from } }));
  };

  async function loadAll() {
    const { data, error } = await db().from('notes').select('id, class_id, folder_id, title, updated_at').order('updated_at', { ascending: false });
    all = error ? [] : data;
    document.dispatchEvent(new CustomEvent('eigen:notes-changed', { detail: {} }));
  }

  function describeError(err) {
    const msg = err?.message || '';
    if (/failed to fetch|network/i.test(msg)) return 'Couldn’t reach Eigen’s servers. Check your connection.';
    if (err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist|schema cache/i.test(msg))
      return 'Notes aren’t set up in the database yet. Run the latest supabase/schema.sql.';
    return 'Something went wrong saving your note.';
  }

  // ---------- Shared with the folder page and the library ----------
  // Notes in a folder (folderId), or every note in a course (classId). [] if notes aren't set up yet.
  async function list({ folderId = null, classId = null }) {
    let q = db().from('notes').select('id, class_id, folder_id, title, body, created_at, updated_at');
    q = folderId ? q.eq('folder_id', folderId) : q.eq('class_id', classId);
    const { data, error } = await q.order('updated_at', { ascending: false });
    return error ? [] : data;
  }

  // Makes a note and opens it in the side panel, ready to type, without leaving the page.
  async function create({ classId, folderId = null }) {
    const { data, error } = await db().from('notes').insert({ class_id: classId, folder_id: folderId })
      .select('id, class_id, folder_id, title, body, created_at, updated_at').single();
    if (error) { console.error(error); toast(describeError(error)); return null; }
    announce(data);
    window.eigenViewer.preview({ fileId: 'note:' + data.id, fileName: data.title, focusTitle: true });
    return data;
  }

  // Saves a change made in the side panel (title and/or body).
  async function saveNote(id, patch) {
    const row = { ...patch, updated_at: new Date().toISOString() };
    if ('title' in row) row.title = row.title.trim().slice(0, 200) || 'Untitled note';
    const { data, error } = await db().from('notes').update(row).eq('id', id).select('id, class_id, folder_id, title, updated_at').maybeSingle();
    if (error || !data) { console.error(error); toast(describeError(error)); return false; }
    announce(data);
    if (note?.id === id) Object.assign(note, row);
    return true;
  }

  // Moves a note to another folder, or onto a course (folderId null).
  async function move(id, { classId, folderId = null }) {
    const cur = all.find(x => x.id === id);
    if (cur && cur.class_id === classId && cur.folder_id === folderId) return;
    const { data, error } = await db().from('notes').update({ class_id: classId, folder_id: folderId }).eq('id', id)
      .select('id, class_id, folder_id, title, updated_at').maybeSingle();
    if (error || !data) { console.error(error); return toast(describeError(error)); }
    announce({ ...data, from: cur ? { classId: cur.class_id, folderId: cur.folder_id } : null });
    const c = window.eigenClasses.findClass(classId);
    const f = folderId && c?.folders.find(x => x.id === folderId);
    toast(`Moved “${data.title}” to ${f ? f.name : c?.name ?? 'the course'}.`);
  }

  async function remove(id) {
    const n = id === note?.id ? note : (await db().from('notes').select('id, class_id, folder_id, title').eq('id', id).maybeSingle()).data;
    if (!n) return;
    const ok = await confirmDelete(`Delete “${n.title}”?`, 'This can’t be undone.');
    if (!ok) return;
    const { error } = await db().from('notes').delete().eq('id', id);
    if (error) return toast(describeError(error));
    announce({ id, class_id: n.class_id, folder_id: n.folder_id });
    if (window.eigenViewer.isOpen('note:' + id)) window.eigenViewer.close();
    if (id === noteId) {
      clearTimeout(saveTimer);
      dirty = false;
      location.hash = n.folder_id ? '#folder/' + n.folder_id : '#library/' + n.class_id;
    }
  }

  // ---------- Editor ----------
  function where(n) {
    const c = window.eigenClasses.findClass(n.class_id);
    const f = n.folder_id && c?.folders.find(x => x.id === n.folder_id);
    return { c, f };
  }

  function render() {
    const editable = status === 'ready' && note;
    titleEl.disabled = bodyEl.disabled = !editable;
    $('note-delete').hidden = !editable;
    if (!editable) {
      titleEl.value = '';
      bodyEl.value = '';
      crumbEl.replaceChildren();
      statusEl.textContent = status === 'loading' ? 'Loading…'
        : status === 'missing' ? 'This note doesn’t exist anymore.'
        : status === 'error' ? 'Couldn’t load this note.'
        : !user ? 'Sign in to write notes.' : '';
      return;
    }
    const { c, f } = where(note);
    const link = (text, href) => { const a = document.createElement('a'); a.href = href; a.textContent = text; return a; };
    crumbEl.replaceChildren(
      link(c?.name ?? 'Course', '#library/' + note.class_id),
      ...(f ? [document.createTextNode(' / '), link(f.name, '#folder/' + f.id)] : []),
    );
    if (document.activeElement !== titleEl) titleEl.value = note.title;
    if (document.activeElement !== bodyEl) bodyEl.value = note.body;
    document.title = `${note.title} · Eigen`;
    statusEl.textContent = dirty ? 'Saving…' : `Saved ${new Date(note.updated_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
    autosize();
  }

  function autosize() { bodyEl.style.height = 'auto'; bodyEl.style.height = Math.max(bodyEl.scrollHeight, 320) + 'px'; }

  async function load() {
    const token = ++loadToken;
    status = 'loading';
    note = null;
    render();
    const { data, error } = await db().from('notes').select('id, class_id, folder_id, title, body, updated_at').eq('id', noteId).maybeSingle();
    if (token !== loadToken) return;
    if (error) { console.error(error); status = 'error'; }
    else if (!data) status = 'missing';
    else { note = data; status = 'ready'; }
    render();
    if (note && !note.body && note.title === 'Untitled note') requestAnimationFrame(() => { titleEl.focus(); titleEl.select(); });
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty || !note) return;
    const n = note;
    const patch = { title: titleEl.value.trim().slice(0, 200) || 'Untitled note', body: bodyEl.value, updated_at: new Date().toISOString() };
    dirty = false;
    const { error } = await db().from('notes').update(patch).eq('id', n.id);
    if (error) { console.error(error); dirty = true; statusEl.textContent = 'Not saved'; return toast(describeError(error)); }
    Object.assign(n, patch);
    announce({ ...n });
    if (n === note) render();
  }

  function edited() {
    dirty = true;
    statusEl.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }
  titleEl.addEventListener('input', edited);
  bodyEl.addEventListener('input', () => { autosize(); edited(); });
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
  titleEl.addEventListener('blur', () => { if (!titleEl.value.trim() && note) { titleEl.value = 'Untitled note'; edited(); } });
  $('note-delete').addEventListener('click', () => note && remove(note.id));
  window.addEventListener('beforeunload', e => { if (dirty) { save(); e.preventDefault(); } });

  // ---------- Routing ----------
  function sync() {
    const next = location.hash.startsWith('#note/') ? location.hash.slice(6) : null;
    if (next !== noteId && dirty) save(); // leaving a note: save what's typed
    if (!next) { noteId = null; return; }
    const changed = next !== noteId;
    noteId = next;
    if (!user || !db()) { status = 'idle'; note = null; render(); return; }
    if (changed || status === 'idle') load();
    else render();
  }
  window.addEventListener('hashchange', sync);
  document.addEventListener('eigen:classes', () => { if (noteId && note) render(); });
  document.addEventListener('eigen:user', e => {
    const next = e.detail || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    status = 'idle';
    all = [];
    if (user && db()) loadAll(); else document.dispatchEvent(new CustomEvent('eigen:notes-changed', { detail: {} }));
    sync();
  });

  // ---------- Sidebar ----------
  function sidebarRows(classId, folderId = null) {
    return all.filter(n => n.class_id === classId && n.folder_id === folderId).map(n => {
      const li = document.createElement('li');
      li.className = 'side-note';
      li.dataset.noteId = n.id;
      li.innerHTML = `<button class="row file-row" type="button" draggable="true" title="Open note"><svg><use href="#i-pencil"/></svg><span class="file-name"></span></button>`;
      li.querySelector('.file-name').textContent = n.title;
      return li;
    });
  }
  const sidebar = document.querySelector('.sidebar');
  const openInPanel = id => { const n = all.find(x => x.id === id); if (n) window.eigenViewer.preview({ fileId: 'note:' + id, fileName: n.title }); };
  sidebar.addEventListener('click', e => {
    const item = e.target.closest('.side-note[data-note-id]');
    if (item) openInPanel(item.dataset.noteId);
  });
  sidebar.addEventListener('dragstart', e => {
    const item = e.target.closest?.('.side-note[data-note-id]');
    if (item) window.eigenUI.drag.start(e, { type: 'note', id: item.dataset.noteId });
  });
  sidebar.addEventListener('contextmenu', e => {
    const item = e.target.closest('.side-note[data-note-id]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const id = item.dataset.noteId;
    const r = item.getBoundingClientRect();
    window.eigenUI.openMenu(e.clientX || r.left, e.clientY || r.bottom, [
      { label: 'Open', icon: 'pencil', run: () => openInPanel(id) },
      { label: 'Open full page', icon: 'external', run: () => { location.hash = '#note/' + id; } },
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, run: () => remove(id) },
    ]);
  }, true);

  window.eigenNotes = {
    sidebarRows,
    list, create, save: saveNote, move, remove,
    find: id => all.find(n => n.id === id),
    // Notes directly in a folder, or on the course itself (folderId null), for the sidebar.
    under: (classId, folderId = null) => all.filter(n => n.class_id === classId && n.folder_id === folderId),
  };
  if (user && db()) loadAll();
  sync();
})();

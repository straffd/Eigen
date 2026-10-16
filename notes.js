// Notes written in Eigen (#note/<id>): a title and plain text, saved as you type. A note lives in a
// folder (on the Notes & docs side of the folder page) or on the course itself, and the course AI
// reads it along with the files.
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

  const db = () => window.eigen?.supabase;
  const announce = n => document.dispatchEvent(new CustomEvent('eigen:notes-changed', { detail: { classId: n.class_id, folderId: n.folder_id } }));

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

  async function create({ classId, folderId = null }) {
    const { data, error } = await db().from('notes').insert({ class_id: classId, folder_id: folderId })
      .select('id, class_id, folder_id, title, body, created_at, updated_at').single();
    if (error) { console.error(error); toast(describeError(error)); return null; }
    announce(data);
    location.hash = '#note/' + data.id;
    return data;
  }

  async function remove(id) {
    const n = id === note?.id ? note : (await db().from('notes').select('id, class_id, folder_id, title').eq('id', id).maybeSingle()).data;
    if (!n) return;
    const ok = await confirmDelete(`Delete “${n.title}”?`, 'This can’t be undone.');
    if (!ok) return;
    const { error } = await db().from('notes').delete().eq('id', id);
    if (error) return toast(describeError(error));
    announce(n);
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
    announce(n);
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
    sync();
  });

  window.eigenNotes = { list, create, remove };
  sync();
})();

// Chats started by typing on the home page (#chat/<id>). They're listed under Chats in the sidebar.
// Dragging a chat onto a course or folder files it there: it then answers from that course's (or
// folder's) files and shows under it in the sidebar. Dragging it onto Chats takes it back out.
(() => {
  const MAX_TITLE = 60;
  const $ = id => document.getElementById(id);
  const section = $('chats-section');
  const listEl = $('chat-list');
  const emptyEl = $('chats-empty');
  const { el, icon, toast, confirmDelete, openMenu, inlineInput } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null;
  let chats = [];        // [{ id, title, classId, folderId, updatedAt }], most recent first
  let status = 'idle';   // 'idle' | 'loading' | 'ready' | 'error'
  let loadToken = 0;

  const db = () => window.eigen?.supabase;
  const find = id => chats.find(c => c.id === id);
  const fromRow = r => ({ id: r.id, title: r.title, classId: r.class_id, folderId: r.folder_id, updatedAt: Date.parse(r.updated_at) });
  const sortChats = () => chats.sort((a, b) => b.updatedAt - a.updatedAt);

  // Where a chat shows in the sidebar: under its course/folder, or under Chats if it has none
  // (or its course was deleted). Chats in an archived course or folder are put away with it.
  function placement(c) {
    if (!c.classId) return { kind: 'loose' };
    const course = window.eigenClasses.findClass(c.classId);
    if (!course) return window.eigenClasses.status() === 'ready' ? { kind: 'loose' } : { kind: 'hidden' };
    if (course.archivedAt) return { kind: 'hidden' };
    const folder = c.folderId ? course.folders.find(f => f.id === c.folderId) : null;
    if (c.folderId && folder?.archivedAt) return { kind: 'hidden' };
    return { kind: 'placed', classId: course.id, folderId: folder ? folder.id : null };
  }

  function describeError(err) {
    const msg = err?.message || '';
    if (/failed to fetch|network/i.test(msg)) return 'Couldn’t reach Eigen’s servers. Check your connection.';
    if (err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist|schema cache/i.test(msg))
      return 'Chats aren’t set up in the database yet. Run the latest supabase/schema.sql.';
    return 'Something went wrong saving your chat.';
  }

  // ---------- Render ----------
  function chatRow(c) {
    const li = el(`
      <li class="chat-item" data-chat-id="${c.id}">
        <a class="row chat-row ${location.hash === '#chat/' + c.id ? 'active' : ''}" href="#chat/${c.id}" draggable="true">${icon('message')}<span class="chat-name"></span></a>
      </li>`);
    li.querySelector('.chat-name').textContent = c.title;
    return li;
  }

  function render() {
    section.hidden = !user || !db();
    const loose = chats.filter(c => placement(c).kind === 'loose');
    listEl.replaceChildren(...loose.map(chatRow));
    emptyEl.hidden = loose.length > 0;
    emptyEl.textContent = status === 'loading' ? 'Loading chats…'
      : status === 'error' ? 'Couldn’t load your chats.'
      : 'Type on Home to start a chat.';
    document.dispatchEvent(new CustomEvent('eigen:chats'));
  }

  // ---------- Data ----------
  async function load() {
    const token = ++loadToken;
    status = 'loading';
    chats = [];
    render();
    const { data, error } = await db().from('chats').select('id, title, class_id, folder_id, updated_at')
      .order('updated_at', { ascending: false }).limit(200);
    if (token !== loadToken) return;
    if (error) {
      console.error(error);
      status = 'error';
    } else {
      chats = data.map(fromRow);
      status = 'ready';
    }
    render();
  }

  // Starts a chat named after its first question.
  async function create(question) {
    const words = question.replace(/\s+/g, ' ').trim();
    const title = words.length > MAX_TITLE ? words.slice(0, MAX_TITLE - 1).replace(/\s+\S*$/, '') + '…' : words;
    const { data, error } = await db().from('chats').insert({ title: title || 'New chat' })
      .select('id, title, class_id, folder_id, updated_at').single();
    if (error) { console.error(error); toast(describeError(error)); return null; }
    const c = fromRow(data);
    chats.unshift(c);
    render();
    return c;
  }

  // Files a chat under a course or folder (folderId null = the whole course), or back under Chats (classId null).
  async function move(chatId, classId, folderId = null, { quiet = false } = {}) {
    const c = find(chatId);
    if (!c || (c.classId === classId && c.folderId === folderId)) return;
    const before = { classId: c.classId, folderId: c.folderId };
    Object.assign(c, { classId, folderId: classId ? folderId : null });
    render();
    const { error } = await db().from('chats').update({ class_id: c.classId, folder_id: c.folderId }).eq('id', chatId);
    if (error) {
      console.error(error);
      Object.assign(c, before);
      render();
      return toast(describeError(error));
    }
    if (quiet) return;
    const course = classId && window.eigenClasses.findClass(classId);
    const where = !course ? 'Chats' : folderId ? course.folders.find(f => f.id === folderId)?.name ?? course.name : course.name;
    toast(`Moved “${c.title}” to ${where}.`, { label: 'Undo', run: () => move(chatId, before.classId, before.folderId, { quiet: true }) });
  }

  // Keeps the most recently used chat at the top.
  function touch(chatId) {
    const c = find(chatId);
    if (!c) return;
    c.updatedAt = Date.now();
    sortChats();
    render();
  }

  async function rename(chatId) {
    const c = find(chatId);
    const row = document.querySelector(`.sidebar [data-chat-id="${chatId}"]`);
    if (!c || !row) return;
    row.innerHTML = `<div class="chat-row editing">${icon('message')}<span class="slot"></span></div>`;
    const title = await inlineInput(row.querySelector('.slot'), { value: c.title, maxLength: MAX_TITLE });
    if (!title || title === c.title) return render();
    const old = c.title;
    c.title = title;
    render();
    const { error } = await db().from('chats').update({ title }).eq('id', chatId);
    if (error) { console.error(error); c.title = old; render(); toast(describeError(error)); }
  }

  async function remove(chatId) {
    const c = find(chatId);
    if (!c) return;
    const ok = await confirmDelete(`Delete “${c.title}”?`, 'This deletes the chat and its messages. This can’t be undone.');
    if (!ok) return;
    const { error } = await db().from('chats').delete().eq('id', chatId);
    if (error) { console.error(error); return toast(describeError(error)); }
    chats = chats.filter(x => x !== c);
    if (location.hash === '#chat/' + chatId) location.hash = '';
    render();
  }

  // ---------- Events ----------
  // Right-click a chat anywhere in the sidebar (under Chats or inside a course).
  document.querySelector('.sidebar').addEventListener('contextmenu', e => {
    const item = e.target.closest('[data-chat-id]');
    if (!item || e.target.closest('.inline-input')) return;
    e.preventDefault();
    e.stopPropagation();
    const chatId = item.dataset.chatId;
    const c = find(chatId);
    if (!c) return;
    const x = e.clientX || item.getBoundingClientRect().left;
    const y = e.clientY || item.getBoundingClientRect().bottom;
    openMenu(x, y, [
      { label: 'Rename', icon: 'pencil', run: () => rename(chatId) },
      ...(c.classId ? [{ label: 'Move out of course', icon: 'message', run: () => move(chatId, null) }] : []),
      '-',
      { label: 'Delete chat', icon: 'trash', danger: true, run: () => remove(chatId) },
    ]);
  }, true);

  // Dropping a chat on the Chats section takes it out of its course.
  let dragId = null;
  document.querySelector('.sidebar').addEventListener('dragstart', e => {
    const item = e.target.closest?.('[data-chat-id]');
    if (!item) return;
    dragId = item.dataset.chatId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-eigen-chat', dragId);
    requestAnimationFrame(() => item.classList.add('dragging'));
  });
  document.querySelector('.sidebar').addEventListener('dragend', () => {
    dragId = null;
    section.classList.remove('drop-into');
    document.querySelectorAll('.chat-item.dragging').forEach(n => n.classList.remove('dragging'));
  });
  const chatDrag = e => [...(e.dataTransfer?.types || [])].includes('application/x-eigen-chat');
  section.addEventListener('dragover', e => {
    if (!chatDrag(e) || !find(dragId)?.classId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    section.classList.add('drop-into');
  });
  section.addEventListener('dragleave', e => { if (!section.contains(e.relatedTarget)) section.classList.remove('drop-into'); });
  section.addEventListener('drop', e => {
    section.classList.remove('drop-into');
    if (!chatDrag(e) || !find(dragId)?.classId) return;
    e.preventDefault();
    move(dragId, null);
  });

  window.addEventListener('hashchange', () => {
    document.querySelectorAll('.sidebar .chat-row').forEach(a => a.classList.toggle('active', a.getAttribute('href') === location.hash));
  });
  // Courses loaded or changed: chats in them may need to move between sections.
  document.addEventListener('eigen:classes', () => {
    if (status !== 'ready') return;
    const loose = chats.filter(c => placement(c).kind === 'loose').map(c => c.id).join();
    if (loose !== [...listEl.children].map(li => li.dataset.chatId).filter(Boolean).join()) render();
  });

  function sync() {
    if (user && db()) load();
    else { loadToken++; status = 'idle'; chats = []; render(); }
  }
  document.addEventListener('eigen:user', e => {
    const next = e.detail || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    sync();
  });

  window.eigenChats = {
    status: () => status,
    find,
    // Chats filed directly under a course (folderId null) or under one of its folders.
    under: (classId, folderId = null) => chats.filter(c => {
      const p = placement(c);
      return p.kind === 'placed' && p.classId === classId && p.folderId === folderId;
    }),
    row: chatRow,
    create, move, touch, rename, remove,
    isDragging: () => !!dragId,
    draggingId: () => dragId,
  };
  sync();
})();

// Classes and their folders in the sidebar.
// Signed in: stored in Supabase (tables from supabase/schema.sql).
// Signed out: stored in this browser's localStorage, and moved into the account on first sign-in.
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

  let classes = [];   // [{ id, name, createdAt, folders: [{ id, name, createdAt }] }]
  let store = null;
  let status = 'loading'; // 'loading' | 'ready' | 'error'
  const expanded = new Set();

  const uid = () => crypto.randomUUID();
  const findClass = id => classes.find(c => c.id === id);
  const byCreated = (a, b) => a.createdAt - b.createdAt;

  // ---------- Storage: browser (guest) ----------
  const localStore = {
    kind: 'local',
    async list() {
      try { return JSON.parse(localStorage.getItem(GUEST_KEY)) || []; } catch { return []; }
    },
    persist() {
      try { localStorage.setItem(GUEST_KEY, JSON.stringify(classes)); } catch {}
    },
    async addClass() { this.persist(); },
    async renameClass() { this.persist(); },
    async deleteClass() { this.persist(); },
    async addFolder() { this.persist(); },
    async renameFolder() { this.persist(); },
    async deleteFolder() { this.persist(); },
  };

  // ---------- Storage: Supabase (signed in) ----------
  function supabaseStore(db) {
    const check = ({ error }) => { if (error) throw error; };
    return {
      kind: 'supabase',
      async list() {
        const { data, error } = await db.from('classes')
          .select('id, name, created_at, folders(id, name, created_at)');
        if (error) throw error;
        return data.map(c => ({
          id: c.id,
          name: c.name,
          createdAt: Date.parse(c.created_at),
          folders: (c.folders || [])
            .map(f => ({ id: f.id, name: f.name, createdAt: Date.parse(f.created_at) }))
            .sort(byCreated),
        })).sort(byCreated);
      },
      async addClass(c) { check(await db.from('classes').insert({ id: c.id, name: c.name })); },
      async renameClass(c) { check(await db.from('classes').update({ name: c.name }).eq('id', c.id)); },
      async deleteClass(c) { check(await db.from('classes').delete().eq('id', c.id)); },
      async addFolder(c, f) { check(await db.from('folders').insert({ id: f.id, class_id: c.id, name: f.name })); },
      async renameFolder(c, f) { check(await db.from('folders').update({ name: f.name }).eq('id', f.id)); },
      async deleteFolder(c, f) { check(await db.from('folders').delete().eq('id', f.id)); },
    };
  }

  function describeError(err) {
    const msg = err?.message || '';
    if (/class_limit/.test(msg)) return `Free plan includes up to ${MAX_CLASSES} classes.`;
    if (/failed to fetch|network/i.test(msg)) return 'Couldn’t reach Eigen’s servers. Check your connection.';
    if (err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist|schema cache/i.test(msg))
      return 'Classes aren’t set up in the database yet.';
    return 'Something went wrong saving your classes.';
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
    } catch (err) {
      if (gen !== generation) return;
      console.error(err);
      status = 'error';
      classes = [];
      toast(describeError(err));
    }
    render();
  }

  // Move classes made while signed out into a newly signed-in account (only if the account has none).
  // Also picks up classes saved per-account in the browser by the previous version of Eigen.
  async function importGuestClasses(userId) {
    const legacyKey = 'eigen.classes.' + userId;
    let guest = await localStore.list();
    if (!guest.length) {
      try { guest = JSON.parse(localStorage.getItem(legacyKey)) || []; } catch { guest = []; }
    }
    if (!guest.length || classes.length) return;
    try {
      for (const c of guest.slice(0, MAX_CLASSES)) {
        await store.addClass(c);
        for (const f of c.folders) await store.addFolder(c, f);
      }
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(legacyKey);
      toast('Moved your classes into your account.');
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
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
  }

  function confirmDelete(title, text) {
    return new Promise(resolve => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
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
  function inlineInput(container, { value = '', placeholder = '', className = '' }) {
    return new Promise(resolve => {
      const input = el(`<input class="inline-input ${className}" maxlength="${MAX_NAME}" spellcheck="false">`);
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
  function render() {
    list.replaceChildren(...classes.map(renderClass));
    empty.hidden = classes.length > 0 && status === 'ready';
    empty.textContent = status === 'loading' ? 'Loading classes…'
      : status === 'error' ? 'Couldn’t load your classes.'
      : 'No classes yet. Press + to add one.';
    const full = classes.length >= MAX_CLASSES || status !== 'ready';
    addBtn.classList.toggle('is-disabled', full);
    limitNote.hidden = !(classes.length >= MAX_CLASSES);
    addBtn.setAttribute('aria-label', full ? 'Can’t add a class right now' : 'Add class');
  }

  function renderClass(c) {
    const open = expanded.has(c.id);
    const li = el(`
      <li class="class" data-class-id="${c.id}">
        <div class="class-item">
          <button class="row class-toggle" type="button" aria-expanded="${open}">
            ${icon('chevron', 'chev')}<span class="class-name"></span>
          </button>
          <div class="class-actions">
            <button class="icon-btn" type="button" data-action="add-folder" aria-label="Add folder">${icon('circle-plus', 'sm')}</button>
            <button class="icon-btn" type="button" aria-label="Class settings">${icon('settings', 'sm')}</button>
          </div>
        </div>
        <ul class="folder-list" ${open ? '' : 'hidden'}></ul>
      </li>`);
    li.querySelector('.class-name').textContent = c.name;
    const folders = li.querySelector('.folder-list');
    if (c.folders.length) {
      folders.append(...c.folders.map(f => renderFolder(c, f)));
    } else {
      folders.append(el(`<li class="folder-empty">No folders yet</li>`));
    }
    return li;
  }

  function renderFolder(c, f) {
    const li = el(`
      <li class="folder" data-folder-id="${f.id}">
        <button class="row folder-row" type="button">${icon('folder')}<span class="folder-name"></span></button>
      </li>`);
    li.querySelector('.folder-name').textContent = f.name;
    return li;
  }

  // ---------- Actions ----------
  async function addClass() {
    if (status !== 'ready') return;
    if (classes.length >= MAX_CLASSES) {
      toast(`Free plan includes up to ${MAX_CLASSES} classes.`);
      return;
    }
    const slot = el(`<li class="class"><div class="class-item editing"></div></li>`);
    list.append(slot);
    empty.hidden = true;
    const name = await inlineInput(slot.firstElementChild, { placeholder: 'Class name, e.g. COMP1511' });
    if (!name || classes.length >= MAX_CLASSES) return render();
    const c = { id: uid(), name, folders: [], createdAt: Date.now() };
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
    const f = { id: uid(), name, createdAt: Date.now() };
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
      n ? `This also deletes its ${n} folder${n === 1 ? '' : 's'}. This can’t be undone.` : 'This can’t be undone.');
    if (!ok) return;
    classes = classes.filter(x => x.id !== classId);
    expanded.delete(classId);
    await commit('deleteClass', c);
  }

  async function deleteFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    if (!f) return;
    const ok = await confirmDelete(`Delete ${f.name}?`, 'This can’t be undone.');
    if (!ok) return;
    c.folders = c.folders.filter(x => x.id !== folderId);
    await commit('deleteFolder', c, f);
  }

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
        '-',
        { label: 'Delete folder', icon: 'trash', danger: true, run: () => deleteFolder(classId, folderId) },
      ]);
    } else {
      openMenu(x, y, [
        { label: 'New folder', icon: 'folder-plus', run: () => addFolder(classId) },
        { label: 'Rename', icon: 'pencil', run: () => renameClass(classId) },
        '-',
        { label: 'Delete class', icon: 'trash', danger: true, run: () => deleteClass(classId) },
      ]);
    }
  });

  // ---------- Events ----------
  addBtn.addEventListener('click', addClass);

  list.addEventListener('click', e => {
    const classEl = e.target.closest('[data-class-id]');
    if (!classEl) return;
    if (e.target.closest('[data-action="add-folder"]')) return addFolder(classEl.dataset.classId);
    if (e.target.closest('.class-toggle')) return toggle(classEl.dataset.classId);
  });

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
  // auth.js reports the initial (signed-out) state before this script loads.
  if (currentUser === undefined) { currentUser = 'guest'; useStore(localStore); }
})();

// Classes and their folders in the sidebar.
// Stored in localStorage for now, one list per signed-in account ("guest" when signed out).
(() => {
  const MAX_CLASSES = 4; // Free plan limit
  const MAX_NAME = 40;

  const $ = id => document.getElementById(id);
  const list = $('class-list');
  const addBtn = $('add-class');
  const empty = $('classes-empty');
  const limitNote = $('classes-limit');
  const menu = $('context-menu');
  const confirmDialog = $('confirm-dialog');
  const toastEl = $('toast');

  // ---------- Storage ----------
  let storageKey = 'eigen.classes.guest';
  let classes = [];
  const expanded = new Set();

  function load() {
    try { classes = JSON.parse(localStorage.getItem(storageKey)) || []; }
    catch { classes = []; }
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(classes)); } catch {}
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const findClass = id => classes.find(c => c.id === id);

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
    empty.hidden = classes.length > 0;
    const full = classes.length >= MAX_CLASSES;
    limitNote.hidden = !full;
    addBtn.classList.toggle('is-disabled', full);
    addBtn.setAttribute('aria-label', full ? 'Class limit reached' : 'Add class');
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
    if (classes.length >= MAX_CLASSES) {
      toast(`Free plan includes up to ${MAX_CLASSES} classes.`);
      return;
    }
    const slot = el(`<li class="class"><div class="class-item editing"></div></li>`);
    list.append(slot);
    empty.hidden = true;
    const name = await inlineInput(slot.firstElementChild, { placeholder: 'Class name, e.g. COMP1511' });
    if (name) {
      const c = { id: uid(), name, folders: [], createdAt: Date.now() };
      classes.push(c);
      save();
    }
    render();
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
    if (name) {
      c.folders.push({ id: uid(), name, createdAt: Date.now() });
      save();
    }
    render();
  }

  async function renameClass(classId) {
    const c = findClass(classId);
    const row = list.querySelector(`[data-class-id="${classId}"] .class-item`);
    if (!c || !row) return;
    row.classList.add('editing');
    const name = await inlineInput(row, { value: c.name });
    if (name && name !== c.name) { c.name = name; save(); }
    render();
  }

  async function renameFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    const li = list.querySelector(`[data-folder-id="${folderId}"]`);
    if (!f || !li) return;
    li.innerHTML = `<div class="folder-row editing">${icon('folder')}<span class="slot"></span></div>`;
    const name = await inlineInput(li.querySelector('.slot'), { value: f.name });
    if (name && name !== f.name) { f.name = name; save(); }
    render();
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
    save();
    render();
  }

  async function deleteFolder(classId, folderId) {
    const c = findClass(classId);
    const f = c?.folders.find(x => x.id === folderId);
    if (!f) return;
    const ok = await confirmDelete(`Delete ${f.name}?`, 'This can’t be undone.');
    if (!ok) return;
    c.folders = c.folders.filter(x => x.id !== folderId);
    save();
    render();
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

  // Switch to the signed-in user's classes.
  document.addEventListener('eigen:user', e => {
    const key = 'eigen.classes.' + (e.detail?.id || 'guest');
    if (key === storageKey) return;
    storageKey = key;
    expanded.clear();
    load();
    render();
  });

  load();
  render();
})();

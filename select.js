// Selecting several items at once, in the sidebar and in the course library: drag a box from empty
// space (or from the empty part of a row, beside its name), or Ctrl/Cmd-click and Shift-click rows.
// Selected items can be deleted together (Delete key, right-click, or the bar that appears) and
// dragged together onto a folder or course. Dragging a row by its name or icon still moves it.
(() => {
  const { el, icon, toast, confirmDelete, openMenu } = window.eigenUI;
  const NAME_PARTS = '.file-name, .folder-name, .chat-name, .class-name, .file-badge, svg, .lib-chev, .chev-btn, .class-actions, .icon-btn, .inline-input, input, textarea, select, .kind-tag';

  const LABELS = { folder: ['folder', 'folders'], file: ['file', 'files'], note: ['note', 'notes'], chat: ['chat', 'chats'] };
  const describe = keys => {
    const counts = {};
    for (const k of keys) { const t = k.split(':')[0]; counts[t] = (counts[t] || 0) + 1; }
    return Object.entries(counts).map(([t, n]) => `${n} ${LABELS[t][n === 1 ? 0 : 1]}`).join(', ');
  };

  // Deletes the given items ('folder:<id>', 'file:<id>', 'note:<id>', 'chat:<id>') after one confirmation.
  async function deleteItems(keys) {
    if (!keys.length) return false;
    const of = t => keys.filter(k => k.startsWith(t + ':')).map(k => k.slice(t.length + 1));
    const folders = of('folder');
    const ok = await confirmDelete(`Delete ${describe(keys)}?`,
      (folders.length ? 'Everything inside the folders is deleted too. ' : '') + 'This can’t be undone.');
    if (!ok) return false;
    const results = await Promise.all([
      window.eigenFiles.deleteMany(of('file')),
      window.eigenNotes.removeMany(of('note')),
      window.eigenChats.removeMany(of('chat')),
    ]);
    if (folders.length) results.push(await window.eigenClasses.deleteFolders(folders));
    if (results.every(Boolean)) toast(`Deleted ${describe(keys)}.`);
    return true;
  }

  // One selectable area (the sidebar, the library list). Items are elements with data-sel="type:id".
  function selectable(container, { bar }) {
    const selected = new Set();
    let anchor = null;      // last clicked key, for Shift-click ranges
    const items = () => [...container.querySelectorAll('[data-sel]')].filter(x => x.offsetParent !== null);
    const keyOf = x => x.dataset.sel;

    function paint() {
      // Items can disappear (deleted, collapsed into a closed course): forget them.
      const present = new Set([...container.querySelectorAll('[data-sel]')].map(keyOf));
      for (const k of [...selected]) if (!present.has(k)) selected.delete(k);
      container.querySelectorAll('[data-sel]').forEach(x => x.classList.toggle('selected', selected.has(keyOf(x))));
      bar.hidden = selected.size < 1;
      bar.querySelector('.sel-count').textContent = `${selected.size} selected`;
    }
    const set = keys => { selected.clear(); keys.forEach(k => selected.add(k)); paint(); };
    // Lists re-render often: keep the selection showing.
    new MutationObserver(() => paint()).observe(container, { childList: true, subtree: true });

    // Ctrl/Cmd-click toggles, Shift-click selects a range; a plain click clears the selection.
    container.addEventListener('click', e => {
      const item = e.target.closest('[data-sel]');
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (!item) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const k = keyOf(item);
        if (e.shiftKey && anchor) {
          const list = items().map(keyOf);
          const [a, b] = [list.indexOf(anchor), list.indexOf(k)].sort((x, y) => x - y);
          if (a >= 0) list.slice(a, b + 1).forEach(x => selected.add(x));
        } else if (selected.has(k)) selected.delete(k);
        else selected.add(k);
        anchor = k;
        paint();
      } else if (selected.size && !dragged) set([]);
    }, true);

    // Drag a box. It starts on empty space, or on the empty part of a row (not its name or icon,
    // which drag the row itself), and only after the pointer moves a little, so clicks still work.
    let start = null, box = null, before = null, dragged = false;
    container.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest(NAME_PARTS)) return;
      e.preventDefault(); // no native drag or text selection from here
      start = { x: e.clientX, y: e.clientY, additive: e.ctrlKey || e.metaKey || e.shiftKey };
      before = new Set(selected);
      dragged = false;
    });
    document.addEventListener('mousemove', e => {
      if (!start) return;
      if (!box) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        box = el('<div class="sel-box"></div>');
        document.body.append(box);
        dragged = true;
      }
      const r = { left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY), right: Math.max(start.x, e.clientX), bottom: Math.max(start.y, e.clientY) };
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.right - r.left + 'px', height: r.bottom - r.top + 'px' });
      selected.clear();
      if (start.additive) before.forEach(k => selected.add(k));
      for (const x of items()) {
        const b = x.getBoundingClientRect();
        if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) selected.add(keyOf(x));
      }
      paint();
      // Scroll the list when the box reaches its edge.
      const scroller = container.closest('.sidebar') || container.closest('.main');
      const sr = scroller.getBoundingClientRect();
      if (e.clientY > sr.bottom - 24) scroller.scrollTop += 12;
      else if (e.clientY < sr.top + 24) scroller.scrollTop -= 12;
    });
    document.addEventListener('mouseup', () => {
      if (!start) return;
      start = null;
      box?.remove();
      box = null;
      setTimeout(() => { dragged = false; }); // the click that follows a box isn't a "clear" click
    });

    // Right-click on a selected item acts on the whole selection.
    container.addEventListener('contextmenu', e => {
      const item = e.target.closest('[data-sel]');
      if (!item || selected.size < 2 || !selected.has(keyOf(item))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openMenu(e.clientX, e.clientY, [
        { label: `Delete ${selected.size} items`, icon: 'trash', danger: true, run: () => removeSelected() },
        { label: 'Clear selection', icon: 'close', run: () => set([]) },
      ]);
    }, true);

    async function removeSelected() {
      if (await deleteItems([...selected])) set([]);
    }
    bar.querySelector('[data-act="delete"]').addEventListener('click', removeSelected);
    bar.querySelector('[data-act="clear"]').addEventListener('click', () => set([]));

    return {
      keys: () => [...selected],
      has: k => selected.has(k),
      clear: () => set([]),
      removeSelected,
      size: () => selected.size,
    };
  }

  function makeBar() {
    return el(`
      <div class="sel-bar" hidden>
        <span class="sel-count"></span>
        <button type="button" class="sel-act danger" data-act="delete">${icon('trash')}Delete</button>
        <button type="button" class="sel-act" data-act="clear">Clear</button>
      </div>`);
  }

  // The sidebar: courses' folders, files and notes, and chats.
  const sidebarBar = makeBar();
  document.querySelector('.sidebar .account').before(sidebarBar);
  const sidebar = selectable(document.querySelector('.sidebar .classes'), { bar: sidebarBar });

  // The course library list.
  const libraryBar = makeBar();
  document.getElementById('library-content').after(libraryBar); // below the list, so it never pushes rows around
  const library = selectable(document.getElementById('library-content'), { bar: libraryBar });

  // Delete / Backspace deletes the selection; Escape clears it.
  let last = sidebar;
  document.addEventListener('mousedown', e => {
    if (e.target.closest('.sidebar')) last = sidebar;
    else if (e.target.closest('#library-content, .library-view .sel-bar')) last = library;
  }, true);
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    const area = last.size() ? last : sidebar.size() ? sidebar : library.size() ? library : null;
    if (!area) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); area.removeSelected(); }
    else if (e.key === 'Escape') area.clear();
  });
  // Leaving the library clears its selection.
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#library/')) library.clear(); });

  // Dragging a selected file or note takes the whole selection's files and notes with it.
  window.eigenSelect = {
    dragGroup(key) {
      for (const area of [sidebar, library]) {
        if (area.has(key)) {
          const group = area.keys().filter(k => k.startsWith('file:') || k.startsWith('note:'));
          if (group.length > 1) return group.map(k => ({ type: k.split(':')[0], id: k.slice(k.indexOf(':') + 1) }));
        }
      }
      return null;
    },
    deleteItems,
  };
})();

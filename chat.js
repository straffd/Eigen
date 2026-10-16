// Course AI chat. Opened by clicking a course in the sidebar (#course/<id>) or "Ask AI" on a folder
// (#course/<id>/f/<folderId>). Answers stream from the course-chat Supabase function, which reads
// the text of every file in the course (or the chosen folder).
// The same page shows chats started on Home (#chat/<id>, see chats.js): they have their own history
// and answer from the course or folder they've been dragged into, if any.
(() => {
  const $ = id => document.getElementById(id);
  const log = $('chat-log');
  const form = $('chat-form');
  const input = $('chat-input');
  const sendBtn = $('chat-send');
  const refToggle = $('ref-mode');
  const scopeSel = $('chat-scope');
  const newBtn = $('chat-new');
  const titleEl = $('chat-title');
  const crumbEl = $('chat-crumb');
  const contextEl = $('chat-context');
  const keyChip = $('key-chip');
  const { el, icon, toast, confirmDelete } = window.eigenUI;

  let user = window.eigen?.currentUser?.() ?? null; // may already be signed in by the time this loads
  let classId = null;
  let folderId = null;
  let chatId = null;     // set on #chat/<id> ('new' = a blank chat not saved yet); classId/folderId then say where it's filed
  let queued = null;     // { chatId, text }: first question typed on Home, sent once the chat opens
  let messages = [];     // [{ id, role, content, citations, error, pending }]
  let status = 'idle';   // 'idle' | 'loading' | 'ready' | 'error'
  let sending = false;
  let courseFiles = [];  // [{ id, name, mime_type, storage_path, folder_id, aiStatus }]
  let loadToken = 0;

  const db = () => window.eigen?.supabase;
  const fnUrl = () => `${window.EIGEN_CONFIG.SUPABASE_URL}/functions/v1/course-chat`;
  const course = () => (classId ? window.eigenClasses.findClass(classId) : null);
  const chat = () => (chatId === 'new' ? { id: 'new', title: 'New chat' } : chatId ? window.eigenChats.find(chatId) : null);
  const scopeName = () => (folderId ? window.eigenClasses.findFolder(folderId)?.f.name : null) ?? course()?.name ?? null;

  // ---------- Reference mode (remembered per browser) ----------
  try { refToggle.checked = localStorage.getItem('eigen.referenceMode') === '1'; } catch {}
  refToggle.addEventListener('change', () => {
    try { localStorage.setItem('eigen.referenceMode', refToggle.checked ? '1' : '0'); } catch {}
    contextEl.dataset.ref = refToggle.checked ? '1' : '';
  });

  // ---------- Markdown (safe subset) ----------
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/((?:\[\[\d+(?:,\d+)*\]\])+)/g, m => `<span class="cite-refs">${[...m.matchAll(/\[\[(\d+(?:,\d+)*)\]\]/g)]
        .map(x => x[1].includes(',')
          ? `<button type="button" class="cite-ref cite-group" data-ns="${x[1]}">${x[1].replace(/,/g, ', ')}</button>`
          : `<button type="button" class="cite-ref" data-n="${x[1]}">${x[1]}</button>`).join('')}</span>`);
  }
  function markdown(text) {
    // Older answers may contain raw [[src:…]] markers the model wrote in an unexpected format: hide them.
    text = text.replace(/\[\[?\s*src\s*:[^\]]*\]\]?/gi, '').replace(/ +([.,;:!?])/g, '$1');
    const lines = esc(text).split('\n');
    const out = [];
    let list = null, para = [], code = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of lines) {
      if (code) {
        if (/^```/.test(line)) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; } else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<h${Math.min(m[1].length + 2, 6)}>${inline(m[2])}</h${Math.min(m[1].length + 2, 6)}>`); continue; }
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flushPara(); if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (list) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      para.push(line);
    }
    if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    flushPara(); flushList();
    return out.join('');
  }

  // ---------- Rendering ----------
  function pageLabel(s) {
    if (s.page == null) return '';
    if (/\.pdf$/i.test(s.fileName)) return `p. ${s.page}`;
    if (/\.pptx?$/i.test(s.fileName)) return `slide ${s.page}`;
    return `section ${s.page}`;
  }

  const openSources = new WeakSet();

  // One button for several pages: "pp. 7, 10, 12" (or "3 sources" when they span files).
  function groupLabel(cs) {
    if (cs.some(c => c.fileId !== cs[0].fileId || c.page == null)) return `${cs.length} sources`;
    const kind = pageLabel(cs[0]).split(' ')[0];
    const plural = { 'p.': 'pp.', slide: 'slides', section: 'sections' }[kind] || kind;
    return `${plural} ${cs.map(c => c.page).join(', ')}`;
  }

  function renderMessage(m) {
    if (m.role === 'user') {
      const node = el(`<div class="msg user"><div class="bubble"></div></div>`);
      node.firstElementChild.textContent = m.content;
      return node;
    }
    const node = el(`<div class="msg assistant" data-id="${m.id || ''}"><div class="msg-body"></div></div>`);
    const body = node.firstElementChild;
    if (m.error) {
      body.classList.add('msg-error');
      body.textContent = m.error;
      if (m.needsKey) {
        const b = el(`<button type="button" class="btn-secondary btn-sm add-key" data-action="add-key">${icon('key')}Add API key</button>`);
        node.append(b);
      }
    } else if (m.pending && !m.content) {
      body.innerHTML = `<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>`;
    } else {
      body.innerHTML = markdown(m.content);
      for (const b of body.querySelectorAll('.cite-group')) {
        const cs = b.dataset.ns.split(',').map(n => m.citations?.find(c => c.n === Number(n))).filter(Boolean);
        if (cs.length) b.textContent = groupLabel(cs);
      }
    }
    if (m.citations?.length) {
      // Collapsed by default; stays open across re-renders once the student opens it.
      const open = openSources.has(m);
      const src = el(`
        <div class="sources">
          <button type="button" class="sources-toggle" aria-expanded="${open}">${icon('chevron', 'chev')}<span>Sources</span><span class="sources-count">${m.citations.length}</span></button>
          <ol ${open ? '' : 'hidden'}></ol>
        </div>`);
      src.firstElementChild.addEventListener('click', e => {
        const show = !openSources.has(m);
        if (show) openSources.add(m); else openSources.delete(m);
        e.currentTarget.setAttribute('aria-expanded', show);
        src.querySelector('ol').hidden = !show;
      });
      for (const c of m.citations) {
        const li = el(`
          <li data-n="${c.n}">
            <button type="button" class="source" data-file="${c.fileId}" data-page="${c.page ?? ''}">
              <span class="src-n">${c.n}</span><span class="src-name"></span><span class="src-page"></span>
            </button>
            <p class="src-quote"></p>
          </li>`);
        li.querySelector('.src-name').textContent = c.fileName;
        li.querySelector('.src-page').textContent = pageLabel(c) + (c.approximate ? ' · approximate' : '');
        li.querySelector('.src-quote').textContent = c.quote ? `“${c.quote.length > 220 ? c.quote.slice(0, 220) + '…' : c.quote}”` : '';
        src.querySelector('ol').append(li);
      }
      node.append(src);
    }
    return node;
  }

  function emptyState() {
    const c = course();
    const node = el(`
      <div class="chat-empty">
        ${icon('sparkle')}
        <p class="chat-empty-title"></p>
        <p class="chat-empty-text"></p>
        <div class="suggestions"></div>
      </div>`);
    node.querySelector('.chat-empty-title').textContent = chatId && !c ? 'Ask anything' : `Ask anything about ${scopeName() ?? 'this course'}`;
    node.querySelector('.chat-empty-text').textContent = chatId && !c
      ? 'This chat isn’t in a course yet. Drag it onto a course or folder in the sidebar to answer from those files.'
      : courseFiles.length
        ? 'Answers come from your uploaded files first. Turn on Reference mode to see exactly where each fact comes from.'
        : 'Upload lecture slides or notes to a folder in this course so answers come from your own materials.';
    for (const s of ['Summarise the key ideas so far', 'Make 5 practice questions with answers', 'Explain the hardest concept simply']) {
      const b = el(`<button type="button" class="suggestion"></button>`);
      b.textContent = s;
      b.addEventListener('click', () => { input.value = s; send(); });
      node.querySelector('.suggestions').append(b);
    }
    return node;
  }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 120; }

  function render({ scroll = false } = {}) {
    const c = course();
    const h = chat();
    if (chatId ? !h : !c) {
      const ready = chatId ? window.eigenChats.status() === 'ready' : window.eigenClasses.status() === 'ready';
      titleEl.textContent = ready ? (chatId ? 'Chat not found' : 'Course not found') : '';
      crumbEl.textContent = chatId ? 'Chat' : 'Course AI';
      contextEl.textContent = '';
      scopeSel.parentElement.hidden = !!chatId;
      form.hidden = true;
      newBtn.hidden = true;
      log.replaceChildren();
      return;
    }
    if (chatId) {
      titleEl.textContent = h.title;
      crumbEl.textContent = c ? `Chat · ${scopeName()}` : 'Chat';
      document.title = `${h.title} · Eigen`;
      scopeSel.parentElement.hidden = true;
    } else {
      titleEl.textContent = c.name;
      crumbEl.textContent = 'Course AI';
      document.title = `${c.name} AI · Eigen`;
      scopeSel.parentElement.hidden = false;
      renderScope(c);
    }

    if (!user || !db()) {
      form.hidden = true;
      newBtn.hidden = true;
      contextEl.textContent = '';
      log.replaceChildren(el(`
        <div class="files-empty">
          ${icon('lock')}
          <p class="files-empty-title">Sign in to use the AI</p>
          <p class="files-empty-text">Eigen answers questions using the files you’ve saved in this course.</p>
          <button class="btn-primary" type="button" data-action="signin">Sign in</button>
        </div>`));
      return;
    }

    form.hidden = false;
    newBtn.hidden = !messages.length;
    renderKeyChip();
    input.placeholder = scopeName() ? `Ask about ${scopeName()}…` : 'Ask anything…';
    sendBtn.disabled = sending;
    renderContext();

    const stick = scroll || nearBottom();
    if (status === 'loading') log.replaceChildren(el(`<p class="files-status chat-status">Loading chat…</p>`));
    else if (status === 'error') log.replaceChildren(el(`<p class="files-status chat-status">Couldn’t load this chat. Check that the AI is set up in Supabase.</p>`));
    else if (!messages.length) log.replaceChildren(emptyState());
    else log.replaceChildren(...messages.map(renderMessage));
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function renderKeyChip() {
    const has = window.eigenAI.hasKey();
    const name = window.eigenAI.getProvider() === 'gemini' ? 'Gemini' : 'Claude';
    keyChip.classList.toggle('on', has);
    keyChip.querySelector('span').textContent = has ? `${name} · your key` : 'Add API key';
    keyChip.title = has ? `Questions use your own ${name} API key (saved in this browser)` : 'Use your own Claude or Gemini API key';
  }

  function renderScope(c) {
    const folders = c.folders.filter(f => !f.archivedAt);
    const opts = [['', 'Whole course'], ...folders.map(f => [f.id, f.name])];
    scopeSel.replaceChildren(...opts.map(([v, label]) => { const o = el('<option></option>'); o.value = v; o.textContent = label; return o; }));
    scopeSel.value = folderId && folders.some(f => f.id === folderId) ? folderId : '';
  }

  function renderContext() {
    if (chatId && !course()) {
      contextEl.textContent = 'Not in a course · drag this chat onto a course or folder to use its files';
      contextEl.title = '';
      return;
    }
    const inScope = courseFiles.filter(f => !folderId || f.folder_id === folderId);
    const ready = inScope.filter(f => f.aiStatus === 'ready').length;
    const reading = inScope.filter(f => f.aiStatus === null && window.eigenReader.canRead(f.name, f.mime_type || '')).length;
    const folders = new Set(inScope.map(f => f.folder_id).filter(Boolean)).size;
    let text = !inScope.length ? 'No files yet, so answers use general knowledge'
      : `Using ${ready} file${ready === 1 ? '' : 's'}${folderId || !folders ? '' : ` from ${folders} folder${folders === 1 ? '' : 's'}${inScope.some(f => !f.folder_id) ? ' and the course' : ''}`}`;
    if (reading) text += ` · reading ${reading} more…`;
    contextEl.textContent = text;
    contextEl.title = inScope.map(f => `${f.name}${f.aiStatus === 'ready' ? '' : ' (not readable)'}`).join('\n');
  }

  let frame = 0;
  const renderSoon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  // ---------- Data ----------
  async function load() {
    window.eigenReader.warmUp();
    const token = ++loadToken;
    if (chatId === 'new') {
      status = 'ready';
      messages = [];
      courseFiles = [];
      render({ scroll: true });
      requestAnimationFrame(() => input.focus()); // once the chat page is showing
      return;
    }
    status = 'loading';
    messages = [];
    courseFiles = [];
    render();
    const c = course();
    try {
      const folderIds = c ? c.folders.filter(f => !f.archivedAt).map(f => f.id) : [];
      const cols = 'id, name, mime_type, storage_path, folder_id, file_texts(status)';
      const none = Promise.resolve({ data: [], error: null });
      const [hist, inFolders, onCourse] = await Promise.all([
        scopedChat(db().from('chat_messages').select('id, role, content, citations')).order('created_at', { ascending: true }).limit(200),
        folderIds.length ? db().from('files').select(cols).in('folder_id', folderIds).eq('uploaded', true) : none,
        // Files kept on the course itself, outside any folder (none if that isn't set up yet).
        c ? db().from('files').select(cols).eq('class_id', classId).eq('uploaded', true).then(r => (r.error ? { data: [], error: null } : r)) : none,
      ]);
      if (hist.error) throw hist.error;
      if (inFolders.error) throw inFolders.error;
      const files = { data: [...onCourse.data, ...inFolders.data] };
      if (token !== loadToken) return;
      messages = hist.data.map(m => ({ ...m, citations: (m.citations || []).map(normalizeCite) }));
      courseFiles = files.data.map(f => {
        const t = Array.isArray(f.file_texts) ? f.file_texts[0] : f.file_texts;
        return { ...f, aiStatus: t?.status ?? null };
      });
      status = 'ready';
      // Read any older files the AI hasn't seen yet.
      for (const f of courseFiles) if (f.aiStatus === null) window.eigenReader.readFile(f);
    } catch (err) {
      if (token !== loadToken) return;
      console.error(err);
      status = 'error';
    }
    render({ scroll: true });
    // The first question typed on Home goes as soon as its chat is open.
    if (status === 'ready' && queued?.chatId === chatId && !messages.length) {
      input.value = queued.text;
      queued = null;
      send();
    }
  }

  const normalizeCite = c => ({
    n: c.n, fileId: c.fileId, fileName: c.fileName, folderName: c.folderName, page: c.page,
    quote: c.quote, quotes: c.quotes ?? (c.quote ? [c.quote] : []), claim: c.claim || '', approximate: !!c.approximate,
  });

  async function send() {
    const text = input.value.trim();
    if (!text || sending || !user || status !== 'ready') return;
    if (chatId === 'new') return startChat(text, input);
    sending = true;
    messages = messages.filter(m => !m.transient); // clear the last error message
    input.value = '';
    autosize();
    const userMsg = { role: 'user', content: text };
    const reply = { role: 'assistant', content: '', citations: [], pending: true };
    messages.push(userMsg, reply);
    render({ scroll: true });

    try {
      // Give files still being read a moment to finish, but don't hold the question up for long.
      const unread = courseFiles.filter(f => f.aiStatus === null && (!folderId || f.folder_id === folderId));
      if (unread.length) {
        await Promise.race([
          Promise.all(unread.map(f => window.eigenReader.readFile(f))),
          new Promise(r => setTimeout(r, 15_000)),
        ]);
        if (courseFiles.some(f => unread.includes(f) && f.aiStatus === null)) toast('Some files are still being read, so this answer may not include them yet.');
      }

      let finished = false;
      const handle = ev => {
        if (ev.t === 'text') reply.content += ev.text;
        else if (ev.t === 'cite') {
          const c = normalizeCite({ n: ev.n, ...ev.source });
          const i = reply.citations.findIndex(x => x.n === c.n);
          if (i >= 0) reply.citations[i] = c; else reply.citations.push(c); // later events add more quotes for the same page
        }
        else if (ev.t === 'done') { reply.id = ev.id; finished = true; if (ev.trimmed) toast('This course is large, so only the most relevant pages were used.'); }
        else if (ev.t === 'error') throw new Error(ev.message);
        renderSoon();
      };

      if (window.eigenAI.hasKey()) {
        // Your own key: straight from this browser to Anthropic.
        let failure = null;
        await window.eigenAI.ask({
          userId: user.id, classId, folderId, chatId, question: text, referenceMode: refToggle.checked,
          onEvent: ev => { if (ev.t === 'error') failure = ev.message; else handle(ev); },
        });
        if (failure) throw new Error(failure);
      } else {
        const { data: { session } } = await db().auth.getSession();
        if (!session) throw new Error('Please sign in again.');
        const res = await fetch(fnUrl(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: window.EIGEN_CONFIG.SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(chatId
            ? { chat_id: chatId, message: text, reference_mode: refToggle.checked }
            : { class_id: classId, folder_id: folderId, message: text, reference_mode: refToggle.checked }),
        }).catch(() => null);
        if (!res || !res.ok || !res.body) {
          let msg = !res || res.status === 404
            ? 'The shared AI isn’t set up yet. Add your own Claude or Gemini API key to use the course AI now.'
            : 'Something went wrong. Please try again.';
          try { msg = (await res.json()).error || msg; } catch {}
          const e = new Error(msg);
          e.needsKey = !res || res.status === 404;
          throw e;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) handle(JSON.parse(line));
          }
        }
      }
      if (!finished) throw new Error('The answer was interrupted. Please try again.');
      reply.pending = false;
      if (chatId) window.eigenChats.touch(chatId);
    } catch (err) {
      console.error(err);
      reply.pending = false;
      if (!reply.content) {
        // Nothing was saved: drop the turn and give the question back.
        messages.splice(messages.indexOf(userMsg), 2);
        input.value = text;
        autosize();
        messages.push({ role: 'assistant', error: err.message || 'Something went wrong.', needsKey: !!err.needsKey, transient: true });
      } else {
        reply.error = null;
        reply.content += `\n\n*(${err.message || 'Interrupted'})*`;
      }
    } finally {
      sending = false;
      render();
      input.focus();
    }
  }

  // ---------- Events ----------
  form.addEventListener('submit', e => { e.preventDefault(); send(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }
  input.addEventListener('input', autosize);

  keyChip.addEventListener('click', () => window.eigenSettings.open());
  document.addEventListener('eigen:key-changed', () => { if (classId) renderKeyChip(); });

  // A chat has its own messages; otherwise the whole course and each folder keep separate conversations.
  const scopedChat = q => chatId ? q.eq('chat_id', chatId)
    : (folderId ? q.eq('folder_id', folderId) : q.is('folder_id', null)).eq('class_id', classId).is('chat_id', null);

  scopeSel.addEventListener('change', () => {
    location.hash = scopeSel.value ? `#course/${classId}/f/${scopeSel.value}` : `#course/${classId}`;
  });

  newBtn.addEventListener('click', async () => {
    const where = chatId ? 'this chat' : folderId ? `the ${window.eigenClasses.findFolder(folderId)?.f.name ?? 'folder'} chat` : 'the whole-course chat';
    const ok = await confirmDelete('Clear this chat?', `This deletes the messages in ${where}. Other chats and your files stay as they are.`, 'Clear chat');
    if (!ok) return;
    const { error } = await scopedChat(db().from('chat_messages').delete());
    if (error) return toast('Couldn’t clear the chat. Please try again.');
    messages = [];
    render();
  });

  log.addEventListener('click', async e => {
    if (e.target.closest('[data-action="signin"]')) return $('signin-open').click();
    if (e.target.closest('[data-action="add-key"]')) return window.eigenSettings.open();
    // A citation number or a source opens the cited page beside the chat, with the passage highlighted.
    const ref = e.target.closest('.cite-ref, .source');
    if (ref) {
      const msgEl = ref.closest('.msg');
      const msg = messages.find(m => m.id && m.id === msgEl.dataset.id) ?? messages[[...log.querySelectorAll('.msg')].indexOf(msgEl)];
      const find = n => msg?.citations?.find(c => c.n === n);
      // Notes written in Eigen open in the note editor rather than the page viewer.
      const isNote = c => c?.fileId?.startsWith('note:');
      const openNote = c => { location.hash = '#note/' + c.fileId.slice(5); };
      const flash = n => {
        const li = msgEl.querySelector(`.sources li[data-n="${n}"]`);
        if (li) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
      };
      // A page-group button opens every page behind the explanation, side by side.
      if (ref.dataset.ns) {
        const ns = ref.dataset.ns.split(',').map(Number);
        ns.forEach(flash);
        const all = ns.map(find).filter(Boolean);
        const group = all.filter(c => !isNote(c));
        if (group.length > 1) window.eigenViewer.open(group, 0);
        else if (group.length) window.eigenViewer.open(group[0]);
        else if (all.length) openNote(all[0]);
        return;
      }
      const n = Number(ref.dataset.n ?? ref.closest('li')?.dataset.n);
      const cite = find(n);
      flash(n);
      if (isNote(cite)) openNote(cite);
      else if (cite) window.eigenViewer.open(cite);
      else if (ref.dataset.file) openSource(ref.dataset.file, ref.dataset.page);
      return;
    }
  });

  // Opens the cited file in a new tab, at the cited page for PDFs.
  async function openSource(fileId, page) {
    const win = window.open('', '_blank');
    let f = courseFiles.find(x => x.id === fileId);
    if (!f) {
      const { data } = await db().from('files').select('id, name, storage_path').eq('id', fileId).maybeSingle();
      f = data;
    }
    if (!f) { win?.close(); return toast('That file has been deleted.'); }
    const { data, error } = await db().storage.from('files').createSignedUrl(f.storage_path, 300);
    if (error || !data?.signedUrl) { win?.close(); return toast('Couldn’t open that file.'); }
    const url = data.signedUrl + (page && /\.pdf$/i.test(f.name) ? `#page=${page}` : '');
    if (win) win.location = url; else location.assign(url);
  }

  document.addEventListener('eigen:file-read', e => {
    const f = courseFiles.find(x => x.id === e.detail.id);
    if (f) { f.aiStatus = e.detail.status; if (classId) renderContext(); }
  });
  // A file uploaded on a folder page belongs to this course: refresh the file list next time.
  document.addEventListener('eigen:files-changed', () => { if (classId) status = 'stale'; });

  // ---------- Routing ----------
  function sync() {
    const mc = /^#chat\/([^/]+)$/.exec(location.hash);
    const m = /^#course\/([^/]+)(?:\/f\/([^/]+))?$/.exec(location.hash);
    if (!m && !mc) { classId = null; chatId = null; return; }
    let next;
    if (mc) {
      const h = window.eigenChats.find(mc[1]);
      const c = h?.classId ? window.eigenClasses.findClass(h.classId) : null;
      next = { chatId: mc[1], classId: c ? c.id : null, folderId: c && c.folders.some(f => f.id === h.folderId) ? h.folderId : null };
    } else {
      next = { chatId: null, classId: m[1], folderId: m[2] || null };
    }
    const changed = next.chatId !== chatId || next.classId !== classId || next.folderId !== folderId;
    ({ chatId, classId, folderId } = next);
    const ready = user && db() && (chatId ? chat() : course());
    if (ready && (changed || status === 'idle' || status === 'stale')) load();
    else render();
  }
  window.addEventListener('hashchange', sync);
  document.addEventListener('eigen:classes', () => { if (classId || chatId) sync(); });
  // Chats loaded, renamed, or dragged into another course or folder.
  document.addEventListener('eigen:chats', () => { if (chatId) sync(); });

  // Typing on Home (or in a blank chat from +) saves a new chat and sends the question there.
  const homeForm = document.querySelector('.home .ask');
  const homeInput = homeForm.querySelector('textarea');
  async function startChat(text, box) {
    if (!text) return;
    if (!user || !db()) return $('signin-open').click();
    box.disabled = true;
    const h = await window.eigenChats.create(text);
    box.disabled = false;
    if (!h) return;
    box.value = '';
    box.style.height = 'auto';
    queued = { chatId: h.id, text };
    if (location.hash === '#chat/new') location.replace('#chat/' + h.id); // don't keep the blank chat in history
    else location.hash = '#chat/' + h.id;
  }
  homeForm.addEventListener('submit', e => { e.preventDefault(); startChat(homeInput.value.trim(), homeInput); });
  homeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); startChat(homeInput.value.trim(), homeInput); }
  });
  document.addEventListener('eigen:user', e => {
    const next = e.detail || null;
    if ((next?.id || null) === (user?.id || null)) return;
    user = next;
    status = 'idle';
    messages = [];
    sync();
  });
  sync();
})();

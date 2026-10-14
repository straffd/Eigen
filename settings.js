// Settings window: choose the AI provider (Claude or Gemini) and save your own API key for it.
// Keys are stored only in this browser.
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('settings-dialog');
  const ai = window.eigenAI;
  const mask = k => `${k.slice(0, 8)}…${k.slice(-4)}`;
  const changed = () => document.dispatchEvent(new CustomEvent('eigen:key-changed'));

  // ---------- Provider switch ----------
  const switchBtns = [...dialog.querySelectorAll('.provider-switch button')];
  function showProvider(p) {
    switchBtns.forEach(b => {
      const on = b.dataset.aiProvider === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
    dialog.querySelectorAll('.provider-panel').forEach(el => { el.hidden = el.dataset.panel !== p; });
  }
  switchBtns.forEach(b => b.addEventListener('click', () => {
    ai.setProvider(b.dataset.aiProvider);
    showProvider(b.dataset.aiProvider);
    changed();
  }));

  // ---------- One key form per provider ----------
  function keyForm({ prefix, label, get, set, verify, pattern, patternMsg, onSaved, onRefresh }) {
    const form = $(`${prefix}-form`), input = $(`${prefix}-input`), message = $(`${prefix}-message`);
    const statusEl = $(`${prefix}-status`), saveBtn = $(`${prefix}-save`), removeBtn = $(`${prefix}-remove`);
    const say = (text, kind = 'error') => { message.textContent = text || ''; message.dataset.kind = kind; };
    function refresh() {
      const key = get();
      statusEl.textContent = key ? `Saved in this browser: ${mask(key)}` : `No ${label} key saved.`;
      statusEl.classList.toggle('on', !!key);
      removeBtn.hidden = !key;
      input.value = '';
      input.placeholder = key ? 'Paste a new key to replace it' : input.dataset.placeholder || input.placeholder;
      onRefresh?.(key);
    }
    input.dataset.placeholder = input.placeholder;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return say('Paste your API key first.');
      if (!pattern.test(key)) return say(patternMsg);
      saveBtn.disabled = true;
      say(`Checking the key with ${label}…`, 'info');
      try {
        const result = await verify(key);
        if (!result.ok) return say(result.message);
        set(key);
        onSaved?.(result);
        refresh();
        changed();
        say(`Key saved. The course AI will use ${label} with your key.`, 'success');
      } catch (err) {
        console.error(err);
        say('Couldn’t check the key. Please try again.');
      } finally {
        saveBtn.disabled = false;
      }
    });
    removeBtn.addEventListener('click', () => { set(''); onSaved?.(null); refresh(); changed(); say('Key removed from this browser.', 'info'); });
    return { refresh, say };
  }

  const claude = keyForm({
    prefix: 'key', label: 'Anthropic', get: ai.getKey, set: ai.setKey, verify: ai.verifyKey,
    pattern: /^sk-ant-[\w-]{20,}$/, patternMsg: 'That doesn’t look like an Anthropic API key. It should start with sk-ant-.',
  });

  // Gemini: remember which models the key can use, for the model picker.
  const modelSel = $('gmodel'), modelField = $('gmodel-field');
  let geminiModels = [];
  function fillModels() {
    const current = ai.getGeminiModel();
    const list = geminiModels.length ? geminiModels : current ? [current] : [];
    modelSel.replaceChildren(...list.map(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; return o; }));
    if (current) modelSel.value = current;
    modelField.hidden = !ai.getGeminiKey() || !list.length;
  }
  modelSel.addEventListener('change', () => { ai.setGeminiModel(modelSel.value); changed(); });
  const gemini = keyForm({
    prefix: 'gkey', label: 'Gemini', get: ai.getGeminiKey, set: ai.setGeminiKey, verify: ai.verifyGeminiKey,
    pattern: /^AIza[\w-]{30,}$/, patternMsg: 'That doesn’t look like a Gemini API key. It should start with AIza.',
    onSaved: result => {
      geminiModels = result?.models || [];
      if (!result) ai.setGeminiModel('');
      else if (!geminiModels.includes(ai.getGeminiModel())) ai.setGeminiModel(geminiModels[0]);
    },
    onRefresh: fillModels,
  });

  function open() {
    claude.say(''); gemini.say('');
    claude.refresh(); gemini.refresh();
    showProvider(ai.getProvider());
    document.getElementById('account-menu').hidden = true;
    dialog.showModal();
  }

  $('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  $('open-settings').addEventListener('click', open);

  window.eigenSettings = { open };
})();

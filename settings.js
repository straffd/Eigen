// Settings window: currently just the user's own Anthropic API key (stored only in this browser).
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('settings-dialog');
  const form = $('key-form');
  const input = $('key-input');
  const message = $('key-message');
  const statusEl = $('key-status');
  const saveBtn = $('key-save');
  const removeBtn = $('key-remove');

  const mask = k => `${k.slice(0, 10)}…${k.slice(-4)}`;
  const say = (text, kind = 'error') => { message.textContent = text || ''; message.dataset.kind = kind; };

  function refresh() {
    const key = window.eigenAI.getKey();
    statusEl.textContent = key ? `Saved in this browser: ${mask(key)}` : 'No key saved. The course AI uses Eigen’s shared server if it’s set up.';
    statusEl.classList.toggle('on', !!key);
    removeBtn.hidden = !key;
    input.value = '';
    input.placeholder = key ? 'Paste a new key to replace it' : 'sk-ant-…';
    document.dispatchEvent(new CustomEvent('eigen:key-changed'));
  }

  function open() {
    say('');
    refresh();
    document.getElementById('account-menu').hidden = true;
    dialog.showModal();
    input.focus();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return say('Paste your API key first.');
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) return say('That doesn’t look like an Anthropic API key. It should start with sk-ant-.');
    saveBtn.disabled = true;
    say('Checking the key with Anthropic…', 'info');
    try {
      const result = await window.eigenAI.verifyKey(key);
      if (!result.ok) return say(result.message);
      window.eigenAI.setKey(key);
      refresh();
      say('Key saved. The course AI will now use your key.', 'success');
    } catch (err) {
      console.error(err);
      say('Couldn’t check the key. Please try again.');
    } finally {
      saveBtn.disabled = false;
    }
  });

  removeBtn.addEventListener('click', () => {
    window.eigenAI.setKey('');
    refresh();
    say('Key removed from this browser.', 'info');
  });

  $('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  $('open-settings').addEventListener('click', open);

  window.eigenSettings = { open };
})();

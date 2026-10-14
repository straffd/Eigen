// Authentication: Google and email/password.
(() => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.EIGEN_CONFIG || {};
  const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
  const client = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  const $ = id => document.getElementById(id);
  const dialog = $('auth-dialog');
  const form = $('auth-form');
  const message = $('auth-message');
  const submit = $('auth-submit');
  const signedOut = $('signin-open');
  const signedIn = document.querySelector('.account-signed-in');
  const menu = $('account-menu');
  const menuBtn = $('account-menu-btn');

  let mode = 'signin'; // or 'signup'

  const NOT_CONFIGURED = 'Sign-in isn’t connected yet. Add your Supabase URL and key in config.js.';

  function setMessage(text, kind = 'error') {
    message.textContent = text || '';
    message.dataset.kind = kind;
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    dialog.dataset.mode = mode;
    $('auth-title-text').textContent = signup ? 'Join' : 'Sign in to';
    submit.textContent = signup ? 'Create account' : 'Sign in';
    $('auth-switch-text').textContent = signup ? 'Already have an account?' : 'New to Eigen?';
    $('auth-switch').textContent = signup ? 'Sign in' : 'Create an account';
    form.password.autocomplete = signup ? 'new-password' : 'current-password';
    form.password.placeholder = signup ? 'At least 8 characters' : '';
    form.password.minLength = signup ? 8 : 0;
    setMessage('');
  }

  function openDialog() {
    setMode('signin');
    form.reset();
    dialog.showModal();
    if (!configured) setMessage(NOT_CONFIGURED, 'info');
  }

  function renderUser(user) {
    signedOut.hidden = Boolean(user);
    signedIn.hidden = !user;
    if (!user) return;
    const meta = user.user_metadata || {};
    const name = meta.full_name || meta.name || user.email.split('@')[0];
    $('account-name').textContent = name;
    $('account-email').textContent = user.email;
    const avatar = $('account-avatar');
    avatar.textContent = '';
    if (meta.avatar_url) {
      const img = new Image();
      img.src = meta.avatar_url;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      avatar.append(img);
    } else {
      avatar.textContent = name.charAt(0).toUpperCase();
    }
  }

  function toggleMenu(open = menu.hidden) {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open);
  }

  // Events
  signedOut.addEventListener('click', openDialog);
  $('auth-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  $('auth-switch').addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));

  document.querySelectorAll('[data-provider]').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!configured) return setMessage(NOT_CONFIGURED, 'info');
      const { error } = await client.auth.signInWithOAuth({
        provider: btn.dataset.provider,
        options: { redirectTo: location.origin + location.pathname },
      });
      if (error) setMessage(error.message);
    }));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!form.email.checkValidity()) return setMessage('Enter a valid email address.');
    if (!password) return setMessage('Enter your password.');
    if (mode === 'signup' && password.length < 8) return setMessage('Password must be at least 8 characters.');
    if (!configured) return setMessage(NOT_CONFIGURED, 'info');

    submit.disabled = true;
    setMessage('');
    try {
      if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({
          email, password,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (data.session) dialog.close();
        else setMessage('Check your inbox to confirm your email, then sign in.', 'success');
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        dialog.close();
      }
    } catch (err) {
      const offline = /failed to fetch|network/i.test(err.message || '');
      setMessage(offline ? 'Couldn’t reach Eigen’s servers. Check your connection and try again.'
                         : err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });

  menuBtn.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });

  $('signout').addEventListener('click', async () => {
    toggleMenu(false);
    if (client) await client.auth.signOut();
    renderUser(null);
  });

  // Session
  renderUser(null);
  if (client) {
    client.auth.getSession().then(({ data }) => renderUser(data.session?.user ?? null));
    client.auth.onAuthStateChange((_event, session) => renderUser(session?.user ?? null));
  }

  // Exposed for later features (classes, files).
  window.eigen = { supabase: client };
})();

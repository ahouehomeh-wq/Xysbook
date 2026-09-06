/* XyS Book Mondial — interface utilisateur (vanilla JS, temps réel) */
(function () {
  'use strict';

  /* ---------- État global ---------- */
  const state = {
    token: localStorage.getItem('xys_token') || '',
    user: null,          // user public
    socket: null,
    tab: 'feed',
    online: new Set(),
    posts: [],
    notifs: [],
    chats: [],           // conversations privées de la session
    groups: [],
    products: [],
    usersCache: [],
    activeFriendId: null,
    activeGroupId: null,
    me: null,
    connected: false
  };

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  /* ---------- Outils ---------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'à l\'instant';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' j';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  function avatarStyle(u) {
    const url = (u && u.avatarUrl) || '';
    if (url) return 'style="background-image:url(\'' + url + '\')"';
    const ch = esc((u && (u.author || u.name) || '?').slice(0, 1).toUpperCase());
    return 'data-ch="' + ch + '"';
  }
  function initials(u) { return esc(((u && (u.author || u.name)) || '?').slice(0, 1).toUpperCase()); }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'auth-msg show ' + (type === 'ok' ? 'ok' : 'err');
    el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  function authMsg(msg, type) {
    const m = $('#auth-msg');
    m.className = 'auth-msg show ' + (type === 'ok' ? 'ok' : 'err');
    m.textContent = msg;
  }

  /* ---------- API ---------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = opts.headers || {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch('/api' + path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Erreur serveur');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- Image resize (limite serveur ~450 Ko) ---------- */
  function resizeImage(file, maxDim) {
    return new Promise((resolve, reject) => {
      if (file.size < 150000) {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
        return;
      }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale); height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        let q = 0.82;
        let out = canvas.toDataURL('image/jpeg', q);
        while (out.length > 440000 && q > 0.4) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
        resolve(out);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  /* ---------- Auth UI ---------- */
  const authTabs = { login: '#login-form', register: '#register-form', recover: '#recover-form' };
  function setAuthTab(name) {
    $$('.auth-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.authtab === name));
    Object.keys(authTabs).forEach(k => { $(authTabs[k]).hidden = k !== name; });
    if (name === 'recover') {
      $('#recover-question').innerHTML = '';
      $('#recover-form').querySelector('[name=answer]').required = false;
    } else if (name === 'register') {
      $('#register-form').querySelector('[name=answer]').required = true;
    }
  }

  async function doLogin(ev) {
    ev.preventDefault();
    const f = ev.target;
    const login = f.login.value.trim(), password = f.password.value;
    try {
      const d = await api('/auth/login', { method: 'POST', body: { name: login, password } });
      enterApp(d.token, d.user);
    } catch (e) { authMsg(e.message, 'err'); }
  }
  async function doRegister(ev) {
    ev.preventDefault();
    const f = ev.target;
    try {
      const d = await api('/auth/register', {
        method: 'POST',
        body: {
          name: f.name.value.trim(), email: f.email.value.trim(),
          country: f.country.value.trim(), password: f.password.value,
          recoveryQuestion: f.recoveryQuestion.value, recoveryAnswer: f.recoveryAnswer.value
        }
      });
      enterApp(d.token, d.user);
    } catch (e) { authMsg(e.message, 'err'); }
  }
  async function doRecoverStep1(ev) {
    ev.preventDefault();
    const f = ev.target;
    const login = f.login.value.trim();
    if (!login) { authMsg('Indique ton nom ou e-mail', 'err'); return; }
    try {
      const d = await api('/auth/recovery-question', { method: 'POST', body: { login } });
      f.dataset.userId = d.userId;
      $('#recover-question').innerHTML = '<p class="field"><strong>' + esc(d.question) + '</strong></p>';
      f.querySelector('[name=answer]').required = true;
    } catch (e) { authMsg(e.message, 'err'); }
  }
  async function doRecoverStep2(ev) {
    ev.preventDefault();
    const f = ev.target;
    try {
      const d = await api('/auth/reset-password', {
        method: 'POST',
        body: { userId: f.dataset.userId, answer: f.answer.value, newPassword: f.newPassword.value }
      });
      authMsg(d.message || 'Mot de passe réinitialisé !', 'ok');
      f.reset(); delete f.dataset.userId; setAuthTab('login');
    } catch (e) { authMsg(e.message, 'err'); }
  }

  function enterApp(token, user) {
    state.token = token;
    localStorage.setItem('xys_token', token);
    $('#auth-view').hidden = true;
    $('#app').hidden = false;
    state.user = user;
    setAvatarButton();
    connectSocket();
    if (user) loadMe();
    switchTab('feed');
  }
  function logout() {
    if (state.socket) state.socket.disconnect();
    state.token = ''; state.user = null; state.me = null;
    localStorage.removeItem('xys_token');
    $('#app').hidden = true; $('#auth-view').hidden = false;
    setAuthTab('login');
  }
  function setAvatarButton() {
    const b = $('#btn-profile');
    b.textContent = '';
    const u = state.me || state.user || {};
    b.style.backgroundImage = u.avatarUrl ? 'url(' + u.avatarUrl + ')' : 'none';
    if (!u.avatarUrl) b.textContent = initials(u);
  }

  async function loadMe() {
    try {
      const d = await api('/me');
      state.me = d.user;
      state.user = d.user;
      setAvatarButton();
      refreshNotifications();
    } catch (e) { if (e.status === 401) logout(); }
  }

  /* ---------- Socket ---------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const sock = io({ auth: { token: state.token } });
    state.socket = sock;

    sock.on('connect', () => { state.connected = true; });

    sock.on('presence', p => {
      if (p.online) state.online.add(p.id); else state.online.delete(p.id);
      if (state.tab === 'messages') renderMessages();
    });
    sock.on('new-post', post => {
      state.posts = [post].concat(state.posts.filter(p => p.id !== post.id));
      if (state.tab === 'feed') renderFeed();
    });
    sock.on('post-liked', post => upsertPost(post));
    sock.on('post-unliked', post => upsertPost(post));
    sock.on('post-deleted', d => { state.posts = state.posts.filter(p => p.id !== d.id); if (state.tab === 'feed') renderFeed(); });
    sock.on('new-comment', c => {
      const p = state.posts.find(x => x.id === c.postId);
      if (p) { p.commentCount = Number(p.commentCount || 0) + 1; }
      if (state.tab === 'feed') renderFeed();
    });
    sock.on('comment-deleted', c => {
      const p = state.posts.find(x => x.id === c.postId);
      if (p && Number(p.commentCount) > 0) p.commentCount--;
      if (state.tab === 'feed') renderFeed();
    });
    sock.on('new-notification', n => {
      state.notifs.unshift(n); if (state.notifs.length > 50) state.notifs.pop();
      updateNotifBadge();
      if (document.querySelector('#notif-modal')) renderNotifs();
    });
    sock.on('private-message', m => {
      const other = m.from === state.user.id ? m.to : m.from;
      upsertChat(other, m);
      if (state.tab === 'messages' && state.activeFriendId === other) appendMessage(m);
      if (other !== state.user.id) {
        const notif = { type: 'message', senderName: m.fromName, text: m.text, createdAt: m.createdAt, senderId: m.from };
        state.notifs.unshift(notif); updateNotifBadge();
      }
    });
    sock.on('group-message', m => {
      if (state.tab === 'groups' && state.activeGroupId === m.groupId && $('#group-chat')) appendGroupMessage(m);
    });
    sock.on('chat-error', e => toast(e.error || 'Erreur', 'err'));
    sock.on('disconnect', () => { state.connected = false; });
  }

  function upsertPost(post) {
    const i = state.posts.findIndex(p => p.id === post.id);
    if (i >= 0) state.posts[i] = post; else state.posts.unshift(post);
    if (state.tab === 'feed') renderFeed();
  }
  function upsertChat(friendId, msg) {
    let c = state.chats.find(x => x.id === friendId);
    const meta = msg.fromName || '';
    if (!c) {
      c = { id: friendId, name: (msg.from === friendId ? msg.fromName : state.user.name), last: msg.text, ts: msg.createdAt };
      state.chats.unshift(c);
    } else {
      c.last = msg.text; c.ts = msg.createdAt;
      state.chats.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    }
  }
  function updateNotifBadge() {
    const unread = state.notifs.filter(n => !n.isRead).length;
    const b = $('#notif-badge');
    b.hidden = unread === 0;
    b.textContent = unread > 9 ? '9+' : unread;
  }

  /* ---------- Navigation ---------- */
  function switchTab(tab) {
    state.tab = tab;
    $$('.nav-item, .bnav').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    if (tab === 'feed') renderFeed();
    else if (tab === 'messages') renderMessages();
    else if (tab === 'groups') renderGroups();
    else if (tab === 'market') renderMarket();
    else if (tab === 'search') renderSearch();
  }

  function viewBox(html) { $('#view').innerHTML = html; }

  /* ================= FEED ================= */
  async function loadPosts() {
    try { const d = await api('/posts'); state.posts = d.posts || []; }
    catch (e) { toast(e.message, 'err'); }
  }
  function postHTML(p) {
    const mine = state.user.id === p.userId;
    const likedByMe = false; // rempli par l'état local ci-dessous
    const actions = mine
      ? '<button class="pact" data-action="delpost" data-id="' + p.id + '">🗑 Supprimer</button>'
      : '<button class="pact" data-action="report" data-id="' + p.id + '" data-kind="post">⚠️ Signaler</button>';
    return '<article class="post" id="post-' + p.id + '">' +
      '<div class="post-head">' +
        avatarHTML(p, 44) +
        '<div class="who"><div class="name">' + esc(p.author) + '</div>' +
        '<div class="meta">' + timeAgo(p.createdAt) + (p.isPremium ? ' • <span class="chip">⭐ ' + esc(p.subscriptionTier || 'premium') + '</span>' : '') + '</div></div>' +
      '</div>' +
      (p.text ? '<div class="post-body">' + esc(p.text) + '</div>' : '') +
      (p.imageUrl ? '<img class="post-img" src="' + p.imageUrl + '" alt="image" />' : '') +
      '<div class="post-stats" id="stats-' + p.id + '">' + (Number(p.likes) || 0) + ' j\'aime • ' + (Number(p.commentCount) || 0) + ' commentaires</div>' +
      '<div class="post-actions">' +
        '<button class="pact likebtn" data-action="like" data-id="' + p.id + '">👍 <span>J\'aime</span></button>' +
        '<button class="pact" data-action="comments" data-id="' + p.id + '">💬 <span>Commenter</span></button>' +
        actions +
      '</div>' +
      '<div class="comments" id="comments-' + p.id + '" hidden></div>' +
    '</article>';
  }
  function avatarHTML(u, size) {
    const url = (u && (u.avatarUrl)) || '';
    if (url) return '<span class="avatar" style="background-image:url(\'' + url + '\')"></span>';
    return '<span class="avatar">' + esc(((u && (u.author || u.name)) || '?').slice(0, 1).toUpperCase()) + '</span>';
  }
  async function renderFeed() {
    if (!state.posts.length) { await loadPosts(); }
    const storiesBar = await storiesBarHTML();
    let list = state.posts.length ? state.posts.map(postHTML).join('') : '<div class="empty">Aucune publication pour l\'instant. Sois le premier !</div>';
    viewBox(
      '<div class="composer">' +
        '<div class="composer-top">' + avatarHTML(state.user, 40) +
          '<textarea id="post-text" placeholder="Quoi de neuf, ' + esc(state.user.name) + ' ?" maxlength="2000"></textarea>' +
        '</div>' +
        '<div class="composer-preview" id="post-preview" hidden><img id="post-preview-img"/><button class="x" id="preview-clear">✕</button></div>' +
        '<div class="composer-bar">' +
          '<div class="composer-tools">' +
            '<label class="btn btn-ghost btn-sm" style="margin:0">🖼️ Photo<input type="file" id="post-file" accept="image/*" hidden></label>' +
          '</div>' +
          '<button class="btn btn-primary btn-sm" id="post-submit">Publier</button>' +
        '</div>' +
      '</div>' +
      '<div class="stories" id="stories-bar">' + storiesBar + '</div>' +
      '<div id="feed-list">' + list + '</div>'
    );
    $('#btn-profile').dataset.unused = '';
    bindFeedActions();
  }
  function bindFeedActions() {
    const ta = $('#post-text');
    const file = $('#post-file');
    let pendingImg = '';
    const submit = $('#post-submit');
    submit.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text && !pendingImg) { toast('Écris quelque chose ou ajoute une image', 'err'); return; }
      submit.disabled = true;
      try {
        const d = await api('/posts', { method: 'POST', body: { text, imageUrl: pendingImg } });
        state.posts.unshift(d.post);
        ta.value = ''; clearPreview();
        renderFeed();
      } catch (e) { toast(e.message, 'err'); }
      finally { submit.disabled = false; }
    });
    function clearPreview() { pendingImg = ''; $('#post-preview').hidden = true; $('#post-preview-img').src = ''; }
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try { pendingImg = await resizeImage(file.files[0], 1280); $('#post-preview-img').src = pendingImg; $('#post-preview').hidden = false; }
      catch (e) { toast('Image trop lourde', 'err'); }
    });
    $('#preview-clear').addEventListener('click', clearPreview);
  }

  async function storiesBarHTML() {
    try {
      const d = await api('/stories');
      const mine = state.user;
      const addBtn = '<div class="story"><div class="story-ring" data-action="add-story"><div class="inner">➕</div></div><div class="story-name">Ma story</div></div>';
      const items = (d.stories || []).slice(0, 30).map(s =>
        '<div class="story" data-action="view-story" data-sid="' + s.id + '">' +
        '<div class="story-ring"><div class="inner" ' + (s.mediaUrl ? 'style="background-image:url(\'' + s.mediaUrl + '\')"' : '') + '></div></div>' +
        '<div class="story-name">' + esc(s.author) + '</div></div>'
      );
      return addBtn + items.join('');
    } catch (e) { return ''; }
  }

  /* ================= POST / COMMENT INTERACTIONS ================= */
  async function likePost(id) {
    try {
      const d = await api('/posts/' + id + '/like', { method: 'POST' });
      const el = document.querySelector('#post-' + id + ' .likebtn');
      if (el) el.classList.add('liked');
    } catch (e) { if (e.message !== 'Publication introuvable') toast(e.message, 'err'); }
  }
  async function delPost(id) {
    if (!confirm('Supprimer cette publication ?')) return;
    try { await api('/posts/' + id, { method: 'DELETE' }); state.posts = state.posts.filter(p => p.id !== id); renderFeed(); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function toggleComments(id) {
    const wrap = $('#comments-' + id);
    const open = !wrap.hidden;
    wrap.hidden = open;
    const btn = document.querySelector('#post-' + id + ' [data-action=comments]');
    if (open) wrap.innerHTML = '<div class="small muted">▼ Commentaires</div>';
    else await openComments(id);
  }
  async function openComments(postId) {
    const wrap = $('#comments-' + postId);
    const btn = document.querySelector('#post-' + postId + ' [data-action=comments]');
    if (btn) btn.classList.add('liked');
    try {
      const d = await api('/posts/' + postId + '/comments');
      wrap.hidden = false;
      wrap.innerHTML = '<div class="small muted" style="margin-bottom:8px">Commentaires</div>' +
        d.comments.map(commentHTML).join('') +
        '<form class="comment-form" data-cform="' + postId + '">' + avatarHTML(state.user, 30) +
        '<input name="text" placeholder="Écris un commentaire..." maxlength="1000" required />' +
        '<button class="btn btn-primary btn-sm">Envoyer</button></form>';
      wrap.querySelector('form').addEventListener('submit', submitComment);
    } catch (e) { toast(e.message, 'err'); }
  }
  function commentHTML(c) {
    const mine = state.user.id === c.userId;
    return '<div class="comment" id="comment-' + c.id + '">' + avatarHTML(c, 30) +
      '<div class="comment-bubble"><span class="name">' + esc(c.author) + '</span> <p>' + esc(c.text) + '</p></div>' +
      (mine ? '<button class="comment-del" data-action="delcomment" data-id="' + c.id + '" title="Supprimer">🗑</button>' : '') +
    '</div>';
  }
  async function submitComment(ev) {
    ev.preventDefault();
    const f = ev.target;
    const text = f.text.value.trim();
    if (!text) return;
    const postId = f.dataset.cform;
    try {
      await api('/posts/' + postId + '/comments', { method: 'POST', body: { text } });
      await openComments(postId);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function delComment(id) {
    if (!confirm('Supprimer ce commentaire ?')) return;
    try { await api('/comments/' + id, { method: 'DELETE' }); }
    catch (e) { toast(e.message, 'err'); }
  }

  /* ================= MESSAGES (privé) ================= */
  async function renderMessages() {
    const right = state.activeFriendId ? await chatHTML(state.activeFriendId) : '<div class="card center muted">Sélectionne une conversation ou cherche un ami.</div>';
    const chatRows = state.chats.length ? state.chats.map(c => {
      const online = state.online.has(c.id);
      return '<div class="row chatrow" data-friend="' + c.id + '">' +
        '<span class="online-dot ' + (online ? 'on' : '') + '"></span>' +
        '<span class="avatar">' + esc(c.name.slice(0, 1).toUpperCase()) + '</span>' +
        '<div class="who"><div class="name">' + esc(c.name) + '</div><div class="sub">' + esc(c.last) + '</div></div></div>';
    }).join('') : '<div class="empty small">Aucune conversation.</div>';

    viewBox('<div class="panel-split">' +
      '<div class="chat-side"><div class="section-title" style="padding:12px 12px 0">💬 Messages</div>' +
      '<div style="padding:8px 12px"><input id="msg-search" placeholder="Chercher un ami…" /></div>' +
      '<div class="list-scroll">' + chatRows + '</div></div>' +
      '<div class="chat-side" style="padding:12px">' + right + '</div></div>'
    );
    $$('.chatrow').forEach(r => r.addEventListener('click', () => {
      state.activeFriendId = r.dataset.friend;
      renderMessages();
    }));
    $('#msg-search').addEventListener('input', debounce(async () => {
      const q = $('#msg-search').value.trim();
      if (!q) return;
      try {
        const d = await api('/users?search=' + encodeURIComponent(q));
        openFriendPicker(d.users || []);
      } catch (e) {}
    }, 400));
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function openFriendPicker(users) {
    openModal('Nouveau message', '<div class="mb small muted">Choisis une personne :</div>' +
      users.map(u => '<div class="row" data-pick="' + u.id + '">' + avatarHTML(u, 36) +
      '<div class="who"><div class="name">' + esc(u.name) + '</div><div class="sub">' + esc(u.country || '') + '</div></div></div>').join('')
    );
    $$('[data-pick]').forEach(r => r.addEventListener('click', () => {
      const id = r.dataset.pick;
      const name = r.querySelector('.name').textContent;
      closeModal();
      let c = state.chats.find(x => x.id === id);
      if (!c) { c = { id, name, last: '', ts: new Date().toISOString() }; state.chats.unshift(c); }
      state.activeFriendId = id;
      switchTab('messages');
    }));
  }
  async function chatHTML(friendId) {
    let name = friendId;
    const c = state.chats.find(x => x.id === friendId);
    if (c) name = c.name;
    let messages = [];
    try { const d = await api('/messages/' + friendId); messages = d.messages || []; } catch (e) {}
    const bubbles = messages.map(m => {
      const me = m.from === state.user.id;
      return '<div class="msg ' + (me ? 'me' : 'them') + '">' + esc(m.text) + '<span class="t">' + timeAgo(m.createdAt) + '</span></div>';
    }).join('');
    return '<div class="flex spread mb"><h3 style="font-size:16px">' + esc(name) + '</h3>' +
      '<button class="btn btn-ghost btn-sm" data-action="closechat">✕</button></div>' +
      '<div class="chat" id="priv-chat">' + bubbles + '</div>' +
      '<form class="chat-input" id="priv-form" data-to="' + friendId + '">' +
      '<input name="text" placeholder="Écris un message…" autocomplete="off" />' +
      '<button class="btn btn-primary">Envoyer</button></form>';
  }
  async function appendMessage(m) {
    const box = $('#priv-chat');
    if (!box) return;
    const me = m.from === state.user.id;
    box.insertAdjacentHTML('beforeend', '<div class="msg ' + (me ? 'me' : 'them') + '">' + esc(m.text) + '<span class="t">' + timeAgo(m.createdAt) + '</span></div>');
    box.scrollTop = box.scrollHeight;
  }

  /* ================= GROUPES ================= */
  async function renderGroups() {
    try {
      const d = await api('/groups');
      state.groups = d.groups || [];
    } catch (e) {}
    const rows = state.groups.map(g => {
      const action = g.isMember
        ? '<button class="btn btn-ghost btn-sm" data-gaction="open" data-gid="' + g.id + '">Ouvrir</button>'
        : '<button class="btn btn-primary btn-sm" data-gaction="join" data-gid="' + g.id + '">Rejoindre</button>';
      return '<div class="row spread"><div class="who"><div class="name">' + esc(g.name) + '</div>' +
        '<div class="sub">' + g.memberCount + ' membres • ' + esc(g.description || '') + '</div></div>' +
        (g.isMember ? '<button class="btn btn-ghost btn-sm" data-gaction="leave" data-gid="' + g.id + '">Quitter</button>' : '') + action + '</div>';
    }).join('');
    const openGroup = state.activeGroupId ? await groupChatHTML(state.activeGroupId) : '<div class="empty small muted">Ouvre un groupe pour discuter.</div>';
    viewBox('<div class="panel-split">' +
      '<div class="chat-side"><div class="flex spread" style="padding:12px 12px 4px"><h3 class="section-title" style="margin:0">👥 Groupes</h3>' +
      '<button class="btn btn-primary btn-sm" id="new-group">+ Créer</button></div>' +
      '<div class="list-scroll">' + (rows || '<div class="empty">Aucun groupe.</div>') + '</div></div>' +
      '<div class="chat-side" style="padding:12px">' + openGroup + '</div></div>'
    );
    $$('[data-gaction]').forEach(b => b.addEventListener('click', async () => {
      const gid = b.dataset.gid, act = b.dataset.gaction;
      if (act === 'join') { await api('/groups/' + gid + '/join', { method: 'POST' }); renderGroups(); }
      else if (act === 'leave') { await api('/groups/' + gid + '/leave', { method: 'POST' }); if (state.activeGroupId === gid) state.activeGroupId = null; renderGroups(); }
      else if (act === 'open') { state.activeGroupId = gid; renderGroups(); }
    }));
    $('#new-group').addEventListener('click', () => {
      openModal('Créer un groupe',
        '<div class="field"><label>Nom</label><input id="g-name" maxlength="80" /></div>' +
        '<div class="field"><label>Description</label><input id="g-desc" maxlength="200" /></div>' +
        '<button class="btn btn-primary btn-block" id="g-create">Créer</button>');
      $('#g-create').addEventListener('click', async () => {
        const name = $('#g-name').value.trim(); if (!name) return;
        try { const d = await api('/groups', { method: 'POST', body: { name, description: $('#g-desc').value.trim() } }); closeModal(); state.activeGroupId = d.groupId; renderGroups(); }
        catch (e) { toast(e.message, 'err'); }
      });
    });
  }
  async function groupChatHTML(groupId) {
    let name = 'Groupe';
    const g = state.groups.find(x => x.id === groupId);
    if (g) name = g.name;
    let messages = [];
    try { const d = await api('/groups/' + groupId + '/messages'); messages = d.messages || []; } catch (e) {}
    const bubbles = messages.map(m => {
      const me = m.from === state.user.id;
      return '<div class="msg ' + (me ? 'me' : 'them') + '"><b style="font-size:12px">' + esc(m.fromName) + '</b><br>' + esc(m.text) + '<span class="t">' + timeAgo(m.createdAt) + '</span></div>';
    }).join('');
    return '<div class="flex spread mb"><h3 style="font-size:16px">👥 ' + esc(name) + '</h3>' +
      '<button class="btn btn-ghost btn-sm" data-action="closegroup">✕</button></div>' +
      '<div class="chat" id="group-chat">' + bubbles + '</div>' +
      '<form class="chat-input" id="group-form" data-gid="' + groupId + '">' +
      '<input name="text" placeholder="Écris au groupe…" autocomplete="off" /><button class="btn btn-primary">Envoyer</button></form>';
  }
  function appendGroupMessage(m) {
    const box = $('#group-chat'); if (!box) return;
    const me = m.from === state.user.id;
    box.insertAdjacentHTML('beforeend', '<div class="msg ' + (me ? 'me' : 'them') + '"><b style="font-size:12px">' + esc(m.fromName) + '</b><br>' + esc(m.text) + '<span class="t">' + timeAgo(m.createdAt) + '</span></div>');
    box.scrollTop = box.scrollHeight;
  }

  /* ================= MARCHE / PRODUCTS ================= */
  async function renderMarket() {
    try { const d = await api('/products'); state.products = d.products || []; } catch (e) {}
    const cards = state.products.map(p => {
      const mine = p.userId === state.user.id;
      return '<div class="card product-card"><div class="post-head">' + avatarHTML(p, 34) +
        '<div class="who"><div class="name">' + esc(p.author) + '</div><div class="meta">' + timeAgo(p.createdAt) + '</div></div></div>' +
        (p.imageUrl ? '<img src="' + p.imageUrl + '" />' : '') +
        '<div style="padding:8px 2px"><b>' + esc(p.title) + '</b><div class="muted small">' + esc(p.description) + '</div>' +
        '<div class="flex spread mt"><b style="color:var(--blue)">' + esc(p.price) + '</b>' +
        (mine ? '<button class="btn btn-danger btn-sm" data-action="delprod" data-id="' + p.id + '">Supprimer</button>' : '') + '</div></div></div>';
    }).join('');
    viewBox('<div class="flex spread mb"><h2 class="section-title" style="margin:0">🛒 Boutique</h2>' +
      '<button class="btn btn-primary btn-sm" id="new-prod">+ Vendre</button></div>' +
      '<div class="grid3">' + (cards || '<div class="empty">Aucun produit en vente.</div>') + '</div>'
    );
    $('#new-prod').addEventListener('click', () => {
      openModal('Vendre un produit', '<div class="field"><label>Titre</label><input id="p-title" maxlength="100"/></div>' +
        '<div class="field"><label>Description</label><textarea id="p-desc" maxlength="1000"></textarea></div>' +
        '<div class="field"><label>Prix</label><input id="p-price" maxlength="40" placeholder="ex: 5 000 FCFA"/></div>' +
        '<div class="field"><label>Photo</label><input type="file" id="p-file" accept="image/*"/></div>' +
        '<button class="btn btn-primary btn-block" id="p-submit">Publier</button>');
      let img = '';
      $('#p-file').addEventListener('change', async e => { try { img = await resizeImage(e.target.files[0], 1280); } catch (err) { toast('Image trop lourde','err'); } });
      $('#p-submit').addEventListener('click', async () => {
        const title = $('#p-title').value.trim(), desc = $('#p-desc').value.trim(), price = $('#p-price').value.trim();
        if (!title || !desc || !price) { toast('Remplis tous les champs', 'err'); return; }
        try { await api('/products', { method: 'POST', body: { title, description: desc, price, imageUrl: img } }); closeModal(); renderMarket(); }
        catch (e) { toast(e.message, 'err'); }
      });
    });
  }

  /* ================= RECHERCHE ================= */
  async function renderSearch() {
    viewBox('<div class="card"><input id="search-input" placeholder="Rechercher un utilisateur par nom ou pays…" /></div><div id="search-results"></div>');
    $('#search-input').addEventListener('input', debounce(async () => {
      const q = $('#search-input').value.trim();
      if (!q) { $('#search-results').innerHTML = ''; return; }
      try {
        const d = await api('/users?search=' + encodeURIComponent(q));
        $('#search-results').innerHTML = (d.users || []).map(userRowHTML).join('') || '<div class="empty">Aucun résultat.</div>';
        bindUserRows();
      } catch (e) { toast(e.message, 'err'); }
    }, 350));
  }
  function userRowHTML(u) {
    const online = state.online.has(u.id);
    return '<div class="row userrow" data-uid="' + u.id + '">' + avatarHTML(u, 44) +
      '<div class="who"><div class="name">' + esc(u.name) + (u.isAdmin ? ' <span class="chip">ADMIN</span>' : '') + '</div>' +
      '<div class="sub">' + esc(u.country || 'Pays inconnu') + '</div></div>' +
      '<span class="online-dot ' + (online ? 'on' : '') + '"></span></div>';
  }
  function bindUserRows() {
    $$('.userrow').forEach(r => r.addEventListener('click', () => openUserProfile(r.dataset.uid)));
  }

  /* ---------- Profil d'un utilisateur (modale) ---------- */
  async function openUserProfile(userId) {
    try {
      const d = await api('/users/' + userId);
      const u = d.user;
      const blockedRes = await api('/blocks');
      const isBlocked = (blockedRes.blocked || []).some(b => b.id === userId);
      const online = state.online.has(userId);
      openModal('<div class="flex">' + avatarHTML(u, 64) + '<div><b style="font-size:20px">' + esc(u.name) + '</b>' +
        '<div class="small muted">' + esc(u.country || '') + '</div>' +
        '<span class="online-dot ' + (online ? 'on' : '') + '" style="margin-right:4px"></span>' + (online ? 'En ligne' : 'Hors ligne') + '</div></div>',
        '<div class="divider"></div>' +
        '<div class="flex wrap">' +
        '<button class="btn btn-primary btn-sm" data-ua="msg" data-id="' + u.id + '">💬 Message</button>' +
        '<button class="btn btn-ghost btn-sm" data-ua="block' + (isBlocked ? '-off' : '') + '" data-id="' + u.id + '">' + (isBlocked ? '🔓 Débloquer' : '🚫 Bloquer') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-ua="report" data-id="' + u.id + '">⚠️ Signaler</button></div>');
      $$('[data-ua]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.ua, id = b.dataset.id;
        if (a === 'msg') { closeModal(); startChatWith(id); }
        else if (a === 'block' || a === 'block-off') {
          try {
            if (a === 'block') await api('/users/' + id + '/block', { method: 'POST' });
            else await api('/users/' + id + '/block', { method: 'DELETE' });
            toast(a === 'block' ? 'Utilisateur bloqué' : 'Utilisateur débloqué', 'ok'); closeModal();
          } catch (e) { toast(e.message, 'err'); }
        }
        else if (a === 'report') { closeModal(); openReport({ reportedUserId: id }); }
      }));
    } catch (e) { toast(e.message, 'err'); }
  }
  function startChatWith(id) {
    let c = state.chats.find(x => x.id === id);
    if (!c) { c = { id, name: 'Utilisateur', last: '', ts: new Date().toISOString() }; state.chats.unshift(c); }
    state.activeFriendId = id;
    switchTab('messages');
  }
  async function openReport(target) {
    openModal('Signaler', '<div class="field"><label>Raison</label><select id="r-reason">' +
      ['Spam ou arnaque', 'Contenu inapproprié', 'Harcèlement', 'Usurpation d\'identité', 'Autre']
      .map(r => '<option>' + r + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Détails (optionnel)</label><textarea id="r-details" maxlength="1000"></textarea></div>' +
      '<button class="btn btn-primary btn-block" id="r-submit">Envoyer le signalement</button>');
    $('#r-submit').addEventListener('click', async () => {
      try {
        await api('/reports', { method: 'POST', body: { ...target, reason: $('#r-reason').value, details: $('#r-details').value.trim() } });
        toast('Signalement envoyé. Merci !', 'ok'); closeModal();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* ================= NOTIFICATIONS ================= */
  async function refreshNotifications() {
    try { const d = await api('/notifications'); state.notifs = d.notifications || []; updateNotifBadge(); } catch (e) {}
  }
  async function openNotifs() {
    try { const d = await api('/notifications'); state.notifs = d.notifications || []; } catch (e) {}
    await api('/notifications/mark-read', { method: 'POST' }).catch(() => {});
    state.notifs.forEach(n => n.isRead = true);
    updateNotifBadge();
    const html = state.notifs.length ? state.notifs.map(n => {
      const act = n.type === 'like' ? '❤️ ' : n.type === 'comment' ? '💬 ' : n.type === 'message' ? '💬 ' : '🔔 ';
      return '<div class="row" data-notif>'+ avatarHTML({ avatarUrl: n.senderAvatar, author: n.senderName }, 40) +
        '<div class="who"><div class="small"><b>' + esc(n.senderName) + '</b> ' + esc(n.text) + '</div>' +
        '<div class="meta small muted">' + timeAgo(n.createdAt) + '</div></div></div>';
    }).join('') : '<div class="empty">Aucune notification.</div>';
    openModal('Notifications', html);
  }

  /* ================= PROFIL / RÉGLAGES ================= */
  async function renderProfile() {
    const u = state.me || state.user;
    const online = state.connected;
    viewBox('<div class="card">' +
      '<div class="center">' + avatarHTML(u, 96) +
      '<h2 style="margin-top:8px">' + esc(u.name) + (u.isAdmin ? ' <span class="chip">ADMIN</span>' : '') + '</h2>' +
      '<div class="muted">' + esc(u.country || '') + '</div>' +
      '<div class="chip mt">' + Number(u.coins || 0).toLocaleString('fr-FR') + ' jetons</div>' +
      '<div class="chip" style="background:#fff3d6;color:#a66">' + (u.isPremium ? '⭐ ' + esc(u.subscriptionTier || 'premium') : 'Compte standard') + '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="field"><label>Avatar</label><input type="file" id="up-avatar" accept="image/*"/></div>' +
      '<div class="field"><label>Pays</label><input id="up-country" value="' + esc(u.country || '') + '" maxlength="80"/></div>' +
      '<button class="btn btn-primary" id="up-save">Enregistrer le profil</button>' +
      '<div class="divider"></div>' +
      '<h3 class="small muted">Abonnement</h3>' +
      '<div class="flex wrap mt">' +
      '<button class="btn btn-ghost btn-sm" data-tier="standard">Standard</button>' +
      '<button class="btn btn-ghost btn-sm" data-tier="premium">⭐ Premium</button>' +
      '<button class="btn btn-ghost btn-sm" data-tier="elite">👑 Elite</button></div>' +
      '<div class="divider"></div>' +
      '<div class="flex wrap">' +
      '<button class="btn btn-success" id="up-coins">💰 Recharger des jetons</button>' +
      '<button class="btn btn-ghost" id="up-export">⬇️ Exporter mes données (RGPD)</button></div>' +
      '<div class="divider"></div>' +
      '<button class="btn btn-danger" id="up-delete">Supprimer définitivement mon compte</button>' +
      '</div>'
    );
    $('#up-avatar').addEventListener('change', async e => {
      if (!e.target.files[0]) return;
      try { const img = await resizeImage(e.target.files[0], 600); await saveProfile(null, img); }
      catch (err) { toast('Image invalide', 'err'); }
    });
    $('#up-save').addEventListener('click', () => saveProfile($('#up-country').value.trim(), null));
    $$('[data-tier]').forEach(b => b.addEventListener('click', async () => {
      try { const d = await api('/me/subscription', { method: 'PATCH', body: { subscriptionTier: b.dataset.tier } }); state.me = d.user; renderProfile(); toast('Abonnement mis à jour', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }));
    $('#up-coins').addEventListener('click', openCoinsModal);
    $('#up-export').addEventListener('click', exportData);
    $('#up-delete').addEventListener('click', deleteAccount);
  }
  async function saveProfile(country, avatarUrl) {
    try {
      const d = await api('/me', { method: 'PATCH', body: { country: country == null ? (state.me.country || '') : country, avatarUrl: avatarUrl || '' } });
      state.me = d.user; state.user = d.user; setAvatarButton();
      toast('Profil enregistré', 'ok'); renderProfile();
    } catch (e) { toast(e.message, 'err'); }
  }
  function openCoinsModal() {
    const pkgs = [[500, 500], [1000, 1100], [2000, 2300], [5000, 6000], [10000, 12500]];
    openModal('Recharger des jetons',
      '<div class="small muted mb">Démo : recharge simulée (aucun paiement réel n\'est effectué).</div>' +
      '<div class="field"><label>Forfait</label><select id="coin-pkg">' +
      pkgs.map(p => '<option value="' + p[0] + '" data-coins="' + p[1] + '">' + p[0].toLocaleString('fr-FR') + ' FCFA → ' + p[1].toLocaleString('fr-FR') + ' jetons</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Moyen de paiement</label><select id="coin-method">' +
      '<option value="mtn_momo">MTN MoMo</option><option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option>' +
      '</select></div>' +
      '<button class="btn btn-primary btn-block" id="coin-submit">Recharger</button>');
    $('#coin-submit').addEventListener('click', async () => {
      const sel = $('#coin-pkg');
      try {
        const d = await api('/me/buy-coins', { method: 'POST', body: { amount: Number(sel.value), coins: Number(sel.options[sel.selectedIndex].dataset.coins), paymentMethod: $('#coin-method').value } });
        state.me = d.user; state.user = d.user; setAvatarButton();
        toast(d.message || 'Rechargé !', 'ok'); closeModal(); renderProfile();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  async function exportData() {
    try {
      const res = await fetch('/api/me/export', { headers: { 'Authorization': 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('Export impossible');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'xys-book-data.json';
      a.click();
      toast('Données exportées', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  function deleteAccount() {
    const pwd = prompt('Pour confirmer la suppression définitive, entre ton mot de passe :');
    if (pwd === null) return;
    api('/me', { method: 'DELETE', body: { password: pwd } })
      .then(() => { toast('Compte supprimé. À bientôt !', 'ok'); logout(); })
      .catch(e => toast(e.message, 'err'));
  }

  /* ================= MODALE ================= */
  function openModal(title, bodyHTML) {
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-backdrop" id="modal-bd"><div class="modal">' +
      '<div class="modal-head"><h3>' + (typeof title === 'string' ? esc(title) : '') + '</h3><button class="x" id="modal-close">✕</button></div>' +
      '<div id="modal-body">' + (typeof title === 'string' ? bodyHTML : title.innerHTML + bodyHTML) + '</div></div></div>';
    $('#modal-bd').addEventListener('click', e => { if (e.target.id === 'modal-bd') closeModal(); });
    $('#modal-close').addEventListener('click', closeModal);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  /* ---------- Story actions ---------- */
  async function addStory() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        const mediaUrl = await resizeImage(input.files[0], 1400);
        await api('/stories', { method: 'POST', body: { type: 'image', mediaUrl } });
        toast('Story publiée !', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  }
  async function viewStory(sid) {
    try { const d = await api('/stories'); const s = (d.stories || []).find(x => x.id === sid); if (!s) return;
      openModal('<h3>' + esc(s.author) + '</h3>', '<div class="center"><img class="story-media" src="' + s.mediaUrl + '" /></div>'); }
    catch (e) {}
  }

  /* ================= GLOBAL CLICK DELEGATION ================= */
  document.addEventListener('click', async e => {
    const postTarget = e.target.closest('[data-action]');
    if (postTarget) {
      const act = postTarget.dataset.action;
      if (act === 'like') { likePost(postTarget.dataset.id); }
      else if (act === 'comments') { toggleComments(postTarget.dataset.id); }
      else if (act === 'delpost') { delPost(postTarget.dataset.id); }
      else if (act === 'report') { openReport({ postId: postTarget.dataset.id }); }
      else if (act === 'delcomment') { delComment(postTarget.dataset.id); }
      else if (act === 'closechat') { state.activeFriendId = null; renderMessages(); }
      else if (act === 'closegroup') { state.activeGroupId = null; renderGroups(); }
      else if (act === 'add-story') { addStory(); }
      else if (act === 'view-story') { viewStory(postTarget.dataset.sid); }
      else if (act === 'delprod') {
        if (!confirm('Retirer ce produit ?')) return;
        try { await api('/products/' + postTarget.dataset.id, { method: 'DELETE' }); renderMarket(); } catch (err) { toast(err.message, 'err'); }
      }
    }
  });

  // Soumission de messages (privé & groupe) par délégation sur #view
  document.addEventListener('submit', async e => {
    const f = e.target;
    if (f.id === 'priv-form') {
      e.preventDefault();
      const text = f.text.value.trim(); const to = f.dataset.to;
      if (!text) return;
      f.text.value = '';
      const fake = { id: 'tmp', from: state.user.id, fromName: state.user.name, to, text, createdAt: new Date().toISOString() };
      state.socket.emit('private-message', { to, text });
      upsertChat(to, fake);
      appendMessage(fake);
    } else if (f.id === 'group-form') {
      e.preventDefault();
      const text = f.text.value.trim(); const gid = f.dataset.gid;
      if (!text) return; f.text.value = '';
      state.socket.emit('group-message', { groupId: gid, text });
    }
  });

  // Écouteurs de navigation
  $$('.nav-item, .bnav').forEach(el => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  $('#btn-home').addEventListener('click', () => switchTab('feed'));
  $('#btn-profile').addEventListener('click', renderProfile);
  $('#btn-notif').addEventListener('click', openNotifs);
  $$('.auth-tabs .tab-btn').forEach(b => b.addEventListener('click', () => setAuthTab(b.dataset.authtab)));
  $('#login-form').addEventListener('submit', doLogin);
  $('#register-form').addEventListener('submit', doRegister);
  $('#recover-form').addEventListener('submit', ev => {
    ev.preventDefault();
    if (ev.target.dataset.userId) doRecoverStep2(ev); else doRecoverStep1(ev);
  });

  /* ---------- Init ---------- */
  function init() {
    setAuthTab('login');
    if (state.token) {
      api('/me')
        .then(d => { enterApp(state.token, d.user); })
        .catch(() => {
          state.token = '';
          localStorage.removeItem('xys_token');
          $('#auth-view').hidden = false;
        });
    } else {
      $('#auth-view').hidden = false;
    }
  }
  init();
})();

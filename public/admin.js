/* XyS Book — tableau administrateur */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  let token = localStorage.getItem('xys_admin_token') || '';
  let current = 'dashboard';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'à l\'instant';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return d.toLocaleDateString('fr-FR');
  }
  function api(path, opts) {
    opts = opts || {};
    const h = opts.headers || {};
    h['Authorization'] = 'Bearer ' + token;
    if (opts.body && typeof opts.body !== 'string') { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    return fetch('/api' + path, { ...opts, headers: h }).then(async res => {
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(d.error || 'Erreur'); e.status = res.status; throw e; }
      return d;
    });
  }
  function msg(t, type) { const m = $('#al-msg'); m.className = 'auth-msg show ' + (type === 'ok' ? 'ok' : 'err'); m.textContent = t; }
  function toast(t, type) {
    const el = document.createElement('div');
    el.className = 'auth-msg show ' + (type === 'ok' ? 'ok' : 'err');
    el.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    el.textContent = t; document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async function doLogin(ev) {
    ev.preventDefault();
    const f = ev.target;
    try {
      const d = await api('/auth/login', { method: 'POST', body: { name: f.login.value.trim(), password: f.password.value } });
      if (!d.user.isAdmin) { msg('Ce compte n\'est pas administrateur.', 'err'); return; }
      token = d.token; localStorage.setItem('xys_admin_token', token);
      enter();
    } catch (e) { msg(e.message, 'err'); }
  }

  function enter() {
    $('#admin-login').hidden = true;
    $('#admin-app').hidden = false;
    load(current);
  }

  $$('.anav').forEach(b => b.addEventListener('click', () => {
    $$('.anav').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    current = b.dataset.a;
    load(current);
  }));

  async function load(section) {
    const m = $('#admin-main');
    m.innerHTML = '<div class="empty">Chargement…</div>';
    try {
      if (section === 'dashboard') await loadDashboard(m);
      else if (section === 'reports') await loadReports(m);
      else if (section === 'users') await loadUsers(m);
      else if (section === 'posts') await loadPosts(m);
      else if (section === 'comments') await loadComments(m);
      else if (section === 'logs') await loadLogs(m);
    } catch (e) {
      m.innerHTML = '<div class="card">Erreur : ' + esc(e.message) + '</div>';
      if (e.status === 401 || e.status === 403) logout();
    }
  }

  async function loadDashboard(m) {
    const s = await api('/admin/stats');
    m.innerHTML = '<h2 class="section-title">Vue d\'ensemble</h2><div class="stat-grid">' +
      stat(s.users, 'Utilisateurs') + stat(s.posts, 'Publications') + stat(s.comments, 'Commentaires') +
      stat(s.messages, 'Messages') + stat(s.pendingReports, 'Signalements en attente') + '</div>';
  }
  function stat(n, l) { return '<div class="stat"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>'; }

  async function loadReports(m) {
    const d = await api('/admin/reports');
    const rows = (d.reports || []).map(r => {
      const st = r.status || 'pending';
      const target = r.reported_name ? '👤 ' + esc(r.reported_name) : r.post_text ? '📄 ' + esc(r.post_text.slice(0, 60)) : 'Message';
      return '<tr><td>' + esc(r.reporter_name) + '</td><td>' + target + '</td><td>' + esc(r.reason) + '</td>' +
        '<td><span class="badge-status badge-' + st + '">' + st + '</span></td>' +
        '<td><div class="tbl-actions">' +
        '<button class="btn btn-ghost btn-sm" data-rs="reviewed" data-id="' + r.id + '">Traité</button>' +
        '<button class="btn btn-ghost btn-sm" data-rs="rejected" data-id="' + r.id + '">Rejeter</button></div></td></tr>';
    }).join('');
    m.innerHTML = '<h2 class="section-title">🚩 Signalements</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Signalé par</th><th>Cible</th><th>Raison</th><th>Statut</th><th>Action</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="5" class="empty">Aucun signalement.</td></tr>') + '</tbody></table></div>';
    $$('[data-rs]').forEach(b => b.addEventListener('click', async () => {
      try { await api('/admin/reports/' + b.dataset.id, { method: 'PATCH', body: { status: b.dataset.rs } }); toast('Mis à jour', 'ok'); load('reports'); }
      catch (e) { toast(e.message, 'err'); }
    }));
  }

  async function loadUsers(m) {
    const d = await api('/admin/users');
    const rows = (d.users || []).map(u =>
      '<tr><td><b>' + esc(u.name) + '</b>' + (u.isAdmin ? ' <span class="chip">ADMIN</span>' : '') + '</td>' +
      '<td>' + esc(u.email) + '</td><td>' + esc(u.country) + '</td>' +
      '<td>' + (u.isSuspended ? '<span class="badge-status badge-rejected">Suspendu</span>' : '<span class="badge-status badge-reviewed">Actif</span>') + '</td>' +
      '<td><span class="chip">' + esc(u.subscriptionTier || 'standard') + '</span> • ' + (Number(u.coins) || 0).toLocaleString('fr-FR') + ' j</td>' +
      '<td><div class="tbl-actions">' +
      '<button class="btn btn-sm ' + (u.isSuspended ? 'btn-success' : 'btn-danger') + '" data-sus="' + u.id + '" data-cur="' + u.isSuspended + '">' + (u.isSuspended ? 'Réactiver' : 'Suspendre') + '</button>' +
      '<button class="btn btn-sm btn-ghost" data-adm="' + u.id + '" data-cur="' + u.isAdmin + '">' + (u.isAdmin ? 'Retirer admin' : 'Promouvoir admin') + '</button>' +
      '<button class="btn btn-sm btn-ghost" data-tier="' + u.id + '" data-cur="' + (u.subscriptionTier || 'standard') + '">Niveau</button>' +
      '<button class="btn btn-sm btn-ghost" data-coin="' + u.id + '">Jetons</button></div></td></tr>'
    ).join('');
    m.innerHTML = '<h2 class="section-title">👥 Utilisateurs</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Nom</th><th>E-mail</th><th>Pays</th><th>Statut</th><th>Abonnement</th><th>Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty">Aucun utilisateur.</td></tr>') + '</tbody></table></div>';
    $$('[data-sus]').forEach(b => b.addEventListener('click', async () => {
      const suspend = b.dataset.cur !== 'true';
      let reason = '';
      if (suspend) reason = prompt('Raison de la suspension :', 'Violation des règles de la communauté') || '';
      try {
        await api('/admin/users/' + b.dataset.sus + '/suspend', { method: 'PATCH', body: { suspended: suspend, reason } });
        toast(suspend ? 'Compte suspendu' : 'Compte réactivé', 'ok'); load('users');
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-adm]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('/admin/users/' + b.dataset.adm + '/admin', { method: 'PATCH', body: { isAdmin: b.dataset.cur !== 'true' } });
        toast('Rôle mis à jour', 'ok'); load('users');
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-tier]').forEach(b => b.addEventListener('click', async () => {
      const val = prompt('Niveau (standard, premium ou elite) :', b.dataset.cur);
      if (!val) return;
      try {
        await api('/admin/users/' + b.dataset.tier + '/subscription', { method: 'PATCH', body: { subscriptionTier: val.trim().toLowerCase() } });
        toast('Abonnement mis à jour', 'ok'); load('users');
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-coin]').forEach(b => b.addEventListener('click', async () => {
      const val = prompt('Nombre de jetons à ajouter (positif) :', '1000');
      const amount = Number(val);
      if (!amount) return;
      try {
        await api('/admin/users/' + b.dataset.coin + '/coins', { method: 'POST', body: { amount } });
        toast('Jetons crédités', 'ok'); load('users');
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  async function loadPosts(m) {
    const d = await api('/admin/posts');
    const rows = (d.posts || []).map(p =>
      '<tr><td><b>' + esc(p.author) + '</b></td><td>' + esc((p.text || '').slice(0, 80)) + (p.imageUrl ? ' 🖼️' : '') + '</td>' +
      '<td>' + p.likes + ' 👍 / ' + p.commentCount + ' 💬</td><td>' + timeAgo(p.createdAt) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" data-delp="' + p.id + '">Supprimer</button></td></tr>'
    ).join('');
    m.innerHTML = '<h2 class="section-title">📄 Publications</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Auteur</th><th>Contenu</th><th>Stats</th><th>Date</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="empty">Aucune publication.</td></tr>') + '</tbody></table></div>';
    $$('[data-delp]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Supprimer cette publication ?')) return;
      try { await api('/admin/posts/' + b.dataset.delp, { method: 'DELETE' }); toast('Supprimée', 'ok'); load('posts'); }
      catch (e) { toast(e.message, 'err'); }
    }));
  }

  async function loadComments(m) {
    const d = await api('/admin/comments');
    const rows = (d.comments || []).map(c =>
      '<tr><td><b>' + esc(c.author) + '</b></td><td>' + esc(c.text) + '</td><td class="small muted">sur « ' + esc((c.postText || '').slice(0, 40)) + ' »</td>' +
      '<td><button class="btn btn-danger btn-sm" data-delo="' + c.id + '">Supprimer</button></td></tr>'
    ).join('');
    m.innerHTML = '<h2 class="section-title">💬 Commentaires</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Auteur</th><th>Commentaire</th><th>Publication</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" class="empty">Aucun commentaire.</td></tr>') + '</tbody></table></div>';
    $$('[data-delo]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Supprimer ce commentaire ?')) return;
      try { await api('/admin/comments/' + b.dataset.delo, { method: 'DELETE' }); toast('Supprimé', 'ok'); load('comments'); }
      catch (e) { toast(e.message, 'err'); }
    }));
  }

  async function loadLogs(m) {
    const d = await api('/admin/logs');
    const rows = (d.logs || []).map(l =>
      '<tr><td>' + (l.admin_name ? '<b>' + esc(l.admin_name) + '</b>' : '—') + '</td><td>' + esc(l.action) + '</td>' +
      '<td>' + esc(l.target_type) + ' ' + esc((l.target_id || '').slice(0, 8)) + '</td>' +
      '<td class="small">' + esc(l.details || '') + '</td><td>' + timeAgo(l.created_at) + '</td></tr>'
    ).join('');
    m.innerHTML = '<h2 class="section-title">📜 Journal des actions admin</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Admin</th><th>Action</th><th>Cible</th><th>Détails</th><th>Date</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="empty">Aucune action enregistrée.</td></tr>') + '</tbody></table></div>';
  }

  function logout() {
    token = ''; localStorage.removeItem('xys_admin_token');
    $('#admin-login').hidden = false; $('#admin-app').hidden = true;
  }
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-refresh').addEventListener('click', () => load(current));
  $('#al-form').addEventListener('submit', doLogin);

  if (token) enter();
})();

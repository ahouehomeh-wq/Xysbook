require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

if (!JWT_SECRET) {
  console.error('ERREUR: ajoute JWT_SECRET dans les variables d’environnement.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('ERREUR: ajoute DATABASE_URL PostgreSQL dans les variables d’environnement.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const originConfig = CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.split(',').map(x => x.trim());

function id() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function initials(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
}
function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: '',
    country: row.country || '',
    avatarUrl: row.avatar_url || '',
    isAdmin: Boolean(row.is_admin),
    isSuspended: Boolean(row.is_suspended),
    isPremium: Boolean(row.is_premium || row.subscription_tier === 'premium' || row.subscription_tier === 'elite'),
    subscriptionTier: row.subscription_tier || 'standard',
    coins: Number(row.coins || 0),
    createdAt: row.created_at || row.createdAt
  };
}
function adminUser(row) {
  return { ...publicUser(row), email: row.email || '', suspensionReason: row.suspension_reason || '' };
}
function publicPost(row) {
  return {
    id: row.id,
    userId: row.user_id,
    author: row.author,
    avatarUrl: row.avatar_url || '',
    text: row.text,
    imageUrl: row.image_url || '',
    likes: Number(row.likes || 0),
    commentCount: Number(row.comment_count || 0),
    isPremium: Boolean(row.is_premium || row.isPremium || row.subscription_tier === 'premium' || row.subscription_tier === 'elite' || row.subscriptionTier === 'premium' || row.subscriptionTier === 'elite'),
    subscriptionTier: row.subscription_tier || row.subscriptionTier || 'standard',
    createdAt: row.created_at || row.createdAt
  };
}
function publicComment(row) {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    author: row.author,
    avatarUrl: row.avatar_url || '',
    text: row.text,
    isPremium: Boolean(row.is_premium || row.isPremium),
    createdAt: row.created_at || row.createdAt
  };
}
function publicMessage(row) {
  return {
    id: row.id,
    from: row.sender_id,
    fromName: row.from_name,
    to: row.receiver_id,
    text: row.text,
    createdAt: row.created_at || row.createdAt
  };
}
function safeText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

const rateStore = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'ip';
    const user = req.user?.id || 'anon';
    const key = `${name}:${user}:${ip}`;
    const now = Date.now();
    const item = rateStore.get(key) || { count: 0, reset: now + windowMs };
    if (now > item.reset) { item.count = 0; item.reset = now + windowMs; }
    item.count += 1;
    rateStore.set(key, item);
    if (item.count > max) return res.status(429).json({ error: 'Trop d’actions. Réessaie dans quelques instants.' });
    next();
  };
}
const authLimiter = rateLimit('auth', 20, 15 * 60 * 1000);
const postLimiter = rateLimit('post', 12, 60 * 1000);
const commentLimiter = rateLimit('comment', 30, 60 * 1000);
const reportLimiter = rateLimit('report', 10, 10 * 60 * 1000);
const profileLimiter = rateLimit('profile', 20, 10 * 60 * 1000);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      country TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
      suspension_reason TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_question TEXT DEFAULT 'Nom de ta ville de naissance ?';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_answer_hash TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'standard';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 50000;

    CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_unique ON users (LOWER(name));
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email)) WHERE email IS NOT NULL AND email <> '';

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
    CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages (sender_id, receiver_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_logs_created_idx ON admin_logs (created_at DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS group_messages_idx ON group_messages (group_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price TEXT NOT NULL,
      image_url TEXT DEFAULT '',
      is_boosted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS products_boosted_idx ON products (is_boosted DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      type TEXT NOT NULL,
      media_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS stories_created_idx ON stories (created_at DESC);

    CREATE TABLE IF NOT EXISTS lives (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function applyAdminEmails() {
  if (!ADMIN_EMAILS.length) return;
  await pool.query('UPDATE users SET is_admin=TRUE WHERE LOWER(email)=ANY($1::text[])', [ADMIN_EMAILS]);
}

function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name, isAdmin: Boolean(user.isAdmin) }, JWT_SECRET, { expiresIn: '30d' });
}
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, name, is_admin, is_suspended FROM users WHERE id=$1', [decoded.id]);
    if (!result.rowCount) return res.status(401).json({ error: 'Utilisateur introuvable' });
    const row = result.rows[0];
    if (row.is_suspended) return res.status(403).json({ error: 'Ce compte est suspendu' });
    req.user = { id: row.id, name: row.name, isAdmin: Boolean(row.is_admin) };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}
async function adminMiddleware(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin, is_suspended FROM users WHERE id=$1', [req.user.id]);
    if (!result.rowCount) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (result.rows[0].is_suspended) return res.status(403).json({ error: 'Compte suspendu' });
    if (!result.rows[0].is_admin) return res.status(403).json({ error: 'Accès administrateur refusé' });
    next();
  } catch (error) {
    next(error);
  }
}

async function logAdmin(req, action, targetType = '', targetId = '', details = '') {
  try {
    await pool.query(
      `INSERT INTO admin_logs (id, admin_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id(), req.user.id, action, targetType, targetId, safeText(details, 1000)]
    );
  } catch (error) {
    console.error('Erreur journal admin:', error);
  }
}

async function createNotification(userId, senderId, type, postId, text) {
  try {
    if (userId === senderId) return; // Pas d'auto-notification
    const notifId = id();
    await pool.query(
      `INSERT INTO notifications (id, user_id, sender_id, type, post_id, text) VALUES ($1, $2, $3, $4, $5, $6)`,
      [notifId, userId, senderId, type, postId, text]
    );
    const senderRes = await pool.query('SELECT name, avatar_url FROM users WHERE id=$1', [senderId]);
    const senderName = senderRes.rowCount ? senderRes.rows[0].name : 'Quelqu’un';
    const senderAvatar = senderRes.rowCount ? senderRes.rows[0].avatar_url : '';

    const payload = {
      id: notifId,
      userId,
      senderId,
      senderName,
      senderAvatar,
      type,
      postId,
      text,
      isRead: false,
      createdAt: new Date().toISOString()
    };
    io.to(userId).emit('new-notification', payload);
  } catch (error) {
    console.error('Erreur creation notification:', error);
  }
}

async function isBlocked(a, b) {
  const result = await pool.query(
    `SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
    [a, b]
  );
  return result.rowCount > 0;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: originConfig } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: originConfig }));
app.use(express.json({ limit: '750kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected', app: 'XyS Book Mondial' });
  } catch (error) {
    res.status(500).json({ ok: false, database: 'error' });
  }
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const cleanName = safeText(req.body?.name, 60);
    const cleanEmail = safeText(req.body?.email, 120).toLowerCase();
    const cleanCountry = safeText(req.body?.country, 80);
    const password = String(req.body?.password || '');
    const recoveryQuestion = safeText(req.body?.recoveryQuestion, 150) || 'Nom de ta ville de naissance ?';
    const recoveryAnswer = safeText(req.body?.recoveryAnswer, 100).toLowerCase();

    if (!cleanName || !password) return res.status(400).json({ error: 'Nom et mot de passe obligatoires' });
    if (cleanName.length < 2) return res.status(400).json({ error: 'Nom trop court' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe: 6 caractères minimum' });
    if (!recoveryAnswer) return res.status(400).json({ error: 'Réponse de récupération obligatoire pour sécuriser le compte' });

    const exists = await pool.query(
      `SELECT id FROM users WHERE LOWER(name)=LOWER($1) OR ($2 <> '' AND LOWER(email)=LOWER($2)) LIMIT 1`,
      [cleanName, cleanEmail]
    );
    if (exists.rowCount) return res.status(409).json({ error: 'Ce compte existe déjà' });

    const passwordHash = await bcrypt.hash(password, 12);
    const recoveryAnswerHash = await bcrypt.hash(recoveryAnswer, 12);
    const isAdmin = ADMIN_EMAILS.includes(cleanEmail);
    const result = await pool.query(
      `INSERT INTO users (id, name, email, country, is_admin, password_hash, recovery_question, recovery_answer_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, created_at`,
      [id(), cleanName, cleanEmail, cleanCountry, isAdmin, passwordHash, recoveryQuestion, recoveryAnswerHash]
    );
    const user = publicUser(result.rows[0]);
    io.emit('new-user', user);
    res.json({ token: signToken(user), user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const login = safeText(req.body?.name, 120);
    const result = await pool.query(
      `SELECT id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, password_hash, created_at FROM users
       WHERE LOWER(name)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`,
      [login]
    );
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(String(req.body?.password || ''), row.password_hash))) {
      return res.status(401).json({ error: 'Nom/email ou mot de passe incorrect' });
    }
    if (row.is_suspended) return res.status(403).json({ error: 'Ce compte est suspendu' });
    const user = publicUser(row);
    res.json({ token: signToken(user), user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur connexion' });
  }
});

app.post('/api/auth/recovery-question', authLimiter, async (req, res) => {
  try {
    const login = safeText(req.body?.login, 120);
    if (!login) return res.status(400).json({ error: 'Nom ou email obligatoire' });

    const result = await pool.query(
      `SELECT id, recovery_question FROM users WHERE LOWER(name)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`,
      [login]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });

    res.json({
      userId: result.rows[0].id,
      question: result.rows[0].recovery_question || 'Nom de ta ville de naissance ?'
    });
  } catch (error) {
    console.error('Erreur get recovery question:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la question secrète' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const userId = safeText(req.body?.userId, 100);
    const answer = safeText(req.body?.answer, 100).toLowerCase();
    const newPassword = String(req.body?.newPassword || '');

    if (!userId || !answer || !newPassword) {
      return res.status(400).json({ error: 'Tous les champs sont obligatoires' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Nouveau mot de passe: 6 caractères minimum' });
    }

    const userRes = await pool.query('SELECT recovery_answer_hash FROM users WHERE id=$1', [userId]);
    if (!userRes.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const answerHash = userRes.rows[0].recovery_answer_hash;
    if (!answerHash) {
      return res.status(400).json({ error: 'Ce compte n’a pas configuré de question secrète de récupération.' });
    }

    const match = await bcrypt.compare(answer, answerHash);
    if (!match) return res.status(401).json({ error: 'Réponse incorrecte' });

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newPasswordHash, userId]);

    res.json({ ok: true, message: 'Mot de passe réinitialisé avec succès !' });
  } catch (error) {
    console.error('Erreur reset password:', error);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, is_premium, subscription_tier, coins, created_at FROM users WHERE id=$1', [req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ user: publicUser(result.rows[0]) });
});

app.patch('/api/me', authMiddleware, profileLimiter, async (req, res) => {
  const country = safeText(req.body?.country, 80);
  const avatarUrl = String(req.body?.avatarUrl || '').trim();
  if (avatarUrl && (!avatarUrl.startsWith('data:image/') || avatarUrl.length > 450000)) {
    return res.status(400).json({ error: 'Image invalide ou trop lourde. Choisis une petite image.' });
  }
  const result = await pool.query(
    `UPDATE users SET country=$1, avatar_url=$2 WHERE id=$3 RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, is_premium, subscription_tier, coins, created_at`,
    [country, avatarUrl, req.user.id]
  );
  const user = publicUser(result.rows[0]);
  io.emit('profile-updated', user);
  res.json({ user });
});

app.patch('/api/me/subscription', authMiddleware, async (req, res) => {
  try {
    const tier = String(req.body?.subscriptionTier || 'standard').toLowerCase();
    if (!['standard', 'premium', 'elite'].includes(tier)) {
      return res.status(400).json({ error: 'Niveau d’abonnement invalide' });
    }
    const isPremium = (tier === 'premium' || tier === 'elite');
    const result = await pool.query(
      `UPDATE users SET subscription_tier=$1, is_premium=$2 WHERE id=$3 RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, is_premium, subscription_tier, coins, created_at`,
      [tier, isPremium, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const user = publicUser(result.rows[0]);
    io.emit('profile-updated', user);
    res.json({ user });
  } catch (error) {
    console.error('Erreur patch subscription:', error);
    res.status(500).json({ error: 'Erreur lors de la modification de l’abonnement' });
  }
});

app.get('/api/me/export', authMiddleware, profileLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRes, postsRes, commentsRes, messagesRes, blocksRes, reportsRes] = await Promise.all([
      pool.query('SELECT id, name, email, country, avatar_url, is_admin, created_at FROM users WHERE id=$1', [userId]),
      pool.query('SELECT id, text, likes, created_at FROM posts WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT id, post_id, text, created_at FROM comments WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT id, sender_id, receiver_id, from_name, text, created_at FROM messages WHERE sender_id=$1 OR receiver_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT blocked_id, created_at FROM blocks WHERE blocker_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT id, reported_user_id, post_id, message_id, reason, details, status, created_at FROM reports WHERE reporter_id=$1 ORDER BY created_at DESC', [userId])
    ]);

    if (!userRes.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const exportData = {
      profile: userRes.rows[0],
      posts: postsRes.rows,
      comments: commentsRes.rows,
      messages: messagesRes.rows,
      blocked_users: blocksRes.rows,
      reports_filed: reportsRes.rows,
      exported_at: new Date().toISOString(),
      disclaimer: "Ce fichier contient l'intégralité de vos données personnelles collectées par XyS Book. Conformément au RGPD et aux règles de confidentialité de Meta, vous disposez du droit à la portabilité de vos données."
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="xys-book-data-${userId}.json"`);
    res.json(exportData);
  } catch (error) {
    console.error('Erreur export de données:', error);
    res.status(500).json({ error: 'Erreur lors de l’export des données' });
  }
});

app.delete('/api/me', authMiddleware, profileLimiter, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: 'Mot de passe obligatoire pour valider la suppression' });

    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const passwordHash = result.rows[0].password_hash;
    const match = await bcrypt.compare(password, passwordHash);
    if (!match) return res.status(401).json({ error: 'Mot de passe incorrect' });

    await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);

    io.emit('user-deleted', { id: req.user.id });
    io.emit('presence', { id: req.user.id, name: req.user.name, online: false });

    res.json({ ok: true, message: 'Compte supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression compte:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du compte' });
  }
});

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.id, n.user_id, n.sender_id, n.type, n.post_id, n.text, n.is_read, n.created_at,
              u.name AS sender_name, u.avatar_url AS sender_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id=n.sender_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ notifications: result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      senderId: row.sender_id,
      senderName: row.sender_name || 'Quelqu’un',
      senderAvatar: row.sender_avatar || '',
      type: row.type,
      postId: row.post_id,
      text: row.text,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Erreur get notifications:', error);
    res.status(500).json({ error: 'Erreur de récupération des notifications' });
  }
});

app.post('/api/notifications/mark-read', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Erreur mark-read notifications:', error);
    res.status(500).json({ error: 'Erreur mise à jour des notifications' });
  }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.description, g.creator_id, g.created_at,
              COUNT(gm.user_id)::int AS member_count,
              EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$1) AS is_member
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id=g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`
    , [req.user.id]);
    res.json({ groups: result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      creatorId: row.creator_id,
      createdAt: row.created_at,
      memberCount: Number(row.member_count),
      isMember: Boolean(row.is_member)
    })) });
  } catch (error) {
    console.error('Erreur get groups:', error);
    res.status(500).json({ error: 'Erreur de récupération des groupes' });
  }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const name = safeText(req.body?.name, 80);
    const description = safeText(req.body?.description, 200);
    if (!name) return res.status(400).json({ error: 'Nom du groupe obligatoire' });

    const groupId = id();
    await pool.query(
      `INSERT INTO groups (id, name, description, creator_id) VALUES ($1, $2, $3, $4)`,
      [groupId, name, description, req.user.id]
    );
    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
      [groupId, req.user.id]
    );

    res.json({ ok: true, groupId });
  } catch (error) {
    console.error('Erreur post group:', error);
    res.status(500).json({ error: 'Erreur de création du groupe' });
  }
});

app.post('/api/groups/:id/join', authMiddleware, async (req, res) => {
  try {
    const groupId = req.params.id;
    const exists = await pool.query('SELECT 1 FROM groups WHERE id=$1', [groupId]);
    if (!exists.rowCount) return res.status(404).json({ error: 'Groupe introuvable' });

    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Erreur join group:', error);
    res.status(500).json({ error: 'Impossible de rejoindre le groupe' });
  }
});

app.post('/api/groups/:id/leave', authMiddleware, async (req, res) => {
  try {
    const groupId = req.params.id;
    await pool.query(
      `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [groupId, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Erreur leave group:', error);
    res.status(500).json({ error: 'Impossible de quitter le groupe' });
  }
});

app.get('/api/groups/:id/messages', authMiddleware, async (req, res) => {
  try {
    const groupId = req.params.id;
    const isMember = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, req.user.id]);
    if (!isMember.rowCount) return res.status(403).json({ error: 'Vous devez rejoindre le groupe pour lire les messages' });

    const result = await pool.query(
      `SELECT * FROM (
         SELECT gm.id, gm.group_id, gm.sender_id, gm.from_name, gm.text, gm.created_at, u.avatar_url
         FROM group_messages gm
         JOIN users u ON u.id=gm.sender_id
         WHERE gm.group_id=$1
         ORDER BY gm.created_at DESC
         LIMIT 100
       ) recent
       ORDER BY created_at ASC`,
      [groupId]
    );

    res.json({ messages: result.rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      from: row.sender_id,
      fromName: row.from_name,
      avatarUrl: row.avatar_url || '',
      text: row.text,
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Erreur get group messages:', error);
    res.status(500).json({ error: 'Erreur de récupération des messages' });
  }
});

app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.avatar_url, u.is_premium AS user_is_premium, u.subscription_tier AS user_tier
       FROM products p
       JOIN users u ON u.id = p.user_id
       WHERE u.is_suspended = FALSE
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=$1 AND b.blocked_id=p.user_id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=p.user_id AND b.blocked_id=$1)
       ORDER BY 
         CASE 
           WHEN u.subscription_tier = 'elite' THEN 3
           WHEN u.subscription_tier = 'premium' THEN 2
           WHEN p.is_boosted = TRUE THEN 2
           ELSE 1
         END DESC, 
         p.created_at DESC
       LIMIT 200`,
      [req.user.id]
    );

    res.json({ products: result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      author: row.author,
      title: row.title,
      description: row.description,
      price: row.price,
      imageUrl: row.image_url || '',
      isBoosted: Boolean(row.is_boosted || row.user_tier === 'premium' || row.user_tier === 'elite'),
      subscriptionTier: row.user_tier || 'standard',
      createdAt: row.created_at,
      avatarUrl: row.avatar_url || ''
    })) });
  } catch (error) {
    console.error('Erreur get products:', error);
    res.status(500).json({ error: 'Erreur de récupération des produits' });
  }
});

app.post('/api/products', authMiddleware, postLimiter, async (req, res) => {
  try {
    const title = safeText(req.body?.title, 100);
    const description = safeText(req.body?.description, 1000);
    const price = safeText(req.body?.price, 40);
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const isBoosted = Boolean(req.body?.isBoosted);

    if (!title || !description || !price) {
      return res.status(400).json({ error: 'Titre, description et prix obligatoires.' });
    }
    if (imageUrl && (!imageUrl.startsWith('data:image/') || imageUrl.length > 450000)) {
      return res.status(400).json({ error: 'Image produit invalide ou trop lourde. Choisissez moins de 350 Ko.' });
    }

    const productId = id();
    await pool.query(
      `INSERT INTO products (id, user_id, author, title, description, price, image_url, is_boosted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [productId, req.user.id, req.user.name, title, description, price, imageUrl, isBoosted]
    );

    io.emit('new-product', { id: productId, userId: req.user.id, author: req.user.name, title, description, price, imageUrl, isBoosted });

    res.json({ ok: true, productId });
  } catch (error) {
    console.error('Erreur post product:', error);
    res.status(500).json({ error: 'Erreur lors de l’ajout du produit' });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await pool.query('SELECT user_id FROM products WHERE id=$1', [productId]);
    if (!product.rowCount) return res.status(404).json({ error: 'Produit introuvable' });

    const ownerId = product.rows[0].user_id;
    if (ownerId !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Vous n’êtes pas autorisé à supprimer ce produit.' });
    }

    await pool.query('DELETE FROM products WHERE id=$1', [productId]);
    io.emit('product-deleted', { id: productId });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erreur delete product:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du produit' });
  }
});

app.get('/api/stories', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.avatar_url, u.subscription_tier
       FROM stories s
       JOIN users u ON u.id = s.user_id
       WHERE s.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY 
         CASE 
           WHEN u.subscription_tier = 'elite' THEN 3
           WHEN u.subscription_tier = 'premium' THEN 2
           ELSE 1
         END DESC,
         s.created_at DESC
       LIMIT 100`
    );
    res.json({ stories: result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      author: row.author,
      type: row.type,
      mediaUrl: row.media_url,
      avatarUrl: row.avatar_url || '',
      subscriptionTier: row.subscription_tier || 'standard',
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Erreur get stories:', error);
    res.status(500).json({ error: 'Erreur lors du chargement des stories' });
  }
});

app.post('/api/stories', authMiddleware, postLimiter, async (req, res) => {
  try {
    const type = safeText(req.body?.type, 10) || 'image';
    const mediaUrl = String(req.body?.mediaUrl || '').trim();

    if (!mediaUrl) return res.status(400).json({ error: 'Média de la story obligatoire' });
    if (mediaUrl.length > 550000) {
      return res.status(400).json({ error: 'Story trop lourde. Choisissez un fichier plus petit.' });
    }

    const storyId = id();
    await pool.query(
      `INSERT INTO stories (id, user_id, author, type, media_url) VALUES ($1, $2, $3, $4, $5)`,
      [storyId, req.user.id, req.user.name, type, mediaUrl]
    );

    io.emit('new-story', { id: storyId, userId: req.user.id, author: req.user.name, type, mediaUrl, createdAt: new Date().toISOString() });
    res.json({ ok: true, storyId });
  } catch (error) {
    console.error('Erreur post story:', error);
    res.status(500).json({ error: 'Erreur lors de la publication de la story' });
  }
});

app.get('/api/lives', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.avatar_url, u.subscription_tier
       FROM lives l
       JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC`
    );
    res.json({ lives: result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      author: row.author,
      title: row.title,
      avatarUrl: row.avatar_url || '',
      subscriptionTier: row.subscription_tier || 'standard',
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Erreur get lives:', error);
    res.status(500).json({ error: 'Erreur de récupération des direct' });
  }
});

app.post('/api/lives', authMiddleware, async (req, res) => {
  try {
    const title = safeText(req.body?.title, 100) || 'Vidéo en Direct de ' + req.user.name;
    const liveId = id();

    await pool.query(
      `INSERT INTO lives (id, user_id, author, title) VALUES ($1, $2, $3, $4)`,
      [liveId, req.user.id, req.user.name, title]
    );

    io.emit('live-started', { id: liveId, userId: req.user.id, author: req.user.name, title });
    res.json({ ok: true, liveId });
  } catch (error) {
    console.error('Erreur start live:', error);
    res.status(500).json({ error: 'Erreur de lancement du direct' });
  }
});

app.delete('/api/lives/:id', authMiddleware, async (req, res) => {
  try {
    const liveId = req.params.id;
    const result = await pool.query('DELETE FROM lives WHERE id=$1 AND user_id=$2 RETURNING id', [liveId, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Direct introuvable ou non autorisé.' });

    io.emit('live-stopped', { id: liveId });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erreur delete live:', error);
    res.status(500).json({ error: 'Erreur d’arrêt du direct' });
  }
});

app.post('/api/me/buy-coins', authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);
    const coinsToCredit = Number(req.body?.coins || 0);
    const paymentMethod = String(req.body?.paymentMethod || 'mtn_momo');
    const phone = String(req.body?.phone || '').trim();

    if (!coinsToCredit || !amount) {
      return res.status(400).json({ error: 'Montant de rechargement invalide' });
    }

    const result = await pool.query(
      `UPDATE users SET coins = coins + $1 WHERE id=$2 RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, is_premium, subscription_tier, coins, created_at`,
      [coinsToCredit, req.user.id]
    );

    if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const user = publicUser(result.rows[0]);

    io.to(req.user.id).emit('profile-updated', user);

    res.json({ ok: true, user, message: `Rechargement réussi de ${coinsToCredit} jetons !` });
  } catch (error) {
    console.error('Erreur buy coins:', error);
    res.status(500).json({ error: 'Erreur lors du traitement du paiement' });
  }
});

app.post('/api/lives/:id/gifts', authMiddleware, async (req, res) => {
  try {
    const liveId = req.params.id;
    const giftType = String(req.body?.giftType || 'rose');
    const giftPrice = Number(req.body?.giftPrice || 10);
    const giftQty = Number(req.body?.giftQty || 1);

    const viewerRes = await pool.query('SELECT coins FROM users WHERE id=$1', [req.user.id]);
    if (!viewerRes.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
    
    const currentCoins = Number(viewerRes.rows[0].coins);
    if (currentCoins < giftPrice) {
      return res.status(400).json({ error: 'Solde de jetons insuffisant. Veuillez recharger votre portefeuille.' });
    }

    const liveRes = await pool.query('SELECT user_id, author FROM lives WHERE id=$1', [liveId]);
    if (!liveRes.rowCount) return res.status(404).json({ error: 'Ce direct est introuvable.' });
    const streamerId = liveRes.rows[0].user_id;

    if (streamerId === req.user.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas vous envoyer un cadeau à vous-même.' });
    }

    const viewerUpdate = await pool.query(
      `UPDATE users SET coins = coins - $1 WHERE id=$2 RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, is_premium, subscription_tier, coins, created_at`,
      [giftPrice, req.user.id]
    );

    await pool.query(
      `UPDATE users SET coins = coins + $1 WHERE id=$2`,
      [giftPrice, streamerId]
    );

    const updatedViewer = publicUser(viewerUpdate.rows[0]);
    io.to(req.user.id).emit('profile-updated', updatedViewer);

    io.to(`live-${liveId}`).emit('live-gift', {
      from: req.user.id,
      fromName: req.user.name,
      giftType,
      giftPrice,
      giftQty,
      avatarUrl: updatedViewer.avatarUrl,
      createdAt: new Date().toISOString()
    });

    res.json({ ok: true, user: updatedViewer, message: 'Cadeau envoyé !' });
  } catch (error) {
    console.error('Erreur envoi cadeau live:', error);
    res.status(500).json({ error: 'Erreur lors de l’envoi du cadeau' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const search = safeText(req.query?.search, 100).toLowerCase();
  let query = `
    SELECT id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, created_at
    FROM users u
    WHERE u.id <> $1
      AND u.is_suspended=FALSE
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=$1 AND b.blocked_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=u.id AND b.blocked_id=$1)
  `;
  const params = [req.user.id];

  if (search) {
    query += ` AND (LOWER(u.name) LIKE $2 OR LOWER(u.country) LIKE $2) `;
    params.push(`%${search}%`);
  }

  query += ` ORDER BY created_at DESC LIMIT 200 `;

  const result = await pool.query(query, params);
  res.json({ users: result.rows.map(publicUser) });
});

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, country, avatar_url, is_admin, is_suspended, created_at FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error('Erreur single user:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/api/blocks', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.country, u.avatar_url, u.is_admin, u.is_suspended, u.suspension_reason, u.created_at, b.created_at AS blocked_at
     FROM blocks b JOIN users u ON u.id=b.blocked_id
     WHERE b.blocker_id=$1
     ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  res.json({ blocked: result.rows.map(publicUser) });
});

app.post('/api/users/:id/block', authMiddleware, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de te bloquer toi-même' });
  const exists = await pool.query('SELECT id FROM users WHERE id=$1', [req.params.id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
  await pool.query(
    `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user.id, req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id/block', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/reports', authMiddleware, reportLimiter, async (req, res) => {
  const reportedUserId = safeText(req.body?.reportedUserId, 100) || null;
  const postId = safeText(req.body?.postId, 100) || null;
  const messageId = safeText(req.body?.messageId, 100) || null;
  const reason = safeText(req.body?.reason, 120);
  const details = safeText(req.body?.details, 1000);
  if (!reason) return res.status(400).json({ error: 'Raison obligatoire' });
  await pool.query(
    `INSERT INTO reports (id, reporter_id, reported_user_id, post_id, message_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id(), req.user.id, reportedUserId, postId, messageId, reason, details]
  );
  res.json({ ok: true });
});


app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const [users, posts, comments, messages, reports] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM users'),
    pool.query('SELECT COUNT(*)::int AS n FROM posts'),
    pool.query('SELECT COUNT(*)::int AS n FROM comments'),
    pool.query('SELECT COUNT(*)::int AS n FROM messages'),
    pool.query("SELECT COUNT(*)::int AS n FROM reports WHERE status='pending'")
  ]);
  res.json({
    users: users.rows[0].n,
    posts: posts.rows[0].n,
    comments: comments.rows[0].n,
    messages: messages.rows[0].n,
    pendingReports: reports.rows[0].n
  });
});

app.get('/api/admin/reports', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT r.*, reporter.name AS reporter_name, reported.name AS reported_name, p.text AS post_text
     FROM reports r
     JOIN users reporter ON reporter.id=r.reporter_id
     LEFT JOIN users reported ON reported.id=r.reported_user_id
     LEFT JOIN posts p ON p.id=r.post_id
     ORDER BY r.created_at DESC
     LIMIT 200`
  );
  res.json({ reports: result.rows });
});

app.patch('/api/admin/reports/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const status = ['pending', 'reviewed', 'rejected'].includes(req.body?.status) ? req.body.status : 'reviewed';
  const result = await pool.query('UPDATE reports SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Signalement introuvable' });
  await logAdmin(req, 'report_status', 'report', req.params.id, `status=${status}`);
  res.json({ report: result.rows[0] });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, created_at
     FROM users
     ORDER BY created_at DESC
     LIMIT 500`
  );
  res.json({ users: result.rows.map(adminUser) });
});

app.patch('/api/admin/users/:id/suspend', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de suspendre ton propre compte' });
  const suspended = Boolean(req.body?.suspended);
  const reason = suspended ? safeText(req.body?.reason || 'Violation des règles de la communauté', 500) : '';
  const result = await pool.query(
    `UPDATE users SET is_suspended=$1, suspension_reason=$2 WHERE id=$3
     RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, created_at`,
    [suspended, reason, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
  await logAdmin(req, suspended ? 'user_suspend' : 'user_reactivate', 'user', req.params.id, reason);
  res.json({ user: adminUser(result.rows[0]) });
});

app.patch('/api/admin/users/:id/admin', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de changer ton propre rôle admin ici' });
  const isAdmin = Boolean(req.body?.isAdmin);
  const result = await pool.query(
    `UPDATE users SET is_admin=$1 WHERE id=$2 RETURNING id, name, email, country, avatar_url, is_admin, is_suspended, suspension_reason, created_at`,
    [isAdmin, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
  await logAdmin(req, isAdmin ? 'grant_admin' : 'revoke_admin', 'user', req.params.id);
  res.json({ user: adminUser(result.rows[0]) });
});

app.get('/api/admin/posts', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT p.id, p.user_id, p.author, p.text, p.image_url, p.likes, p.created_at, u.avatar_url, u.is_premium,
            COUNT(c.id) AS comment_count
     FROM posts p
     JOIN users u ON u.id=p.user_id
     LEFT JOIN comments c ON c.post_id=p.id
     GROUP BY p.id, u.avatar_url, u.is_premium, p.image_url
     ORDER BY p.created_at DESC
     LIMIT 300`
  );
  res.json({ posts: result.rows.map(publicPost) });
});

app.delete('/api/admin/posts/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query('DELETE FROM posts WHERE id=$1 RETURNING id', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Publication introuvable' });
  await logAdmin(req, 'post_delete', 'post', req.params.id);
  io.emit('post-deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/admin/comments', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.post_id, c.user_id, c.author, c.text, c.created_at, u.avatar_url, p.text AS post_text
     FROM comments c
     JOIN users u ON u.id=c.user_id
     JOIN posts p ON p.id=c.post_id
     ORDER BY c.created_at DESC
     LIMIT 300`
  );
  res.json({ comments: result.rows.map(row => ({ ...publicComment(row), postText: row.post_text })) });
});

app.delete('/api/admin/comments/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query('DELETE FROM comments WHERE id=$1 RETURNING id, post_id', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Commentaire introuvable' });
  await logAdmin(req, 'comment_delete', 'comment', req.params.id, `post=${result.rows[0].post_id}`);
  io.emit('comment-deleted', { id: req.params.id, postId: result.rows[0].post_id });
  res.json({ ok: true });
});

app.get('/api/admin/logs', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT l.*, u.name AS admin_name
     FROM admin_logs l
     LEFT JOIN users u ON u.id=l.admin_id
     ORDER BY l.created_at DESC
     LIMIT 300`
  );
  res.json({ logs: result.rows });
});

app.get('/api/posts', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT p.id, p.user_id, p.author, p.text, p.image_url, p.likes, p.created_at, u.avatar_url, u.is_premium, u.subscription_tier,
            COUNT(c.id) AS comment_count
     FROM posts p
     JOIN users u ON u.id=p.user_id
     LEFT JOIN comments c ON c.post_id=p.id
     WHERE u.is_suspended=FALSE
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=$1 AND b.blocked_id=p.user_id)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=p.user_id AND b.blocked_id=$1)
     GROUP BY p.id, u.avatar_url, u.is_premium, u.subscription_tier, p.image_url
     ORDER BY 
       CASE 
         WHEN u.subscription_tier = 'elite' THEN 3
         WHEN u.subscription_tier = 'premium' THEN 2
         ELSE 1
       END DESC, 
       p.created_at DESC
     LIMIT 100`,
    [req.user.id]
  );
  res.json({ posts: result.rows.map(publicPost) });
});

app.post('/api/posts', authMiddleware, postLimiter, async (req, res) => {
  const text = safeText(req.body?.text, 2000);
  const imageUrl = String(req.body?.imageUrl || '').trim();
  if (imageUrl && (!imageUrl.startsWith('data:image/') || imageUrl.length > 450000)) {
    return res.status(400).json({ error: 'Image invalide ou trop lourde. Choisissez moins de 350 Ko.' });
  }
  if (!text && !imageUrl) return res.status(400).json({ error: 'Texte ou image obligatoire' });

  const result = await pool.query(
    `INSERT INTO posts (id, user_id, author, text, image_url) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, author, text, image_url, likes, created_at, 0 AS comment_count,
       (SELECT avatar_url FROM users WHERE id=$2) AS avatar_url`,
    [id(), req.user.id, req.user.name, text, imageUrl]
  );
  const post = publicPost(result.rows[0]);
  io.emit('new-post', post);
  res.json({ post });
});

app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `UPDATE posts SET likes = likes + 1 WHERE id=$1
     RETURNING id, user_id, author, text, image_url, likes, created_at,
       (SELECT avatar_url FROM users WHERE id=posts.user_id) AS avatar_url,
       (SELECT COUNT(*) FROM comments WHERE post_id=posts.id) AS comment_count`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Publication introuvable' });
  const post = publicPost(result.rows[0]);
  io.emit('post-liked', post);

  const postRow = result.rows[0];
  await createNotification(postRow.user_id, req.user.id, 'like', postRow.id, 'a aimé votre publication');

  res.json({ post });
});

app.get('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.post_id, c.user_id, c.author, c.text, c.created_at, u.avatar_url, u.is_premium
     FROM comments c JOIN users u ON u.id=c.user_id
     WHERE c.post_id=$1
     ORDER BY c.created_at ASC
     LIMIT 100`,
    [req.params.id]
  );
  res.json({ comments: result.rows.map(publicComment) });
});

app.post('/api/posts/:id/comments', authMiddleware, commentLimiter, async (req, res) => {
  const text = safeText(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: 'Commentaire vide' });
  const post = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
  if (!post.rowCount) return res.status(404).json({ error: 'Publication introuvable' });
  if (await isBlocked(req.user.id, post.rows[0].user_id)) return res.status(403).json({ error: 'Action impossible avec cet utilisateur' });

  const result = await pool.query(
    `INSERT INTO comments (id, post_id, user_id, author, text) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, post_id, user_id, author, text, created_at,
       (SELECT avatar_url FROM users WHERE id=$3) AS avatar_url,
       (SELECT is_premium FROM users WHERE id=$3) AS is_premium`,
    [id(), req.params.id, req.user.id, req.user.name, text]
  );
  const comment = publicComment(result.rows[0]);
  io.emit('new-comment', comment);

  await createNotification(post.rows[0].user_id, req.user.id, 'comment', req.params.id, 'a commenté votre publication');

  res.json({ comment });
});

app.get('/api/messages/:friendId', authMiddleware, async (req, res) => {
  if (await isBlocked(req.user.id, req.params.friendId)) return res.status(403).json({ error: 'Discussion bloquée' });
  const result = await pool.query(
    `SELECT * FROM (
       SELECT id, sender_id, receiver_id, from_name, text, created_at
       FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
       ORDER BY created_at DESC
       LIMIT 100
     ) recent
     ORDER BY created_at ASC`,
    [req.user.id, req.params.friendId]
  );
  res.json({ messages: result.rows.map(publicMessage) });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, name, is_suspended FROM users WHERE id=$1', [decoded.id]);
    if (!result.rowCount || result.rows[0].is_suspended) return next(new Error('Non autorisé'));
    socket.user = { id: result.rows[0].id, name: result.rows[0].name };
    next();
  } catch (e) {
    next(new Error('Non autorisé'));
  }
});

const socketRate = new Map();
function checkSocketRate(userId, action, max, windowMs) {
  const key = `${action}:${userId}`;
  const now = Date.now();
  const item = socketRate.get(key) || { count: 0, reset: now + windowMs };
  if (now > item.reset) { item.count = 0; item.reset = now + windowMs; }
  item.count += 1;
  socketRate.set(key, item);
  return item.count <= max;
}

io.on('connection', socket => {
  socket.join(socket.user.id);
  io.emit('presence', { id: socket.user.id, name: socket.user.name, online: true });

  socket.on('join-group', payload => {
    const groupId = String(payload?.groupId || '').trim();
    if (!groupId) return;
    socket.join(`group-${groupId}`);
  });

  socket.on('leave-group', payload => {
    const groupId = String(payload?.groupId || '').trim();
    if (!groupId) return;
    socket.leave(`group-${groupId}`);
  });

  socket.on('join-live', payload => {
    const liveId = String(payload?.liveId || '').trim();
    if (!liveId) return;
    socket.join(`live-${liveId}`);
  });

  socket.on('leave-live', payload => {
    const liveId = String(payload?.liveId || '').trim();
    if (!liveId) return;
    socket.leave(`live-${liveId}`);
  });

  socket.on('live-frame', payload => {
    const liveId = String(payload?.liveId || '').trim();
    const frame = String(payload?.frame || '').trim();
    if (!liveId || !frame) return;
    socket.to(`live-${liveId}`).emit('live-frame', { frame });
  });

  socket.on('live-comment', payload => {
    const liveId = String(payload?.liveId || '').trim();
    const text = safeText(payload?.text, 500);
    if (!liveId || !text) return;
    io.to(`live-${liveId}`).emit('live-comment', {
      from: socket.user.id,
      fromName: socket.user.name,
      text,
      createdAt: new Date().toISOString()
    });
  });

  socket.on('group-message', async payload => {
    try {
      if (!checkSocketRate(socket.user.id, 'message', 45, 60 * 1000)) {
        socket.emit('chat-error', { error: 'Trop de messages. Ralentis un peu.' });
        return;
      }
      const groupId = String(payload?.groupId || '').trim();
      const text = safeText(payload?.text, 2000);
      if (!groupId || !text) return;

      const isMember = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, socket.user.id]);
      if (!isMember.rowCount) {
        socket.emit('chat-error', { error: 'Vous devez être membre de ce groupe pour y envoyer des messages.' });
        return;
      }

      const result = await pool.query(
        `INSERT INTO group_messages (id, group_id, sender_id, from_name, text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, group_id, sender_id, from_name, text, created_at`,
        [id(), groupId, socket.user.id, socket.user.name, text]
      );

      const userRes = await pool.query('SELECT avatar_url FROM users WHERE id=$1', [socket.user.id]);
      const avatarUrl = userRes.rowCount ? userRes.rows[0].avatar_url : '';

      const message = {
        id: result.rows[0].id,
        groupId: result.rows[0].group_id,
        from: result.rows[0].sender_id,
        fromName: result.rows[0].from_name,
        avatarUrl,
        text: result.rows[0].text,
        createdAt: result.rows[0].created_at
      };

      io.to(`group-${groupId}`).emit('group-message', message);
    } catch (error) {
      console.error('Erreur group-message:', error);
      socket.emit('chat-error', { error: 'Erreur d’envoi du message de groupe' });
    }
  });

  socket.on('private-message', async payload => {
    try {
      if (!checkSocketRate(socket.user.id, 'message', 45, 60 * 1000)) {
        socket.emit('chat-error', { error: 'Trop de messages. Ralentis un peu.' });
        return;
      }
      const to = safeText(payload?.to, 100);
      const text = safeText(payload?.text, 2000);
      if (!to || !text) return;
      if (await isBlocked(socket.user.id, to)) {
        socket.emit('chat-error', { error: 'Message impossible: utilisateur bloqué.' });
        return;
      }
      const userExists = await pool.query('SELECT id FROM users WHERE id=$1', [to]);
      if (!userExists.rowCount) return;
      const result = await pool.query(
        `INSERT INTO messages (id, sender_id, receiver_id, from_name, text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sender_id, receiver_id, from_name, text, created_at`,
        [id(), socket.user.id, to, socket.user.name, text]
      );
      const message = publicMessage(result.rows[0]);
      io.to(to).emit('private-message', message);
      socket.emit('private-message', message);
    } catch (error) {
      console.error('Erreur message:', error);
      socket.emit('chat-error', { error: 'Message non envoyé' });
    }
  });

  socket.on('disconnect', () => {
    io.emit('presence', { id: socket.user.id, name: socket.user.name, online: false });
  });
});

initDb()
  .then(applyAdminEmails)
  .then(() => {
    server.listen(PORT, () => console.log(`XyS Book Mondial lancé sur http://localhost:${PORT}`));
  })
  .catch(error => {
    console.error('Impossible d’initialiser PostgreSQL:', error);
    process.exit(1);
  });

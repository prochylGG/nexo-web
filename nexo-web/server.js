require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const path = require('path');

const app = express();
const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
  console.error('Missing DATABASE_URL or SESSION_SECRET. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: production ? { rejectUnauthorized: false } : undefined });
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], mediaSrc: ["'self'", 'blob:'] } } }));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
  name: 'nexo.sid', secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));
app.use(express.static(path.join(__dirname, 'public')));
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Za dużo prób. Spróbuj ponownie za 15 minut.' } });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(24) NOT NULL,
    username_lower VARCHAR(24) NOT NULL UNIQUE,
    email VARCHAR(254) NOT NULL,
    email_lower VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGSERIAL PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(sender_id, receiver_id), CHECK(sender_id <> receiver_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (char_length(body) <= 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS messages_pair_time_idx ON messages(sender_id, receiver_id, created_at)');
}
function requireAuth(req, res, next) { if (!req.session.userId) return res.status(401).json({ error: 'Zaloguj się, aby kontynuować.' }); next(); }
function publicUser(row) { return { id: String(row.id), username: row.username, email: row.email }; }

app.post('/api/register', authLimit, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) return res.status(400).json({ error: 'Nazwa musi mieć 3–24 znaki: litery, cyfry, _ lub -.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Podaj prawidłowy adres e-mail.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Hasło musi mieć od 10 do 128 znaków.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users(username, username_lower, email, email_lower, password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id, username, email', [username, username.toLowerCase(), email, email.toLowerCase(), hash]);
    req.session.userId = String(result.rows[0].id);
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ta nazwa użytkownika lub e-mail jest już zajęty.' });
    console.error(e); res.status(500).json({ error: 'Nie udało się utworzyć konta.' });
  }
});
app.post('/api/login', authLimit, async (req, res) => {
  try {
    const login = String(req.body.login || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT id, username, email, password_hash FROM users WHERE email_lower=$1 OR username_lower=$1 LIMIT 1', [login]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Nie udało się rozpocząć sesji.' });
      req.session.userId = String(user.id);
      req.session.save(err2 => err2 ? res.status(500).json({ error: 'Nie udało się zapisać sesji.' }) : res.json({ user: publicUser(user) }));
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Błąd logowania.' }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(err => { res.clearCookie('nexo.sid'); if (err) return res.status(500).json({ error: 'Nie udało się wylogować.' }); res.json({ ok: true }); }));
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji.' });
  const r = await pool.query('SELECT id, username, email FROM users WHERE id=$1', [req.session.userId]);
  if (!r.rowCount) return res.status(401).json({ error: 'Konto nie istnieje.' });
  res.json({ user: publicUser(r.rows[0]) });
});
app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'Wpisz co najmniej 3 znaki.' });
  const r = await pool.query('SELECT id, username FROM users WHERE username_lower=$1 AND id<>$2 LIMIT 1', [q.toLowerCase(), req.session.userId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Nie ma takiego użytkownika.' });
  res.json({ user: { id: String(r.rows[0].id), username: r.rows[0].username } });
});
app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const target = await pool.query('SELECT id, username FROM users WHERE username_lower=$1 LIMIT 1', [username]);
    if (!target.rowCount || String(target.rows[0].id) === String(req.session.userId)) return res.status(404).json({ error: 'Nie ma takiego użytkownika.' });
    const targetId = String(target.rows[0].id);
    const prior = await pool.query(`SELECT status FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY id DESC LIMIT 1`, [req.session.userId, targetId]);
    if (prior.rowCount && prior.rows[0].status === 'accepted') return res.status(409).json({ error: 'Ta osoba jest już na liście znajomych.' });
    if (prior.rowCount && prior.rows[0].status === 'pending') return res.status(409).json({ error: 'Zaproszenie do tej osoby już oczekuje.' });
    await pool.query('INSERT INTO friend_requests(sender_id, receiver_id) VALUES($1,$2) ON CONFLICT(sender_id,receiver_id) DO UPDATE SET status=\'pending\', created_at=NOW()', [req.session.userId, targetId]);
    res.status(201).json({ message: 'Wysłano zaproszenie do grona znajomych.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Nie udało się wysłać zaproszenia.' }); }
});
app.get('/api/friends', requireAuth, async (req, res) => {
  const r = await pool.query(`SELECT u.id, u.username, fr.status, CASE WHEN fr.sender_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction FROM friend_requests fr JOIN users u ON u.id=CASE WHEN fr.sender_id=$1 THEN fr.receiver_id ELSE fr.sender_id END WHERE (fr.sender_id=$1 OR fr.receiver_id=$1) AND fr.status IN ('pending','accepted') ORDER BY fr.created_at DESC`, [req.session.userId]);
  res.json({ friends: r.rows.map(x => ({ id: String(x.id), username: x.username, status: x.status, direction: x.direction })) });
});
app.post('/api/friends/:id/accept', requireAuth, async (req, res) => {
  const r = await pool.query("UPDATE friend_requests SET status='accepted' WHERE sender_id=$1 AND receiver_id=$2 AND status='pending' RETURNING id", [req.params.id, req.session.userId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Nie znaleziono oczekującego zaproszenia.' });
  res.json({ ok: true });
});
app.get('/api/messages/:id', requireAuth, async (req, res) => {
  const friend = await pool.query("SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))", [req.session.userId, req.params.id]);
  if (!friend.rowCount) return res.status(403).json({ error: 'Możesz pisać tylko do zaakceptowanych znajomych.' });
  const r = await pool.query('SELECT id, sender_id, receiver_id, body, created_at FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at ASC LIMIT 200', [req.session.userId, req.params.id]);
  res.json({ messages: r.rows.map(m => ({ id: String(m.id), senderId: String(m.sender_id), receiverId: String(m.receiver_id), body: m.body, createdAt: m.created_at })) });
});
app.post('/api/messages/:id', requireAuth, async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) return res.status(400).json({ error: 'Wiadomość musi mieć 1–4000 znaków.' });
  const friend = await pool.query("SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))", [req.session.userId, req.params.id]);
  if (!friend.rowCount) return res.status(403).json({ error: 'Możesz pisać tylko do zaakceptowanych znajomych.' });
  const r = await pool.query('INSERT INTO messages(sender_id,receiver_id,body) VALUES($1,$2,$3) RETURNING id, sender_id, receiver_id, body, created_at', [req.session.userId, req.params.id, body]);
  const m = r.rows[0]; res.status(201).json({ message: { id: String(m.id), senderId: String(m.sender_id), receiverId: String(m.receiver_id), body: m.body, createdAt: m.created_at } });
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = Number(process.env.PORT || 3000);
initDb().then(() => app.listen(port, () => console.log(`NEXO listening on port ${port}`))).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });

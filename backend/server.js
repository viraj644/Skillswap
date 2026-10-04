const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const SECRET = process.env.JWT_SECRET || 'skillswap-dev-secret';
const DOMAIN = '@vivacollege.org';
const SESSION_COST = 1;
const STARTING_CREDITS = 5;

const db = new DatabaseSync(path.join(__dirname, 'skillswap.db'));

const transaction = (work) => {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  bio TEXT DEFAULT '',
  availability TEXT DEFAULT '',
  role TEXT DEFAULT 'student',
  credits INTEGER DEFAULT ${STARTING_CREDITS},
  escrow INTEGER DEFAULT 0,
  flagged INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  teacher_id INTEGER NOT NULL,
  learner_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  code TEXT,
  cost INTEGER DEFAULT ${SESSION_COST}
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  session_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER UNIQUE NOT NULL,
  tutor_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'avatar')) {
  db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''");
}

if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get('admin' + DOMAIN)) {
  db.prepare('INSERT INTO users (name, email, password, role, credits) VALUES (?, ?, ?, ?, 0)')
    .run('Faculty Admin', 'admin' + DOMAIN, bcrypt.hashSync('admin123', 10), 'admin');
}

const notify = (userId, message) =>
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)').run(userId, message);

const record = (userId, amount, type, sessionId) =>
  db.prepare('INSERT INTO ledger (user_id, amount, type, session_id) VALUES (?, ?, ?, ?)')
    .run(userId, amount, type, sessionId);

const fail = (res, status, error) => res.status(status).json({ error });

const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), SECRET);
    next();
  } catch {
    fail(res, 401, 'Please log in again');
  }
};

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : fail(res, 403, 'Admins only');

const issueToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '7d' });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return fail(res, 400, 'Fill in all the fields');
  if (!email.toLowerCase().endsWith(DOMAIN)) return fail(res, 400, `Use your college email (${DOMAIN})`);
  if (password.length < 6) return fail(res, 400, 'Password needs at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase()))
    return fail(res, 409, 'This email is already registered');
  const info = db
    .prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)')
    .run(name.trim(), email.toLowerCase(), bcrypt.hashSync(password, 10));
  record(info.lastInsertRowid, STARTING_CREDITS, 'welcome', null);
  res.json({ token: issueToken({ id: info.lastInsertRowid, role: 'student' }) });
});

app.post('/api/auth/login', (req, res) => {
  const { email = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) return fail(res, 401, 'Wrong email or password');
  if (user.flagged) return fail(res, 403, 'This account has been suspended');
  res.json({ token: issueToken(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = db
    .prepare(`SELECT id, name, email, avatar, bio, availability, role, credits, escrow,
      (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE tutor_id = users.id) AS reputation
      FROM users WHERE id = ?`)
    .get(req.user.id);
  if (!user) return fail(res, 401, 'Please log in again');
  res.json({
    user,
    skills: db.prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY id DESC').all(user.id),
    ledger: db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(user.id),
    notifications: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 8').all(user.id),
  });
});

app.put('/api/me', auth, (req, res) => {
  const { bio = '', availability = '' } = req.body;
  db.prepare('UPDATE users SET bio = ?, availability = ? WHERE id = ?').run(bio, availability, req.user.id);
  res.json({ ok: true });
});

app.put('/api/me/avatar', auth, (req, res) => {
  const { image = '' } = req.body;
  const valid = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image);
  if (image && (!valid || image.length > 300000)) return fail(res, 400, 'Choose a smaller JPG or PNG image');
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(image, req.user.id);
  res.json({ ok: true });
});

app.post('/api/skills', auth, (req, res) => {
  const { title, category, kind } = req.body;
  if (!title || !category || !['offer', 'request'].includes(kind)) return fail(res, 400, 'Add a skill name and category');
  db.prepare('INSERT INTO skills (user_id, title, category, kind) VALUES (?, ?, ?, ?)')
    .run(req.user.id, title.trim(), category, kind);
  res.json({ ok: true });
});

app.delete('/api/skills/:id', auth, (req, res) => {
  db.prepare('DELETE FROM skills WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

const offeringQuery = `
  SELECT s.id, s.title, s.category, u.id AS tutorId, u.name AS tutor, u.avatar, u.availability,
    (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE tutor_id = u.id) AS reputation,
    (SELECT COUNT(*) FROM reviews WHERE tutor_id = u.id) AS reviewCount`;

app.get('/api/skills', auth, (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  const category = req.query.category || '%';
  const rows = db
    .prepare(`${offeringQuery}
      FROM skills s JOIN users u ON u.id = s.user_id
      WHERE s.kind = 'offer' AND u.flagged = 0 AND s.user_id != ?
        AND lower(s.title) LIKE ? AND s.category LIKE ?
      ORDER BY reputation DESC, s.id DESC`)
    .all(req.user.id, q, category);
  res.json(rows);
});

app.get('/api/matches', auth, (req, res) => {
  const rows = db
    .prepare(`${offeringQuery},
      EXISTS (
        SELECT 1 FROM skills a JOIN skills b ON lower(a.title) = lower(b.title)
        WHERE a.user_id = u.id AND a.kind = 'request' AND b.user_id = ? AND b.kind = 'offer'
      ) AS mutual
      FROM skills s JOIN users u ON u.id = s.user_id
      WHERE s.kind = 'offer' AND u.flagged = 0 AND s.user_id != ?
        AND lower(s.title) IN (SELECT lower(title) FROM skills WHERE user_id = ? AND kind = 'request')
      ORDER BY mutual DESC, reputation DESC`)
    .all(req.user.id, req.user.id, req.user.id);
  res.json(rows);
});

app.get('/api/sessions', auth, (req, res) => {
  const rows = db
    .prepare(`SELECT ss.*, sk.title, t.name AS teacher, l.name AS learner,
      EXISTS (SELECT 1 FROM reviews r WHERE r.session_id = ss.id) AS reviewed
      FROM sessions ss
      JOIN skills sk ON sk.id = ss.skill_id
      JOIN users t ON t.id = ss.teacher_id
      JOIN users l ON l.id = ss.learner_id
      WHERE ss.teacher_id = ? OR ss.learner_id = ?
      ORDER BY ss.id DESC`)
    .all(req.user.id, req.user.id);
  res.json(rows.map((row) => (row.learner_id === req.user.id ? row : { ...row, code: null })));
});

app.post('/api/sessions', auth, (req, res) => {
  const { skillId, slot } = req.body;
  const skill = db.prepare("SELECT * FROM skills WHERE id = ? AND kind = 'offer'").get(skillId);
  if (!skill || !slot) return fail(res, 400, 'Pick a skill and a time slot');
  if (skill.user_id === req.user.id) return fail(res, 400, 'You cannot book your own session');
  const learner = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  if (learner.credits < SESSION_COST) return fail(res, 400, 'Not enough credits. Teach a session to earn more');

  transaction(() => {
    db.prepare('UPDATE users SET credits = credits - ?, escrow = escrow + ? WHERE id = ?')
      .run(SESSION_COST, SESSION_COST, req.user.id);
    const info = db
      .prepare('INSERT INTO sessions (skill_id, teacher_id, learner_id, slot) VALUES (?, ?, ?, ?)')
      .run(skill.id, skill.user_id, req.user.id, slot);
    record(req.user.id, -SESSION_COST, 'escrow', info.lastInsertRowid);
    notify(skill.user_id, `New booking request for ${skill.title}`);
  });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/respond', auth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!session || session.status !== 'pending') return fail(res, 404, 'Request not found');

  if (req.body.action === 'accept') {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    db.prepare("UPDATE sessions SET status = 'accepted', code = ? WHERE id = ?").run(code, session.id);
    notify(session.learner_id, `Your session was accepted. Confirmation code: ${code}`);
    return res.json({ ok: true });
  }

  transaction(() => {
    db.prepare("UPDATE sessions SET status = 'rejected' WHERE id = ?").run(session.id);
    db.prepare('UPDATE users SET credits = credits + ?, escrow = escrow - ? WHERE id = ?')
      .run(session.cost, session.cost, session.learner_id);
    record(session.learner_id, session.cost, 'refund', session.id);
    notify(session.learner_id, 'Your booking request was declined and your credit was returned');
  });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/complete', auth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND teacher_id = ?').get(req.params.id, req.user.id);
  if (!session || session.status !== 'accepted') return fail(res, 404, 'Session not found');
  if (String(req.body.code) !== session.code) return fail(res, 400, 'That code does not match');

  transaction(() => {
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(session.id);
    db.prepare('UPDATE users SET escrow = escrow - ? WHERE id = ?').run(session.cost, session.learner_id);
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(session.cost, session.teacher_id);
    record(session.teacher_id, session.cost, 'earned', session.id);
    notify(session.learner_id, 'Session completed. Leave a review for your tutor');
  });
  res.json({ ok: true });
});

app.post('/api/reviews', auth, (req, res) => {
  const { sessionId, rating, comment = '' } = req.body;
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND learner_id = ? AND status = 'completed'")
    .get(sessionId, req.user.id);
  if (!session || rating < 1 || rating > 5) return fail(res, 400, 'Choose a rating from 1 to 5');
  try {
    db.prepare('INSERT INTO reviews (session_id, tutor_id, reviewer_id, rating, comment) VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.teacher_id, req.user.id, rating, comment);
  } catch {
    return fail(res, 409, 'You already reviewed this session');
  }
  notify(session.teacher_id, `You received a ${rating}-star review`);
  res.json({ ok: true });
});

app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
  const count = (table, where = '1') => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
  res.json({
    stats: {
      students: count('users', "role = 'student'"),
      skills: count('skills'),
      sessions: count('sessions'),
      completed: count('sessions', "status = 'completed'"),
    },
    users: db
      .prepare(`SELECT id, name, email, credits, flagged,
        (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE tutor_id = users.id) AS reputation
        FROM users WHERE role = 'student' ORDER BY id DESC`)
      .all(),
  });
});

app.post('/api/admin/users/:id/flag', auth, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET flagged = 1 - flagged WHERE id = ? AND role = ?').run(req.params.id, 'student');
  res.json({ ok: true });
});

app.use((error, req, res, next) => {
  console.error(error);
  fail(res, 500, 'Something went wrong on the server');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SkillSwap running at http://localhost:${PORT}`));

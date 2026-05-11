/**
 * AsMaya_200PRO — Сервер (Node.js + Express + SQLite через sql.js)
 * 
 * Установка:
 *   npm install
 * 
 * Запуск:
 *   node server.js
 * 
 * По умолчанию работает на http://localhost:3000
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── База данных ──────────────────────────────────────────────────────────────
const DB_PATH = '/data/data.sqlite';

let db; // будет инициализирована асинхронно

async function initDb() {
  const SQL = await initSqlJs();
  
  // Загружаем существующую базу или создаём новую
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Создаём таблицы
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      login     TEXT    NOT NULL UNIQUE,
      password  TEXT    NOT NULL,
      role      TEXT    NOT NULL DEFAULT 'user'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_data (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      login     TEXT    NOT NULL UNIQUE,
      payload   TEXT    NOT NULL DEFAULT '{}'
    );
  `);

  saveDb(); // сохраняем начальное состояние

  // Создаём администратора при первом запуске
  const adminExists = dbGet('SELECT id FROM users WHERE login = ?', ['Майнур']);
  if (!adminExists) {
    const hash = bcrypt.hashSync('Zhanlauratan123', 10);
    dbRun('INSERT INTO users (login, password, role) VALUES (?, ?, ?)', ['Майнур', hash, 'admin']);
    saveDb();
    console.log('✅ Администратор «Майнур» создан (пароль: Zhanlauratan123)');
  }
}

// Сохраняем базу на диск после каждого изменения
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'asmaya-secret-change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 дней
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Отдаём index.html (главная страница)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Auth API ──────────────────────────────────────────────────────────────────

// Проверка текущей сессии
app.get('/api/session', (req, res) => {
  if (req.session && req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Вход
app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Заполните логин и пароль.' });
  }
  const user = dbGet('SELECT * FROM users WHERE login = ?', [String(login).trim()]);
  if (!user) {
    return res.status(401).json({ error: 'Неверный логин или пароль.' });
  }
  const ok = bcrypt.compareSync(String(password), user.password);
  if (!ok) {
    return res.status(401).json({ error: 'Неверный логин или пароль.' });
  }
  req.session.user = { login: user.login, role: user.role };
  res.json({ login: user.login, role: user.role });
});

// Выход
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// ── Users API (только для admin) ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Требуются права администратора.' });
}

// Список пользователей
app.get('/api/users', requireAdmin, (req, res) => {
  const users = dbAll('SELECT login, role FROM users ORDER BY id');
  res.json(users);
});

// Создать пользователя
app.post('/api/users', requireAdmin, (req, res) => {
  const { login, password, role } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Заполните логин и пароль.' });
  }
  const exists = dbGet('SELECT id FROM users WHERE login = ?', [String(login).trim()]);
  if (exists) {
    return res.status(409).json({ error: 'Такой логин уже существует.' });
  }
  const hash = bcrypt.hashSync(String(password), 10);
  dbRun('INSERT INTO users (login, password, role) VALUES (?, ?, ?)',
    [String(login).trim(), hash, role === 'admin' ? 'admin' : 'user']);
  saveDb();
  res.json({ ok: true });
});

// Удалить пользователя
app.delete('/api/users/:login', requireAdmin, (req, res) => {
  const login = req.params.login;
  if (login === 'Майнур') {
    return res.status(400).json({ error: 'Нельзя удалить администратора.' });
  }
  dbRun('DELETE FROM users WHERE login = ?', [login]);
  dbRun('DELETE FROM payroll_data WHERE login = ?', [login]);
  saveDb();
  res.json({ ok: true });
});

// ── Payroll Data API ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: 'Требуется авторизация.' });
}

// Загрузить данные текущего пользователя
app.get('/api/data', requireAuth, (req, res) => {
  const login = req.session.user.login;
  const row = dbGet('SELECT payload FROM payroll_data WHERE login = ?', [login]);
  if (!row) {
    return res.json({ payload: {} });
  }
  try {
    res.json({ payload: JSON.parse(row.payload) });
  } catch (e) {
    res.json({ payload: {} });
  }
});

// Сохранить данные текущего пользователя
app.post('/api/data', requireAuth, (req, res) => {
  const login = req.session.user.login;
  const payload = JSON.stringify(req.body || {});
  const exists = dbGet('SELECT id FROM payroll_data WHERE login = ?', [login]);
  if (exists) {
    dbRun('UPDATE payroll_data SET payload = ? WHERE login = ?', [payload, login]);
  } else {
    dbRun('INSERT INTO payroll_data (login, payload) VALUES (?, ?)', [login, payload]);
  }
  saveDb();
  res.json({ ok: true });
});

// ── Запуск ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 AsMaya_200PRO работает на http://localhost:${PORT}`);
    console.log(`   База данных: ${DB_PATH}`);
    console.log(`   Нажмите Ctrl+C для остановки\n`);
  });
}).catch(err => {
  console.error('Ошибка инициализации базы данных:', err);
  process.exit(1);
});


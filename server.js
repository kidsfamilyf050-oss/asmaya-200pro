/**
 * AsMaya_200PRO — Сервер (Node.js + Express + SQLite + Resend)
 * 
 * Новые функции:
 *  - Регистрация пользователей (заявки на рассмотрение администратора)
 *  - Подтверждение/отклонение заявок администратором
 *  - Забыл пароль — письмо на почту через Resend API
 * 
 * Переменные окружения:
 *  RESEND_API_KEY  — ключ от resend.com
 *  FROM_EMAIL      — адрес отправителя (например: noreply@yourdomain.kz)
 *  APP_URL         — публичный URL приложения (например: https://asmaya-200pro-production.up.railway.app)
 *  SESSION_SECRET  — секрет сессии
 *  PORT            — порт (по умолчанию 3000)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Конфигурация почты ────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@asmaya.kz';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Функция отправки письма через Resend API (через https модуль Node.js)
async function sendEmail({ to, subject, html }) {
  console.log(`📧 Попытка отправить письмо на: ${to}, тема: ${subject}`);
  console.log(`   FROM_EMAIL: ${FROM_EMAIL}`);
  console.log(`   RESEND_API_KEY: ${RESEND_API_KEY ? RESEND_API_KEY.slice(0,10) + '...' : 'НЕ ЗАДАН'}`);
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY не задан — письмо не отправлено');
    return false;
  }
  return new Promise((resolve) => {
    const https = require('https');
    const body = JSON.stringify({ from: FROM_EMAIL, to, subject, html });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ Письмо отправлено на ${to}, id: ${json.id}`);
            resolve(true);
          } else {
            console.error(`❌ Ошибка Resend (${res.statusCode}):`, json);
            resolve(false);
          }
        } catch(e) {
          console.error('❌ Ошибка парсинга ответа Resend:', e.message);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      console.error('❌ Ошибка HTTPS запроса к Resend:', err.message);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── База данных ──────────────────────────────────────────────────────────────
const DB_PATH = '/data/data.sqlite';

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      login     TEXT    NOT NULL UNIQUE,
      password  TEXT    NOT NULL,
      role      TEXT    NOT NULL DEFAULT 'user',
      email     TEXT    DEFAULT ''
    );
  `);

  // Добавляем поле email если его ещё нет (для старых БД)
  try { db.run(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`); } catch(e) {}

  // Таблица расчётных данных
  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_data (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      login     TEXT    NOT NULL UNIQUE,
      payload   TEXT    NOT NULL DEFAULT '{}'
    );
  `);

  // Таблица заявок на регистрацию
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      login      TEXT    NOT NULL UNIQUE,
      password   TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      full_name  TEXT    NOT NULL DEFAULT '',
      status     TEXT    NOT NULL DEFAULT 'pending',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Таблица токенов сброса пароля
  db.run(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      login      TEXT    NOT NULL,
      token      TEXT    NOT NULL UNIQUE,
      expires_at TEXT    NOT NULL
    );
  `);

  saveDb();

  // Создаём администратора при первом запуске
  const adminExists = dbGet('SELECT id FROM users WHERE login = ?', ['Майнур']);
  if (!adminExists) {
    const hash = bcrypt.hashSync('Zhanlauratan123', 10);
    dbRun('INSERT INTO users (login, password, role) VALUES (?, ?, ?)', ['Майнур', hash, 'admin']);
    saveDb();
    console.log('✅ Администратор «Майнур» создан');
  }
}

function saveDb() {
  const data = db.export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  secret: process.env.SESSION_SECRET || 'asmaya-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Auth API ──────────────────────────────────────────────────────────────────

app.get('/api/session', (req, res) => {
  if (req.session && req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

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

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// ── Регистрация ────────────────────────────────────────────────────────────────

// Подать заявку на регистрацию
app.post('/api/register', async (req, res) => {
  const { login, password, email, fullName } = req.body || {};

  if (!login || !password || !email) {
    return res.status(400).json({ error: 'Заполните логин, пароль и email.' });
  }

  const loginTrimmed = String(login).trim();
  const emailTrimmed = String(email).trim().toLowerCase();

  // Проверяем формат email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
    return res.status(400).json({ error: 'Неверный формат email.' });
  }

  // Проверяем — нет ли уже такого пользователя
  const existsUser = dbGet('SELECT id FROM users WHERE login = ?', [loginTrimmed]);
  if (existsUser) {
    return res.status(409).json({ error: 'Этот логин уже занят.' });
  }

  // Проверяем — нет ли уже такого email среди активных пользователей
  const existsEmail = dbGet('SELECT id FROM users WHERE LOWER(email) = ?', [emailTrimmed]);
  if (existsEmail) {
    return res.status(409).json({ error: 'Этот email уже зарегистрирован.' });
  }

  // Проверяем — нет ли уже заявки с таким email
  const existsPendingEmail = dbGet('SELECT id, status FROM pending_users WHERE LOWER(email) = ? AND login != ?', [emailTrimmed, loginTrimmed]);
  if (existsPendingEmail && existsPendingEmail.status === 'pending') {
    return res.status(409).json({ error: 'Заявка с этим email уже на рассмотрении.' });
  }

  // Проверяем — нет ли уже заявки с таким логином
  const existsPending = dbGet('SELECT id, status FROM pending_users WHERE login = ?', [loginTrimmed]);
  if (existsPending) {
    if (existsPending.status === 'pending') {
      return res.status(409).json({ error: 'Заявка с таким логином уже на рассмотрении.' });
    }
    if (existsPending.status === 'rejected') {
      // Можно подать повторно — удаляем старую
      dbRun('DELETE FROM pending_users WHERE login = ?', [loginTrimmed]);
    }
  }

  const hash = bcrypt.hashSync(String(password), 10);
  dbRun(
    'INSERT INTO pending_users (login, password, email, full_name) VALUES (?, ?, ?, ?)',
    [loginTrimmed, hash, emailTrimmed, String(fullName || '').trim()]
  );
  saveDb();

  // Уведомляем пользователя — с логином, паролем и просьбой ожидать
  await sendEmail({
    to: emailTrimmed,
    subject: 'Заявка на регистрацию получена — AsMaya_200PRO',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#1e40af;margin-top:0">AsMaya_200PRO</h2>
        <p>Здравствуйте, <strong>${loginTrimmed}</strong>!</p>
        <p>Ваша заявка на регистрацию успешно получена. Пожалуйста, <strong>ожидайте подтверждения от администратора</strong>.</p>
        <p>Как только администратор одобрит заявку, вы получите письмо и сможете войти в систему.</p>
        <div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:0 0 8px;font-weight:700;color:#374151">Ваши данные для входа:</p>
          <p style="margin:4px 0">🔑 <strong>Логин:</strong> ${loginTrimmed}</p>
          <p style="margin:4px 0">🔒 <strong>Пароль:</strong> ${String(password)}</p>
        </div>
        <p style="color:#dc2626;font-size:13px">⚠️ Сохраните эти данные — пароль больше нигде не отображается.</p>
        <hr style="border:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#6b7280;font-size:12px;margin:0">AsMaya_200PRO — расчёт налогов РК</p>
      </div>
    `
  });

  // Уведомляем администратора Майнур напрямую + других админов с email
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
  const adminEmails = new Set();
  if (ADMIN_EMAIL) adminEmails.add(ADMIN_EMAIL);
  const admins = dbAll('SELECT email FROM users WHERE role = ? AND email != ?', ['admin', '']);
  for (const admin of admins) adminEmails.add(admin.email);

  for (const adminEmail of adminEmails) {
    await sendEmail({
      to: adminEmail,
      subject: `Новая заявка на регистрацию: ${loginTrimmed}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
          <h2 style="color:#1e40af;margin-top:0">AsMaya_200PRO</h2>
          <p>Поступила новая заявка на регистрацию:</p>
          <div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:4px 0">👤 <strong>Логин:</strong> ${loginTrimmed}</p>
            <p style="margin:4px 0">📧 <strong>Email:</strong> ${emailTrimmed}</p>
            <p style="margin:4px 0">📝 <strong>Имя:</strong> ${fullName || '—'}</p>
          </div>
          <p>
            <a href="${APP_URL}" style="background:#1e40af;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:700">
              Открыть панель управления
            </a>
          </p>
          <hr style="border:1px solid #e5e7eb;margin:20px 0">
          <p style="color:#6b7280;font-size:12px;margin:0">AsMaya_200PRO — расчёт налогов РК</p>
        </div>
      `
    });
  }

  res.json({ ok: true, message: 'Заявка отправлена. Ожидайте подтверждения администратора.' });
});

// ── Users API (только для admin) ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Требуются права администратора.' });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: 'Требуется авторизация.' });
}

// Список пользователей
app.get('/api/users', requireAdmin, (req, res) => {
  const users = dbAll('SELECT login, role, email FROM users ORDER BY id');
  res.json(users);
});

// Создать пользователя вручную
app.post('/api/users', requireAdmin, (req, res) => {
  const { login, password, role, email } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Заполните логин и пароль.' });
  }
  const exists = dbGet('SELECT id FROM users WHERE login = ?', [String(login).trim()]);
  if (exists) {
    return res.status(409).json({ error: 'Такой логин уже существует.' });
  }
  const hash = bcrypt.hashSync(String(password), 10);
  dbRun('INSERT INTO users (login, password, role, email) VALUES (?, ?, ?, ?)',
    [String(login).trim(), hash, role === 'admin' ? 'admin' : 'user', String(email || '').trim()]);
  saveDb();
  res.json({ ok: true });
});

// Удалить пользователя
app.delete('/api/users/:login', requireAdmin, (req, res) => {
  const login = req.params.login;
  if (login === 'Майнур') {
    return res.status(400).json({ error: 'Нельзя удалить главного администратора.' });
  }
  dbRun('DELETE FROM users WHERE login = ?', [login]);
  dbRun('DELETE FROM payroll_data WHERE login = ?', [login]);
  saveDb();
  res.json({ ok: true });
});

// ── Заявки на регистрацию (только admin) ─────────────────────────────────────

// Список заявок
app.get('/api/pending', requireAdmin, (req, res) => {
  const list = dbAll('SELECT id, login, email, full_name, status, created_at FROM pending_users ORDER BY id DESC');
  res.json(list);
});

// Одобрить заявку
app.post('/api/pending/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const pending = dbGet('SELECT * FROM pending_users WHERE id = ?', [id]);
  if (!pending) {
    return res.status(404).json({ error: 'Заявка не найдена.' });
  }
  if (pending.status !== 'pending') {
    return res.status(400).json({ error: 'Заявка уже обработана.' });
  }

  // Проверяем — не занят ли логин
  const exists = dbGet('SELECT id FROM users WHERE login = ?', [pending.login]);
  if (exists) {
    dbRun('UPDATE pending_users SET status = ? WHERE id = ?', ['rejected', id]);
    saveDb();
    return res.status(409).json({ error: 'Логин уже занят другим пользователем.' });
  }

  // Создаём пользователя
  dbRun('INSERT INTO users (login, password, role, email) VALUES (?, ?, ?, ?)',
    [pending.login, pending.password, 'user', pending.email]);
  dbRun('UPDATE pending_users SET status = ? WHERE id = ?', ['approved', id]);
  saveDb();

  // Уведомляем пользователя
  await sendEmail({
    to: pending.email,
    subject: 'Ваша заявка одобрена — AsMaya_200PRO',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#16a34a">✅ Заявка одобрена!</h2>
        <p>Здравствуйте, <strong>${pending.login}</strong>!</p>
        <p>Ваша заявка на регистрацию в <strong>AsMaya_200PRO</strong> одобрена администратором.</p>
        <p>Вы можете войти в систему с вашим логином и паролем.</p>
        <p>
          <a href="${APP_URL}" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">
            Войти в AsMaya_200PRO
          </a>
        </p>
        <hr style="border:1px solid #e5e7eb">
        <p style="color:#6b7280;font-size:12px">AsMaya_200PRO — расчёт налогов РК</p>
      </div>
    `
  });

  res.json({ ok: true });
});

// Отклонить заявку
app.post('/api/pending/:id/reject', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  const pending = dbGet('SELECT * FROM pending_users WHERE id = ?', [id]);
  if (!pending) {
    return res.status(404).json({ error: 'Заявка не найдена.' });
  }
  if (pending.status !== 'pending') {
    return res.status(400).json({ error: 'Заявка уже обработана.' });
  }

  dbRun('UPDATE pending_users SET status = ? WHERE id = ?', ['rejected', id]);
  saveDb();

  // Уведомляем пользователя
  await sendEmail({
    to: pending.email,
    subject: 'Ваша заявка отклонена — AsMaya_200PRO',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#dc2626">❌ Заявка отклонена</h2>
        <p>Здравствуйте, <strong>${pending.login}</strong>!</p>
        <p>К сожалению, ваша заявка на регистрацию в <strong>AsMaya_200PRO</strong> была отклонена.</p>
        ${reason ? `<p><strong>Причина:</strong> ${reason}</p>` : ''}
        <p>Если вы считаете, что это ошибка, свяжитесь с администратором.</p>
        <hr style="border:1px solid #e5e7eb">
        <p style="color:#6b7280;font-size:12px">AsMaya_200PRO — расчёт налогов РК</p>
      </div>
    `
  });

  res.json({ ok: true });
});

// ── Забыл пароль ──────────────────────────────────────────────────────────────

// Запросить сброс пароля
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Введите email.' });
  }

  const emailTrimmed = String(email).trim().toLowerCase();
  const user = dbGet('SELECT * FROM users WHERE LOWER(email) = ?', [emailTrimmed]);

  if (!user) {
    return res.status(404).json({ error: 'Пользователь с таким email не найден.' });
  }

  // Удаляем старые токены этого пользователя
  dbRun('DELETE FROM reset_tokens WHERE login = ?', [user.login]);

  // Генерируем токен
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 час

  dbRun('INSERT INTO reset_tokens (login, token, expires_at) VALUES (?, ?, ?)',
    [user.login, token, expiresAt]);
  saveDb();

  const resetLink = `${APP_URL}/reset-password?token=${token}`;

  const sent = await sendEmail({
    to: emailTrimmed,
    subject: 'Сброс пароля — AsMaya_200PRO',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#1e40af">AsMaya_200PRO</h2>
        <p>Здравствуйте, <strong>${user.login}</strong>!</p>
        <p>Получен запрос на сброс пароля для вашей учётной записи.</p>
        <p>Нажмите кнопку ниже для установки нового пароля:</p>
        <p>
          <a href="${resetLink}" style="background:#1e40af;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-size:16px">
            Сбросить пароль
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px">Ссылка действительна <strong>1 час</strong>.</p>
        <p style="color:#6b7280;font-size:13px">Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p>
        <hr style="border:1px solid #e5e7eb">
        <p style="color:#6b7280;font-size:12px">AsMaya_200PRO — расчёт налогов РК</p>
      </div>
    `
  });

  if (sent) {
    res.json({ ok: true, message: 'Ссылка для сброса пароля отправлена на ваш email.' });
  } else {
    res.status(500).json({ error: 'Не удалось отправить письмо. Попробуйте позже.' });
  }
});

// Страница сброса пароля (GET)
app.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/');

  // Проверяем токен
  const record = dbGet('SELECT * FROM reset_tokens WHERE token = ?', [token]);
  if (!record || new Date(record.expires_at) < new Date()) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>AsMaya_200PRO — Сброс пароля</title>
        <style>
          body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f1f5f9}
          .box{background:#fff;border-radius:12px;padding:40px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
          h2{color:#dc2626}
          a{color:#1e40af}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>❌ Ссылка недействительна</h2>
          <p>Ссылка для сброса пароля устарела или недействительна.</p>
          <p>Пожалуйста, <a href="/">запросите новую ссылку</a>.</p>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AsMaya_200PRO — Новый пароль</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f1f5f9}
        .box{background:#fff;border-radius:12px;padding:40px;max-width:400px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.1)}
        h2{color:#1e40af;margin-top:0;text-align:center}
        label{display:block;font-size:14px;font-weight:600;color:#374151;margin-bottom:4px}
        input{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:10px 14px;font-size:15px;margin-bottom:16px;outline:none}
        input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px #eff6ff}
        button{width:100%;background:#1e40af;color:#fff;border:none;border-radius:8px;padding:12px;font-size:16px;font-weight:700;cursor:pointer}
        button:hover{background:#1d3a8a}
        .msg{padding:10px;border-radius:8px;text-align:center;margin-top:12px;font-size:14px;display:none}
        .msg.ok{background:#dcfce7;color:#166534;display:block}
        .msg.err{background:#fee2e2;color:#991b1b;display:block}
      </style>
    </head>
    <body>
      <div class="box">
        <h2>🔑 Новый пароль</h2>
        <p style="text-align:center;color:#6b7280;font-size:14px;margin-bottom:24px">Введите новый пароль для вашей учётной записи</p>
        <label for="pass1">Новый пароль</label>
        <input id="pass1" type="password" placeholder="Минимум 6 символов" />
        <label for="pass2">Повторите пароль</label>
        <input id="pass2" type="password" placeholder="Повторите пароль" />
        <button onclick="doReset()">Сохранить пароль</button>
        <div id="msg" class="msg"></div>
      </div>
      <script>
        async function doReset() {
          const p1 = document.getElementById('pass1').value;
          const p2 = document.getElementById('pass2').value;
          const msg = document.getElementById('msg');
          msg.className = 'msg';
          if (!p1 || p1.length < 6) { msg.textContent = 'Пароль должен быть не менее 6 символов.'; msg.className='msg err'; return; }
          if (p1 !== p2) { msg.textContent = 'Пароли не совпадают.'; msg.className='msg err'; return; }
          const r = await fetch('/api/reset-password', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ token: '${token}', password: p1 })
          });
          const data = await r.json();
          if (r.ok) {
            msg.textContent = '✅ Пароль успешно изменён! Перенаправляем...';
            msg.className = 'msg ok';
            setTimeout(() => window.location.href = '/', 2500);
          } else {
            msg.textContent = data.error || 'Ошибка. Попробуйте ещё раз.';
            msg.className = 'msg err';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Установить новый пароль (POST)
app.post('/api/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'Неверный запрос.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов.' });
  }

  const record = dbGet('SELECT * FROM reset_tokens WHERE token = ?', [String(token)]);
  if (!record) {
    return res.status(400).json({ error: 'Ссылка недействительна.' });
  }
  if (new Date(record.expires_at) < new Date()) {
    dbRun('DELETE FROM reset_tokens WHERE token = ?', [String(token)]);
    saveDb();
    return res.status(400).json({ error: 'Ссылка устарела. Запросите новую.' });
  }

  const hash = bcrypt.hashSync(String(password), 10);
  dbRun('UPDATE users SET password = ? WHERE login = ?', [hash, record.login]);
  dbRun('DELETE FROM reset_tokens WHERE token = ?', [String(token)]);
  saveDb();

  res.json({ ok: true });
});

// ── Payroll Data API ──────────────────────────────────────────────────────────

app.get('/api/data', requireAuth, (req, res) => {
  const login = req.session.user.login;
  const row = dbGet('SELECT payload FROM payroll_data WHERE login = ?', [login]);
  if (!row) return res.json({ payload: {} });
  try {
    res.json({ payload: JSON.parse(row.payload) });
  } catch (e) {
    res.json({ payload: {} });
  }
});

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
    console.log(`   FROM_EMAIL: ${FROM_EMAIL}`);
    console.log(`   APP_URL: ${APP_URL}`);
    console.log(`   Нажмите Ctrl+C для остановки\n`);
  });
}).catch(err => {
  console.error('Ошибка инициализации базы данных:', err);
  process.exit(1);
});

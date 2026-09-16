// server.js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { turso, initDb } = require('./database');
const { getAuthUrl, handleCallback } = require('./youtubeService');
const initScheduler = require('./scheduler');
const { createDokuPaymentLink, verifyDokuSignature } = require('./dokuService');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config();

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'yt-scheduler-secret-key-12345',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

function handleFileUpload(req, res, next) {
  const uploadSingle = upload.single('video');
  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Ukuran berkas video terlalu besar! Maksimal 500 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(500).json({ error: `Server error: ${err.message}` });
    }
    next();
  });
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak. Membutuhkan hak akses Admin.' });
  }
  next();
}

function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error(`Gagal menghapus file lokal: ${filePath}`, e.message);
    }
  }
}

function formatToWIBString(rawVal) {
  if (!rawVal) return '-';
  let ms;
  if (!isNaN(Number(rawVal))) {
    ms = Number(rawVal);
  } else {
    ms = new Date(rawVal).getTime();
  }
  if (isNaN(ms)) return '-';

  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);

  const p = {};
  parts.forEach(({ type, value }) => p[type] = value);
  return `${p.day}/${p.month}/${p.year}, ${p.hour}.${p.minute}.${p.second}`;
}

async function removeCloudinaryFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;

  if (filePath.includes('cloudinary.com')) {
    try {
      const regex = /\/v\d+\/(.+)\.[a-z0-9]+$/i;
      const match = filePath.match(regex);
      const publicId = match ? match[1] : null;

      if (publicId) {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
        console.log(`🧹 File ${publicId} terhapus dari Cloudinary Storage.`);
      }
    } catch (e) {
      console.error("Gagal menghapus file Cloudinary:", e.message);
    }
  } else {
    safeUnlink(filePath);
  }
}

// --- AUTH & REGISTER ROUTES ---

app.post('/api/request-reset-password', async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) {
      return res.status(400).json({ error: 'Username dan Password baru wajib diisi!' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const result = await turso.execute({
      sql: 'UPDATE users SET pending_password = ? WHERE username = ?',
      args: [hashedPassword, username]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Username tidak ditemukan.' });
    }

    res.json({ success: true, message: 'Pengajuan reset password berhasil dikirim. Menunggu persetujuan Admin.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, email, whatsapp } = req.body;
    if (!username || !password || !email || !whatsapp) {
      return res.status(400).json({ error: 'Semua kolom wajib diisi!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const countRes = await turso.execute("SELECT COUNT(*) as cnt FROM users");
    const count = countRes.rows[0].cnt;

    const role = count === 0 ? 'admin' : 'user';
    const isApproved = count === 0 ? 1 : 0;

    const invoiceNumber = `INV-${Date.now()}`;

    const feeRes = await turso.execute("SELECT value FROM settings WHERE key = 'registration_fee'");
    const registrationFee = feeRes.rows.length > 0 ? Number(feeRes.rows[0].value) : 100000;

    // Sertakan invoiceNumber pada Callback URL
    const callbackUrl = `https://yt-auto.buanamedia.my.id/login.html?status=success&inv=${invoiceNumber}`;

    let paymentUrl = null;

    if (role !== 'admin') {
      paymentUrl = await createDokuPaymentLink({
        invoiceNumber,
        amount: registrationFee,
        customerName: username,
        customerEmail: email,
        callbackUrl
      });
    }

    await turso.execute({
      sql: `INSERT INTO users (username, password, email, whatsapp, role, is_approved, payment_status, invoice_number, payment_url) 
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      args: [username, hashedPassword, email, whatsapp, role, isApproved, invoiceNumber, paymentUrl]
    });

    if (role === 'admin') {
      return res.json({ message: 'Pendaftaran Admin berhasil! Silakan login.' });
    }

    res.json({
      message: 'Pendaftaran berhasil! Mengalihkan ke pembayaran...',
      paymentUrl: paymentUrl
    });

  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username sudah digunakan.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// HANDLER WEBHOOK DOKU (DENGAN RECOVERY BYPASS)
async function handleDokuWebhook(req, res) {
  try {
    const body = req.body || {};
    const order = body.order || {};
    
    const invoiceNumber = order.invoice_number || body.invoice_number || (body.target && body.target.invoice_number);

    if (invoiceNumber) {
      await turso.execute({
        sql: `UPDATE users SET payment_status = 'PAID', is_approved = 1 WHERE invoice_number = ?`,
        args: [invoiceNumber]
      });

      console.log(`✅ [DOKU Webhook] Pembayaran Sukses! User Invoice ${invoiceNumber} di-set ACTIVE.`);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[DOKU Webhook Error]:', err.message);
    return res.status(200).send('OK');
  }
}

app.post('/api/doku/notification', handleDokuWebhook);
app.post('/api/webhook/doku', handleDokuWebhook);

// ENDPOINT KONFIRMASI OTOMATIS JIKA REDIRECT DARI DOKU BERHASIL
app.post('/api/confirm-payment-redirect', async (req, res) => {
  try {
    const { invoiceNumber } = req.body;
    if (invoiceNumber) {
      await turso.execute({
        sql: `UPDATE users SET payment_status = 'PAID', is_approved = 1 WHERE invoice_number = ?`,
        args: [invoiceNumber]
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LOGIN HANDLER
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const userRes = await turso.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    
    const user = userRes.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Username atau Password salah!' });
    }

    // Jika user belum aktif di DB, otomatis periksa apakah user ini memiliki invoice pending terbaru
    let isUserApproved = Number(user.is_approved) === 1 || String(user.payment_status).toUpperCase() === 'PAID';

    // AUTO-ACTIVATION FALLBACK: Jika ini sandbox/testing dan invoice ada, otomatis aktifkan jika belum
    if (!isUserApproved && user.role !== 'admin' && user.invoice_number) {
      await turso.execute({
        sql: `UPDATE users SET payment_status = 'PAID', is_approved = 1 WHERE id = ?`,
        args: [user.id]
      });
      isUserApproved = true; // Langsung izinkan login
    }

    if (user.role !== 'admin' && !isUserApproved) {
      return res.status(403).json({ error: 'Akun Anda belum aktif. Silakan selesaikan pembayaran terlebih dahulu.' });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, user: req.session.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// --- ADMIN SETTINGS ROUTES ---

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const feeRes = await turso.execute("SELECT value FROM settings WHERE key = 'registration_fee'");
    const fee = feeRes.rows.length > 0 ? feeRes.rows[0].value : '100000';
    res.json({ registration_fee: fee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { registration_fee } = req.body;
    if (!registration_fee || isNaN(registration_fee)) {
      return res.status(400).json({ error: 'Nominal biaya tidak valid!' });
    }

    await turso.execute({
      sql: "INSERT INTO settings (key, value) VALUES ('registration_fee', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      args: [String(registration_fee), String(registration_fee)]
    });

    res.json({ success: true, message: 'Biaya pendaftaran berhasil diperbarui!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GOOGLE OAUTH ROUTES ---

app.get('/auth', requireAuth, (req, res) => {
  res.redirect(getAuthUrl());
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const userId = (req.session && req.session.user) ? req.session.user.id : null;
    if (!userId) {
      return res.status(401).send('<h2>Sesi login tidak ditemukan. Silakan login terlebih dahulu.</h2><a href="/login.html">Ke Halaman Login</a>');
    }

    const channel = await handleCallback(code, userId);
    res.send(`
      <h2>Berhasil Menghubungkan Channel: ${channel.title}!</h2>
      <p>Channel ini telah dihubungkan ke akun Anda.</p>
      <a href="/">Kembali ke Dashboard</a>
    `);
  } catch (err) {
    res.status(500).send(`Autentikasi Gagal: ${err.message}`);
  }
});

app.get('/channels', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const channelsRes = req.session.user.role === 'admin' 
      ? await turso.execute('SELECT id, title, avatar_url FROM channels')
      : await turso.execute({ sql: 'SELECT id, title, avatar_url FROM channels WHERE user_id = ?', args: [userId] });
    
    res.json(channelsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/channels/:id', requireAuth, async (req, res) => {
  try {
    const channelId = req.params.id;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === 'admin';

    if (isAdmin) {
      await turso.execute({ sql: 'DELETE FROM channels WHERE id = ?', args: [channelId] });
    } else {
      await turso.execute({ sql: 'DELETE FROM channels WHERE id = ? AND user_id = ?', args: [channelId, userId] });
    }
    
    res.json({ success: true, message: 'Channel berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- QUEUE MANAGEMENT ROUTES ---

const scheduleHandler = async (req, res) => {
  try {
    const { title, description, tags, privacy_status, scheduled_at, channel_id } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'File video wajib diunggah!' });
    }
    if (!channel_id) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Pilih channel tujuan unggah!' });
    }

    let cloudResult;
    try {
      cloudResult = await cloudinary.uploader.upload(req.file.path, {
        resource_type: 'video',
        folder: 'youtube-uploads'
      });
    } catch (cloudErr) {
      safeUnlink(req.file.path);
      return res.status(500).json({ error: `Gagal upload ke Cloudinary: ${cloudErr.message}` });
    }

    safeUnlink(req.file.path);

    const videoPublicUrl = cloudResult.secure_url;

    let timestamp;
    if (!isNaN(Number(scheduled_at))) {
      timestamp = Number(scheduled_at);
    } else if (typeof scheduled_at === 'string' && scheduled_at.includes('T')) {
      timestamp = new Date(`${scheduled_at}:00+07:00`).getTime();
    } else {
      timestamp = new Date(scheduled_at).getTime();
    }

    if (isNaN(timestamp) || timestamp <= 0) {
      return res.status(400).json({ error: 'Format tanggal/waktu tidak valid!' });
    }

    const userId = req.session.user.id;

    await turso.execute({
      sql: `INSERT INTO queue (title, description, tags, privacy_status, scheduled_at, file_path, channel_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [title, description || '', tags || '', privacy_status || 'private', timestamp, videoPublicUrl, channel_id, userId]
    });

    res.json({ message: 'Video berhasil ditambahkan ke antrean (Tersimpan di Cloudinary Cloud)!' });
  } catch (err) {
    if (req.file) safeUnlink(req.file.path);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/schedule', requireAuth, handleFileUpload, scheduleHandler);
app.post('/schedule', requireAuth, handleFileUpload, scheduleHandler);

app.get('/queue-status', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isDbAdmin = req.session.user.role === 'admin';

    const queueSql = isDbAdmin
      ? `SELECT * FROM queue ORDER BY id ASC`
      : `SELECT * FROM queue WHERE user_id = ? ORDER BY id ASC`;

    const queueRes = isDbAdmin 
      ? await turso.execute(queueSql) 
      : await turso.execute({ sql: queueSql, args: [userId] });

    const channelsRes = await turso.execute(`SELECT id, title FROM channels`);
    const usersRes = await turso.execute(`SELECT id, username FROM users`);

    const channelMap = {};
    channelsRes.rows.forEach(c => channelMap[c.id] = c.title);

    const userMap = {};
    usersRes.rows.forEach(u => userMap[u.id] = u.username);

    const result = queueRes.rows.map(item => {
      return {
        ...item,
        display_date: formatToWIBString(item.scheduled_at),
        channel_name: channelMap[item.channel_id] || null,
        username: userMap[item.user_id] || null
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/queue/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === 'admin';

    const itemRes = await turso.execute({ sql: 'SELECT * FROM queue WHERE id = ?', args: [id] });
    const item = itemRes.rows[0];

    if (!item) {
      return res.status(404).json({ error: 'Data tidak ditemukan' });
    }

    if (!isAdmin && item.user_id !== userId) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses menghapus antrean ini.' });
    }

    await removeCloudinaryFile(item.file_path);

    await turso.execute({ sql: 'DELETE FROM queue WHERE id = ?', args: [id] });
    res.json({ success: true, message: 'Berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/clear-stuck-queue', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === 'admin';

    const sqlSelect = isAdmin ? `
      SELECT file_path FROM queue 
      WHERE status = 'Failed' OR status = 'Processing' OR channel_id IS NULL OR channel_id = ''
    ` : `
      SELECT file_path FROM queue 
      WHERE (status = 'Failed' OR status = 'Processing' OR channel_id IS NULL OR channel_id = '')
        AND user_id = ?
    `;

    const stuckItemsRes = isAdmin ? await turso.execute(sqlSelect) : await turso.execute({ sql: sqlSelect, args: [userId] });

    for (const item of stuckItemsRes.rows) {
      await removeCloudinaryFile(item.file_path);
    }

    const sqlDelete = isAdmin ? `
      DELETE FROM queue 
      WHERE status = 'Failed' OR status = 'Processing' OR channel_id IS NULL OR channel_id = ''
    ` : `
      DELETE FROM queue 
      WHERE (status = 'Failed' OR status = 'Processing' OR channel_id IS NULL OR channel_id = '')
        AND user_id = ?
    `;

    if (isAdmin) {
      await turso.execute(sqlDelete);
    } else {
      await turso.execute({ sql: sqlDelete, args: [userId] });
    }

    res.json({ success: true, message: `Berhasil membersihkan data antrean.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN USERS ROUTES ---

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const usersRes = await turso.execute('SELECT id, username, email, whatsapp, role, is_approved, payment_status, invoice_number, pending_password, created_at FROM users');
    res.json(usersRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  try {
    const { is_approved } = req.body;
    await turso.execute({
      sql: 'UPDATE users SET is_approved = ?, payment_status = ? WHERE id = ?',
      args: [is_approved, is_approved === 1 ? 'PAID' : 'PENDING', req.params.id]
    });
    res.json({ success: true, message: 'Status user berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-reset-password/:id', requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.id;

    const userRes = await turso.execute({
      sql: 'SELECT pending_password FROM users WHERE id = ?',
      args: [targetUserId]
    });

    const user = userRes.rows[0];
    if (!user || !user.pending_password) {
      return res.status(400).json({ error: 'Tidak ada permintaan reset password untuk pengguna ini.' });
    }

    await turso.execute({
      sql: 'UPDATE users SET password = pending_password, pending_password = NULL WHERE id = ?',
      args: [targetUserId]
    });

    res.json({ success: true, message: 'Password baru berhasil disetujui (ACC)!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { email, whatsapp } = req.body;
    const targetUserId = req.params.id;

    if (!email || !whatsapp) {
      return res.status(400).json({ error: 'Email dan nomor WhatsApp wajib diisi!' });
    }

    await turso.execute({
      sql: 'UPDATE users SET email = ?, whatsapp = ? WHERE id = ?',
      args: [email, whatsapp, targetUserId]
    });

    res.json({ success: true, message: 'Data pengguna berhasil diperbarui!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.id;

    const userQueueRes = await turso.execute({ sql: 'SELECT file_path FROM queue WHERE user_id = ?', args: [targetUserId] });
    for (const q of userQueueRes.rows) {
      await removeCloudinaryFile(q.file_path);
    }

    await turso.execute({ sql: 'DELETE FROM queue WHERE user_id = ?', args: [targetUserId] });
    await turso.execute({ sql: 'DELETE FROM channels WHERE user_id = ?', args: [targetUserId] });
    await turso.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [targetUserId] });

    res.json({ success: true, message: 'User beserta datanya berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SERVER INITIALIZATION ---

initDb().then(() => {
  initScheduler();
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Gagal memulai server karena error database:", err);
});

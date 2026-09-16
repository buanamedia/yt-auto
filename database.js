require('dotenv').config();
const { createClient } = require('@libsql/client');

let dbUrl = process.env.TURSO_DATABASE_URL || '';
if (dbUrl.startsWith('libsql://')) {
  dbUrl = dbUrl.replace('libsql://', 'https://');
}

const turso = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  try {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        whatsapp TEXT,
        role TEXT DEFAULT 'user',
        is_approved INTEGER DEFAULT 0,
        payment_status TEXT DEFAULT 'PENDING',
        invoice_number TEXT,
        payment_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await turso.execute(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        avatar_url TEXT,
        refresh_token TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await turso.execute(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        tags TEXT,
        privacy_status TEXT DEFAULT 'private',
        scheduled_at INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT DEFAULT 'Pending',
        youtube_id TEXT,
        error_message TEXT,
        channel_id TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      const uInfo = await turso.execute("PRAGMA table_info(users)");
      const uCols = uInfo.rows.map(c => c.name);
      if (!uCols.includes('email')) await turso.execute("ALTER TABLE users ADD COLUMN email TEXT");
      if (!uCols.includes('whatsapp')) await turso.execute("ALTER TABLE users ADD COLUMN whatsapp TEXT");
      if (!uCols.includes('is_approved')) await turso.execute("ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 0");
      if (!uCols.includes('payment_status')) await turso.execute("ALTER TABLE users ADD COLUMN payment_status TEXT DEFAULT 'PENDING'");
      if (!uCols.includes('invoice_number')) await turso.execute("ALTER TABLE users ADD COLUMN invoice_number TEXT");
      if (!uCols.includes('payment_url')) await turso.execute("ALTER TABLE users ADD COLUMN payment_url TEXT");

      const qInfo = await turso.execute("PRAGMA table_info(queue)");
      const qCols = qInfo.rows.map(c => c.name);
      if (!qCols.includes('user_id')) await turso.execute("ALTER TABLE queue ADD COLUMN user_id INTEGER");

      const cInfo = await turso.execute("PRAGMA table_info(channels)");
      const cCols = cInfo.rows.map(c => c.name);
      if (!cCols.includes('user_id')) await turso.execute("ALTER TABLE channels ADD COLUMN user_id INTEGER");
    } catch (migErr) {
      console.error("[DB Migration Warning]:", migErr.message || migErr);
    }

    console.log('✅ Database Turso Cloud berhasil terhubung & tabel siap!');
    return true;
  } catch (err) {
    console.error('❌ Gagal inisialisasi database Turso:', err.message || err);
    return false;
  }
}

// Export turso dan alias db
module.exports = { turso, db: turso, initDb };

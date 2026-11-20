const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('ตั้งค่า DATABASE_URL ในไฟล์ .env ก่อนเริ่มเซิร์ฟเวอร์');
}

if (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'true') {
  throw new Error('ต้องตั้ง DATABASE_SSL=true สำหรับการเชื่อมต่อฐานข้อมูลใน production');
}

const sslEnabled = process.env.DATABASE_SSL === 'true';
const caPath = process.env.DATABASE_CA_CERT
  ? path.resolve(__dirname, process.env.DATABASE_CA_CERT)
  : '';
const sslOptions = sslEnabled
  ? {
      rejectUnauthorized: true,
      ...(caPath ? { ca: fsSync.readFileSync(caPath, 'utf8') } : {})
    }
  : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOptions,
  options: '-c search_path=app_private,public',
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

async function initializeDatabase() {
  const schema = await fs.readFile(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const match = html.match(/const REASONS\s*=\s*(\[[^\r\n]*\]);/);
  if (!match) throw new Error('อ่านรายการ REASONS จาก index.html ไม่ได้');
  const reasons = [...new Set(JSON.parse(match[1]))];
  await withTransaction(async client => {
    await client.query(schema);
    await client.query(
      `INSERT INTO app_options (category, value, sort_order)
       SELECT 'reason', value, position::int
       FROM UNNEST($1::text[]) WITH ORDINALITY AS options(value, position)
       ON CONFLICT (category, value) DO NOTHING`,
      [reasons]
    );
  });
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase, withTransaction };

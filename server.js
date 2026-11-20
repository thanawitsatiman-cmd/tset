require('dotenv').config();

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const path = require('node:path');
const { pool, initializeDatabase, withTransaction } = require('./database');
const { personIdentityKey } = require('./person-identity');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const HEADERS = [
  'id', 'date', 'no', 'name', 'address', 'phone', 'type', 'status', 'phase',
  'size', 'inPhase', 'pole', 'route', 'note', 'src', 'reason'
];
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };
const DONE_STATUS_SQL = "(status IN ('ผ่าน', 'ไม่ผ่าน') OR POSITION('เสร็จ' IN status) > 0)";
const requestUser = new AsyncLocalStorage();
const AUTH_ACCESS_COOKIE = 'petition-access';
const AUTH_REFRESH_COOKIE = 'petition-refresh';
const AUTH_REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function authConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function authFailure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function authSettings() {
  if (!authConfigured()) throw authFailure('ยังไม่ได้ตั้งค่า Supabase Auth บนเซิร์ฟเวอร์', 503);
  let base;
  try {
    base = new URL(process.env.SUPABASE_URL);
  } catch {
    throw authFailure('ค่า SUPABASE_URL ไม่ถูกต้อง', 503);
  }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw authFailure('SUPABASE_URL ต้องใช้ HTTPS', 503);
  }
  return { base: base.origin, key: process.env.SUPABASE_ANON_KEY };
}

async function supabaseAuth(path, { method = 'GET', body, accessToken } = {}) {
  const settings = authSettings();
  let response;
  try {
    response = await fetch(`${settings.base}/auth/v1${path}`, {
      method,
      headers: {
        apikey: settings.key,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw authFailure('เชื่อมต่อระบบยืนยันตัวตนไม่สำเร็จ กรุณาลองใหม่', 503);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { response, data };
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return '';
  }
}

function writeAuthCookies(res, session) {
  const secure = process.env.NODE_ENV === 'production';
  const options = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  const accessAge = Math.max(60, Number(session.expires_in) || 3600) * 1000;
  res.cookie(AUTH_ACCESS_COOKIE, session.access_token, { ...options, maxAge: accessAge });
  res.cookie(AUTH_REFRESH_COOKIE, session.refresh_token, { ...options, maxAge: AUTH_REFRESH_MAX_AGE });
}

function clearAuthCookies(res) {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  };
  res.clearCookie(AUTH_ACCESS_COOKIE, options);
  res.clearCookie(AUTH_REFRESH_COOKIE, options);
}

function checkSameOrigin(req) {
  const origin = req.get('origin');
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw authFailure('คำขอเข้าสู่ระบบไม่ถูกต้อง', 403);
  }
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host !== req.get('host')) {
    throw authFailure('ปฏิเสธคำขอจากเว็บไซต์อื่น', 403);
  }
}

function userRole(email) {
  const address = String(email || '').trim().toLowerCase();
  const contains = key => String(process.env[key] || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean).includes(address);
  if (contains('AUTH_ADMIN_EMAILS')) return 'admin';
  if (contains('AUTH_EDITOR_EMAILS')) return 'editor';
  if (contains('AUTH_VIEWER_EMAILS')) return 'viewer';
  throw authFailure('บัญชีนี้ยังไม่ได้รับอนุญาตให้เข้าใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 403);
}

function publicUser(user) {
  if (!user || !user.email) throw authFailure('Supabase ไม่ส่งข้อมูลบัญชีกลับมา', 401);
  const role = userRole(user.email);
  const metadata = user.user_metadata || {};
  return {
    email: user.email,
    name: metadata.full_name || metadata.name || user.email,
    role
  };
}

async function resolveAuthenticatedUser(req, res) {
  if (!authConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw authFailure('ยังไม่ได้ตั้งค่า Supabase Auth บนเซิร์ฟเวอร์', 503);
    }
    const email = process.env.DEV_USER_EMAIL || 'local@dev';
    const role = process.env.DEV_USER_ROLE || 'admin';
    if (!ROLE_LEVEL[role]) throw new Error('DEV_USER_ROLE ต้องเป็น viewer, editor หรือ admin');
    return { email, name: 'ผู้ใช้ (ทดสอบ)', role };
  }

  const accessToken = cookieValue(req, AUTH_ACCESS_COOKIE);
  const refreshToken = cookieValue(req, AUTH_REFRESH_COOKIE);
  if (!accessToken && !refreshToken) throw authFailure('กรุณาเข้าสู่ระบบ', 401);

  if (accessToken) {
    const result = await supabaseAuth('/user', { accessToken });
    if (result.response.ok) return publicUser(result.data);
    if (result.response.status !== 401) {
      throw authFailure('ตรวจสอบบัญชีกับ Supabase ไม่สำเร็จ', 503);
    }
  }

  if (!refreshToken) {
    clearAuthCookies(res);
    throw authFailure('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  }

  const refreshed = await supabaseAuth('/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  });
  if (!refreshed.response.ok || !refreshed.data.access_token || !refreshed.data.refresh_token) {
    if (![400, 401].includes(refreshed.response.status)) {
      throw authFailure('ต่ออายุเซสชันไม่สำเร็จ กรุณาลองใหม่', 503);
    }
    clearAuthCookies(res);
    throw authFailure('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  }
  writeAuthCookies(res, refreshed.data);
  return publicUser(refreshed.data.user);
}

function requestFromRow(row) {
  const typeValues = row.type_values || [];
  const reasonValues = row.reason_values || [];
  return {
    id: row.id,
    ID: row.id,
    date: row.request_date,
    no: row.request_no,
    name: row.name,
    address: row.address,
    phone: row.phone,
    type: typeValues.length ? typeValues.join(', ') : row.type,
    status: row.status,
    phase: row.phase,
    size: row.size,
    inPhase: row.in_phase,
    pole: row.pole,
    route: row.route,
    note: row.note,
    src: row.src,
    reason: reasonValues.length ? reasonValues.join(', ') : row.reason,
    rn: row.revision
  };
}

function requestValues(data) {
  const value = data && typeof data === 'object' ? data : {};
  const values = {
    typeValues: Array.isArray(value.type)
      ? [...new Set(value.type.map(item => String(item).trim()).filter(Boolean))]
      : (String(value.type || '').trim() ? [String(value.type).trim()] : []),
    reasonValues: Array.isArray(value.reason)
      ? [...new Set(value.reason.map(item => String(item).trim()).filter(Boolean))]
      : (String(value.reason || '').trim() ? String(value.reason).split(/,\s*/).filter(Boolean) : [])
  };
  values.fields = [
    String(value.date || '').slice(0, 10),
    String(value.no || ''),
    String(value.name || ''),
    String(value.address || ''),
    String(value.phone || ''),
    values.typeValues.join(', '),
    String(value.status || ''),
    String(value.phase || ''),
    String(value.size || ''),
    String(value.inPhase || ''),
    String(value.pole || ''),
    String(value.route || ''),
    String(value.note || ''),
    String(value.src || ''),
    values.reasonValues.join(', ')
  ];
  return values;
}

function splitSheetMulti(value, commaOptions) {
  let text = String(value || '');
  const preserved = [];
  commaOptions.slice().sort((a, b) => b.length - a.length).forEach(option => {
    if (!text.includes(option)) return;
    const marker = `\u0001${preserved.length}\u0001`;
    text = text.split(option).join(marker);
    preserved.push(option);
  });
  return text.split(',').map(item => item.trim().replace(/\u0001(\d+)\u0001/g, (marker, index) => preserved[Number(index)] || ''))
    .filter(Boolean);
}

function requireRole(minRole) {
  const user = requestUser.getStore();
  if (!user) throw authFailure('กรุณาเข้าสู่ระบบ', 401);
  if (ROLE_LEVEL[user.role] < ROLE_LEVEL[minRole]) {
    const error = new Error('สิทธิ์ของคุณไม่เพียงพอสำหรับการทำรายการนี้');
    error.status = 403;
    throw error;
  }
  return user;
}

function buildFilters(params) {
  const p = params || {};
  const where = [];
  const values = [];
  const add = value => {
    values.push(value);
    return `$${values.length}`;
  };
  const year = String(p.year || '');
  const month = String(p.month || '');
  const date = String(p.date || '');
  const type = Array.isArray(p.type) ? p.type : (p.type ? [p.type] : []);
  const reason = Array.isArray(p.reason) ? p.reason : (p.reason ? [p.reason] : []);
  const status = String(p.status || '');
  const q = String(p.q || '').trim().toLocaleLowerCase();

  if (year) where.push(`request_date LIKE ${add(year + '%')}`);
  if (month) where.push(`request_date LIKE ${add(month + '%')}`);
  if (date) where.push(`request_date = ${add(date)}`);
  if (type.length) {
    const param = add(type);
    where.push(`type_values && ${param}::text[]`);
  }
  if (reason.length) {
    const param = add(reason);
    where.push(`(reason_values && ${param}::text[] OR ('__none' = ANY(${param}::text[]) AND cardinality(reason_values) = 0))`);
  }
  if (status === '__open') where.push(`NOT ${DONE_STATUS_SQL}`);
  if (status === '__done') where.push(DONE_STATUS_SQL);
  if (status === '__pass') where.push("BTRIM(status) = 'ผ่าน'");
  if (status === '__fail') where.push("BTRIM(status) = 'ไม่ผ่าน'");
  if (q) {
    const param = add(`%${q}%`);
    where.push(`LOWER(CONCAT_WS(' ', request_no, name, address, phone, route, type, reason, status)) LIKE ${param}`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

async function getRequestsPage(params) {
  requireRole('viewer');
  const p = params || {};
  const pageSize = Math.min(200, Math.max(1, Number(p.pageSize) || 50));
  const requestedPage = Math.max(0, Number(p.page) || 0);
  const { clause, values } = buildFilters(p);
  const filterQueries = [
    pool.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE NOT ${DONE_STATUS_SQL})::int AS open_count
                FROM petition_request_rows ${clause}`, values),
    pool.query(`SELECT value, COUNT(*)::int AS count
                FROM petition_request_rows, LATERAL UNNEST(type_values) AS value
                ${clause} GROUP BY value`, values)
  ];
  const [countsResult, typesResult] = await Promise.all(filterQueries);
  const total = countsResult.rows[0].total;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const rowsResult = await pool.query(
    `SELECT * FROM petition_request_rows ${clause}
     ORDER BY request_date DESC, request_no DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, page * pageSize]
  );
  const [yearsResult, monthsResult, optionsResult] = await Promise.all([
    pool.query("SELECT DISTINCT LEFT(request_date, 4) AS value FROM petition_request_rows WHERE request_date ~ '^[0-9]{4}-[0-9]{2}' ORDER BY value"),
    pool.query(
      `SELECT DISTINCT LEFT(request_date, 7) AS value
       FROM petition_request_rows
       WHERE request_date ~ '^[0-9]{4}-[0-9]{2}' AND ($1 = '' OR LEFT(request_date, 4) = $1)
       ORDER BY value`,
      [String(p.year || '')]
    ),
    pool.query(
      `SELECT category, value FROM app_options
       UNION
       SELECT 'type', value
       FROM petition_request_rows, LATERAL UNNEST(type_values) AS value
       WHERE value <> ''
       UNION
       SELECT 'reason', value
       FROM petition_request_rows, LATERAL UNNEST(reason_values) AS value
       WHERE value <> ''
       ORDER BY category, value`
    )
  ]);
  const options = { type: [], reason: [] };
  for (const row of optionsResult.rows) {
    if (options[row.category]) options[row.category].push(row.value);
  }
  const typeCounts = Object.fromEntries(typesResult.rows.map(row => [row.value, row.count]));
  return {
    rows: rowsResult.rows.map(requestFromRow),
    total,
    page,
    pageSize,
    pages,
    openCount: countsResult.rows[0].open_count,
    typeCounts,
    types: options.type,
    reasons: options.reason,
    years: yearsResult.rows.map(row => row.value),
    months: monthsResult.rows.map(row => row.value)
  };
}

function addCount(target, key, amount) {
  if (key) target[key] = (target[key] || 0) + amount;
}

async function getDashboardData(year, requestedMonth) {
  requireRole('viewer');
  const selectedYear = String(year || '');
  const [yearResult, monthResult] = await Promise.all([
    pool.query(
      `SELECT LEFT(request_date, 4) AS key, COUNT(*)::int AS total
       FROM petition_request_rows WHERE request_date ~ '^[0-9]{4}-[0-9]{2}'
       GROUP BY LEFT(request_date, 4) ORDER BY key`
    ),
    pool.query(
      `SELECT LEFT(request_date, 7) AS key,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE NOT ${DONE_STATUS_SQL})::int AS open
       FROM petition_request_rows
       WHERE request_date ~ '^[0-9]{4}-[0-9]{2}' AND ($1 = '' OR LEFT(request_date, 4) = $1)
       GROUP BY LEFT(request_date, 7) ORDER BY key`,
      [selectedYear]
    )
  ]);
  const yearSummary = yearResult.rows;
  const years = yearSummary.map(row => row.key);
  const months = monthResult.rows.map(row => row.key);
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);
  const yesterdayDate = new Date(now.getTime() - 86400000);
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(yesterdayDate);
  const currentMonth = today.slice(0, 7);
  const month = months.includes(String(requestedMonth || ''))
    ? String(requestedMonth)
    : (months.includes(currentMonth) ? currentMonth : (months[months.length - 1] || currentMonth));
  const monthIndex = months.indexOf(month);
  const previousMonthTotal = monthIndex > 0 ? monthResult.rows[monthIndex - 1].total : null;
  const monthPrefix = selectedYear ? `${selectedYear}%` : '%';
  const [dailyResult, typeResult, phaseResult, dateTotalsResult] = await Promise.all([
    pool.query(
      `SELECT request_date AS key, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${DONE_STATUS_SQL})::int AS done
       FROM petition_request_rows WHERE request_date LIKE $1 GROUP BY request_date ORDER BY key`,
      [month + '%']
    ),
    pool.query(
      `SELECT LEFT(request_date, 7) AS month, value AS type, COUNT(*)::int AS total
       FROM petition_request_rows, LATERAL UNNEST(type_values) AS value
       WHERE request_date LIKE $1 AND value <> ''
       GROUP BY LEFT(request_date, 7), value`,
      [monthPrefix]
    ),
    pool.query(
      `SELECT TRIM(phase) AS phase, COUNT(*)::int AS total
       FROM petition_request_rows
       WHERE request_date LIKE $1 AND phase <> '' AND phase <> '-'
       GROUP BY TRIM(phase)`,
      [month + '%']
    ),
    pool.query(
      `SELECT request_date AS key, COUNT(*)::int AS total
       FROM petition_request_rows WHERE request_date = ANY($1::text[]) GROUP BY request_date`,
      [[today, yesterday]]
    )
  ]);
  const monthTypes = {};
  for (const row of typeResult.rows) {
    if (!monthTypes[row.month]) monthTypes[row.month] = {};
    addCount(monthTypes[row.month], row.type, row.total);
  }
  const byMonth = Object.fromEntries(monthResult.rows.map(row => [row.key, row.total]));
  const byYear = Object.fromEntries(yearSummary.map(row => [row.key, row.total]));
  const byDay = Object.fromEntries(dailyResult.rows.map(row => [row.key, row.total]));
  const dateTotals = Object.fromEntries(dateTotalsResult.rows.map(row => [row.key, row.total]));
  const monthRow = monthResult.rows.find(row => row.key === month);
  return {
    total: selectedYear
      ? (yearSummary.find(row => row.key === selectedYear) || { total: 0 }).total
      : yearSummary.reduce((sum, row) => sum + row.total, 0),
    allTotal: yearSummary.reduce((sum, row) => sum + row.total, 0),
    years,
    months,
    month,
    today: (!selectedYear || today.startsWith(selectedYear)) ? (dateTotals[today] || 0) : 0,
    yesterday: (!selectedYear || yesterday.startsWith(selectedYear)) ? (dateTotals[yesterday] || 0) : 0,
    monthTotal: monthRow ? monthRow.total : 0,
    previousMonthTotal,
    open: monthResult.rows.reduce((sum, row) => sum + row.open, 0),
    doneMonth: dailyResult.rows.reduce((sum, row) => sum + row.done, 0),
    byMonth,
    byYear,
    byDay,
    types: monthTypes[month] || {},
    phases: Object.fromEntries(phaseResult.rows.map(row => [row.phase, row.total])),
    monthSummary: monthResult.rows.map(row => ({
      key: row.key,
      total: row.total,
      open: row.open,
      types: monthTypes[row.key] || {}
    })),
    yearSummary
  };
}

async function getBookData(params) {
  requireRole('viewer');
  const p = { ...(params || {}) };
  const years = (await getDashboardData('', '')).years;
  if (String(p.year || '') === 'all') {
    p.year = '';
    p.month = '';
    return { year: 'all', month: '', years, months: [], page: await getRequestsPage(p) };
  }
  const currentYear = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(new Date());
  let selectedYear = String(p.year || '');
  if (!years.includes(selectedYear)) {
    selectedYear = years.includes(currentYear) ? currentYear : (years[years.length - 1] || currentYear);
  }
  const dashboard = await getDashboardData(selectedYear, '');
  let month = p.month == null ? 'auto' : String(p.month);
  if (month === 'auto') {
    const currentMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()).slice(0, 7);
    month = dashboard.months.includes(currentMonth)
      ? currentMonth
      : (dashboard.months[dashboard.months.length - 1] || '');
  }
  if (month && !month.startsWith(selectedYear)) month = '';
  p.year = selectedYear;
  p.month = month;
  return {
    year: selectedYear,
    month,
    years,
    months: dashboard.monthSummary,
    page: await getRequestsPage(p)
  };
}

async function writeAudit(client, user, action, target, detail, requestId, changes) {
  await client.query(
    `INSERT INTO audit_log (email, action, target, detail, request_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      user.email,
      action,
      String(target || ''),
      String(detail || '').slice(0, 1000),
      requestId || null,
      JSON.stringify(changes || {})
    ]
  );
}

async function savePerson(client, name, address, phone, currentId) {
  const personName = String(name || '');
  const personAddress = String(address || '');
  const personPhone = String(phone || '');
  let identityKey = personIdentityKey(personName, personPhone, personAddress);
  if (!personIdentityKey(personName, personPhone, personAddress).split('\u001f')[0]) {
    identityKey += `\u001f${crypto.randomUUID()}`;
  }
  if (currentId) {
    const updated = await client.query(
      `UPDATE petition_requests
       SET name = $2, address = $3, phone = $4, identity_key = $5, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [currentId, personName, personAddress, personPhone, identityKey]
    );
    if (!updated.rowCount) throw new Error('ไม่พบข้อมูลผู้ขอ');
    return updated.rows[0].id;
  }
  const result = await client.query(
    `INSERT INTO petition_requests (id, name, address, phone, identity_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (identity_key) DO UPDATE
       SET name = EXCLUDED.name, address = EXCLUDED.address, phone = EXCLUDED.phone, updated_at = NOW()
     RETURNING id`,
    [crypto.randomUUID(), personName, personAddress, personPhone, identityKey]
  );
  return result.rows[0].id;
}

function sheetRecord(id, values, revision) {
  const record = { id: String(id) };
  HEADERS.slice(1).forEach((field, index) => {
    record[field] = values[index];
  });
  record._revision = Number(revision);
  return record;
}

async function queueSheetSync(client, id, values, revision) {
  await client.query(
    'INSERT INTO sheets_sync_outbox (request_id, payload) VALUES ($1, $2::jsonb)',
    [String(id), JSON.stringify(sheetRecord(id, values, revision))]
  );
}

const api = {
  getMe: async () => {
    const user = requireRole('viewer');
    return {
      ...user,
      canWrite: ROLE_LEVEL[user.role] >= ROLE_LEVEL.editor,
      canDelete: user.role === 'admin'
    };
  },
  getVersion: async () => {
    requireRole('viewer');
    const result = await pool.query("SELECT value FROM app_meta WHERE key = 'data_version'");
    return Number(result.rows[0].value);
  },
  getOptions: async () => {
    requireRole('viewer');
    const result = await pool.query(
      `SELECT category, value FROM app_options
       UNION
       SELECT 'type', value
       FROM petition_request_rows, LATERAL UNNEST(type_values) AS value
       WHERE value <> ''
       UNION
       SELECT 'reason', value
       FROM petition_request_rows, LATERAL UNNEST(reason_values) AS value
       WHERE value <> ''
       ORDER BY category, value`
    );
    const options = { types: [], reasons: [] };
    result.rows.forEach(row => options[row.category === 'type' ? 'types' : 'reasons'].push(row.value));
    return options;
  },
  refreshData: async () => {
    requireRole('editor');
    return true;
  },
  getRequest: async ([id]) => {
    requireRole('viewer');
    const result = await pool.query('SELECT * FROM petition_request_rows WHERE id = $1', [String(id || '')]);
    if (!result.rowCount) throw new Error('ไม่พบคำร้อง');
    return requestFromRow(result.rows[0]);
  },
  getRequestsPage: async ([params]) => getRequestsPage(params),
  getDashboardData: async ([year, month]) => getDashboardData(year, month),
  getBookData: async ([params]) => getBookData(params),
  createRequest: async ([data, idOverride]) => {
    const user = requireRole('editor');
    return withTransaction(async client => {
      const request = requestValues(data);
      const values = request.fields;
      if (!values[1].trim() && /^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
        const prefix = `${String((Number(values[0].slice(0, 4)) + 543) % 100).padStart(2, '0')}${values[0].slice(5, 7)}-`;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [prefix]);
        const existing = await client.query('SELECT request_no FROM petition_years WHERE request_no LIKE $1', [`${prefix}%`]);
        const max = existing.rows.reduce((current, row) => {
          const suffix = row.request_no.slice(prefix.length);
          const number = /^\d+$/.test(suffix) ? Number(suffix) : 0;
          return Math.max(current, number);
        }, 0);
        values[1] = prefix + String(max + 1).padStart(4, '0');
      }
      const id = idOverride || crypto.randomUUID();
      const personId = await savePerson(client, values[2], values[3], values[4]);
      const insert = await client.query(
        `INSERT INTO petition_years
         (id, person_id, request_date, request_no, type, type_values, status, phase, size,
          in_phase, pole, route, note, src, reason, reason_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING revision`,
        [id, personId, values[0], values[1], values[5], request.typeValues, ...values.slice(6), request.reasonValues]
      );
      const version = await client.query(
        "UPDATE app_meta SET value = value + 1 WHERE key = 'data_version' RETURNING value"
      );
      await writeAudit(client, user, 'create', values[1] || id, `ID ${id}`);
      await queueSheetSync(client, id, values, insert.rows[0].revision);
      return {
        success: true,
        id,
        no: values[1],
        rn: insert.rows[0].revision,
        ver: Number(version.rows[0].value),
        prevVer: Number(version.rows[0].value) - 1
      };
    });
  },
  updateRequest: async ([id, patch, hint]) => {
    const user = requireRole('editor');
    if (!id) throw new Error('ไม่พบรหัสคำร้อง');
    return withTransaction(async client => {
      await client.query('SELECT id FROM petition_years WHERE id = $1 FOR UPDATE', [String(id)]);
      const existing = await client.query('SELECT * FROM petition_request_rows WHERE id = $1', [String(id)]);
      if (!existing.rowCount) throw new Error('ไม่พบคำร้องที่ต้องการแก้ไข');
      const old = requestFromRow(existing.rows[0]);
      const incoming = patch && typeof patch === 'object' ? patch : {};
      if (hint != null && Number(hint) !== old.rn) {
        const error = new Error('ข้อมูลถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณารีเฟรชก่อนบันทึก');
        error.status = 409;
        throw error;
      }
      const merged = { ...old, ...incoming };
      const request = requestValues(merged);
      if (!Object.prototype.hasOwnProperty.call(incoming, 'type')) {
        request.fields[5] = existing.rows[0].type;
        request.typeValues = existing.rows[0].type_values || [];
      }
      if (!Object.prototype.hasOwnProperty.call(incoming, 'reason')) {
        request.fields[14] = existing.rows[0].reason;
        request.reasonValues = existing.rows[0].reason_values || [];
      }
      const values = request.fields;
      const personId = await savePerson(client, values[2], values[3], values[4], existing.rows[0].person_id);
      const updated = await client.query(
        `UPDATE petition_years SET
           person_id = $2, request_date = $3, request_no = $4,
           type = $5, type_values = $6, status = $7, phase = $8, size = $9,
           in_phase = $10, pole = $11, route = $12, note = $13, src = $14,
           reason = $15, reason_values = $16,
           revision = revision + 1, updated_at = NOW()
         WHERE id = $1 RETURNING revision`,
        [String(id), personId, values[0], values[1], values[5], request.typeValues, ...values.slice(6), request.reasonValues]
      );
      const version = await client.query(
        "UPDATE app_meta SET value = value + 1 WHERE key = 'data_version' RETURNING value"
      );
      const oldValues = requestValues(old).fields;
      const changes = {};
      HEADERS.slice(1).forEach((field, index) => {
        if (oldValues[index] !== values[index]) {
          changes[field] = { from: oldValues[index], to: values[index] };
        }
      });
      await writeAudit(
        client,
        user,
        'update',
        values[1] || old.no || id,
        Object.keys(changes).join(', '),
        String(id),
        changes
      );
      await queueSheetSync(client, id, values, updated.rows[0].revision);
      return {
        success: true,
        rn: updated.rows[0].revision,
        ver: Number(version.rows[0].value),
        prevVer: Number(version.rows[0].value) - 1
      };
    });
  },
  deleteRequest: async ([id]) => {
    const user = requireRole('admin');
    if (!id) throw new Error('ไม่พบรหัสคำร้อง');
    return withTransaction(async client => {
      const existing = await client.query('SELECT * FROM petition_request_rows WHERE id = $1', [String(id)]);
      if (!existing.rowCount) throw new Error('ไม่พบคำร้องที่ต้องการลบ');
      const row = requestFromRow(existing.rows[0]);
      await client.query('DELETE FROM petition_years WHERE id = $1', [String(id)]);
      await client.query(
        `DELETE FROM petition_requests person
         WHERE person.id = $1
           AND NOT EXISTS (SELECT 1 FROM petition_years years WHERE years.person_id = person.id)`,
        [existing.rows[0].person_id]
      );
      const version = await client.query(
        "UPDATE app_meta SET value = value + 1 WHERE key = 'data_version' RETURNING value"
      );
      await writeAudit(client, user, 'delete', row.no || id, JSON.stringify({
        name: row.name, date: row.date, type: row.type, status: row.status
      }));
      return {
        success: true,
        ver: Number(version.rows[0].value),
        prevVer: Number(version.rows[0].value) - 1
      };
    });
  }
};

let processingSheetsOutbox = false;
async function processSheetsOutbox() {
  if (!process.env.SHEETS_WEB_APP_URL || !process.env.SHEETS_SYNC_TOKEN || processingSheetsOutbox) return;
  processingSheetsOutbox = true;
  try {
    const pending = await pool.query(
      `SELECT id, request_id, payload, attempts
       FROM sheets_sync_outbox
       WHERE completed_at IS NULL AND next_attempt_at <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM sheets_sync_outbox newer
           WHERE newer.request_id = sheets_sync_outbox.request_id
             AND newer.completed_at IS NULL AND newer.id > sheets_sync_outbox.id
         )
       ORDER BY id
       LIMIT 1`
    );
    if (!pending.rowCount) return;
    const item = pending.rows[0];
    try {
      const response = await fetch(process.env.SHEETS_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: process.env.SHEETS_SYNC_TOKEN,
          action: 'upsert',
          row: item.payload
        }),
        signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        throw new Error(result.error || `Google Sheets ตอบกลับผิดพลาด (${response.status})`);
      }
      await pool.query(
        `UPDATE sheets_sync_outbox
         SET completed_at = NOW(), last_error = ''
         WHERE request_id = $1 AND completed_at IS NULL AND id <= $2`,
        [item.request_id, item.id]
      );
    } catch (error) {
      const attempts = Number(item.attempts) + 1;
      const message = String(error.message || error).slice(0, 1000);
      await pool.query(
        `UPDATE sheets_sync_outbox
         SET attempts = $2, last_error = $3,
             next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 5 * (2 ^ LEAST($2, 9)))::int)
         WHERE id = $1`,
        [item.id, attempts, message]
      );
      console.error('Google Sheets sync failed; will retry:', message);
    }
  } catch (error) {
    console.error('Google Sheets outbox processing failed:', error);
  } finally {
    processingSheetsOutbox = false;
  }
}

function validSyncToken(value) {
  const expected = process.env.SHEETS_SYNC_TOKEN || '';
  const actual = String(value || '');
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function validateSheetsSyncConfig() {
  const hasUrl = Boolean(process.env.SHEETS_WEB_APP_URL);
  const hasToken = Boolean(process.env.SHEETS_SYNC_TOKEN);
  if (hasUrl !== hasToken) {
    throw new Error('ต้องตั้งค่า SHEETS_WEB_APP_URL และ SHEETS_SYNC_TOKEN พร้อมกัน');
  }
  if (!hasUrl) return false;
  let url;
  try {
    url = new URL(process.env.SHEETS_WEB_APP_URL);
  } catch {
    throw new Error('ค่า SHEETS_WEB_APP_URL ไม่ถูกต้อง');
  }
  if (url.protocol !== 'https:' || process.env.SHEETS_SYNC_TOKEN.length < 32) {
    throw new Error('การซิงก์ชีตต้องใช้ URL แบบ HTTPS และ token อย่างน้อย 32 ตัวอักษร');
  }
  return true;
}

app.post('/api/sheets-sync', async (req, res) => {
  if (!validSyncToken(req.body && req.body.token)) {
    return res.status(401).json({ ok: false, error: 'ซิงก์ชีตไม่ได้: token ไม่ถูกต้อง' });
  }
  const incoming = req.body && req.body.row;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ ok: false, error: 'ข้อมูลแถวไม่ถูกต้อง' });
  }
  const row = {};
  HEADERS.forEach(field => { row[field] = String(incoming[field] == null ? '' : incoming[field]).trim(); });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !row.type) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกวันที่และประเภทคำร้องให้ครบ' });
  }

  const syncUser = { email: 'google-sheets-sync', name: 'Google Sheets Sync', role: 'editor' };
  try {
    const options = await pool.query(
      `SELECT category, value FROM app_options
       UNION
       SELECT 'type', value
       FROM petition_request_rows, LATERAL UNNEST(type_values) AS value
       WHERE value <> ''
       UNION
       SELECT 'reason', value
       FROM petition_request_rows, LATERAL UNNEST(reason_values) AS value
       WHERE value <> ''`
    );
    row.type = splitSheetMulti(row.type, options.rows.filter(option => option.category === 'type').map(option => option.value).filter(value => value.includes(',')));
    row.reason = splitSheetMulti(row.reason, options.rows.filter(option => option.category === 'reason').map(option => option.value).filter(value => value.includes(',')));
    row.src = row.src || 'Google Sheets';
    let result;
    if (row.id) {
      const revision = Number(incoming._revision);
      if (!Number.isInteger(revision) || revision < 1) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) {
          return res.status(400).json({ ok: false, error: 'ID ของคำร้องไม่ถูกต้อง' });
        }
        const existing = await pool.query('SELECT * FROM petition_request_rows WHERE id = $1', [row.id]);
        if (existing.rowCount) {
          const currentRow = requestFromRow(existing.rows[0]);
          const current = requestValues(currentRow).fields;
          const incomingValues = requestValues(row).fields;
          if (current.every((value, index) => value === incomingValues[index]
            || (index === 1 && incomingValues[index] === '' && value !== ''))) {
            return res.json({ ok: true, id: row.id, no: currentRow.no, revision: existing.rows[0].revision });
          }
          return res.status(409).json({ ok: false, error: 'ข้อมูลมีอยู่แล้วแต่ไม่ตรงกัน กรุณารีเฟรชจากเว็บก่อนแก้ไข' });
        }
        result = await requestUser.run(syncUser, () => api.createRequest([row, row.id]));
      } else {
        result = await requestUser.run(syncUser, () => api.updateRequest([row.id, row, revision]));
      }
    } else {
      result = await requestUser.run(syncUser, () => api.createRequest([row]));
    }
    return res.json({ ok: true, id: result.id || row.id, no: result.no || row.no, revision: result.rn });
  } catch (error) {
    console.error('Google Sheets inbound sync:', error);
    return res.status(error.status || 400).json({ ok: false, error: error.message || 'ซิงก์ข้อมูลจากชีตไม่สำเร็จ' });
  }
});

app.post('/api/sheets-sync/export', async (req, res) => {
  if (!validSyncToken(req.body && req.body.token)) {
    return res.status(401).json({ ok: false, error: 'ซิงก์ชีตไม่ได้: token ไม่ถูกต้อง' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM petition_request_rows ORDER BY request_date, request_no, id'
    );
    const rows = result.rows.map(row => {
      const record = requestFromRow(row);
      record._revision = record.rn;
      return record;
    });
    return res.json({ ok: true, rows });
  } catch (error) {
    console.error('Google Sheets export:', error);
    return res.status(500).json({ ok: false, error: 'ส่งออกข้อมูลไปชีตไม่สำเร็จ' });
  }
});

app.post('/api/:fn', async (req, res) => {
  const fn = api[req.params.fn];
  if (!fn) return res.status(404).json({ error: `ไม่พบฟังก์ชัน ${req.params.fn}` });
  try {
    checkSameOrigin(req);
    const user = await resolveAuthenticatedUser(req, res);
    const result = await requestUser.run(user, () => fn(req.body.args || []));
    res.json({ result });
  } catch (error) {
    console.error(`API ${req.params.fn}:`, error);
    res.status(error.status || 400).json({ error: error.message || 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

app.get('/auth/config', (req, res) => {
  res.json({ enabled: authConfigured(), required: process.env.NODE_ENV === 'production' });
});

app.post('/auth/login', async (req, res) => {
  try {
    checkSameOrigin(req);
    if (!authConfigured()) throw authFailure('ระบบล็อกอินยังไม่ได้ตั้งค่า', 503);
    const staffId = String(req.body.staffId || '').trim();
    const password = String(req.body.password || '');
    if (!staffId || !password || staffId.length > 80 || password.length > 1024) {
      throw authFailure('กรุณากรอกรหัสเจ้าหน้าที่และรหัสผ่านให้ครบ', 400);
    }

    let account;
    try {
      const result = await pool.query(
        'SELECT email FROM staff_accounts WHERE staff_id = $1',
        [staffId]
      );
      account = result.rows[0];
    } catch (error) {
      console.error('Staff account lookup failed:', error);
      throw authFailure('ตรวจสอบรหัสเจ้าหน้าที่ไม่สำเร็จ กรุณาลองใหม่', 503);
    }
    if (!account) throw authFailure('รหัสเจ้าหน้าที่หรือรหัสผ่านไม่ถูกต้อง', 401);

    const result = await supabaseAuth('/token?grant_type=password', {
      method: 'POST',
      body: { email: account.email, password }
    });
    if (!result.response.ok || !result.data.access_token || !result.data.refresh_token) {
      if (result.response.status === 429) {
        throw authFailure('พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่', 429);
      }
      if (result.response.status >= 500) throw authFailure('ระบบล็อกอินขัดข้อง กรุณาลองใหม่', 503);
      throw authFailure('รหัสเจ้าหน้าที่หรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    const user = publicUser(result.data.user);
    writeAuthCookies(res, result.data);
    res.json({ result: { email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    clearAuthCookies(res);
    res.status(error.status || 400).json({ error: error.message || 'เข้าสู่ระบบไม่สำเร็จ' });
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    checkSameOrigin(req);
    const accessToken = cookieValue(req, AUTH_ACCESS_COOKIE);
    clearAuthCookies(res);
    if (accessToken && authConfigured()) {
      const result = await supabaseAuth('/logout?scope=local', {
        method: 'POST',
        accessToken
      });
      if (!result.response.ok && result.response.status !== 401) {
        throw authFailure('ล้างเซสชันจาก Supabase ไม่สำเร็จ', 503);
      }
    }
    res.json({ result: true });
  } catch (error) {
    clearAuthCookies(res);
    res.status(error.status || 400).json({ error: error.message || 'ออกจากระบบไม่สำเร็จ' });
  }
});

async function start() {
  try {
    const sheetsSyncEnabled = validateSheetsSyncConfig();
    await initializeDatabase();
    if (sheetsSyncEnabled) {
      setInterval(processSheetsOutbox, 3000).unref();
      processSheetsOutbox();
    }
    app.listen(PORT, HOST, () => {
      console.log(`เปิดที่ http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', error.message);
    process.exitCode = 1;
    await pool.end();
  }
}

start();

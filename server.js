const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SESSION_COOKIE = 'neon_fleet_session';
const PREVIEW_COOKIE = 'webdev_app_session';
const COOKIE_BASE = 'Path=/; HttpOnly; Secure; SameSite=None';
const FLEET_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const SHOP_ITEMS = { 'volt-core': 60, phantom: 70 };

let pool;

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }));
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.MANUS_JWT_SECRET || 'neon-fleet-development-secret').update(value).digest('base64url');
}

function encodeSession(openId) {
  const payload = Buffer.from(JSON.stringify({ openId, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodeSession(value) {
  if (!value) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature || sign(payload) !== signature) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.exp > Date.now() ? parsed : null;
  } catch { return null; }
}

function decodeJwt(value) {
  if (!value) return null;
  try {
    const [header, payload, signature] = value.split('.');
    if (!header || !payload || !signature || sign(`${header}.${payload}`) !== signature) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.exp && parsed.exp * 1000 < Date.now()) return null;
    if (parsed.appId && process.env.MANUS_PROJECT_ID && parsed.appId !== process.env.MANUS_PROJECT_ID) return null;
    return parsed;
  } catch { return null; }
}

function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0];
  return `${proto}://${host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || `oauth_${response.status}`);
  return data;
}

async function ensureDatabase() {
  pool = mysql.createPool(process.env.DATABASE_URL || process.env.DRIZZLE_DATABASE_URL);
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      open_id VARCHAR(191) NOT NULL UNIQUE,
      username VARCHAR(32) NOT NULL UNIQUE,
      display_name VARCHAR(128) NOT NULL,
      email VARCHAR(191) NULL,
      avatar_url TEXT NULL,
      coins INT NOT NULL DEFAULT 1045,
      subscription_until DATETIME NULL,
      unlocked_level INT NOT NULL DEFAULT 1,
      next_unlock_at DATETIME NULL,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      total_shots INT NOT NULL DEFAULT 0,
      total_hits INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS friendships (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      requester_id BIGINT UNSIGNED NOT NULL,
      addressee_id BIGINT UNSIGNED NOT NULL,
      status ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_friend_pair (requester_id, addressee_id),
      INDEX (addressee_id),
      CONSTRAINT fk_friend_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_friend_addressee FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS purchases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      item_key VARCHAR(64) NOT NULL,
      price INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX (user_id),
      CONSTRAINT fk_purchase_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS matches (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(12) NOT NULL UNIQUE,
      host_id BIGINT UNSIGNED NOT NULL,
      guest_id BIGINT UNSIGNED NULL,
      host_fleet TEXT NULL,
      guest_fleet TEXT NULL,
      host_shots TEXT NOT NULL,
      guest_shots TEXT NOT NULL,
      status ENUM('waiting','active','finished') NOT NULL DEFAULT 'waiting',
      turn_user_id BIGINT UNSIGNED NULL,
      winner_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX (host_id), INDEX (guest_id),
      CONSTRAINT fk_match_host FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_match_guest FOREIGN KEY (guest_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const statement of statements) await pool.query(statement);
}

function makeUsername(name, openId) {
  const base = String(name || 'captain').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '').slice(0, 20) || 'captain';
  return `${base}_${crypto.createHash('sha1').update(openId).digest('hex').slice(0, 5)}`.slice(0, 32);
}

async function upsertUser(identity) {
  const openId = String(identity.openId || identity.sub || identity.id || '');
  if (!openId) throw new Error('oauth_identity_missing');
  const name = String(identity.name || identity.displayName || identity.email || 'Neon Captain').slice(0, 128);
  const email = identity.email ? String(identity.email).slice(0, 191) : null;
  const avatarUrl = identity.avatarUrl || identity.avatar || null;
  const [existing] = await pool.query('SELECT * FROM users WHERE open_id = ?', [openId]);
  if (existing.length) {
    await pool.query('UPDATE users SET display_name = ?, email = COALESCE(?, email), avatar_url = COALESCE(?, avatar_url) WHERE id = ?', [name, email, avatarUrl, existing[0].id]);
    return { ...existing[0], display_name: name, email: email || existing[0].email, avatar_url: avatarUrl || existing[0].avatar_url };
  }
  let username = makeUsername(name, openId);
  const [same] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (same.length) username = `${username.slice(0, 25)}_${Date.now().toString().slice(-6)}`;
  const [result] = await pool.query('INSERT INTO users (open_id, username, display_name, email, avatar_url) VALUES (?, ?, ?, ?, ?)', [openId, username, name, email, avatarUrl]);
  const [created] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  return created[0];
}

async function userFromRequest(req) {
  const cookies = parseCookies(req);
  const ownSession = decodeSession(cookies[SESSION_COOKIE]);
  if (ownSession?.openId) {
    const [rows] = await pool.query('SELECT * FROM users WHERE open_id = ?', [ownSession.openId]);
    if (rows.length) return rows[0];
  }
  const previewJwt = decodeJwt(cookies[PREVIEW_COOKIE]);
  if (previewJwt) {
    const openId = previewJwt.openId || previewJwt.open_id || previewJwt.sub || previewJwt.userId;
    if (openId) {
      return upsertUser({ openId, name: previewJwt.name, email: previewJwt.email });
    }
  }
  return null;
}

async function requireUser(req, res) {
  const user = await userFromRequest(req);
  if (!user) { json(res, 401, { error: 'auth_required' }); return null; }
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.display_name, email: user.email, avatarUrl: user.avatar_url, coins: user.coins, subscriptionUntil: user.subscription_until, unlockedLevel: user.unlocked_level, nextUnlockAt: user.next_unlock_at, wins: user.wins, losses: user.losses, totalShots: user.total_shots, totalHits: user.total_hits };
}

function activeSubscription(user) {
  return user.subscription_until && new Date(user.subscription_until).getTime() > Date.now();
}

function levelData(user) {
  const subscribed = activeSubscription(user);
  const nextTime = user.next_unlock_at ? new Date(user.next_unlock_at).getTime() : null;
  return [1, 2, 3, 4].map((level) => ({ level, unlocked: subscribed || level <= user.unlocked_level || (level === user.unlocked_level + 1 && nextTime && Date.now() >= nextTime), subscribed, nextUnlockAt: user.next_unlock_at }));
}

function parseFleet(value) { try { return JSON.parse(value || '[]'); } catch { return []; } }
function parseShots(value) { try { return JSON.parse(value || '[]'); } catch { return []; } }
function validFleet(fleet) {
  if (!Array.isArray(fleet) || fleet.length !== FLEET_LENGTHS.length) return false;
  const all = fleet.flatMap((ship) => Array.isArray(ship.positions) ? ship.positions : []);
  return fleet.every((ship, index) => Array.isArray(ship.positions) && ship.positions.length === FLEET_LENGTHS[index] && ship.positions.every((position) => Number.isInteger(position) && position >= 0 && position < 100)) && new Set(all).size === all.length;
}
function matchPlayerSide(match, userId) { return Number(match.host_id) === Number(userId) ? 'host' : Number(match.guest_id) === Number(userId) ? 'guest' : null; }
function matchView(match, userId) {
  const side = matchPlayerSide(match, userId);
  const myFleet = side === 'host' ? parseFleet(match.host_fleet) : parseFleet(match.guest_fleet);
  const opponentFleet = side === 'host' ? parseFleet(match.guest_fleet) : parseFleet(match.host_fleet);
  const myShots = side === 'host' ? parseShots(match.host_shots) : parseShots(match.guest_shots);
  const shotsOnMe = side === 'host' ? parseShots(match.guest_shots) : parseShots(match.host_shots);
  const view = { code: match.code, status: match.status, side, hostId: match.host_id, guestId: match.guest_id, turnUserId: match.turn_user_id, winnerId: match.winner_id, myFleet, myShots, shotsOnMe, opponentReady: opponentFleet.length > 0, myFleetReady: myFleet.length > 0 };
  if (match.status === 'finished') view.opponentFleet = opponentFleet;
  return view;
}

async function api(req, res, pathname, query) {
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { user: publicUser(await userFromRequest(req)) });
  if (pathname === '/auth/login' && req.method === 'GET') {
    const redirectUri = `${getOrigin(req)}/auth/callback`;
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = Buffer.from(JSON.stringify({ redirectUri, nonce })).toString('base64url');
    const location = new URL(`${process.env.MANUS_OAUTH_PORTAL_URL}/app-auth`);
    location.searchParams.set('appId', process.env.MANUS_PROJECT_ID);
    location.searchParams.set('redirectUri', redirectUri);
    location.searchParams.set('state', state);
    location.searchParams.set('responseType', 'code');
    return redirect(res, location.toString(), { 'Set-Cookie': `neon_fleet_oauth=${encodeURIComponent(`${nonce}.${state}`)}; Max-Age=600; ${COOKIE_BASE}` });
  }
  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const cookies = parseCookies(req);
      const stored = cookies.neon_fleet_oauth || '';
      const received = String(query.get('state') || '');
      const code = String(query.get('code') || '');
      const decoded = JSON.parse(Buffer.from(received, 'base64url').toString('utf8'));
      if (!code || !stored.startsWith(`${decoded.nonce}.`) || !stored.endsWith(received)) throw new Error('oauth_state_mismatch');
      const token = await fetchJson(`${process.env.MANUS_OAUTH_API_URL}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: process.env.MANUS_PROJECT_ID, grantType: 'authorization_code', code, redirectUri: decoded.redirectUri }) });
      const identity = await fetchJson(`${process.env.MANUS_OAUTH_API_URL}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.accessToken}` }, body: JSON.stringify({ accessToken: token.accessToken }) });
      const user = await upsertUser(identity);
      return redirect(res, `${getOrigin(req)}/#account`, { 'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(user.open_id))}; Max-Age=2592000; ${COOKIE_BASE}` });
    } catch (error) { return text(res, 400, `OAuth login failed: ${error.message}`); }
  }
  if (pathname === '/auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; ${COOKIE_BASE}` });

  const user = await requireUser(req, res);
  if (!user) return;

  if (pathname === '/api/progress' && req.method === 'GET') return json(res, 200, { user: publicUser(user), levels: levelData(user) });
  if (pathname === '/api/profile' && req.method === 'PATCH') {
    const body = await readBody(req);
    const displayName = String(body.displayName || '').trim().slice(0, 128);
    if (displayName.length < 2) return json(res, 400, { error: 'display_name_too_short' });
    await pool.query('UPDATE users SET display_name = ? WHERE id = ?', [displayName, user.id]);
    return json(res, 200, { user: publicUser({ ...user, display_name: displayName }) });
  }
  if (pathname === '/api/progress/complete' && req.method === 'POST') {
    const body = await readBody(req);
    const level = Math.max(1, Math.min(4, Number(body.level || 1)));
    const shots = Math.max(0, Math.min(1000, Number(body.shots || 0)));
    const hits = Math.max(0, Math.min(shots, Number(body.hits || 0)));
    const subscribed = activeSubscription(user);
    const nextLevel = Math.max(user.unlocked_level, level + 1);
    const nextUnlockAt = subscribed || nextLevel > 4 ? null : new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET wins = wins + 1, coins = coins + 200, total_shots = total_shots + ?, total_hits = total_hits + ?, unlocked_level = ?, next_unlock_at = ? WHERE id = ?', [shots, hits, Math.min(4, nextLevel), nextUnlockAt, user.id]);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [user.id]);
    return json(res, 200, { user: publicUser(rows[0]), levels: levelData(rows[0]), reward: 200 });
  }
  if (pathname === '/api/subscription/demo' && req.method === 'POST') {
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET subscription_until = ?, unlocked_level = 4, next_unlock_at = NULL WHERE id = ?', [until, user.id]);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [user.id]);
    return json(res, 200, { user: publicUser(rows[0]), levels: levelData(rows[0]), demo: true });
  }
  if (pathname === '/api/shop/purchase' && req.method === 'POST') {
    const body = await readBody(req);
    const itemKey = String(body.itemKey || '');
    const price = SHOP_ITEMS[itemKey];
    if (!price) return json(res, 400, { error: 'item_not_found' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [user.id]);
      if (!rows[0] || rows[0].coins < price) { await connection.rollback(); return json(res, 400, { error: 'insufficient_coins' }); }
      await connection.query('UPDATE users SET coins = coins - ? WHERE id = ?', [price, user.id]);
      await connection.query('INSERT INTO purchases (user_id, item_key, price) VALUES (?, ?, ?)', [user.id, itemKey, price]);
      await connection.commit();
      const [updated] = await pool.query('SELECT * FROM users WHERE id = ?', [user.id]);
      return json(res, 200, { user: publicUser(updated[0]), itemKey });
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  if (pathname === '/api/users/search' && req.method === 'GET') {
    const q = String(query.get('q') || '').trim();
    if (q.length < 2) return json(res, 200, { users: [] });
    const [rows] = await pool.query('SELECT id, username, display_name, avatar_url FROM users WHERE id <> ? AND (username LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT 20', [user.id, `%${q}%`, `%${q}%`]);
    return json(res, 200, { users: rows.map((item) => ({ id: item.id, username: item.username, displayName: item.display_name, avatarUrl: item.avatar_url })) });
  }
  if (pathname === '/api/friends' && req.method === 'GET') {
    const [rows] = await pool.query(`SELECT f.id, f.status, f.requester_id, f.addressee_id, u.id AS user_id, u.username, u.display_name, u.avatar_url
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY f.created_at DESC`, [user.id, user.id, user.id]);
    const friends = rows.map((item) => ({ id: item.id, status: item.status, direction: Number(item.requester_id) === Number(user.id) ? 'outgoing' : 'incoming', user: { id: item.user_id, username: item.username, displayName: item.display_name, avatarUrl: item.avatar_url } }));
    return json(res, 200, { friends });
  }
  if (pathname === '/api/friends/request' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.username || '').trim();
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [target]);
    if (!rows.length || Number(rows[0].id) === Number(user.id)) return json(res, 404, { error: 'user_not_found' });
    const [existing] = await pool.query('SELECT id, status FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', [user.id, rows[0].id, rows[0].id, user.id]);
    if (existing.length) return json(res, 409, { error: 'friend_request_exists' });
    await pool.query('INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)', [user.id, rows[0].id]);
    return json(res, 201, { ok: true });
  }
  if (pathname === '/api/friends/respond' && req.method === 'POST') {
    const body = await readBody(req);
    const status = body.accept ? 'accepted' : 'declined';
    const [result] = await pool.query('UPDATE friendships SET status = ? WHERE id = ? AND addressee_id = ?', [status, Number(body.friendshipId), user.id]);
    return json(res, result.affectedRows ? 200 : 404, { ok: Boolean(result.affectedRows) });
  }
  if (pathname === '/api/matches' && req.method === 'POST') {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query('INSERT INTO matches (code, host_id, host_shots, guest_shots) VALUES (?, ?, ?, ?)', [code, user.id, '[]', '[]']);
    const [rows] = await pool.query('SELECT * FROM matches WHERE code = ?', [code]);
    return json(res, 201, { match: matchView(rows[0], user.id) });
  }
  if (pathname === '/api/matches/join' && req.method === 'POST') {
    const body = await readBody(req);
    const [rows] = await pool.query('SELECT * FROM matches WHERE code = ? AND status = \'waiting\'', [String(body.code || '').toUpperCase()]);
    if (!rows.length) return json(res, 404, { error: 'match_not_found' });
    if (Number(rows[0].host_id) === Number(user.id)) return json(res, 400, { error: 'cannot_join_own_match' });
    await pool.query('UPDATE matches SET guest_id = ? WHERE id = ?', [user.id, rows[0].id]);
    const [updated] = await pool.query('SELECT * FROM matches WHERE id = ?', [rows[0].id]);
    return json(res, 200, { match: matchView(updated[0], user.id) });
  }
  const matchMatch = pathname.match(/^\/api\/matches\/([A-Z0-9]+)(?:\/(fleet|shot))?$/);
  if (matchMatch) {
    const code = matchMatch[1];
    const action = matchMatch[2];
    const [rows] = await pool.query('SELECT * FROM matches WHERE code = ?', [code]);
    if (!rows.length) return json(res, 404, { error: 'match_not_found' });
    let match = rows[0];
    const side = matchPlayerSide(match, user.id);
    if (!side) return json(res, 403, { error: 'not_match_player' });
    if (!action && req.method === 'GET') return json(res, 200, { match: matchView(match, user.id) });
    if (action === 'fleet' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!validFleet(body.fleet)) return json(res, 400, { error: 'invalid_fleet' });
      const column = side === 'host' ? 'host_fleet' : 'guest_fleet';
      await pool.query(`UPDATE matches SET ${column} = ? WHERE id = ?`, [JSON.stringify(body.fleet), match.id]);
      const [updatedRows] = await pool.query('SELECT * FROM matches WHERE id = ?', [match.id]);
      match = updatedRows[0];
      if (match.host_fleet && match.guest_fleet && match.status === 'waiting') {
        await pool.query('UPDATE matches SET status = \'active\', turn_user_id = host_id WHERE id = ?', [match.id]);
        const [activeRows] = await pool.query('SELECT * FROM matches WHERE id = ?', [match.id]);
        match = activeRows[0];
      }
      return json(res, 200, { match: matchView(match, user.id) });
    }
    if (action === 'shot' && req.method === 'POST') {
      const body = await readBody(req);
      const position = Number(body.position);
      if (!Number.isInteger(position) || position < 0 || position >= 100) return json(res, 400, { error: 'invalid_position' });
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [locked] = await connection.query('SELECT * FROM matches WHERE id = ? FOR UPDATE', [match.id]);
        match = locked[0];
        if (match.status !== 'active' || Number(match.turn_user_id) !== Number(user.id)) { await connection.rollback(); return json(res, 409, { error: 'not_your_turn' }); }
        const shotColumn = side === 'host' ? 'host_shots' : 'guest_shots';
        const shots = side === 'host' ? parseShots(match.host_shots) : parseShots(match.guest_shots);
        if (shots.includes(position)) { await connection.rollback(); return json(res, 409, { error: 'already_shot' }); }
        const opponentFleet = side === 'host' ? parseFleet(match.guest_fleet) : parseFleet(match.host_fleet);
        const hit = opponentFleet.some((ship) => ship.positions.includes(position));
        shots.push(position);
        const allOpponentPositions = opponentFleet.flatMap((ship) => ship.positions);
        const destroyed = allOpponentPositions.length > 0 && allOpponentPositions.every((cell) => shots.includes(cell));
        const updates = destroyed ? { status: 'finished', winner_id: user.id, turn_user_id: null } : { turn_user_id: hit ? user.id : (side === 'host' ? match.guest_id : match.host_id) };
        await connection.query(`UPDATE matches SET ${shotColumn} = ?, status = ?, winner_id = ?, turn_user_id = ? WHERE id = ?`, [JSON.stringify(shots), updates.status || match.status, updates.winner_id || null, updates.turn_user_id || null, match.id]);
        await connection.commit();
        const [updatedRows] = await pool.query('SELECT * FROM matches WHERE id = ?', [match.id]);
        return json(res, 200, { result: hit ? 'hit' : 'miss', sunkAll: destroyed, match: matchView(updatedRows[0], user.id) });
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    }
  }
  return json(res, 404, { error: 'not_found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(requested).replace(/^\/+/, '');
  if (safe.includes('..')) return text(res, 403, 'Forbidden');
  const file = path.join(ROOT, safe);
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return text(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  } catch { text(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) await api(req, res, url.pathname, url.searchParams);
    else await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
  }
});

ensureDatabase().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Neon Fleet server listening on ${PORT}`))).catch((error) => { console.error('Database initialization failed', error); process.exit(1); });

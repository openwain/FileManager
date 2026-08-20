'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PASSWORDS_PATH = path.join(ROOT, 'xyy_password.txt');
const DATA_DIR = path.join(ROOT, 'data');
const STORAGE_ROOT = path.join(ROOT, 'storage');
const USERS_ROOT = path.join(DATA_DIR, 'users');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const TRASH_ROOT = path.join(DATA_DIR, 'trash');
const TRASH_INDEX_PATH = path.join(DATA_DIR, 'trash.json');
const SHARES_PATH = path.join(DATA_DIR, 'shares.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.json');
const UPLOAD_ATTRIBUTIONS_PATH = path.join(DATA_DIR, 'upload-attributions.json');

const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const config = {
  ...fileConfig,
  host: process.env.LANTERN_HOST || fileConfig.host,
  port: Number(process.env.LANTERN_PORT || fileConfig.port)
};
if (!config.username || !config.password || config.password === 'change-me-now') {
  console.error('Please set a unique username and password in config.json before starting.');
  process.exit(1);
}

function loadAccounts() {
  const result = new Map([[config.username, config.password]]);
  const storageNames = new Map([[config.username.normalize('NFKC').toLocaleLowerCase('en-US'), config.username]]);
  if (!fs.existsSync(PASSWORDS_PATH)) return result;
  const lines = fs.readFileSync(PASSWORDS_PATH, 'utf8').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    const username = separator === -1 ? '' : line.slice(0, separator).trim();
    const password = separator === -1 ? '' : line.slice(separator + 1).trim();
    const invalidUsername = !username || username === '.' || username === '..' || /[<>:"/\\|?*\u0000-\u001f]/u.test(username) || /[. ]$/u.test(username) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(username);
    if (invalidUsername || !password) throw new Error(`Invalid account at xyy_password.txt line ${index + 1}`);
    const storageName = username.normalize('NFKC').toLocaleLowerCase('en-US');
    const conflictingUsername = storageNames.get(storageName);
    if (conflictingUsername) throw new Error(`Account name conflict: "${username}" and "${conflictingUsername}" resolve to the same storage name`);
    storageNames.set(storageName, username);
    if (username !== config.username) result.set(username, password);
  }
  return result;
}

const accounts = loadAccounts();

const sessionSecret = crypto.createHash('sha256')
  .update(`${config.username}\0${config.password}\0lantern-v1`)
  .digest();
const sessions = new Map();
const captchas = new Map();
const loginAttempts = new Map();
let trashEntries = [];
let shares = [];
let auditEntries = [];
let uploadAttributions = [];
const sessionDays = Math.max(1, Number(config.sessionDays) || 365);
const maxUploadMb = Math.max(1, Number(config.maxUploadMb) || 2048);
const maxUploadBytes = maxUploadMb * 1024 * 1024;
const maxUploadLabel = maxUploadMb % 1024 === 0 ? `${maxUploadMb / 1024} GB` : `${maxUploadMb} MB`;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_LOGIN_ATTEMPTS = Math.max(1, Number(config.maxLoginAttempts) || 5);
const LOGIN_WINDOW_MS = Math.max(1, Number(config.loginWindowMinutes) || 15) * 60 * 1000;
const RECENT_RESULT_LIMIT = 200;
const RECENT_SCAN_LIMIT = Math.max(RECENT_RESULT_LIMIT, Number(config.recentScanLimit) || 2000);
const SEARCH_SCAN_LIMIT = Math.max(RECENT_RESULT_LIMIT, Number(config.searchScanLimit) || 5000);
const TRASH_RETENTION_DAYS = Math.max(1, Number(config.trashRetentionDays) || 30);
let persistenceQueue = Promise.resolve();
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function randomId(size = 24) {
  return crypto.randomBytes(size).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function pruneExpiringEntries() {
  const now = Date.now();
  for (const [id, captcha] of captchas) if (captcha.expires <= now) captchas.delete(id);
  for (const [ip, attempts] of loginAttempts) {
    const active = attempts.filter((time) => time > now - LOGIN_WINDOW_MS);
    if (active.length) loginAttempts.set(ip, active); else loginAttempts.delete(ip);
  }
}

function loginRetryAfter(ip) {
  pruneExpiringEntries();
  const attempts = loginAttempts.get(ip) || [];
  if (attempts.length < MAX_LOGIN_ATTEMPTS) return 0;
  return Math.max(1, Math.ceil((attempts[0] + LOGIN_WINDOW_MS - Date.now()) / 1000));
}

function recordFailedLogin(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts.filter((time) => time > Date.now() - LOGIN_WINDOW_MS));
}

function clearFailedLogins(ip) {
  loginAttempts.delete(ip);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

function setCookie(res, value, maxAge = sessionDays * 86400) {
  res.setHeader('Set-Cookie', `lantern_session=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function cleanRelative(input = '') {
  const normal = path.posix.normalize(`/${String(input).replaceAll('\\', '/')}`).slice(1);
  if (normal === '..' || normal.startsWith('../') || normal.includes('\0')) throw new Error('Invalid path');
  return normal === '.' ? '' : normal;
}

function userBase(username) {
  if (!accounts.has(username)) throw new Error('Unknown account');
  return username === config.username ? STORAGE_ROOT : path.join(USERS_ROOT, username, 'files');
}

function userTrashRoot(username) {
  return username === config.username ? TRASH_ROOT : path.join(USERS_ROOT, username, 'trash');
}

async function ensureUserSpace(username) {
  await fsp.mkdir(userBase(username), { recursive: true });
  await fsp.mkdir(userTrashRoot(username), { recursive: true });
}

async function storageStats(username) {
  const stats = await fsp.statfs(userBase(username));
  const blockSize = Number(stats.bsize);
  const total = Number(stats.blocks) * blockSize;
  const free = Number(stats.bavail) * blockSize;
  const used = Math.max(0, total - free);
  return { total, free, used, usedPercent: total ? Math.min(100, Math.max(0, (used / total) * 100)) : 0 };
}

function diskPath(relative = '', username = config.username) {
  const base = userBase(username);
  const resolved = path.resolve(base, cleanRelative(relative));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error('Invalid path');
  return resolved;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip'
  })[ext] || 'application/octet-stream';
}

function previewable(filePath) {
  return ['.txt', '.md', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(path.extname(filePath).toLowerCase());
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function zipHeader(signature, length) {
  const buffer = Buffer.alloc(length);
  buffer.writeUInt32LE(signature, 0);
  return buffer;
}

function makeZipEntry(name, data, offset) {
  const filename = Buffer.from(name, 'utf8');
  const checksum = crc32(data);
  const local = zipHeader(0x04034b50, 30 + filename.length);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  const central = zipHeader(0x02014b50, 46 + filename.length);
  central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
  filename.copy(central, 46);
  return { local, central };
}

async function collectArchiveEntries(relative, entries, seen, username) {
  const clean = cleanRelative(relative);
  if (!clean) throw new Error('Storage root cannot be archived');
  const target = diskPath(clean, username);
  const stats = await fsp.stat(target);
  if (stats.isDirectory()) {
    const directoryName = `${clean}/`;
    if (!seen.has(directoryName)) { seen.add(directoryName); entries.push({ name: directoryName, data: Buffer.alloc(0) }); }
    const children = await fsp.readdir(target, { withFileTypes: true });
    for (const child of children) await collectArchiveEntries(`${clean}/${child.name}`, entries, seen, username);
    return;
  }
  if (!stats.isFile()) return;
  if (stats.size > MAX_ARCHIVE_BYTES) throw new Error('A selected file exceeds the 250 MB archive limit');
  const data = await fsp.readFile(target);
  const name = clean;
  if (!seen.has(name)) { seen.add(name); entries.push({ name, data }); }
}

async function buildZip(paths, username) {
  const entries = []; const seen = new Set();
  for (const item of paths) await collectArchiveEntries(item, entries, seen, username);
  let total = 0;
  for (const entry of entries) { total += entry.data.length; if (total > MAX_ARCHIVE_BYTES) throw new Error('Selected items exceed the 250 MB archive limit'); }
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) { const zipEntry = makeZipEntry(entry.name, entry.data, offset); locals.push(zipEntry.local, entry.data); centrals.push(zipEntry.central); offset += zipEntry.local.length + entry.data.length; }
  const centralDirectory = Buffer.concat(centrals);
  const ending = zipHeader(0x06054b50, 22);
  ending.writeUInt16LE(entries.length, 8); ending.writeUInt16LE(entries.length, 10); ending.writeUInt32LE(centralDirectory.length, 12); ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, ending]);
}

async function collectArchiveEntriesFromAbsolute(target, archiveName, entries, seen) {
  const stats = await fsp.stat(target);
  if (stats.isDirectory()) {
    const directoryName = `${archiveName.replace(/\/$/u, '')}/`;
    if (!seen.has(directoryName)) { seen.add(directoryName); entries.push({ name: directoryName, data: Buffer.alloc(0) }); }
    const children = await fsp.readdir(target, { withFileTypes: true });
    for (const child of children) await collectArchiveEntriesFromAbsolute(path.join(target, child.name), `${directoryName}${child.name}`, entries, seen);
    return;
  }
  if (!stats.isFile()) return;
  if (stats.size > MAX_ARCHIVE_BYTES) throw new Error('A selected file exceeds the 250 MB archive limit');
  if (!seen.has(archiveName)) { seen.add(archiveName); entries.push({ name: archiveName, data: await fsp.readFile(target) }); }
}

async function buildMixedZip(items, username) {
  const entries = []; const seen = new Set();
  for (const item of items) {
    if (item.kind === 'shared') {
      const share = findShareForRecipient(item.id, username);
      const sourceRelative = sharePath(share, item.path || '');
      await collectArchiveEntriesFromAbsolute(diskPath(sourceRelative, share.owner), path.posix.basename(sourceRelative), entries, seen);
    } else {
      const relative = cleanRelative(item.path);
      await collectArchiveEntriesFromAbsolute(diskPath(relative, username), relative, entries, seen);
    }
  }
  let total = 0;
  for (const entry of entries) { total += entry.data.length; if (total > MAX_ARCHIVE_BYTES) throw new Error('Selected items exceed the 250 MB archive limit'); }
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) { const zipEntry = makeZipEntry(entry.name, entry.data, offset); locals.push(zipEntry.local, entry.data); centrals.push(zipEntry.central); offset += zipEntry.local.length + entry.data.length; }
  const centralDirectory = Buffer.concat(centrals); const ending = zipHeader(0x06054b50, 22);
  ending.writeUInt16LE(entries.length, 8); ending.writeUInt16LE(entries.length, 10); ending.writeUInt32LE(centralDirectory.length, 12); ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, ending]);
}

async function existsPath(relative, username) {
  try { return await fsp.stat(diskPath(relative, username)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function uniqueRelativePath(relative, username) {
  const clean = cleanRelative(relative);
  const directory = path.posix.dirname(clean);
  const extension = path.posix.extname(clean);
  const base = path.posix.basename(clean, extension);
  for (let index = 1; index < 1000; index += 1) {
    const candidateName = `${base} (${index})${extension}`;
    const candidate = directory === '.' ? candidateName : path.posix.join(directory, candidateName);
    if (!await existsPath(candidate, username)) return candidate;
  }
  throw new Error('Unable to create a copy name');
}

async function uploadConflicts(targetPath, names, username) {
  const target = cleanRelative(targetPath || '');
  const conflicts = [];
  const copies = {};
  for (const rawName of names) {
    const name = cleanRelative(rawName);
    if (!name) continue;
    const relative = path.posix.join(target, name);
    const stats = await existsPath(relative, username);
    if (!stats) continue;
    conflicts.push({ name, path: relative, type: stats.isDirectory() ? 'folder' : 'file' });
    copies[name] = path.posix.relative(target || '.', await uniqueRelativePath(relative, username)).replaceAll('\\', '/');
  }
  return { conflicts, copies };
}

async function removeCreatedEmptyDirectories(deepestDirectory, firstCreatedDirectory) {
  if (!firstCreatedDirectory) return;
  const boundary = path.toNamespacedPath(path.resolve(firstCreatedDirectory));
  let current = path.toNamespacedPath(path.resolve(deepestDirectory));
  const comparePath = (value) => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const comparableBoundary = comparePath(boundary);
  const comparableCurrent = comparePath(current);
  if (comparableCurrent !== comparableBoundary && !comparableCurrent.startsWith(`${comparableBoundary}${path.sep}`)) return;
  while (true) {
    try {
      await fsp.rmdir(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A concurrent cleanup may already have removed this directory.
      } else if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        return;
      } else {
        throw error;
      }
    }
    if (comparePath(current) === comparableBoundary) return;
    current = path.dirname(current);
  }
}

async function streamUpload(req, targetPath, relativeName, username, mode = 'error') {
  const cleanName = cleanRelative(relativeName);
  if (!cleanName) throw new Error('Invalid upload path');
  let finalRelative = path.posix.join(targetPath, cleanName);
  if (!['error', 'replace', 'copy'].includes(mode)) throw new Error('Invalid upload mode');
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > maxUploadBytes) throw new Error(`File exceeds the ${maxUploadLabel} upload limit`);
  const originalExisting = await existsPath(finalRelative, username);
  if (mode === 'copy' && originalExisting) finalRelative = await uniqueRelativePath(finalRelative, username);
  const finalExisting = finalRelative === path.posix.join(targetPath, cleanName) ? originalExisting : await existsPath(finalRelative, username);
  if (finalExisting?.isDirectory()) throw new Error('A folder with the same name already exists');
  if (finalExisting && mode !== 'replace') throw new Error('A file with the same name already exists');
  const destination = diskPath(finalRelative, username);
  const destinationDirectory = path.dirname(destination);
  const firstCreatedDirectory = await fsp.mkdir(destinationDirectory, { recursive: true });
  const temporary = `${destination}.${randomId(8)}.uploading`;
  let received = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; if (received > maxUploadBytes) callback(new Error(`File exceeds the ${maxUploadLabel} upload limit`)); else callback(null, chunk); } });
  try {
    await pipeline(req, limiter, fs.createWriteStream(temporary, { flags: 'wx' }));
    if (mode === 'replace') await fsp.rm(destination, { force: true });
    await fsp.rename(temporary, destination);
    return { size: received, path: path.posix.relative(cleanRelative(targetPath || '') || '.', finalRelative).replaceAll('\\', '/') };
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    await removeCreatedEmptyDirectories(destinationDirectory, firstCreatedDirectory).catch(() => {});
    throw error;
  }
}

async function prepareUploadReplace(targetPath, names, username) {
  const target = cleanRelative(targetPath || '');
  let count = 0;
  for (const rawName of names) {
    const name = cleanRelative(rawName);
    if (!name || path.posix.basename(name) !== name) throw new Error('Invalid upload conflict name');
    const full = diskPath(path.posix.join(target, name), username);
    await fsp.rm(full, { recursive: true, force: true });
    takeUploadAttributions(username, path.posix.join(target, name));
    count += 1;
  }
  await persistUploadAttributions();
  return count;
}

async function atomicWrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomId(6)}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function queuePersistence(write) {
  const task = persistenceQueue.then(write);
  persistenceQueue = task.catch((error) => console.error('Failed to persist application data:', error));
  return task;
}

function persistSessions() {
  return queuePersistence(async () => {
    const now = Date.now();
    const active = [...sessions.entries()].filter(([, session]) => session.expires > now);
    sessions.clear();
    for (const [id, session] of active) sessions.set(id, session);
    await atomicWrite(SESSIONS_PATH, JSON.stringify(Object.fromEntries(active)));
  });
}

function persistTrash() {
  return queuePersistence(() => atomicWrite(TRASH_INDEX_PATH, JSON.stringify(trashEntries, null, 2)));
}

function persistShares() {
  return queuePersistence(() => atomicWrite(SHARES_PATH, JSON.stringify(shares, null, 2)));
}

function persistAudit() {
  return queuePersistence(() => atomicWrite(AUDIT_PATH, JSON.stringify(auditEntries, null, 2)));
}

function persistUploadAttributions() {
  return queuePersistence(() => atomicWrite(UPLOAD_ATTRIBUTIONS_PATH, JSON.stringify(uploadAttributions, null, 2)));
}

function workspaceUsernameFor(loginUsername, workspace) {
  return workspace === 'public' && loginUsername !== config.username ? config.username : loginUsername;
}

function sessionPayload(session) {
  const loginUsername = session.loginUsername || session.username || config.username;
  const workspaceUsername = workspaceUsernameFor(loginUsername, session.workspace);
  const publicWorkspace = workspaceUsername === config.username && loginUsername !== config.username;
  return {
    authenticated: true,
    csrf: session.csrf,
    username: loginUsername,
    workspaceUsername,
    publicUsername: config.username,
    publicWorkspace,
    canSwitchWorkspace: loginUsername !== config.username,
    sharingEnabled: sharingEnabled(workspaceUsername),
    maxUploadBytes
  };
}

function addUploadAttributions(entries, owner) {
  if (owner !== config.username || !uploadAttributions.length) return entries;
  const byPath = new Map(uploadAttributions.filter((item) => item.owner === owner).map((item) => [item.path, item]));
  return entries.map((entry) => {
    const attribution = byPath.get(entry.path);
    return attribution ? { ...entry, uploader: attribution.uploader, uploadedAt: attribution.uploadedAt } : entry;
  });
}

async function recordUploadAttribution(owner, relative, uploader) {
  if (owner !== config.username) return;
  const clean = cleanRelative(relative);
  uploadAttributions = uploadAttributions.filter((item) => !(item.owner === owner && item.path === clean));
  uploadAttributions.push({ owner, path: clean, uploader, uploadedAt: Date.now() });
  await persistUploadAttributions();
}

function takeUploadAttributions(owner, relative) {
  if (owner !== config.username) return [];
  const clean = cleanRelative(relative);
  const prefix = `${clean}/`;
  const taken = uploadAttributions.filter((item) => item.owner === owner && (item.path === clean || item.path.startsWith(prefix)));
  if (taken.length) uploadAttributions = uploadAttributions.filter((item) => !taken.includes(item));
  return taken;
}

function rewriteUploadAttributionPaths(owner, previousPath, nextPath) {
  if (owner !== config.username) return false;
  const previous = cleanRelative(previousPath);
  const next = cleanRelative(nextPath);
  const prefix = `${previous}/`;
  let changed = false;
  for (const item of uploadAttributions) {
    if (item.owner !== owner || (item.path !== previous && !item.path.startsWith(prefix))) continue;
    item.path = `${next}${item.path.slice(previous.length)}`;
    changed = true;
  }
  return changed;
}

function recordAudit(action, username, target = '', details = '') {
  auditEntries.push({ time: Date.now(), action, username, target, details });
  if (auditEntries.length > 2000) auditEntries = auditEntries.slice(-2000);
  return persistAudit();
}

function readSession(req) {
  const raw = cookieValue(req, 'lantern_session');
  const [id, signature] = raw.split('.');
  if (!id || !signature || !safeEqual(signature, sign(id))) return null;
  const session = sessions.get(id);
  if (!session || session.expires < Date.now()) return null;
  const loginUsername = session.username || config.username;
  if (!accounts.has(loginUsername)) return null;
  const username = workspaceUsernameFor(loginUsername, session.workspace);
  return { id, ...session, loginUsername, username, publicWorkspace: username === config.username && loginUsername !== config.username };
}

function requireAuth(req, res) {
  const session = readSession(req);
  if (!session) {
    json(res, 401, { error: 'Session expired' });
    return null;
  }
  return session;
}

function requireCsrf(req, res, session) {
  if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) {
    json(res, 403, { error: 'Request verification failed' });
    return false;
  }
  return true;
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) { reject(new Error('Request is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function bodyJson(req) {
  const body = await readBody(req);
  try { return JSON.parse(body.toString('utf8') || '{}'); } catch { throw new Error('Invalid JSON'); }
}

function extractMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(delimiter) + delimiter.length + 2;
  while (start > delimiter.length + 1 && start < buffer.length) {
    const end = buffer.indexOf(delimiter, start);
    if (end === -1) break;
    const part = buffer.subarray(start, end - 2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator !== -1) {
      const header = part.subarray(0, separator).toString('utf8');
      const data = part.subarray(separator + 4);
      const filenameMatch = /filename="([^"]*)"/i.exec(header);
      const nameMatch = /name="([^"]*)"/i.exec(header);
      if (nameMatch) parts.push({ name: nameMatch[1], filename: filenameMatch?.[1], data });
    }
    start = end + delimiter.length + 2;
  }
  return parts;
}

function makeCaptcha(req) {
  pruneExpiringEntries();
  const id = randomId(12);
  const chars = '23456789ABCEFGHJLNPSTUZ';
  const answer = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  captchas.set(id, { answer, ip: clientIp(req), expires: Date.now() + 5 * 60 * 1000 });
  return { id, answer };
}

const CAPTCHA_STROKES = {
  2: 'M3 8C8 2 20 2 24 8C28 14 22 18 16 23L4 41H26',
  3: 'M4 7C11 2 23 3 24 11C25 17 20 20 15 21C22 21 26 25 24 34C22 44 10 44 4 39',
  4: 'M22 43V5L3 29H27M4 29H22',
  5: 'M25 6H7L5 21C14 17 23 20 24 29C26 41 13 44 4 38',
  6: 'M24 8C17 2 6 7 5 23V30C6 44 26 43 25 30C24 19 12 20 5 25',
  7: 'M3 6H27L12 43',
  8: 'M15 4C3 4 3 18 14 21C28 23 27 43 14 43C1 43 1 24 14 21C27 18 27 4 15 4',
  9: 'M24 24C16 30 5 27 5 16C5 2 25 2 25 17V29C24 39 16 44 6 41',
  A: 'M3 43L14 4L27 43M8 28H21',
  B: 'M5 4V43M5 5C27 2 28 20 6 23M6 23C30 21 29 44 5 42',
  C: 'M26 9C21 2 7 4 4 18V30C7 45 21 44 27 38',
  E: 'M25 5H5V43H26M5 24H20',
  F: 'M25 5H5V43M5 24H20',
  G: 'M26 10C21 2 7 4 4 19V30C7 45 22 44 26 37V26H16',
  H: 'M4 4V43M26 4V43M5 24H25',
  J: 'M25 5V33C25 45 5 45 4 36',
  L: 'M5 4V43H26',
  N: 'M4 43V5L26 43V5',
  P: 'M5 43V5C29 1 29 25 5 23',
  S: 'M25 8C18 1 5 4 5 14C5 26 25 20 25 32C25 45 10 44 4 38',
  T: 'M3 5H28M15 5V43',
  U: 'M5 4V32C5 46 25 46 25 32V4',
  Z: 'M4 5H27L4 43H27'
};

function captchaSvg(answer) {
  const letters = [...answer].map((letter, index) => {
    const angle = crypto.randomInt(-13, 14);
    const verticalOffset = crypto.randomInt(-1, 3);
    return `<path d="${CAPTCHA_STROKES[letter]}" transform="translate(${8 + index * 31} ${verticalOffset}) rotate(${angle} 15 24)"/>`;
  }).join('');
  const lines = Array.from({ length: 5 }, () => {
    const startY = crypto.randomInt(7, 47);
    const middleY = crypto.randomInt(7, 47);
    const endY = crypto.randomInt(7, 47);
    return `<path d="M0 ${startY}Q85 ${middleY} 170 ${endY}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="54" viewBox="0 0 170 54"><rect width="170" height="54" rx="8" fill="#f4f0e8"/><g fill="none" stroke="#c1aa87" stroke-width="1.1" opacity=".72">${lines}</g><g fill="none" stroke="#273d59" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${letters}</g></svg>`;
}

async function listDirectory(relative, username) {
  const location = diskPath(relative, username);
  const children = await fsp.readdir(location, { withFileTypes: true });
  const entries = await Promise.all(children.map(async (entry) => {
    const full = path.join(location, entry.name);
    const stats = await fsp.stat(full);
    return { name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, type: entry.isDirectory() ? 'folder' : 'file', size: stats.size, modified: stats.mtimeMs };
  }));
  return addUploadAttributions(entries.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true })), username);
}

async function listFolders(username, relative = '') {
  const clean = cleanRelative(relative || '');
  const location = diskPath(clean, username);
  const children = await fsp.readdir(location, { withFileTypes: true });
  const folders = children
    .filter((child) => child.isDirectory())
    .map((child) => ({ name: child.name, path: clean ? `${clean}/${child.name}` : child.name }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  return { path: clean, name: clean ? path.posix.basename(clean) : '全部文件', folders };
}

async function copyEntry(source, destination) {
  const stats = await fsp.stat(source);
  if (stats.isDirectory()) {
    await fsp.mkdir(destination);
    const children = await fsp.readdir(source, { withFileTypes: true });
    for (const child of children) await copyEntry(path.join(source, child.name), path.join(destination, child.name));
    return;
  }
  if (!stats.isFile()) throw new Error('Only files or folders can be copied');
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function moveEntry(sourceRelative, destinationRelative, username) {
  const sourcePath = cleanRelative(sourceRelative);
  const destinationPath = cleanRelative(destinationRelative || '');
  if (!sourcePath) throw new Error('Storage root cannot be moved');
  if (destinationPath === sourcePath || destinationPath.startsWith(`${sourcePath}/`)) throw new Error('Cannot move an item into itself');
  const source = diskPath(sourcePath, username);
  const destinationFolder = diskPath(destinationPath, username);
  const folderStats = await fsp.stat(destinationFolder);
  if (!folderStats.isDirectory()) throw new Error('Destination must be a folder');
  const finalRelative = path.posix.join(destinationPath, path.posix.basename(sourcePath));
  const finalPath = diskPath(finalRelative, username);
  if (await existsPath(finalRelative, username)) throw new Error('An item with the same name already exists in the destination');
  await fsp.rename(source, finalPath);
  await rewriteSharePaths(username, sourcePath, finalRelative);
  if (rewriteUploadAttributionPaths(username, sourcePath, finalRelative)) await persistUploadAttributions();
  return finalRelative;
}

async function copySharedEntry(shareId, sharedPath, destinationRelative, username) {
  const share = findShareForRecipient(shareId, username);
  const sourceRelative = sharePath(share, sharedPath || '');
  const source = diskPath(sourceRelative, share.owner);
  const destinationPath = cleanRelative(destinationRelative || '');
  const folderStats = await fsp.stat(diskPath(destinationPath, username));
  if (!folderStats.isDirectory()) throw new Error('Destination must be a folder');
  const finalRelative = path.posix.join(destinationPath, path.posix.basename(sourceRelative));
  if (await existsPath(finalRelative, username)) throw new Error('An item with the same name already exists in the destination');
  const finalPath = diskPath(finalRelative, username);
  try {
    await copyEntry(source, finalPath);
  } catch (error) {
    await fsp.rm(finalPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await recordUploadAttribution(username, finalRelative, username);
  return finalRelative;
}

async function listRecent(username = config.username) {
  const pendingDirectories = [''];
  const result = [];
  let scanned = 0;
  let truncated = false;
  while (pendingDirectories.length && scanned < RECENT_SCAN_LIMIT) {
    const relative = pendingDirectories.pop();
    const location = diskPath(relative, username);
    const children = await fsp.readdir(location, { withFileTypes: true });
    const directories = [];
    for (const entry of children) {
      if (scanned >= RECENT_SCAN_LIMIT) { truncated = true; break; }
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      const stats = await fsp.stat(path.join(location, entry.name));
      scanned += 1;
      result.push({ name: entry.name, path: entryPath, location: relative || '根目录', type: entry.isDirectory() ? 'folder' : 'file', size: stats.size, modified: stats.mtimeMs });
      if (entry.isDirectory()) directories.push({ path: entryPath, modified: stats.mtimeMs });
      if (result.length > RECENT_RESULT_LIMIT * 2) result.sort((a, b) => b.modified - a.modified).splice(RECENT_RESULT_LIMIT);
    }
    directories.sort((a, b) => a.modified - b.modified);
    pendingDirectories.push(...directories.map((directory) => directory.path));
    if (truncated) break;
  }
  return { entries: addUploadAttributions(result.sort((a, b) => b.modified - a.modified).slice(0, RECENT_RESULT_LIMIT), username), scanned, truncated: truncated || pendingDirectories.length > 0 };
}

async function searchFiles(query, username, type = 'all', sort = 'modified') {
  const needle = String(query || '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
  if (!needle) return { entries: [], scanned: 0, truncated: false };
  const pendingDirectories = ['']; const results = []; let scanned = 0; let truncated = false;
  while (pendingDirectories.length && scanned < SEARCH_SCAN_LIMIT) {
    const relative = pendingDirectories.pop();
    const location = diskPath(relative, username); const children = await fsp.readdir(location, { withFileTypes: true });
    for (const entry of children) {
      if (scanned >= SEARCH_SCAN_LIMIT) { truncated = true; break; }
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name; const stats = await fsp.stat(path.join(location, entry.name)); scanned += 1;
      if (entry.isDirectory()) pendingDirectories.push(entryPath);
      if ((type === 'all' || type === (entry.isDirectory() ? 'folder' : 'file')) && entry.name.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(needle)) results.push({ name: entry.name, path: entryPath, location: relative || '根目录', type: entry.isDirectory() ? 'folder' : 'file', size: entry.isDirectory() ? 0 : stats.size, modified: stats.mtimeMs });
    }
    if (truncated) break;
  }
  const comparators = { name: (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }), size: (a, b) => b.size - a.size, modified: (a, b) => b.modified - a.modified };
  return { entries: addUploadAttributions(results.sort(comparators[sort] || comparators.modified).slice(0, RECENT_RESULT_LIMIT), username), scanned, truncated: truncated || pendingDirectories.length > 0 };
}

async function moveToTrash(relative, username) {
  const clean = cleanRelative(relative);
  if (!clean) throw new Error('Storage root cannot be deleted');
  const source = diskPath(clean, username);
  const stats = await fsp.stat(source);
  const id = `${Date.now().toString(36)}-${randomId(8)}`;
  const trashPath = path.join(userTrashRoot(username), id);
  await fsp.rename(source, trashPath);
  const attributions = takeUploadAttributions(username, clean);
  const entry = { id, owner: username, name: path.basename(clean), originalPath: clean, type: stats.isDirectory() ? 'folder' : 'file', size: stats.size, modified: stats.mtimeMs, deletedAt: Date.now(), ...(attributions.length ? { attributions } : {}) };
  trashEntries.push(entry);
  return entry;
}

async function restoreTrash(ids, username) {
  for (const id of ids) {
    const index = trashEntries.findIndex((entry) => entry.id === id && (entry.owner || config.username) === username);
    if (index === -1) throw new Error('Trash item no longer exists');
    const entry = trashEntries[index];
    let restorePath = entry.originalPath;
    let destination = diskPath(restorePath, username);
    try { await fsp.access(destination); restorePath = await uniqueRelativePath(entry.originalPath, username); destination = diskPath(restorePath, username); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(path.join(userTrashRoot(username), entry.id), destination);
    for (const attribution of entry.attributions || []) {
      attribution.path = `${restorePath}${attribution.path.slice(entry.originalPath.length)}`;
      uploadAttributions = uploadAttributions.filter((item) => !(item.owner === attribution.owner && item.path === attribution.path));
      uploadAttributions.push(attribution);
    }
    entry.restoredPath = restorePath;
    trashEntries.splice(index, 1);
  }
  await Promise.all([persistTrash(), persistUploadAttributions()]);
}

async function purgeTrash(ids, username) {
  for (const id of ids) {
    const index = trashEntries.findIndex((entry) => entry.id === id && (entry.owner || config.username) === username);
    if (index === -1) continue;
    await fsp.rm(path.join(userTrashRoot(username), id), { recursive: true, force: true });
    trashEntries.splice(index, 1);
  }
  await persistTrash();
}

async function purgeExpiredTrash() {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400000;
  const expired = trashEntries.filter((entry) => entry.deletedAt < cutoff);
  if (!expired.length) return 0;
  for (const entry of expired) await fsp.rm(path.join(userTrashRoot(entry.owner || config.username), entry.id), { recursive: true, force: true });
  trashEntries = trashEntries.filter((entry) => entry.deletedAt >= cutoff);
  await persistTrash();
  return expired.length;
}

function sharingEnabled(username) {
  return username !== config.username;
}

function shareIsActive(entry) {
  return !entry.expiresAt || entry.expiresAt > Date.now();
}

async function sharedFileInfo(entry) {
  try {
    const target = diskPath(entry.sourcePath, entry.owner);
    const stats = await fsp.stat(target);
    if (!stats.isFile() && !stats.isDirectory()) throw new Error('Shared item is not available');
    return { available: true, type: stats.isDirectory() ? 'folder' : 'file', size: stats.isDirectory() ? 0 : stats.size, modified: stats.mtimeMs };
  } catch {
    return { available: false, type: entry.type || 'file', size: 0, modified: entry.createdAt };
  }
}

function findShareForRecipient(id, username) {
  const entry = shares.find((item) => item.id === id && item.recipient === username && shareIsActive(item));
  if (!entry) throw new Error('Shared item no longer exists');
  return entry;
}

function sharePath(entry, relative = '') {
  const nested = cleanRelative(relative || '');
  return nested ? path.posix.join(entry.sourcePath, nested) : entry.sourcePath;
}

async function markShareOverwrite(owner, overwrittenPath, username) {
  let changed = false;
  const cleanPath = cleanRelative(overwrittenPath);
  for (const entry of shares) {
    if (entry.owner !== owner || (cleanPath !== entry.sourcePath && !cleanPath.startsWith(entry.sourcePath + '/'))) continue;
    entry.lastOverwrittenBy = username;
    entry.lastOverwrittenAt = Date.now();
    entry.lastOverwrittenPath = cleanPath === entry.sourcePath ? '' : cleanPath.slice(entry.sourcePath.length + 1);
    changed = true;
  }
  if (changed) await persistShares();
}

async function listSharedDirectory(id, username, relative = '') {
  const entry = findShareForRecipient(id, username);
  const location = diskPath(sharePath(entry, relative), entry.owner);
  const stats = await fsp.stat(location);
  if (!stats.isDirectory()) throw new Error('Shared item is not a folder');
  const children = await fsp.readdir(location, { withFileTypes: true });
  const entries = await Promise.all(children.map(async (child) => {
    const childPath = relative ? `${cleanRelative(relative)}/${child.name}` : child.name;
    const full = path.join(location, child.name);
    const childStats = await fsp.stat(full);
    const overwritten = entry.lastOverwrittenPath === childPath || (child.isDirectory() && entry.lastOverwrittenPath?.startsWith(childPath + '/'));
    return { id: entry.id, path: childPath, name: child.name, type: child.isDirectory() ? 'folder' : 'file', shared: true, sender: entry.sender, owner: entry.owner, canOverwrite: Boolean(entry.canOverwrite), available: true, size: child.isDirectory() ? 0 : childStats.size, modified: childStats.mtimeMs, createdAt: entry.createdAt, lastOverwrittenBy: overwritten ? entry.lastOverwrittenBy : '', lastOverwrittenAt: overwritten ? entry.lastOverwrittenAt : 0 };
  }));
  return { share: { id: entry.id, name: path.posix.basename(entry.sourcePath), sender: entry.sender, owner: entry.owner, canOverwrite: Boolean(entry.canOverwrite) }, path: cleanRelative(relative || ''), entries: entries.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) };
}

async function listSharedFiles(username) {
  const mine = shares.filter((entry) => entry.recipient === username && shareIsActive(entry)).sort((a, b) => b.createdAt - a.createdAt);
  return Promise.all(mine.map(async (entry) => {
    const forwardedRecipients = [...new Set(shares.filter((candidate) => candidate.sender === username && candidate.owner === entry.owner && candidate.sourcePath === entry.sourcePath).map((candidate) => candidate.recipient))];
    return {
      id: entry.id,
      path: entry.id,
      name: path.posix.basename(entry.sourcePath),
      type: 'file',
      shared: true,
      sender: entry.sender,
      owner: entry.owner,
      canOverwrite: Boolean(entry.canOverwrite),
      forwardedRecipients,
      createdAt: entry.createdAt,
      lastOverwrittenBy: entry.lastOverwrittenBy || '',
      lastOverwrittenAt: entry.lastOverwrittenAt || 0,
      expiresAt: entry.expiresAt || 0,
      ...await sharedFileInfo(entry)
    };
  }));
}

async function listSentShares(username) {
  const grouped = new Map();
  for (const entry of shares) {
    if (entry.owner !== username || !shareIsActive(entry)) continue;
    const key = entry.sourcePath;
    if (!grouped.has(key)) grouped.set(key, { entry, recipients: new Set() });
    grouped.get(key).recipients.add(entry.recipient);
  }
  const result = await Promise.all([...grouped.values()].map(async ({ entry, recipients }) => {
    const info = await sharedFileInfo(entry);
    return {
      path: entry.sourcePath,
      name: path.posix.basename(entry.sourcePath),
      type: info.type,
      size: info.size,
      modified: info.modified,
      sharedSent: true,
      owner: username,
      sharedRecipients: [...recipients],
      lastOverwrittenBy: entry.lastOverwrittenBy || '',
      lastOverwrittenAt: entry.lastOverwrittenAt || 0
    };
  }));
  return result.sort((left, right) => right.modified - left.modified);
}

function addOwnedShareStatus(entries, username) {
  for (const entry of entries) {
    const related = shares.filter((share) => share.owner === username && (share.sourcePath === entry.path || entry.path.startsWith(share.sourcePath + '/')));
    entry.sharedRecipients = [...new Set(related.map((share) => share.recipient))];
    const overwritten = related.filter((share) => {
      if (!share.lastOverwrittenBy) return false;
      const overwrittenPath = share.lastOverwrittenPath ? share.sourcePath + '/' + share.lastOverwrittenPath : share.sourcePath;
      return overwrittenPath === entry.path || (entry.type === 'folder' && overwrittenPath.startsWith(entry.path + '/'));
    }).sort((left, right) => (right.lastOverwrittenAt || 0) - (left.lastOverwrittenAt || 0))[0];
    entry.lastOverwrittenBy = overwritten?.lastOverwrittenBy || '';
    entry.lastOverwrittenAt = overwritten?.lastOverwrittenAt || 0;
  }
  return entries;
}

async function rewriteSharePaths(owner, previousPath, nextPath) {
  let changed = false;
  for (const entry of shares) {
    if (entry.owner !== owner || (entry.sourcePath !== previousPath && !entry.sourcePath.startsWith(`${previousPath}/`))) continue;
    entry.sourcePath = `${nextPath}${entry.sourcePath.slice(previousPath.length)}`;
    changed = true;
  }
  if (changed) await persistShares();
}

async function createShares(username, data) {
  if (!sharingEnabled(username)) throw new Error('The shared account cannot send personal shares');
  const recipients = [...new Set(Array.isArray(data.recipients) ? data.recipients : [data.recipient])].filter(Boolean);
  if (!recipients.length) throw new Error('Please select at least one recipient');
  if (recipients.some((recipient) => recipient === username || recipient === config.username || !accounts.has(recipient))) throw new Error('Invalid share recipient');
  let canOverwrite = data.canOverwrite === true;
  const expiresAt = data.expiresAt ? Number(data.expiresAt) : 0;
  if (expiresAt && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error('Share expiration must be in the future');

  let owner = username;
  let sourcePaths = [];
  if (data.shareId) {
    const sourceShare = shares.find((entry) => entry.id === data.shareId && entry.recipient === username);
    if (!sourceShare) throw new Error('Shared file no longer exists');
    owner = sourceShare.owner;
    sourcePaths = [sharePath(sourceShare, data.path || '')];
    canOverwrite = Boolean(sourceShare.canOverwrite) && canOverwrite;
  } else {
    sourcePaths = (Array.isArray(data.paths) ? data.paths : [data.path]).filter(Boolean).map((item) => cleanRelative(item));
  }
  sourcePaths = [...new Set(sourcePaths)].filter(Boolean);
  if (!sourcePaths.length) throw new Error('Invalid file path');

  let count = 0;
  for (const sourcePath of sourcePaths) {
    const source = diskPath(sourcePath, owner);
    const stats = await fsp.stat(source);
    if (!stats.isFile() && !stats.isDirectory()) throw new Error('Only files or folders can be shared');
    const type = stats.isDirectory() ? 'folder' : 'file';
    for (const recipient of recipients) {
      if (recipient === owner) continue;
      const existing = shares.find((entry) => entry.owner === owner && entry.sourcePath === sourcePath && entry.recipient === recipient);
      if (existing) {
        existing.sender = username;
        existing.type = type;
        existing.canOverwrite = canOverwrite;
        existing.expiresAt = expiresAt;
        existing.createdAt = Date.now();
      } else {
        shares.push({ id: `${Date.now().toString(36)}-${randomId(8)}`, owner, sourcePath, type, canOverwrite, sender: username, recipient, expiresAt, createdAt: Date.now() });
      }
      count += 1;
    }
  }
  if (!count) throw new Error('The selected users already own this file');
  await persistShares();
  return count;
}

async function revokeShares(username, data) {
  let remove;
  if (data.shareId) {
    const sourceShare = shares.find((entry) => entry.id === data.shareId && entry.recipient === username);
    if (!sourceShare) throw new Error('Shared file no longer exists');
    remove = (entry) => entry.sender === username && entry.owner === sourceShare.owner && entry.sourcePath === sourceShare.sourcePath;
  } else {
    const sourcePath = cleanRelative(data.path || '');
    if (!sourcePath) throw new Error('Invalid file path');
    remove = (entry) => entry.owner === username && entry.sourcePath === sourcePath;
  }
  const before = shares.length;
  shares = shares.filter((entry) => !remove(entry));
  await persistShares();
  return before - shares.length;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/') {
    const page = await fsp.readFile(path.join(ROOT, 'public', 'index.html'));
    return text(res, 200, page, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/favicon.ico') return text(res, 200, await fsp.readFile(path.join(ROOT, 'favicon.ico')), 'image/x-icon');
  if (req.method === 'GET' && pathname === '/app.css') return text(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'app.css')), 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/file-icons.js') return text(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'file-icons.js')), 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/app.js') return text(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'app.js')), 'text/javascript; charset=utf-8');
  const fileIcon = pathname.match(/^\/icons\/file-types\/([a-z0-9-]+\.svg)$/);
  if (req.method === 'GET' && fileIcon) return text(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'icons', 'file-types', fileIcon[1])), 'image/svg+xml; charset=utf-8');
  if (req.method === 'GET' && pathname === '/api/captcha') {
    const captcha = makeCaptcha(req);
    return json(res, 200, { id: captcha.id, svg: captchaSvg(captcha.answer) });
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    const ip = clientIp(req);
    const retryAfter = loginRetryAfter(ip);
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return json(res, 429, { error: `登录尝试过多，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试` });
    }
    const data = await bodyJson(req);
    const captcha = captchas.get(data.captchaId);
    captchas.delete(data.captchaId);
    const validCaptcha = captcha && captcha.ip === ip && captcha.expires > Date.now() && safeEqual(String(data.captcha || '').toUpperCase(), captcha.answer);
    const username = String(data.username || '');
    const validCredentials = accounts.has(username) && safeEqual(data.password || '', accounts.get(username));
    if (!validCaptcha || !validCredentials) {
      recordFailedLogin(ip);
      return json(res, 401, { error: '用户名、密码或验证码不正确' });
    }
    clearFailedLogins(ip);
    const id = randomId();
    const session = { username, csrf: randomId(), expires: Date.now() + sessionDays * 86400 * 1000 };
    await ensureUserSpace(username);
    sessions.set(id, session);
    await persistSessions();
    await recordAudit('login', username);
    setCookie(res, `${id}.${sign(id)}`);
    return json(res, 200, sessionPayload(session));
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    const current = readSession(req);
    return json(res, 200, current ? sessionPayload(current) : { authenticated: false });
  }
  const session = requireAuth(req, res);
  if (!session) return;
  if (req.method === 'POST' && pathname === '/api/workspace') {
    if (!requireCsrf(req, res, session)) return;
    if (session.loginUsername === config.username) return json(res, 403, { error: '公共账户不能切换到个人工作区' });
    const data = await bodyJson(req);
    if (!['personal', 'public'].includes(data.workspace)) return json(res, 400, { error: '无效的工作区' });
    const storedSession = sessions.get(session.id);
    storedSession.workspace = data.workspace === 'public' ? 'public' : undefined;
    await persistSessions();
    await recordAudit('workspace', session.loginUsername, data.workspace === 'public' ? config.username : session.loginUsername, data.workspace);
    return json(res, 200, sessionPayload({ ...storedSession, loginUsername: session.loginUsername }));
  }
  await ensureUserSpace(session.username);
  if (req.method === 'GET' && pathname === '/api/storage-stats') {
    return json(res, 200, await storageStats(session.username));
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    if (!requireCsrf(req, res, session)) return;
    sessions.delete(session.id); await persistSessions(); setCookie(res, '', 0); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/list') {
    const relative = cleanRelative(url.searchParams.get('path') || '');
    const entries = addOwnedShareStatus(await listDirectory(relative, session.username), session.username);
    if (!relative && sharingEnabled(session.username)) entries.push(...await listSharedFiles(session.username));
    return json(res, 200, { path: relative, entries });
  }
  if (req.method === 'GET' && pathname === '/api/folders') {
    return json(res, 200, await listFolders(session.username, url.searchParams.get('path') || ''));
  }
  if (req.method === 'GET' && pathname === '/api/recent') {
    const recent = await listRecent(session.username);
    recent.entries = addOwnedShareStatus(recent.entries, session.username);
    return json(res, 200, recent);
  }
  if (req.method === 'GET' && pathname === '/api/search') {
    const result = await searchFiles(url.searchParams.get('q'), session.username, url.searchParams.get('type') || 'all', url.searchParams.get('sort') || 'modified');
    result.entries = addOwnedShareStatus(result.entries, session.username);
    return json(res, 200, result);
  }
  if (req.method === 'GET' && pathname === '/api/trash') {
    await purgeExpiredTrash();
    return json(res, 200, { entries: trashEntries.filter((entry) => (entry.owner || config.username) === session.username).sort((a, b) => b.deletedAt - a.deletedAt).map((entry) => ({ ...entry, path: entry.id, modified: entry.deletedAt, location: path.posix.dirname(entry.originalPath) === '.' ? '根目录' : path.posix.dirname(entry.originalPath) })) });
  }
  if (req.method === 'GET' && pathname === '/api/users') {
    const users = sharingEnabled(session.username) ? [...accounts.keys()].filter((username) => username !== config.username && username !== session.username).sort() : [];
    return json(res, 200, { users, sharingEnabled: sharingEnabled(session.username) });
  }
  if (req.method === 'GET' && pathname === '/api/shares') {
    return json(res, 200, { entries: sharingEnabled(session.username) ? await listSharedFiles(session.username) : [] });
  }
  if (req.method === 'GET' && pathname === '/api/shares/sent') {
    return json(res, 200, { entries: sharingEnabled(session.username) ? await listSentShares(session.username) : [] });
  }
  if (req.method === 'GET' && pathname === '/api/shares/list') {
    return json(res, 200, await listSharedDirectory(url.searchParams.get('id') || '', session.username, url.searchParams.get('path') || ''));
  }
  if (req.method === 'GET' && pathname === '/api/shares/download') {
    const entry = findShareForRecipient(url.searchParams.get('id') || '', session.username);
    const relative = url.searchParams.get('path') || '';
    const file = diskPath(sharePath(entry, relative), entry.owner);
    const stats = await fsp.stat(file);
    if (stats.isFile()) {
      res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': stats.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (stats.isDirectory()) {
      const archive = await buildZip([sharePath(entry, relative)], entry.owner);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${path.basename(file)}.zip`)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(archive);
    }
    return json(res, 400, { error: 'Shared file is unavailable' });
  }
  if (req.method === 'GET' && pathname === '/api/shares/preview') {
    const entry = findShareForRecipient(url.searchParams.get('id') || '', session.username);
    const relative = url.searchParams.get('path') || '';
    const file = diskPath(sharePath(entry, relative), entry.owner);
    const stats = await fsp.stat(file);
    if (!stats.isFile() || !previewable(file)) return json(res, 400, { error: 'This shared file cannot be previewed' });
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': stats.size, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'POST' && pathname === '/api/share') {
    if (!requireCsrf(req, res, session)) return;
    const count = await createShares(session.username, await bodyJson(req));
    await recordAudit('share', session.loginUsername, '', `${count} access grants`);
    return json(res, 201, { ok: true, count });
  }
  if (req.method === 'POST' && pathname === '/api/shares/revoke') {
    if (!requireCsrf(req, res, session)) return;
    const count = await revokeShares(session.username, await bodyJson(req));
    return json(res, 200, { ok: true, count });
  }
  if (req.method === 'POST' && pathname === '/api/shares/delete') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const ids = Array.isArray(data.ids) ? data.ids : [data.id]; const before = shares.length;
    shares = shares.filter((entry) => entry.recipient !== session.username || !ids.includes(entry.id));
    await persistShares();
    return json(res, 200, { ok: true, count: before - shares.length });
  }
  if (req.method === 'POST' && pathname === '/api/upload-conflicts') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req);
    return json(res, 200, await uploadConflicts(data.path || '', Array.isArray(data.names) ? data.names : [], session.username));
  }
  if (req.method === 'POST' && pathname === '/api/upload-replace') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req);
    const names = Array.isArray(data.names) ? data.names : [];
    if (!names.length) throw new Error('No upload conflicts selected');
    return json(res, 200, { ok: true, count: await prepareUploadReplace(data.path || '', names, session.username) });
  }
  if (req.method === 'GET' && pathname === '/api/download') {
    const relative = cleanRelative(url.searchParams.get('path') || '');
    const file = diskPath(relative, session.username);
    const stats = await fsp.stat(file);
    if (!stats.isFile()) return json(res, 400, { error: 'Only files can be downloaded' });
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': stats.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && pathname === '/api/preview') {
    const relative = cleanRelative(url.searchParams.get('path') || '');
    const file = diskPath(relative, session.username);
    const stats = await fsp.stat(file);
    if (!stats.isFile() || !previewable(file)) return json(res, 400, { error: 'This file cannot be previewed' });
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': stats.size, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'POST' && pathname === '/api/archive') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const paths = Array.isArray(data.paths) ? data.paths : []; const sharedItems = Array.isArray(data.sharedItems) ? data.sharedItems : [];
    if (!paths.length && !sharedItems.length) throw new Error('No valid items selected');
    if (paths.some((item) => typeof item !== 'string' || !cleanRelative(item))) throw new Error('No valid items selected');
    const archive = sharedItems.length ? await buildMixedZip([...paths.map((path) => ({ kind: 'local', path })), ...sharedItems.map((item) => ({ kind: 'shared', id: item.id, path: item.path || '' }))], session.username) : await buildZip(paths, session.username);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Content-Disposition': "attachment; filename=lantern-selection.zip", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(archive);
  }
  if (req.method === 'POST' && pathname === '/api/upload-stream') {
    if (!requireCsrf(req, res, session)) return;
    const targetPath = cleanRelative(url.searchParams.get('path') || '');
    const relativeName = url.searchParams.get('name') || '';
    const uploaded = await streamUpload(req, targetPath, relativeName, session.username, url.searchParams.get('mode') || 'error');
    const uploadedPath = path.posix.join(targetPath, uploaded.path);
    await recordUploadAttribution(session.username, uploadedPath, session.loginUsername);
    await recordAudit('upload', session.loginUsername, uploadedPath, session.publicWorkspace ? `workspace:${config.username}` : '');
    return json(res, 201, { ok: true, count: 1, ...uploaded });
  }
  if (req.method === 'POST' && pathname === '/api/shares/upload-stream') {
    if (!requireCsrf(req, res, session)) return;
    const entry = findShareForRecipient(url.searchParams.get('id') || '', session.username);
    if (!entry.canOverwrite) throw new Error('This share does not allow overwrite uploads');
    const targetPath = cleanRelative(url.searchParams.get('path') || '');
    const relativeName = cleanRelative(url.searchParams.get('name') || '');
    if (!relativeName) throw new Error('Invalid upload path');
    const sharedRoot = await existsPath(entry.sourcePath, entry.owner);
    if (!sharedRoot) throw new Error('Shared item is unavailable');
    let finalRelative;
    if (sharedRoot.isFile()) {
      if (targetPath || relativeName !== path.posix.basename(entry.sourcePath)) throw new Error('The uploaded file name must match the shared file');
      finalRelative = entry.sourcePath;
    } else {
      finalRelative = sharePath(entry, path.posix.join(targetPath, relativeName));
    }
    const existing = await existsPath(finalRelative, entry.owner);
    if (!existing || existing.isDirectory()) throw new Error('Only existing shared files can be overwritten');
    const uploaded = await streamUpload(req, path.posix.dirname(finalRelative), path.posix.basename(finalRelative), entry.owner, 'replace');
    await markShareOverwrite(entry.owner, finalRelative, session.username);
    return json(res, 201, { ok: true, count: 1, ...uploaded });
  }
  if (req.method === 'POST' && pathname === '/api/folder') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const target = diskPath(path.posix.join(cleanRelative(data.path || ''), path.basename(data.name || '')), session.username);
    if (!data.name || path.basename(data.name) !== data.name) throw new Error('Invalid folder name');
    await fsp.mkdir(target); return json(res, 201, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/rename') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const previousPath = cleanRelative(data.path); const nextPath = path.posix.join(path.posix.dirname(previousPath), path.basename(data.name || '')); const source = diskPath(previousPath, session.username); const destination = diskPath(nextPath, session.username);
    if (!data.name || path.basename(data.name) !== data.name) throw new Error('Invalid name');
    await fsp.rename(source, destination);
    await rewriteSharePaths(session.username, previousPath, nextPath);
    if (rewriteUploadAttributionPaths(session.username, previousPath, nextPath)) await persistUploadAttributions();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/move') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req);
    const finalPaths = [];
    const reservedNames = [];
    const destination = cleanRelative(data.destination || '');
    const ownedPaths = (Array.isArray(data.paths) ? data.paths : (data.path ? [data.path] : [])).map((sourcePath) => cleanRelative(sourcePath));
    if (ownedPaths.some((sourcePath) => destination === sourcePath || destination.startsWith(`${sourcePath}/`))) throw new Error('Cannot move an item into itself');
    if (ownedPaths.some((sourcePath) => ownedPaths.some((candidate) => candidate !== sourcePath && candidate.startsWith(`${sourcePath}/`)))) throw new Error('Do not select both a folder and an item inside it');
    for (const item of Array.isArray(data.sharedItems) ? data.sharedItems : []) {
      const share = findShareForRecipient(item.id, session.username);
      reservedNames.push(path.posix.basename(sharePath(share, item.path || '')));
    }
    if (data.sharedId) {
      const share = findShareForRecipient(data.sharedId, session.username);
      reservedNames.push(path.posix.basename(sharePath(share, data.sharedPath || '')));
    }
    for (const sourcePath of ownedPaths) reservedNames.push(path.posix.basename(sourcePath));
    if (new Set(reservedNames.map((name) => process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name)).size !== reservedNames.length) throw new Error('Selected items contain duplicate names');
    for (const name of reservedNames) if (await existsPath(path.posix.join(destination, name), session.username)) throw new Error('An item with the same name already exists in the destination');
    if (Array.isArray(data.sharedItems) && data.sharedItems.length) {
      for (const item of data.sharedItems) finalPaths.push(await copySharedEntry(item.id, item.path || '', data.destination || '', session.username));
      await recordAudit('copy', session.loginUsername, finalPaths.join(', '), 'shared:batch');
    }
    if (data.sharedId) {
      finalPaths.push(await copySharedEntry(data.sharedId, data.sharedPath || '', data.destination || '', session.username));
      await recordAudit('copy', session.loginUsername, finalPaths[0], `shared:${data.sharedId}`);
    }
    if (ownedPaths.length) {
      for (const sourcePath of ownedPaths) finalPaths.push(await moveEntry(sourcePath, destination, session.username));
      await recordAudit('move', session.loginUsername, finalPaths.join(', '), session.publicWorkspace ? `workspace:${config.username}` : '');
    }
    if (!finalPaths.length) throw new Error('No valid items selected');
    return json(res, 200, { ok: true, paths: finalPaths });
  }
  if (req.method === 'POST' && pathname === '/api/delete') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req);
    const paths = Array.isArray(data.paths) ? data.paths : [data.path];
    if (!paths.length || paths.some((item) => typeof item !== 'string' || !cleanRelative(item))) throw new Error('No valid items selected');
    const moved = [];
    try { for (const item of paths) moved.push(await moveToTrash(item, session.username)); } finally { await Promise.all([persistTrash(), persistUploadAttributions()]); }
    await recordAudit('trash', session.loginUsername, paths.join(', '), session.publicWorkspace ? `workspace:${config.username}` : '');
    return json(res, 200, { ok: true, count: moved.length });
  }
  if (req.method === 'POST' && pathname === '/api/trash/restore') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const ids = Array.isArray(data.ids) ? data.ids : [data.id];
    if (!ids.filter(Boolean).length) throw new Error('No valid items selected');
    await restoreTrash(ids, session.username); await recordAudit('restore', session.loginUsername, ids.join(', '), session.publicWorkspace ? `workspace:${config.username}` : ''); return json(res, 200, { ok: true, count: ids.length });
  }
  if (req.method === 'POST' && pathname === '/api/trash/purge') {
    if (!requireCsrf(req, res, session)) return;
    const data = await bodyJson(req); const ids = data.all ? trashEntries.filter((entry) => (entry.owner || config.username) === session.username).map((entry) => entry.id) : (Array.isArray(data.ids) ? data.ids : [data.id]);
    await purgeTrash(ids.filter(Boolean), session.username); await recordAudit('purge', session.loginUsername, ids.join(', '), session.publicWorkspace ? `workspace:${config.username}` : ''); return json(res, 200, { ok: true, count: ids.length });
  }
  if (req.method === 'POST' && pathname === '/api/upload') {
    if (!requireCsrf(req, res, session)) return;
    const match = /boundary=(.+)$/i.exec(req.headers['content-type'] || '');
    if (!match) throw new Error('Expected multipart upload');
    const parts = extractMultipart(await readBody(req, 200 * 1024 * 1024), match[1].trim().replace(/^"|"$/g, ''));
    const targetPath = cleanRelative(parts.find((part) => part.name === 'path')?.data.toString('utf8') || '');
    const uploads = parts.filter((part) => part.name === 'files' && part.filename);
    let relativePaths = [];
    try { relativePaths = JSON.parse(parts.find((part) => part.name === 'relativePaths')?.data.toString('utf8') || '[]'); } catch { throw new Error('Invalid upload manifest'); }
    if (!uploads.length) throw new Error('No files selected');
    for (let index = 0; index < uploads.length; index += 1) {
      const file = uploads[index];
      const relativeName = cleanRelative(relativePaths[index] || file.filename);
      if (!relativeName) continue;
      const destination = diskPath(path.posix.join(targetPath, relativeName), session.username);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, file.data, { flag: 'wx' });
      await recordUploadAttribution(session.username, path.posix.join(targetPath, relativeName), session.loginUsername);
    }
    return json(res, 201, { ok: true, count: uploads.length });
  }
  return json(res, 404, { error: 'Not found' });
}

async function initialize() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
  await fsp.mkdir(USERS_ROOT, { recursive: true });
  await fsp.mkdir(TRASH_ROOT, { recursive: true });
  try {
    const saved = JSON.parse(await fsp.readFile(SESSIONS_PATH, 'utf8'));
    for (const [id, session] of Object.entries(saved)) if (session.expires > Date.now()) sessions.set(id, session);
  } catch { /* first launch */ }
  try { trashEntries = JSON.parse(await fsp.readFile(TRASH_INDEX_PATH, 'utf8')); } catch { trashEntries = []; }
  try { shares = JSON.parse(await fsp.readFile(SHARES_PATH, 'utf8')); } catch { shares = []; }
  try { auditEntries = JSON.parse(await fsp.readFile(AUDIT_PATH, 'utf8')); } catch { auditEntries = []; }
  try { uploadAttributions = JSON.parse(await fsp.readFile(UPLOAD_ATTRIBUTIONS_PATH, 'utf8')); } catch { uploadAttributions = []; }
  await purgeExpiredTrash();
  await persistSessions();
  await persistTrash();
  await persistShares();
  await persistAudit();
  await persistUploadAttributions();
}

if (require.main === module) {
  initialize().then(() => {
    const server = http.createServer((req, res) => route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent && !res.destroyed) json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || 'Unexpected error' });
    }));
    server.requestTimeout = 0;
    server.listen(config.port, config.host, () => {
      console.log(`Lantern File Manager is running at http://localhost:${config.port}`);
      console.log(`Storage root: ${STORAGE_ROOT}`);
      console.log(`Loaded accounts: ${accounts.size}`);
    });
  });
}

module.exports = { removeCreatedEmptyDirectories, sessionPayload, workspaceUsernameFor };

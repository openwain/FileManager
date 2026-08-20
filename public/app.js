const $ = (selector) => document.querySelector(selector);
const state = { csrf: '', username: '', workspaceUsername: '', publicUsername: '', publicWorkspace: false, canSwitchWorkspace: false, greeting: '私有工作区', sharingEnabled: false, maxUploadBytes: 2 * 1024 ** 3, path: '', entries: [], mode: 'files', viewMode: 'grid', captchaId: '', dialogAction: null, dialogPath: '', moveTarget: null, moveDestination: '', moveBackStack: [], moveForwardStack: [], shareTarget: null, sharedRoot: null, sharedPath: '', sharedUploadTarget: null, searchReturn: null, previewTarget: null, selected: new Set() };
let historyReady = false;
let activeUpload = null;
let activeDownload = null;
let downloadProgressRun = 0;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}), ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': state.csrf } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求未成功');
  return data;
}

function toast(message, isError = false) { const element = $('#toast'); element.textContent = message; element.classList.toggle('error', isError); element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2500); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
function formatSize(bytes) { if (!bytes) return '—'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function formatDiskGb(bytes) { return `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`; }
function formatDate(time) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(time)); }
function nameForPath(value) { return value.split('/').filter(Boolean).pop() || '全部文件'; }
function parentPath(value) { const parts = value.split('/').filter(Boolean); parts.pop(); return parts.join('/'); }
function folderHash(value) { return `#/files${value ? `/${value.split('/').map((part) => encodeURIComponent(part)).join('/')}` : ''}`; }
function sharedHash(id, value = '') { return `#/shared/${encodeURIComponent(id)}${value ? `/${value.split('/').map((part) => encodeURIComponent(part)).join('/')}` : ''}`; }
function routeFromHash() {
  try {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const section = parts.shift() || 'files';
    if (section === 'shared') {
      if (!parts.length) return { mode: 'shared' };
      const id = decodeURIComponent(parts.shift());
      return { mode: 'shared-folder', id, path: parts.map((part) => decodeURIComponent(part)).join('/') };
    }
    if (section === 'sent') return { mode: 'sent' };
    if (section === 'files') return { mode: 'files', path: parts.map((part) => decodeURIComponent(part)).join('/') };
  } catch { /* invalid hash falls back to root */ }
  return { mode: 'files', path: '' };
}
function routeUrl(route) {
  if (route.mode === 'shared') return '#/shared';
  if (route.mode === 'sent') return '#/sent';
  if (route.mode === 'shared-folder') return sharedHash(route.id, route.path || '');
  return folderHash(route.path || '');
}
function ensureAppHistory(initialRoute = routeFromHash()) {
  if (historyReady) return;
  const rootState = { lantern: true, mode: 'files', path: '' };
  history.replaceState(rootState, '', folderHash('')); history.pushState({ ...rootState, guard: true }, '', folderHash(''));
  if (initialRoute.mode !== 'files' || initialRoute.path) history.pushState({ lantern: true, ...initialRoute }, '', routeUrl(initialRoute));
  historyReady = true;
}
function clearSelection() { state.selected.clear(); }
function applySession(session) {
  state.csrf = session.csrf;
  state.username = session.username;
  state.workspaceUsername = session.workspaceUsername || session.username;
  state.publicUsername = session.publicUsername || 'openwain';
  state.publicWorkspace = Boolean(session.publicWorkspace);
  state.canSwitchWorkspace = Boolean(session.canSwitchWorkspace);
  state.sharingEnabled = Boolean(session.sharingEnabled);
  state.maxUploadBytes = Number(session.maxUploadBytes) || state.maxUploadBytes;
  state.greeting = state.publicWorkspace ? '公共工作区' : '私有工作区';
  $('#workspace-greeting').textContent = state.greeting;
  $('#current-username').textContent = state.workspaceUsername;
  $('.topbar-identity').title = state.publicWorkspace ? `以 ${state.publicUsername} 权限访问，登录者：${state.username}` : `已登录：${state.username}`;
  $('#app-view').classList.toggle('public-workspace', state.publicWorkspace);
  $('#nav-shared').hidden = !state.sharingEnabled;
  $('#nav-sent').hidden = !state.sharingEnabled;
  const switchButton = $('#workspace-switch-button');
  switchButton.hidden = !state.canSwitchWorkspace;
  switchButton.classList.toggle('return-personal', state.publicWorkspace);
  $('#workspace-switch-label').textContent = state.publicWorkspace ? '返回个人空间' : '切换公共空间';
  switchButton.title = state.publicWorkspace ? `返回 ${state.username} 的个人工作区` : `以 ${state.publicUsername} 权限访问公共工作区`;
  switchButton.setAttribute('aria-label', switchButton.title);
}
async function loadStorageStats() { try { const result = await api('/api/storage-stats'); $('#storage-total').textContent = formatDiskGb(result.total); $('#storage-free').textContent = formatDiskGb(result.free); $('#storage-used-percent').textContent = `已用 ${Math.round(result.usedPercent)}%`; $('#storage-fill').style.width = `${result.usedPercent}%`; } catch { $('#storage-used-percent').textContent = '读取失败'; } }

async function refreshCaptcha() { const captcha = await api('/api/captcha'); state.captchaId = captcha.id; $('#captcha-image').innerHTML = captcha.svg; $('[name="captcha"]').value = ''; }
async function showLogin() { $('#app-view').hidden = true; $('#login-view').hidden = false; $('#login-error').textContent = ''; await refreshCaptcha(); }
async function login(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const error = $('#login-error'); error.textContent = '';
  try { const result = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password'), captcha: form.get('captcha'), captchaId: state.captchaId }) }); applySession(result); await showApp(); } catch (err) { error.textContent = err.message; refreshCaptcha(); }
}

function setNav(active) { document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.id === active)); }
function renderTopology() {
  const panel = $('#path-topology'); const tree = $('#topology-tree');
  if (state.mode === 'recent' || state.mode === 'trash') { panel.hidden = true; tree.innerHTML = ''; return; }
  panel.hidden = false;
  if (state.mode === 'sent') {
    tree.innerHTML = '<button class="topology-node current" style="--depth:0" data-topology-sent title="分享的文件"><span class="topology-joint">●</span><span>分享的文件</span></button>';
    tree.querySelector('[data-topology-sent]').addEventListener('click', () => showSent({ pushHistory: false }));
    return;
  }
  if (state.mode === 'shared') {
    tree.innerHTML = '<button class="topology-node current" style="--depth:0" data-topology-shared-root title="收到的文件"><span class="topology-joint">●</span><span>收到的文件</span></button>';
    tree.querySelector('[data-topology-shared-root]').addEventListener('click', () => showShared({ pushHistory: false }));
    return;
  }
  if (state.mode === 'shared-folder') {
    const pieces = state.sharedPath ? state.sharedPath.split('/') : []; let built = '';
    tree.innerHTML = `<button class="topology-node" style="--depth:0" data-topology-shared-root title="收到的文件"><span class="topology-joint">●</span><span>收到的文件</span></button><button class="topology-node ${!pieces.length ? 'current' : ''}" style="--depth:1" data-topology-shared-path="" title="${escapeHtml(state.sharedRoot.name)}"><span class="topology-joint">└</span><span>${escapeHtml(state.sharedRoot.name)}</span></button>${pieces.map((piece, index) => { built = built ? `${built}/${piece}` : piece; return `<button class="topology-node ${index === pieces.length - 1 ? 'current' : ''}" style="--depth:${index + 2}" data-topology-shared-path="${escapeHtml(built)}" title="${escapeHtml(built)}"><span class="topology-joint">└</span><span>${escapeHtml(piece)}</span></button>`; }).join('')}`;
    tree.querySelector('[data-topology-shared-root]').addEventListener('click', () => showShared());
    tree.querySelectorAll('[data-topology-shared-path]').forEach((button) => button.addEventListener('click', () => loadSharedDirectory(state.sharedRoot.id, button.dataset.topologySharedPath, { pushHistory: button.dataset.topologySharedPath !== state.sharedPath })));
    return;
  }
  const pieces = state.path ? state.path.split('/') : []; let built = '';
  tree.innerHTML = `<button class="topology-node ${!pieces.length ? 'current' : ''}" style="--depth:0" data-topology-path="" title="全部文件"><span class="topology-joint">●</span><span>全部文件</span></button>${pieces.map((piece, index) => { built = built ? `${built}/${piece}` : piece; return `<button class="topology-node ${index === pieces.length - 1 ? 'current' : ''}" style="--depth:${index + 1}" data-topology-path="${escapeHtml(built)}" title="${escapeHtml(built)}"><span class="topology-joint">└</span><span>${escapeHtml(piece)}</span></button>`; }).join('')}`;
  tree.querySelectorAll('[data-topology-path]').forEach((button) => button.addEventListener('click', () => loadDirectory(button.dataset.topologyPath)));
}
function renderBreadcrumbs() {
  const holder = $('#breadcrumbs'); holder.textContent = ''; return;
  if (state.mode === 'recent') { holder.textContent = '跨文件夹汇总 · 最近修改'; return; }
  if (state.mode === 'search') { holder.textContent = '全库搜索结果'; return; }
  if (state.mode === 'shared') { holder.textContent = '他人发送 · 虚拟访问标记'; return; }
  if (state.mode === 'sent') { holder.textContent = '我发送 · 分享访问标记'; return; }
  if (state.mode === 'shared-folder') {
    const pieces = state.sharedPath ? state.sharedPath.split('/') : []; let built = '';
    holder.innerHTML = `<button class="crumb" data-shared-root>收到的文件</button><span class="crumb-separator">/</span><button class="crumb ${!pieces.length ? 'current' : ''}" data-shared-path="">${escapeHtml(state.sharedRoot.name)}</button>${pieces.map((piece, index) => { built = built ? `${built}/${piece}` : piece; return `<span class="crumb-separator">/</span><button class="crumb ${index === pieces.length - 1 ? 'current' : ''}" data-shared-path="${escapeHtml(built)}">${escapeHtml(piece)}</button>`; }).join('')}`;
    holder.querySelector('[data-shared-root]').addEventListener('click', showShared);
    holder.querySelectorAll('[data-shared-path]').forEach((button) => button.addEventListener('click', () => loadSharedDirectory(state.sharedRoot.id, button.dataset.sharedPath)));
    return;
  }
  if (state.mode === 'trash') { holder.textContent = '已删除项目 · 可恢复或永久删除'; return; }
  const pieces = state.path ? state.path.split('/') : []; let built = '';
  holder.innerHTML = `<button class="workspace-greeting crumb ${!pieces.length ? 'current' : ''}" data-path="" aria-label="返回全部文件"><i aria-hidden="true"></i>${escapeHtml(state.greeting)}</button>${pieces.map((piece, index) => { built = built ? `${built}/${piece}` : piece; return `<span class="crumb-separator">/</span><button class="crumb ${index === pieces.length - 1 ? 'current' : ''}" data-path="${escapeHtml(built)}">${escapeHtml(piece)}</button>`; }).join('')}`;
  holder.querySelectorAll('.crumb').forEach((button) => button.addEventListener('click', () => loadDirectory(button.dataset.path)));
}
function glyph(entry) {
  if (globalThis.LanternFileIcons?.iconMarkup) return globalThis.LanternFileIcons.iconMarkup(entry, escapeHtml);
  return `<span class="file-type ${entry?.type === 'folder' ? 'folder' : 'kind-generic'}" aria-hidden="true"></span>`;
}
function normalMenu(entry) { const recipients = entry.sharedRecipients || []; const previewable = entry.type === 'file' && /\.(txt|md|json|pdf|png|jpe?g|gif|webp|svg)$/i.test(entry.name); const download = entry.type === 'file' ? `<button data-download="${escapeHtml(entry.path)}">下载</button>` : `<button data-download-folder="${escapeHtml(entry.path)}">下载文件夹</button>`; const preview = previewable ? `<button data-preview="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">预览</button>` : ''; const sharing = state.sharingEnabled ? `<button data-share="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">分享给用户</button>${recipients.length ? `<button class="danger" data-revoke-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-recipients="${escapeHtml(recipients.join('、'))}">撤销分享</button>` : ''}` : ''; return `<details class="row-menu"><summary class="icon-button" aria-label="更多操作" title="更多操作">⋯</summary><div class="menu-popover">${download}${preview}${sharing}<button data-move="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-type="${escapeHtml(entry.type)}">移动到...</button><button data-rename="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">重命名</button><button class="danger" data-delete="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">移入回收站</button></div></details>`; }
function trashMenu(entry) { return `<details class="row-menu"><summary class="icon-button" aria-label="更多操作" title="更多操作">⋯</summary><div class="menu-popover"><button data-restore="${escapeHtml(entry.id)}">恢复</button><button class="danger" data-purge="${escapeHtml(entry.id)}" data-name="${escapeHtml(entry.name)}">永久删除</button></div></details>`; }
function sharedMenu(entry) { const recipients = entry.forwardedRecipients || []; const nestedPath = state.mode === 'shared-folder' ? entry.path : ''; const canPreview = entry.available && entry.type === 'file' && /\.(txt|md|json|pdf|png|jpe?g|gif|webp|svg)$/i.test(entry.name); const preview = canPreview ? `<button data-shared-preview="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(nestedPath)}" data-name="${escapeHtml(entry.name)}">预览</button>` : ''; const overwrite = entry.available && entry.canOverwrite && entry.type === 'file' ? `<button data-shared-replace="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(nestedPath)}" data-name="${escapeHtml(entry.name)}">上传同名文件覆盖</button>` : ''; const copy = entry.available ? `<button data-copy-shared="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(nestedPath)}" data-name="${escapeHtml(entry.name)}" data-type="${escapeHtml(entry.type)}">复制到...</button>` : ''; const remove = state.mode === 'shared' ? `<button class="danger" data-remove-share="${escapeHtml(entry.id)}" data-name="${escapeHtml(entry.name)}">删除分享</button>` : ''; return `<details class="row-menu"><summary class="icon-button" aria-label="更多操作" title="更多操作">⋯</summary><div class="menu-popover"><button ${entry.available ? `data-shared-download="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(nestedPath)}"` : 'disabled'}>下载</button>${preview}${overwrite}${copy}<button ${entry.available ? `data-forward="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(nestedPath)}" data-name="${escapeHtml(entry.name)}"` : 'disabled'}>继续分享</button>${recipients.length ? `<button class="danger" data-revoke-forward="${escapeHtml(entry.id)}" data-name="${escapeHtml(entry.name)}" data-recipients="${escapeHtml(recipients.join('、'))}">撤销转发</button>` : ''}${remove}</div></details>`; }
function row(entry) {
  const isShared = state.mode === 'shared' || entry.shared; const isSent = state.mode === 'sent' || entry.sharedSent; const sharedPath = state.mode === 'shared-folder' ? entry.path : ''; const id = state.mode === 'trash' ? entry.id : (isShared ? `shared:${entry.id}:${encodeURIComponent(sharedPath)}` : entry.path);
  const overwriteLabel = entry.lastOverwrittenBy ? `，${entry.lastOverwrittenBy} 覆盖` : '';
  const ownedShareLabel = entry.sharedRecipients?.length ? `${state.username} 发送${overwriteLabel} · 接收者：${entry.sharedRecipients.join('、')}` : '';
  const location = state.mode === 'trash' ? `原位置：${entry.originalPath}` : (state.mode === 'recent' || state.mode === 'search' ? `位置：${entry.location}` : (isShared ? `${entry.sender} 发送${overwriteLabel}${entry.sender !== entry.owner ? ` · 源自 ${entry.owner}` : ''}${entry.available ? '' : ' · 源文件已不可用'}` : (isSent ? `${entry.owner} 发送${overwriteLabel} · 接收者：${(entry.sharedRecipients || []).join('、')}` : ownedShareLabel)));
  const action = state.mode === 'trash' ? trashMenu(entry) : (isShared ? sharedMenu(entry) : normalMenu(entry));
  const sharedPreviewable = entry.type === 'file' && /\.(txt|md|json|pdf|png|jpe?g|gif|webp|svg)$/i.test(entry.name);
  const title = state.mode === 'trash' ? `<span>${escapeHtml(entry.name)}</span>` : (isShared ? (entry.available ? (entry.type === 'folder' ? `<button data-shared-open="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}">${escapeHtml(entry.name)}</button>` : `<button data-shared-preview="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}" data-name="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</button>`) : `<span class="shared-unavailable">${escapeHtml(entry.name)}</span>`) : (entry.type === 'folder' ? `<button data-open="${escapeHtml(entry.path)}" data-type="folder">${escapeHtml(entry.name)}</button>` : `<button data-preview="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</button>`));
  const rowOpen = entry.type === 'folder' && state.mode !== 'trash' ? (isShared ? ` data-shared-row-open="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}"` : ` data-row-open="${escapeHtml(entry.path)}"`) : '';
  const selector = isSent || isShared && !entry.available ? '<span class="check-cell"></span>' : `<span class="check-cell"><input type="checkbox" data-select="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(entry.name)}" ${state.selected.has(id) ? 'checked' : ''}></span>`;
  const uploader = entry.uploader ? `<small class="upload-attribution"><span aria-hidden="true">↑</span> ${escapeHtml(entry.uploader)} 上传</small>` : '';
  return `<article class="file-row"${rowOpen}>${selector}<div class="file-name">${glyph(entry)}<div>${title}${location ? `<small class="recent-location">${escapeHtml(location)}</small>` : ''}${uploader}</div></div><time class="file-date">${formatDate(state.mode === 'trash' ? entry.deletedAt : (isShared ? entry.createdAt : entry.modified))}</time><span class="file-size">${entry.type === 'folder' || !entry.available && isShared ? '—' : formatSize(entry.size)}</span>${action}</article>`;
}
function card(entry) {
  const isShared = state.mode === 'shared' || entry.shared; const isSent = state.mode === 'sent' || entry.sharedSent; const sharedPath = state.mode === 'shared-folder' ? entry.path : ''; const id = state.mode === 'trash' ? entry.id : (isShared ? `shared:${entry.id}:${encodeURIComponent(sharedPath)}` : entry.path);
  const overwriteLabel = entry.lastOverwrittenBy ? `，${entry.lastOverwrittenBy} 覆盖` : '';
  const ownedShareLabel = entry.sharedRecipients?.length ? `${state.username} 发送${overwriteLabel} · 接收者：${entry.sharedRecipients.join('、')}` : '';
  const location = state.mode === 'trash' ? `原位置：${entry.originalPath}` : (state.mode === 'recent' || state.mode === 'search' ? `位置：${entry.location}` : (isShared ? `${entry.sender} 发送${overwriteLabel}${entry.sender !== entry.owner ? ` · 源自 ${entry.owner}` : ''}${entry.available ? '' : ' · 源文件已不可用'}` : (isSent ? `${entry.owner} 发送${overwriteLabel} · 接收者：${(entry.sharedRecipients || []).join('、')}` : ownedShareLabel)));
  const action = state.mode === 'trash' ? trashMenu(entry) : (isShared ? sharedMenu(entry) : normalMenu(entry));
  const sharedPreviewable = entry.type === 'file' && /\.(txt|md|json|pdf|png|jpe?g|gif|webp|svg)$/i.test(entry.name);
  const title = state.mode === 'trash' ? `<span>${escapeHtml(entry.name)}</span>` : (isShared ? (entry.available ? (entry.type === 'folder' ? `<button data-shared-open="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}">${escapeHtml(entry.name)}</button>` : `<button data-shared-preview="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}" data-name="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</button>`) : `<span class="shared-unavailable">${escapeHtml(entry.name)}</span>`) : (entry.type === 'folder' ? `<button data-open="${escapeHtml(entry.path)}" data-type="folder">${escapeHtml(entry.name)}</button>` : `<button data-preview="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</button>`));
  const rowOpen = entry.type === 'folder' && state.mode !== 'trash' ? (isShared ? ` data-shared-row-open="${escapeHtml(entry.id)}" data-shared-path="${escapeHtml(sharedPath)}"` : ` data-row-open="${escapeHtml(entry.path)}"`) : '';
  const selector = isSent || isShared && !entry.available ? '' : `<label class="card-select"><input type="checkbox" data-select="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(entry.name)}" ${state.selected.has(id) ? 'checked' : ''}></label>`;
  const uploader = entry.uploader ? `<small class="upload-attribution"><span aria-hidden="true">↑</span> ${escapeHtml(entry.uploader)} 上传</small>` : '';
  const date = formatDate(state.mode === 'trash' ? entry.deletedAt : (isShared ? entry.createdAt : entry.modified));
  const cardPreview = entry.type === 'file' && state.mode !== 'trash' && !isShared ? ` data-card-preview="${escapeHtml(entry.path)}" data-card-name="${escapeHtml(entry.name)}"` : '';
  const sharedCardPreview = entry.type === 'file' && isShared && entry.available ? ` data-card-shared-preview="${escapeHtml(entry.id)}" data-card-shared-path="${escapeHtml(sharedPath)}" data-card-name="${escapeHtml(entry.name)}"` : '';
  const cardSize = entry.type === 'folder' ? '' : `<span>${!entry.available && isShared ? '—' : formatSize(entry.size)}</span>`;
  return `<article class="file-card"${rowOpen}${cardPreview}${sharedCardPreview}><div class="file-card-toolbar">${selector}${action}</div><div class="file-card-icon">${glyph(entry)}</div><div class="file-card-name">${title}</div>${location ? `<small class="file-card-location">${escapeHtml(location)}</small>` : ''}${uploader}<div class="file-card-meta"><time>${date}</time>${cardSize}</div></article>`;
}
function renderList() {
  const filter = $('#search-input').value.trim().toLocaleLowerCase(); const items = state.entries.filter((entry) => `${entry.name} ${entry.sender || ''} ${entry.uploader || ''}`.toLocaleLowerCase().includes(filter));
  const isTrash = state.mode === 'trash'; const isSharedMode = state.mode === 'shared'; const isSharedFolderMode = state.mode === 'shared-folder'; const isSentMode = state.mode === 'sent'; const selectableItems = items.filter((entry) => !entry.sharedSent && (!entry.shared || entry.available)); const anySelected = state.selected.size > 0;
  const gridView = state.viewMode === 'grid'; const fileList = $('#file-list'); fileList.classList.toggle('view-grid', gridView); $('#drop-zone').classList.toggle('grid-view', gridView); fileList.innerHTML = items.map(gridView ? card : row).join(''); $('#empty-state').hidden = items.length !== 0; $('.file-head').style.display = items.length && !gridView ? 'grid' : 'none'; $('#file-count').textContent = `${items.length} 项`;
  const viewToggle = $('#view-toggle'); viewToggle.querySelector('.view-icon').className = `view-icon ${gridView ? 'view-icon-list' : 'view-icon-grid'}`; viewToggle.setAttribute('aria-label', gridView ? '切换到列表视图' : '切换到图标视图'); viewToggle.title = gridView ? '切换到列表视图' : '切换到图标视图';
  const sharedSelection = isSharedMode || isSharedFolderMode; const selectedValues = [...state.selected]; const selectedHasShared = selectedValues.some((value) => value.startsWith('shared:')); const selectedHasOwned = selectedValues.some((value) => !value.startsWith('shared:')); $('#batch-toolbar').hidden = isSentMode || !anySelected; $('#selected-count').textContent = `${state.selected.size} 项已选`; $('#batch-download').hidden = isTrash || sharedSelection; $('#batch-move').hidden = isTrash; $('#batch-move').textContent = selectedHasShared ? (selectedHasOwned ? '移动/复制到...' : '复制到...') : '移动到...'; $('#batch-share').hidden = isTrash || sharedSelection || !state.sharingEnabled; $('#batch-delete').hidden = isTrash || sharedSelection; $('#batch-restore').hidden = !isTrash; $('#batch-purge').hidden = !isTrash;
  const selectionKey = (entry) => isTrash ? entry.id : (entry.shared ? `shared:${entry.id}:${encodeURIComponent(isSharedFolderMode ? entry.path : '')}` : entry.path); const canSelect = !isSentMode; const allSelected = selectableItems.length > 0 && selectableItems.every((entry) => state.selected.has(selectionKey(entry))); const someSelected = selectableItems.some((entry) => state.selected.has(selectionKey(entry))); $('#select-all').hidden = true; $('#select-all').checked = canSelect && allSelected; $('#select-all').indeterminate = canSelect && someSelected && !allSelected; $('#grid-select-control').hidden = !canSelect; $('#grid-select-all').checked = canSelect && allSelected; $('#grid-select-all').indeterminate = canSelect && someSelected && !allSelected;
  const empty = $('#empty-state'); empty.querySelector('h2').textContent = isTrash ? '回收站是空的' : (isSharedMode ? '还没有收到文件' : (isSentMode ? '还没有分享文件' : '这里还没有文件')); empty.querySelector('p').textContent = isTrash ? '移入回收站的文件会出现在这里，可恢复或永久清除。' : (isSharedMode ? '其他用户发送的文件会出现在这里。' : (isSentMode ? '分享给其他用户的文件会集中显示在这里。' : '上传文件，或新建一个文件夹开始整理。')); empty.querySelector('.upload-button').hidden = isTrash || isSharedMode || isSentMode;
  document.querySelectorAll('[data-select]').forEach((input) => input.addEventListener('change', () => { input.checked ? state.selected.add(input.dataset.select) : state.selected.delete(input.dataset.select); renderList(); }));
  document.querySelectorAll('[data-row-open]').forEach((element) => element.addEventListener('click', (event) => { if (event.target.closest('button,input,details,summary,a,label')) return; loadDirectory(element.dataset.rowOpen); }));
  document.querySelectorAll('[data-shared-row-open]').forEach((element) => element.addEventListener('click', (event) => { if (event.target.closest('button,input,details,summary,a,label')) return; loadSharedDirectory(element.dataset.sharedRowOpen, element.dataset.sharedPath); }));
  document.querySelectorAll('[data-card-preview]').forEach((element) => element.addEventListener('click', (event) => { if (event.target.closest('button,input,details,summary,a,label')) return; showPreview(element.dataset.cardPreview, element.dataset.cardName); }));
  document.querySelectorAll('[data-card-shared-preview]').forEach((element) => element.addEventListener('click', (event) => { if (event.target.closest('button,input,details,summary,a,label')) return; showSharedPreview(element.dataset.cardSharedPreview, element.dataset.cardSharedPath || '', element.dataset.cardName); }));
  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => button.dataset.type === 'folder' ? loadDirectory(button.dataset.open) : (window.location.href = `/api/download?path=${encodeURIComponent(button.dataset.open)}`)));
  document.querySelectorAll('[data-shared-open]').forEach((button) => button.addEventListener('click', () => loadSharedDirectory(button.dataset.sharedOpen, button.dataset.sharedPath)));
  document.querySelectorAll('[data-download]').forEach((button) => button.addEventListener('click', () => window.location.href = `/api/download?path=${encodeURIComponent(button.dataset.download)}`));
  document.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', () => showPreview(button.dataset.preview, button.dataset.name)));
  document.querySelectorAll('[data-shared-preview]').forEach((button) => button.addEventListener('click', () => showSharedPreview(button.dataset.sharedPreview, button.dataset.sharedPath || '', button.dataset.name)));
  document.querySelectorAll('[data-download-folder]').forEach((button) => button.addEventListener('click', () => downloadArchive([button.dataset.downloadFolder], nameForPath(button.dataset.downloadFolder))));
  document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => openMoveDialog({ path: button.dataset.move, name: button.dataset.name, type: button.dataset.type })));
  document.querySelectorAll('[data-copy-shared]').forEach((button) => button.addEventListener('click', () => openMoveDialog({ sharedId: button.dataset.copyShared, sharedPath: button.dataset.sharedPath || '', name: button.dataset.name, type: button.dataset.type })));
  document.querySelectorAll('[data-rename]').forEach((button) => button.addEventListener('click', () => openNameDialog('rename', button.dataset.rename, button.dataset.name)));
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteEntries([button.dataset.delete], button.dataset.name)));
  document.querySelectorAll('[data-restore]').forEach((button) => button.addEventListener('click', () => restoreEntries([button.dataset.restore])));
  document.querySelectorAll('[data-purge]').forEach((button) => button.addEventListener('click', () => purgeEntries([button.dataset.purge], button.dataset.name)));
  document.querySelectorAll('[data-share]').forEach((button) => button.addEventListener('click', () => openShareDialog({ paths: [button.dataset.share], name: button.dataset.name })));
  document.querySelectorAll('[data-forward]').forEach((button) => button.addEventListener('click', () => openShareDialog({ shareId: button.dataset.forward, path: button.dataset.sharedPath || '', name: button.dataset.name })));
  document.querySelectorAll('[data-shared-download]').forEach((button) => button.addEventListener('click', () => { window.location.href = `/api/shares/download?id=${encodeURIComponent(button.dataset.sharedDownload)}&path=${encodeURIComponent(button.dataset.sharedPath || '')}`; }));
  document.querySelectorAll('[data-shared-replace]').forEach((button) => button.addEventListener('click', () => chooseSharedReplacement(button.dataset.sharedReplace, button.dataset.sharedPath || '', button.dataset.name)));
  document.querySelectorAll('[data-remove-share]').forEach((button) => button.addEventListener('click', () => removeShare(button.dataset.removeShare, button.dataset.name)));
  document.querySelectorAll('[data-revoke-path]').forEach((button) => button.addEventListener('click', () => revokeShare({ path: button.dataset.revokePath }, button.dataset.name, button.dataset.recipients)));
  document.querySelectorAll('[data-revoke-forward]').forEach((button) => button.addEventListener('click', () => revokeShare({ shareId: button.dataset.revokeForward }, button.dataset.name, button.dataset.recipients)));
}
function showFileCommands({ sharedOverwrite = false } = {}) { $('.command-row').hidden = false; $('.command-row').classList.toggle('single-command', sharedOverwrite); $('#new-folder-button').hidden = sharedOverwrite; $('#folder-upload-button').hidden = sharedOverwrite; $('#file-upload-button').hidden = false; }
function hideFileCommands() { $('.command-row').hidden = true; $('.command-row').classList.remove('single-command'); $('#new-folder-button').hidden = false; $('#folder-upload-button').hidden = false; $('#file-upload-button').hidden = false; }
async function loadDirectory(nextPath = state.path, { pushHistory = true } = {}) { try { const result = await api(`/api/list?path=${encodeURIComponent(nextPath)}`); state.path = result.path; state.entries = result.entries; state.mode = 'files'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); if (pushHistory && historyReady && history.state?.path !== state.path) history.pushState({ lantern: true, mode: 'files', path: state.path }, '', folderHash(state.path)); $('#folder-title').textContent = nameForPath(state.path); $('#section-kicker').textContent = state.path ? 'FOLDER' : (state.publicWorkspace ? 'PUBLIC SPACE' : 'MY SPACE'); $('#back-button').hidden = !state.path; showFileCommands(); setNav('nav-files'); renderBreadcrumbs(); renderTopology(); renderList(); } catch (error) { toast(error.message, true); } }
async function showRecent() { try { const result = await api('/api/recent'); state.path = ''; state.entries = result.entries; state.mode = 'recent'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); $('#folder-title').textContent = '最近修改'; $('#section-kicker').textContent = result.truncated ? `RECENT ACTIVITY · 已扫描 ${result.scanned} 项` : 'RECENT ACTIVITY'; $('#back-button').hidden = true; hideFileCommands(); setNav('nav-recent'); renderBreadcrumbs(); renderTopology(); renderList(); if (result.truncated) toast(`文件较多，已在扫描的 ${result.scanned} 项中显示最新结果`); } catch (error) { toast(error.message, true); } }
async function runSearch() { const query = $('#search-input').value.trim(); if (!query) { if (!state.searchReturn) return renderList(); const restore = state.searchReturn; state.searchReturn = null; if (restore.mode === 'files') return loadDirectory(restore.path); if (restore.mode === 'recent') return showRecent(); if (restore.mode === 'trash') return showTrash(); return loadDirectory(''); } try { if (!state.searchReturn) state.searchReturn = { mode: state.mode, path: state.path }; const result = await api(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent($('#search-type').value)}&sort=${encodeURIComponent($('#search-sort').value)}`); state.path = ''; state.entries = result.entries; state.mode = 'search'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); $('#folder-title').textContent = `搜索：${query}`; $('#section-kicker').textContent = result.truncated ? `SEARCH · 已扫描 ${result.scanned} 项` : `SEARCH · ${result.entries.length} 项`; $('#back-button').hidden = true; hideFileCommands(); renderBreadcrumbs(); renderTopology(); renderList(); if (result.truncated) toast(`搜索范围较大，已在扫描的 ${result.scanned} 项中显示匹配结果`); } catch (error) { toast(error.message, true); } }
async function showShared({ pushHistory = true } = {}) { if (!state.sharingEnabled) return; try { const result = await api('/api/shares'); state.path = ''; state.entries = result.entries; state.mode = 'shared'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); if (pushHistory && historyReady) history.pushState({ lantern: true, mode: 'shared' }, '', '#/shared'); $('#folder-title').textContent = '收到的文件'; $('#section-kicker').textContent = 'SHARED WITH ME'; $('#back-button').hidden = true; hideFileCommands(); setNav('nav-shared'); renderBreadcrumbs(); renderTopology(); renderList(); } catch (error) { toast(error.message, true); } }
async function showSent({ pushHistory = true } = {}) { if (!state.sharingEnabled) return; try { const result = await api('/api/shares/sent'); state.path = ''; state.entries = result.entries; state.mode = 'sent'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); if (pushHistory && historyReady) history.pushState({ lantern: true, mode: 'sent' }, '', '#/sent'); $('#folder-title').textContent = '分享的文件'; $('#section-kicker').textContent = 'SHARED BY ME'; $('#back-button').hidden = true; hideFileCommands(); setNav('nav-sent'); renderBreadcrumbs(); renderTopology(); renderList(); } catch (error) { toast(error.message, true); } }
async function loadSharedDirectory(id, nextPath = '', { pushHistory = true } = {}) { try { const result = await api(`/api/shares/list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(nextPath)}`); state.path = ''; state.entries = result.entries; state.mode = 'shared-folder'; state.sharedRoot = result.share; state.sharedPath = result.path; clearSelection(); if (pushHistory && historyReady) history.pushState({ lantern: true, mode: 'shared-folder', id, path: result.path }, '', sharedHash(id, result.path)); $('#folder-title').textContent = nameForPath(result.path) === '全部文件' ? result.share.name : nameForPath(result.path); $('#section-kicker').textContent = `${result.share.sender} 发送 · ${result.share.canOverwrite ? '允许覆盖' : '只读'}`; $('#back-button').hidden = false; if (result.share.canOverwrite) showFileCommands({ sharedOverwrite: true }); else hideFileCommands(); setNav('nav-shared'); renderBreadcrumbs(); renderTopology(); renderList(); } catch (error) { toast(error.message, true); } }
async function showTrash() { try { const result = await api('/api/trash'); state.path = ''; state.entries = result.entries; state.mode = 'trash'; state.sharedRoot = null; state.sharedPath = ''; clearSelection(); $('#folder-title').textContent = '回收站'; $('#section-kicker').textContent = 'RECOVERY AREA'; $('#back-button').hidden = true; hideFileCommands(); setNav('nav-trash'); renderBreadcrumbs(); renderTopology(); renderList(); } catch (error) { toast(error.message, true); } }
async function refreshCurrent() { if (state.mode === 'recent') return showRecent(); if (state.mode === 'search') return runSearch(); if (state.mode === 'shared') return showShared({ pushHistory: false }); if (state.mode === 'sent') return showSent({ pushHistory: false }); if (state.mode === 'shared-folder') return loadSharedDirectory(state.sharedRoot.id, state.sharedPath, { pushHistory: false }); if (state.mode === 'trash') return showTrash(); return loadDirectory(state.path, { pushHistory: false }); }
async function showApp() {
  $('#login-view').hidden = true; $('#app-view').hidden = false;
  const initialRoute = routeFromHash(); ensureAppHistory(initialRoute);
  let initialLoad;
  if (!state.sharingEnabled && initialRoute.mode !== 'files') initialLoad = loadDirectory('', { pushHistory: false });
  else if (initialRoute.mode === 'shared') initialLoad = showShared({ pushHistory: false });
  else if (initialRoute.mode === 'sent') initialLoad = showSent({ pushHistory: false });
  else if (initialRoute.mode === 'shared-folder') initialLoad = loadSharedDirectory(initialRoute.id, initialRoute.path || '', { pushHistory: false });
  else initialLoad = loadDirectory(initialRoute.path || '', { pushHistory: false });
  await Promise.all([initialLoad, loadStorageStats()]);
}
async function switchWorkspace() {
  const button = $('#workspace-switch-button');
  const nextWorkspace = state.publicWorkspace ? 'personal' : 'public';
  button.disabled = true;
  try {
    const session = await api('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: nextWorkspace }) });
    applySession(session);
    state.searchReturn = null;
    $('#search-input').value = '';
    history.replaceState({ lantern: true, mode: 'files', path: '' }, '', folderHash(''));
    await Promise.all([loadDirectory('', { pushHistory: false }), loadStorageStats()]);
    toast(state.publicWorkspace ? '已进入公共工作区' : '已返回个人工作区');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function openNameDialog(action, targetPath = '', name = '') { state.dialogAction = action; state.dialogPath = targetPath; $('#dialog-kicker').textContent = action === 'rename' ? 'ORGANIZE' : 'NEW FOLDER'; $('#dialog-title').textContent = action === 'rename' ? '重命名' : '新建文件夹'; $('#dialog-confirm').textContent = action === 'rename' ? '保存更改' : '创建'; $('#name-input').value = name; $('#dialog-error').textContent = ''; $('#name-dialog').showModal(); setTimeout(() => $('#name-input').focus(), 20); }
function closeNameDialog() { state.dialogAction = null; state.dialogPath = ''; $('#dialog-error').textContent = ''; $('#name-dialog').close(); }
async function loadMoveFolders(nextPath = state.moveDestination) {
  const list = $('#move-folder-list');
  list.innerHTML = '<p class="move-folder-loading">正在读取文件夹...</p>';
  try {
    const result = await api(`/api/folders?path=${encodeURIComponent(nextPath)}`);
    state.moveDestination = result.path;
    $('#move-folder-current').textContent = result.path || '全部文件';
    $('#move-folder-back').disabled = !result.path;
    list.innerHTML = result.folders.length ? result.folders.map((folder) => `<button type="button" class="move-folder-option" data-move-folder="${escapeHtml(folder.path)}" role="option" aria-selected="false"><span class="move-folder-icon" aria-hidden="true"></span><span class="move-folder-name">${escapeHtml(folder.name)}</span><span class="move-folder-enter" aria-hidden="true">›</span></button>`).join('') : '<p class="move-folder-loading">此文件夹内没有子文件夹</p>';
    list.querySelectorAll('[data-move-folder]').forEach((button) => button.addEventListener('click', () => {
      state.moveBackStack.push(state.moveDestination);
      state.moveForwardStack = [];
      loadMoveFolders(button.dataset.moveFolder);
    }));
  } catch (error) {
    $('#move-error').textContent = error.message;
    list.innerHTML = '<p class="move-folder-loading">无法读取文件夹</p>';
  }
}
async function openMoveDialog(target) {
  state.moveTarget = target;
  const shared = Boolean(target.sharedId || target.sharedItems) && !target.path && !target.paths;
  const mixed = Boolean(target.sharedItems && target.paths);
  $('#move-dialog-kicker').textContent = mixed ? 'ORGANIZE ITEMS' : (shared ? 'COPY ITEM' : 'MOVE ITEM');
  $('#move-dialog-title').textContent = mixed ? '移动或复制项目' : (shared ? '复制项目' : '移动项目');
  $('#move-confirm').textContent = mixed ? '移动/复制到此处' : (shared ? '复制到此处' : '移动到此处');
  $('#move-file-name').textContent = target.name;
  $('#move-error').textContent = '';
  $('#move-new-folder-row').hidden = true;
  $('#move-new-folder-name').value = '';
  state.moveBackStack = [];
  state.moveForwardStack = [];
  $('#move-dialog').showModal();
  const sourcePath = target.path || '';
  await loadMoveFolders(shared ? '' : parentPath(sourcePath));
}
function closeMoveDialog() { state.moveTarget = null; state.moveDestination = ''; state.moveBackStack = []; state.moveForwardStack = []; $('#move-error').textContent = ''; if ($('#move-dialog').open) $('#move-dialog').close(); }
function moveDialogBack() {
  if (!$('#move-dialog').open || !state.moveDestination) return;
  const previous = state.moveBackStack.pop() ?? parentPath(state.moveDestination);
  state.moveForwardStack.push(state.moveDestination);
  loadMoveFolders(previous);
}
function moveDialogForward() {
  if (!$('#move-dialog').open || !state.moveForwardStack.length) return;
  const next = state.moveForwardStack.pop();
  state.moveBackStack.push(state.moveDestination);
  loadMoveFolders(next);
}
async function createMoveFolder() {
  const name = $('#move-new-folder-name').value;
  if (!name?.trim()) return;
  try {
    const parent = state.moveDestination;
    await api('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: parent, name: name.trim() }) });
    const newPath = parent ? `${parent}/${name.trim()}` : name.trim();
    await loadMoveFolders(newPath);
  } catch (error) { $('#move-error').textContent = error.message; }
}
function toggleMoveFolderInput() {
  const row = $('#move-new-folder-row');
  row.hidden = !row.hidden;
  if (!row.hidden) setTimeout(() => $('#move-new-folder-name').focus(), 20);
}
async function submitMove(event) {
  event.preventDefault();
  if (!state.moveTarget) return;
  const error = $('#move-error'); error.textContent = '';
  try {
    const target = state.moveTarget;
    const destination = state.moveDestination;
    const shared = Boolean(target.sharedId || target.sharedItems) && !target.path && !target.paths;
    const mixed = Boolean(target.sharedItems && target.paths);
    const payload = { destination, ...(target.sharedItems ? { sharedItems: target.sharedItems } : {}), ...(target.paths ? { paths: target.paths } : {}), ...(target.sharedId ? { sharedId: target.sharedId, sharedPath: target.sharedPath || '' } : {}), ...(!target.sharedId && !target.paths && target.path ? { path: target.path } : {}) };
    await api('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeMoveDialog();
    toast(mixed ? '已移动或复制到目标文件夹' : (shared ? '已复制到目标文件夹' : '已移动到目标文件夹'));
    await refreshCurrent();
  } catch (err) { error.textContent = err.message; }
}
async function openShareDialog(target) { try { const result = await api('/api/users'); state.shareTarget = target; $('#share-file-name').textContent = target.name; $('#share-can-overwrite').checked = false; $('#share-expiry').value = ''; $('#share-error').textContent = ''; $('#share-users').innerHTML = result.users.length ? result.users.map((username) => `<label class="share-user"><input type="checkbox" value="${escapeHtml(username)}"><span>${escapeHtml(username)}</span></label>`).join('') : '<p>没有可选的接收用户</p>'; $('#share-dialog').showModal(); } catch (error) { toast(error.message, true); } }
function closeShareDialog() { state.shareTarget = null; $('#share-dialog').close(); }
async function submitShare(event) { event.preventDefault(); const recipients = [...document.querySelectorAll('#share-users input:checked')].map((input) => input.value); const error = $('#share-error'); const days = Number($('#share-expiry').value || 0); error.textContent = ''; if (!recipients.length) { error.textContent = '请至少选择一个接收用户'; return; } try { const target = state.shareTarget || {}; const results = []; if (target.paths?.length) results.push(await api('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: target.paths, recipients, canOverwrite: $('#share-can-overwrite').checked, expiresAt: days ? Date.now() + days * 86400000 : 0 }) })); for (const item of target.sharedItems || []) results.push(await api('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId: item.id, path: item.path || '', recipients, canOverwrite: $('#share-can-overwrite').checked, expiresAt: days ? Date.now() + days * 86400000 : 0 }) })); closeShareDialog(); toast(`已创建 ${results.reduce((sum, result) => sum + Number(result.count || 0), 0)} 条分享`); await refreshCurrent(); } catch (err) { error.textContent = err.message; } }
let confirmResolver = null;
function askConfirm({ title, message, confirmText = '确认', cancelText = '取消', tone = 'danger', kicker = 'CONFIRM ACTION' }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-kicker').textContent = kicker;
  $('#confirm-accept').textContent = confirmText;
  $('#confirm-cancel').textContent = cancelText;
  dialog.classList.toggle('is-warning', tone === 'warning');
  dialog.showModal();
  setTimeout(() => $('#confirm-cancel').focus(), 20);
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function closeConfirmDialog(confirmed) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
  resolve?.(confirmed);
}
async function removeShare(id, name) { if (!await askConfirm({ title: '删除分享记录？', message: `将删除「${name}」的分享访问标记，接收方将无法再通过此记录访问。`, confirmText: '删除分享' })) return; try { await api('/api/shares/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); toast('已删除分享'); await refreshCurrent(); } catch (error) { toast(error.message, true); } }
async function revokeShare(target, name, recipients) { if (!await askConfirm({ title: '撤销分享权限？', message: `「${name}」对 ${recipients} 的访问权限将被收回。`, confirmText: '撤销分享' })) return; try { const result = await api('/api/shares/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) }); toast(`已撤销 ${result.count} 条分享`); await refreshCurrent(); } catch (error) { toast(error.message, true); } }
async function submitName(event) { event.preventDefault(); const name = $('#name-input').value.trim(); if (!name) return; const error = $('#dialog-error'); error.textContent = ''; try { if (state.dialogAction === 'rename') await api('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: state.dialogPath, name }) }); else await api('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: state.path, name }) }); $('#name-dialog').close(); toast(state.dialogAction === 'rename' ? '已重命名' : '文件夹已创建'); await refreshCurrent(); } catch (err) { error.textContent = err.message; } }
function selectedBatchItems(values = [...state.selected]) {
  const sharedItems = []; const paths = [];
  for (const value of values) {
    if (!value.startsWith('shared:')) { paths.push(value); continue; }
    const [, id, encodedPath = ''] = value.split(':');
    sharedItems.push({ id, path: decodeURIComponent(encodedPath) });
  }
  return { paths, sharedItems };
}
async function deleteEntries(paths, name = '') { if (!await askConfirm({ title: '移入回收站？', message: `${name ? `「${name}」` : `${paths.length} 个项目`}将被移入回收站，之后仍可恢复。`, confirmText: '移入回收站', tone: 'warning', kicker: 'MOVE TO TRASH' })) return; try { const result = await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) }); toast(`已移入回收站 ${result.count} 项`); await refreshCurrent(); } catch (error) { toast(error.message, true); } }
async function deleteSelectedBatch() {
  const { paths, sharedItems } = selectedBatchItems();
  if (!paths.length && !sharedItems.length) return;
  const message = paths.length && sharedItems.length
    ? `本地 ${paths.length} 项将移入回收站；收到的 ${sharedItems.length} 项将删除分享链接。此操作不会删除发送方的原文件。`
    : sharedItems.length ? `将删除 ${sharedItems.length} 个收到文件的分享链接，发送方原文件不会被删除。` : `「${paths.length} 个项目」将被移入回收站，之后仍可恢复。`;
  if (!await askConfirm({ title: paths.length && sharedItems.length ? '处理所选项目？' : (sharedItems.length ? '删除分享链接？' : '移入回收站？'), message, confirmText: paths.length && sharedItems.length ? '继续处理' : (sharedItems.length ? '删除链接' : '移入回收站'), tone: 'warning', kicker: sharedItems.length ? 'REMOVE SHARED ACCESS' : 'MOVE TO TRASH' })) return;
  try {
    let moved = 0;
    if (paths.length) moved = (await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) })).count;
    if (sharedItems.length) await api('/api/shares/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: sharedItems.map((item) => item.id) }) });
    toast(sharedItems.length ? (moved ? `已移入回收站 ${moved} 项，并删除分享链接` : '已删除分享链接') : `已移入回收站 ${moved} 项`);
    await refreshCurrent();
  } catch (error) { toast(error.message, true); }
}
async function restoreEntries(ids) { try { const result = await api('/api/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); toast(`已恢复 ${result.count} 项`); await showTrash(); } catch (error) { toast(error.message, true); } }
async function purgeEntries(ids, name = '') { if (!await askConfirm({ title: '永久删除？', message: `${name ? `「${name}」` : `${ids.length} 个项目`}将被永久删除。此操作无法撤销，也不能从回收站恢复。`, confirmText: '永久删除', kicker: 'PERMANENT DELETE' })) return; try { const result = await api('/api/trash/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); toast(`已永久删除 ${result.count} 项`); await showTrash(); } catch (error) { toast(error.message, true); } }
function showDownloadProgress(name) {
  const progress = $('#download-progress');
  const run = ++downloadProgressRun;
  progress.hidden = false;
  progress.classList.add('is-preparing');
  progress.classList.remove('is-complete');
  progress.removeAttribute('aria-valuenow');
  $('#download-progress-label').textContent = `正在准备 ${name}.zip`;
  $('#download-progress-detail').textContent = '正在打包文件夹';
  $('#download-progress-percent').textContent = '准备中';
  $('#download-progress-fill').style.width = '';
  return run;
}
function updateDownloadProgress(received, total) {
  const progress = $('#download-progress');
  const percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
  progress.classList.remove('is-preparing');
  progress.setAttribute('aria-valuenow', String(percent));
  $('#download-progress-label').textContent = '正在下载文件夹';
  $('#download-progress-detail').textContent = total > 0 ? `${formatSize(received)} / ${formatSize(total)}` : `已下载 ${formatSize(received)}`;
  $('#download-progress-percent').textContent = total > 0 ? `${percent}%` : '下载中';
  $('#download-progress-fill').style.width = total > 0 ? `${percent}%` : '100%';
}
function finishDownloadProgress(run) {
  const progress = $('#download-progress');
  progress.classList.remove('is-preparing');
  progress.classList.add('is-complete');
  progress.setAttribute('aria-valuenow', '100');
  $('#download-progress-label').textContent = '下载已完成';
  $('#download-progress-detail').textContent = 'ZIP 文件已保存';
  $('#download-progress-percent').textContent = '100%';
  $('#download-progress-fill').style.width = '100%';
  setTimeout(() => { if (!activeDownload && progress.dataset.downloadRun === String(run)) progress.hidden = true; }, 1200);
}
async function downloadArchive(paths, archiveName = '', sharedItems = []) {
  if (activeDownload) { toast('已有文件夹正在下载'); return; }
  const controller = new AbortController();
  activeDownload = controller;
  const downloadName = archiveName || (!sharedItems.length && paths.length === 1 ? nameForPath(paths[0]) : 'lantern-selection');
  const progressRun = showDownloadProgress(downloadName);
  $('#download-progress').dataset.downloadRun = String(progressRun);
  try {
    const response = await fetch('/api/archive', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ paths, sharedItems }) });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '归档下载失败'); }
    const total = Number(response.headers.get('Content-Length')) || 0;
    const chunks = [];
    let received = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        updateDownloadProgress(received, total);
      }
    } else {
      const buffer = await response.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
      received = buffer.byteLength;
      updateDownloadProgress(received, total || received);
    }
    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${downloadName}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    finishDownloadProgress(progressRun);
    toast(`${downloadName}.zip 下载完成`);
  } catch (error) {
    $('#download-progress').hidden = true;
    toast(error.name === 'AbortError' ? '已取消文件夹下载' : error.message, error.name !== 'AbortError');
  } finally {
    if (activeDownload === controller) activeDownload = null;
  }
}
async function showPreview(filePath, name) { const dialog = $('#preview-dialog'); const content = $('#preview-content'); const url = `/api/preview?path=${encodeURIComponent(filePath)}`; const ext = name.split('.').pop().toLowerCase(); state.previewTarget = { path: filePath, name }; $('#preview-shell').classList.toggle('preview-pdf', ext === 'pdf'); $('#preview-title').textContent = name; $('#preview-share').hidden = !state.sharingEnabled; content.textContent = '正在加载预览…'; dialog.showModal(); try { content.textContent = ''; if (['txt', 'md', 'json'].includes(ext)) { const response = await fetch(url, { credentials: 'same-origin' }); if (!response.ok) throw new Error('当前文件暂不支持预览，可直接下载'); const pre = document.createElement('pre'); pre.textContent = await response.text(); content.append(pre); } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) { const image = document.createElement('img'); image.src = url; image.alt = name; content.append(image); } else if (ext === 'pdf') { const frame = document.createElement('iframe'); frame.src = `${url}#view=FitH`; frame.title = name; content.append(frame); } else { content.textContent = '当前格式暂不支持站内预览，可使用上方“下载”按钮打开文件。'; } } catch (error) { content.textContent = error.message; } }
async function showSharedPreview(id, sharedPath, name) { const target = { id, path: sharedPath, name, shared: true }; const url = `/api/shares/preview?id=${encodeURIComponent(id)}&path=${encodeURIComponent(sharedPath)}`; state.previewTarget = target; await renderPreview(url, name); }

async function renderPreview(url, name) { const dialog = $('#preview-dialog'); const content = $('#preview-content'); const ext = name.split('.').pop().toLowerCase(); $('#preview-shell').classList.toggle('preview-pdf', ext === 'pdf'); $('#preview-title').textContent = name; $('#preview-share').hidden = !state.sharingEnabled; content.textContent = '正在加载预览…'; dialog.showModal(); try { content.textContent = ''; if (['txt', 'md', 'json'].includes(ext)) { const response = await fetch(url, { credentials: 'same-origin' }); if (!response.ok) throw new Error('当前文件暂不支持预览，可直接下载'); const pre = document.createElement('pre'); pre.textContent = await response.text(); content.append(pre); } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) { const image = document.createElement('img'); image.src = url; image.alt = name; content.append(image); } else if (ext === 'pdf') { const frame = document.createElement('iframe'); frame.src = `${url}#view=FitH`; frame.title = name; content.append(frame); } else { content.textContent = '当前格式暂不支持站内预览，可使用上方“下载”按钮打开文件。'; } } catch (error) { content.textContent = error.message; } }

function updatePreviewFullscreenButton() { const button = $('#preview-fullscreen'); const active = document.fullscreenElement === $('#preview-shell'); button.querySelector('span').textContent = active ? '⤡' : '⤢'; button.setAttribute('aria-label', active ? '退出全屏预览' : '全屏预览'); button.title = active ? '退出全屏预览' : '全屏预览'; }
function refitFullscreenPdf() { const shell = $('#preview-shell'); const frame = shell.querySelector('.preview-content iframe'); if (!shell.classList.contains('preview-pdf') || !frame) return; requestAnimationFrame(() => requestAnimationFrame(() => { frame.src = `${frame.src.split('#')[0]}#view=FitH&refresh=${Date.now()}`; })); }
async function closePreview() { const dialog = $('#preview-dialog'); try { if (document.fullscreenElement === $('#preview-shell')) await document.exitFullscreen(); } finally { if (dialog.open) dialog.close(); } }
function chooseSharedReplacement(id, sharedPath, name) {
  const picker = document.createElement('input'); picker.type = 'file';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0]; if (!file) return;
    if (file.name !== name) { toast(`请选择同名文件“${name}”`, true); return; }
    state.sharedUploadTarget = { id, path: parentPath(sharedPath), name };
    try { await upload([file]); } finally { state.sharedUploadTarget = null; }
  });
  picker.click();
}
async function prepareUploadPlan(allFiles, isFolder, targetPath) {
  if (state.sharedUploadTarget) {
    if (allFiles.length !== 1 || allFiles[0].name !== state.sharedUploadTarget.name) throw new Error(`请选择同名文件“${state.sharedUploadTarget.name}”`);
    if (!await askConfirm({ title: '覆盖共享文件？', message: `本地文件将替换「${state.sharedUploadTarget.name}」的现有内容。`, confirmText: '覆盖文件', tone: 'warning', kicker: 'REPLACE FILE' })) return null;
    return { shared: true, names: new Map(), sharedTarget: state.sharedUploadTarget };
  }
  if (state.mode === 'shared-folder') {
    if (!state.sharedRoot?.canOverwrite) throw new Error('这个共享文件夹是只读的');
    if (isFolder) throw new Error('共享文件夹内仅支持覆盖同名文件');
    const existing = new Set(state.entries.filter((entry) => entry.type === 'file').map((entry) => entry.name.normalize('NFKC').toLocaleLowerCase()));
    const missing = allFiles.filter((file) => !existing.has(file.name.normalize('NFKC').toLocaleLowerCase()));
    if (missing.length) throw new Error(`共享目录只能覆盖已有同名文件：${missing.slice(0, 3).map((file) => file.name).join('、')}`);
    if (!await askConfirm({ title: '覆盖同名文件？', message: `共享目录中的 ${allFiles.length} 个同名文件将被替换。`, confirmText: `覆盖 ${allFiles.length} 个文件`, tone: 'warning', kicker: 'REPLACE FILES' })) return null;
    return { shared: true, names: new Map(), sharedTarget: { id: state.sharedRoot.id, path: state.sharedPath } };
  }
  const topNames = [...new Set(allFiles.map((item) => isFolder ? item.relativePath.split('/')[0] : item.name))];
  const result = await api('/api/upload-conflicts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: targetPath, names: topNames }) });
  if (!result.conflicts.length) return { shared: false, names: new Map() };
  const label = result.conflicts.slice(0, 4).map((item) => item.name).join('、');
  if (await askConfirm({ title: '发现同名内容', message: `以下内容已经存在：${label}${result.conflicts.length > 4 ? ' 等' : ''}。替换后，原内容将被覆盖。`, confirmText: '替换原内容', cancelText: '取消替换', tone: 'warning', kicker: `${result.conflicts.length} CONFLICT${result.conflicts.length > 1 ? 'S' : ''}` })) {
    await api('/api/upload-replace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: targetPath, names: result.conflicts.map((item) => item.name) }) });
    return { shared: false, names: new Map() };
  }
  if (!await askConfirm({ title: '创建副本？', message: '保留现有内容，并为本次上传的同名项目自动生成副本名称。', confirmText: '创建副本', cancelText: '取消上传', tone: 'warning', kicker: 'KEEP BOTH' })) return null;
  return { shared: false, names: new Map(Object.entries(result.copies || {})) };
}
function plannedUploadName(item, isFolder, copies) {
  const original = isFolder ? item.relativePath : item.name;
  if (!isFolder) return copies.get(item.name) || original;
  const parts = original.split('/'); parts[0] = copies.get(parts[0]) || parts[0]; return parts.join('/');
}
function uploadItem(file, relativePath = '') {
  const cleanPath = String(relativePath || file.webkitRelativePath || file.name).replaceAll('\\', '/').replace(/^\/+/, '');
  return { file, name: file.name, size: file.size, type: file.type, relativePath: cleanPath || file.name };
}
function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
function directoryEntries(entry) {
  const reader = entry.createReader(); const entries = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => reader.readEntries((batch) => { if (!batch.length) { resolve(entries); return; } entries.push(...batch); readBatch(); }, reject);
    readBatch();
  });
}
async function collectDroppedEntry(entry, parentPath = '') {
  if (entry.isFile) return [uploadItem(await fileFromEntry(entry), `${parentPath}${entry.name}`)];
  if (!entry.isDirectory) return [];
  const children = await directoryEntries(entry);
  const nested = await Promise.all(children.map((child) => collectDroppedEntry(child, `${parentPath}${entry.name}/`)));
  return nested.flat();
}
async function droppedUploadItems(dataTransfer) {
  const transferItems = Array.from(dataTransfer.items || []);
  if (transferItems.some((item) => typeof item.webkitGetAsEntry === 'function')) {
    const nested = await Promise.all(transferItems.map(async (item) => {
      const entry = item.webkitGetAsEntry?.();
      if (entry) return collectDroppedEntry(entry);
      const file = item.getAsFile?.();
      return file ? [uploadItem(file)] : [];
    }));
    return nested.flat();
  }
  return Array.from(dataTransfer.files || [], (file) => uploadItem(file));
}
async function upload(files, isFolder = false) {
  if (!files.length) return;
  if (activeUpload) { toast('已有上传任务正在进行', true); return; }
  const allFiles = [...files].map((item) => item.file ? item : uploadItem(item)); const totalBytes = allFiles.reduce((sum, item) => sum + item.size, 0); const targetPath = state.mode === 'files' ? state.path : '';
  isFolder ||= allFiles.some((item) => item.relativePath !== item.name);
  if (totalBytes > state.maxUploadBytes) { toast(`单次上传的文件或文件夹不能超过 ${formatSize(state.maxUploadBytes)}`, true); return; }
  let plan;
  try { plan = await prepareUploadPlan(allFiles, isFolder, targetPath); } catch (error) { toast(error.message, true); return; }
  if (!plan) return;
  const panel = $('#upload-progress'); const fill = $('#upload-progress-fill'); const percent = $('#upload-progress-percent'); const detail = $('#upload-progress-detail');
  $('#upload-progress-label').textContent = allFiles.length === 1 ? allFiles[0].name : `正在上传 ${allFiles.length} 个文件`; detail.textContent = `0 B / ${formatSize(totalBytes)}`; percent.textContent = '0%'; fill.style.width = '0%'; panel.hidden = false;
  const task = { cancelled: false, xhr: null, abort() { this.cancelled = true; this.xhr?.abort(); } }; activeUpload = task;
  let completedBytes = 0;
  const updateProgress = (loaded, complete = false) => { const sent = Math.min(completedBytes + loaded, totalBytes); const calculated = totalBytes ? Math.round((sent / totalBytes) * 100) : 100; const value = complete ? 100 : Math.min(99, calculated); percent.textContent = `${value}%`; fill.style.width = `${value}%`; detail.textContent = calculated >= 100 && !complete ? '上传完成，服务器正在保存…' : `${formatSize(sent)} / ${formatSize(totalBytes)}`; };
  try {
    for (const file of allFiles) {
      if (task.cancelled) throw new DOMException('上传已取消', 'AbortError');
      const relativeName = plannedUploadName(file, isFolder, plan.names);
      const uploadFile = () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); task.xhr = xhr;
        const endpoint = plan.shared ? `/api/shares/upload-stream?id=${encodeURIComponent(plan.sharedTarget.id)}&path=${encodeURIComponent(plan.sharedTarget.path || '')}&name=${encodeURIComponent(file.name)}` : `/api/upload-stream?path=${encodeURIComponent(targetPath)}&name=${encodeURIComponent(relativeName)}&mode=error`;
        xhr.open('POST', endpoint); xhr.withCredentials = true; xhr.setRequestHeader('X-CSRF-Token', state.csrf); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.addEventListener('progress', (event) => updateProgress(event.loaded));
        xhr.addEventListener('load', () => { let result = {}; try { result = JSON.parse(xhr.responseText || '{}'); } catch { /* invalid server response */ } if (xhr.status >= 200 && xhr.status < 300) resolve(result); else reject(new Error(result.error || `上传失败（${xhr.status || '无响应'}）`)); });
        xhr.addEventListener('error', () => reject(new Error('网络错误，上传未完成')));
        xhr.addEventListener('abort', () => reject(new DOMException('上传已取消', 'AbortError')));
        xhr.send(file.file);
      });
      for (let attempt = 0; ; attempt += 1) {
        try { await uploadFile(); break; } catch (error) {
          const retryable = error.name !== 'AbortError' && !task.cancelled && attempt < 2 && /网络错误|无响应|上传失败（5/.test(error.message);
          if (!retryable) throw error;
          detail.textContent = `${file.name} 上传失败，正在重试（${attempt + 1}/2）…`;
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      completedBytes += file.size; updateProgress(0);
    }
    updateProgress(0, true); detail.textContent = `${formatSize(totalBytes)} / ${formatSize(totalBytes)}`; toast(`已上传 ${allFiles.length} 个文件`); await refreshCurrent(); setTimeout(() => { if (!activeUpload) panel.hidden = true; }, 900);
  } catch (error) {
    panel.hidden = true; toast(error.name === 'AbortError' ? '上传已取消' : error.message, error.name !== 'AbortError');
  } finally {
    if (activeUpload === task) activeUpload = null;
  }
}
async function boot() { try { const session = await api('/api/session'); if (!session.authenticated) throw new Error('Not signed in'); applySession(session); await showApp(); } catch { await showLogin(); } }

$('#login-form').addEventListener('submit', login); $('#refresh-captcha').addEventListener('click', refreshCaptcha); $('#new-folder-button').addEventListener('click', () => openNameDialog('folder')); $('#name-form').addEventListener('submit', submitName); $('#share-form').addEventListener('submit', submitShare);
$('#name-dialog-close').addEventListener('click', closeNameDialog); $('#name-dialog-cancel').addEventListener('click', closeNameDialog); $('#name-dialog').addEventListener('cancel', () => { state.dialogAction = null; state.dialogPath = ''; $('#dialog-error').textContent = ''; });
$('#move-form').addEventListener('submit', submitMove); $('#move-folder-back').addEventListener('click', moveDialogBack); $('#move-new-folder').addEventListener('click', toggleMoveFolderInput); $('#move-create-folder').addEventListener('click', createMoveFolder); $('#move-new-folder-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); createMoveFolder(); } }); $('#move-dialog-close').addEventListener('click', closeMoveDialog); $('#move-dialog-cancel').addEventListener('click', closeMoveDialog); $('#move-dialog').addEventListener('cancel', closeMoveDialog);
let moveSideButtonAction = 0;
function interceptMoveSideButton(event) {
  if (!$('#move-dialog').open || (event.button !== 3 && event.button !== 4)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'pointerdown' || event.type === 'mousedown') moveSideButtonAction = 0;
  if (event.type === 'mouseup' && moveSideButtonAction !== event.button) {
    moveSideButtonAction = event.button;
    if (event.button === 3) moveDialogBack(); else moveDialogForward();
  }
  if (event.type === 'auxclick') moveSideButtonAction = 0;
}
['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'click'].forEach((eventName) => window.addEventListener(eventName, interceptMoveSideButton, true));
document.addEventListener('click', (event) => {
  const activeMenu = event.target.closest('.row-menu');
  document.querySelectorAll('.row-menu[open]').forEach((menu) => {
    if (menu !== activeMenu) menu.removeAttribute('open');
  });
  const searchOptions = $('#search-options');
  if (searchOptions.open && !event.target.closest('#search-options')) searchOptions.removeAttribute('open');
});
$('#share-dialog-close').addEventListener('click', closeShareDialog); $('#share-dialog-cancel').addEventListener('click', closeShareDialog); $('#share-dialog').addEventListener('cancel', () => { state.shareTarget = null; });
$('#confirm-accept').addEventListener('click', () => closeConfirmDialog(true)); $('#confirm-cancel').addEventListener('click', () => closeConfirmDialog(false)); $('#confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeConfirmDialog(false); }); $('#confirm-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeConfirmDialog(false); });
const previewFullscreenButton = $('#preview-fullscreen');
previewFullscreenButton.hidden = !document.fullscreenEnabled || typeof $('#preview-shell').requestFullscreen !== 'function';
previewFullscreenButton.addEventListener('click', async () => { try { if (document.fullscreenElement === $('#preview-shell')) await document.exitFullscreen(); else await $('#preview-shell').requestFullscreen(); } catch (error) { toast('无法进入全屏预览', true); } });
document.addEventListener('fullscreenchange', () => { updatePreviewFullscreenButton(); refitFullscreenPdf(); });
$('#preview-close').addEventListener('click', closePreview);
$('#preview-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closePreview(); });
$('#preview-download').addEventListener('click', () => { if (!state.previewTarget) return; const target = state.previewTarget; window.location.href = target.shared ? `/api/shares/download?id=${encodeURIComponent(target.id)}&path=${encodeURIComponent(target.path || '')}` : `/api/download?path=${encodeURIComponent(target.path)}`; }); $('#preview-share').addEventListener('click', async () => { if (!state.previewTarget) return; const preview = state.previewTarget; const target = preview.shared ? { shareId: preview.id, path: preview.path || '', name: preview.name } : { paths: [preview.path], name: preview.name }; await closePreview(); openShareDialog(target); });
$('#upload-input').addEventListener('change', (event) => { upload(event.target.files); event.target.value = ''; }); $('#folder-input').addEventListener('change', (event) => { upload(event.target.files, true); event.target.value = ''; }); document.addEventListener('change', (event) => { if (event.target.matches('.empty-upload')) { upload(event.target.files); event.target.value = ''; } });
let searchTimer; $('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 260); }); $('#search-type').addEventListener('change', () => { $('#search-options').removeAttribute('open'); if ($('#search-input').value.trim()) runSearch(); }); $('#search-sort').addEventListener('change', () => { $('#search-options').removeAttribute('open'); if ($('#search-input').value.trim()) runSearch(); }); const selectVisible = (checked) => { const filterValue = $('#search-input').value.trim().toLocaleLowerCase(); const visible = state.entries.filter((entry) => !entry.sharedSent && (!entry.shared || entry.available) && `${entry.name} ${entry.sender || ''} ${entry.uploader || ''}`.toLocaleLowerCase().includes(filterValue)); visible.forEach((entry) => { const sharedPath = state.mode === 'shared-folder' ? entry.path : ''; const id = state.mode === 'trash' ? entry.id : (entry.shared ? `shared:${entry.id}:${encodeURIComponent(sharedPath)}` : entry.path); checked ? state.selected.add(id) : state.selected.delete(id); }); renderList(); }; $('#select-all').addEventListener('change', (event) => selectVisible(event.target.checked)); $('#grid-select-all').addEventListener('change', (event) => selectVisible(event.target.checked));
$('#batch-download').addEventListener('click', () => { const { paths, sharedItems } = selectedBatchItems(); downloadArchive(paths, '', sharedItems); }); $('#batch-move').addEventListener('click', () => { const values = [...state.selected]; const { paths, sharedItems } = selectedBatchItems(values); openMoveDialog({ ...(sharedItems.length ? { sharedItems } : {}), ...(paths.length ? { paths } : {}), name: `已选择 ${values.length} 项` }); }); $('#batch-share').addEventListener('click', () => { const values = [...state.selected]; const { paths, sharedItems } = selectedBatchItems(values); if (paths.length || sharedItems.length) openShareDialog({ ...(paths.length ? { paths } : {}), ...(sharedItems.length ? { sharedItems } : {}), name: `已选择 ${values.length} 项` }); }); $('#batch-delete').addEventListener('click', deleteSelectedBatch); $('#batch-restore').addEventListener('click', () => restoreEntries([...state.selected])); $('#batch-purge').addEventListener('click', () => purgeEntries([...state.selected]));
$('#view-toggle').addEventListener('click', () => { state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid'; renderList(); });
$('#cancel-upload').addEventListener('click', () => activeUpload?.abort());
$('#cancel-download').addEventListener('click', () => activeDownload?.abort());
function setMobileMenu(open) { $('#app-view').classList.toggle('menu-open', open); document.body.classList.toggle('mobile-nav-open', open); $('#mobile-menu').setAttribute('aria-expanded', String(open)); }
function closeMobileMenu() { setMobileMenu(false); }
$('#home-button').addEventListener('click', (event) => { event.preventDefault(); closeMobileMenu(); loadDirectory(''); }); $('#nav-files').addEventListener('click', () => { closeMobileMenu(); loadDirectory(''); }); $('#nav-recent').addEventListener('click', () => { closeMobileMenu(); showRecent(); }); $('#nav-shared').addEventListener('click', () => { closeMobileMenu(); showShared(); }); $('#nav-sent').addEventListener('click', () => { closeMobileMenu(); showSent(); }); $('#nav-trash').addEventListener('click', () => { closeMobileMenu(); showTrash(); }); $('#mobile-menu').addEventListener('click', () => setMobileMenu(!$('#app-view').classList.contains('menu-open'))); $('#sidebar-close-button').addEventListener('click', closeMobileMenu); $('#mobile-drawer-backdrop').addEventListener('click', closeMobileMenu); $('#workspace-switch-button').addEventListener('click', switchWorkspace); document.addEventListener('keydown', (event) => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search-input').focus(); } if (event.key === 'Escape') { $('#search-options').removeAttribute('open'); if ($('#app-view').classList.contains('menu-open')) closeMobileMenu(); } }); $('#logout-button').addEventListener('click', async () => { if (!await askConfirm({ title: '退出登录？', message: '退出后需要重新验证身份才能进入文件库。', confirmText: '退出登录', tone: 'warning', kicker: 'SIGN OUT' })) return; try { await api('/api/logout', { method: 'POST' }); closeMobileMenu(); showLogin(); } catch (error) { toast(error.message, true); } });
$('#back-button').addEventListener('click', () => { if (state.path || state.mode === 'shared-folder') history.back(); else window.alert('已经位于最上层'); });
window.addEventListener('popstate', (event) => { const next = event.state; if (!next?.lantern) { history.pushState({ lantern: true, mode: 'files', path: state.path, guard: true }, '', folderHash(state.path)); window.alert('已经位于最上层'); return; } if (next.mode === 'shared') { showShared({ pushHistory: false }); return; } if (next.mode === 'sent') { showSent({ pushHistory: false }); return; } if (next.mode === 'shared-folder') { loadSharedDirectory(next.id, next.path || '', { pushHistory: false }); return; } if (next.mode === 'files') { if (next.path === state.path && state.mode === 'files') { history.pushState({ ...next, guard: true }, '', folderHash(next.path)); window.alert('已经位于最上层'); return; } loadDirectory(next.path, { pushHistory: false }); } });
const dropZone = $('#drop-zone'); const canDropUpload = () => !['trash', 'shared', 'recent'].includes(state.mode) && (state.mode !== 'shared-folder' || state.sharedRoot?.canOverwrite); ['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); if (canDropUpload()) dropZone.style.outline = '2px dashed #2779a7'; })); ['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.style.outline = ''; })); dropZone.addEventListener('drop', async (event) => { if (!canDropUpload()) return; try { const items = await droppedUploadItems(event.dataTransfer); if (!items.length) throw new Error('没有读取到可上传的文件'); await upload(items); } catch (error) { toast(`无法读取拖入的文件夹：${error.message}`, true); } });
boot();

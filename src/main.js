const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, nativeImage, globalShortcut, dialog, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');

function loadFirebaseConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const firebaseConfig = loadFirebaseConfig();

function assertFirebaseConfigured() {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error('Firebase 尚未配置。请将 src/firebase-config.example.json 复制为 src/firebase-config.json，并填写项目配置。');
  }
}

let mainWindow;
let tray;
let isQuitting = false;
let dockEdge = null;
let edgeHidden = false;
let movingForDock = false;
let expandedBounds = null;
let revealCooldownUntil = 0;
let resizeSession = null;
let windowStateTimer = null;
let userMovingWindow = false;
let edgeTabDrag = null;
let activeShortcut = null;
let cloudAuth = null;
let cloudUploadTimer = null;
let cloudSyncEnabled = false;
const TAB_SHORT = 32;
const TAB_LONG = 112;
const REVEAL_INSET = 12;
const SNAP_DISTANCE = 14;
const MIN_WINDOW_WIDTH = 340;
const MIN_WINDOW_HEIGHT = 420;

function dataPath() {
  if (process.env.STICKY_TEST_DATA_PATH) return process.env.STICKY_TEST_DATA_PATH;
  return path.join(app.getPath('userData'), 'sticky-todos.json');
}

function backupDirectory() { return path.join(app.getPath('userData'), 'backups'); }

function cloudAuthPath() { return path.join(app.getPath('userData'), 'firebase-session.json'); }

function saveCloudAuth(value) {
  cloudAuth = value;
  if (!value) { try { fs.unlinkSync(cloudAuthPath()); } catch {} return; }
  const json = JSON.stringify(value);
  const stored = safeStorage.isEncryptionAvailable()
    ? { encrypted: true, value: safeStorage.encryptString(json).toString('base64') }
    : { encrypted: false, value: json };
  fs.writeFileSync(cloudAuthPath(), JSON.stringify(stored), 'utf8');
}

function loadCloudAuth() {
  try {
    const stored = JSON.parse(fs.readFileSync(cloudAuthPath(), 'utf8'));
    const json = stored.encrypted
      ? safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
      : stored.value;
    cloudAuth = JSON.parse(json);
  } catch { cloudAuth = null; }
  return cloudAuth;
}

async function firebaseRequest(url, options = {}) {
  assertFirebaseConfigured();
  const response = await net.fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Firebase 请求失败 (${response.status})`);
  return body;
}

function authMessage(message) {
  const code = String(message || '').split(' : ')[0];
  return ({ EMAIL_EXISTS: '这个邮箱已经注册，请直接登录。', INVALID_LOGIN_CREDENTIALS: '邮箱或密码不正确。', EMAIL_NOT_FOUND: '邮箱或密码不正确。', INVALID_EMAIL: '邮箱格式不正确。', WEAK_PASSWORD: '密码至少需要 8 位。', TOO_MANY_ATTEMPTS_TRY_LATER: '尝试次数过多，请稍后再试。', USER_DISABLED: '该账号已被停用。' })[code] || message;
}

async function sendVerificationEmail(idToken) {
  return firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken })
  });
}

async function lookupCloudUser(idToken) {
  const result = await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  return result.users?.[0] || {};
}

async function authenticateCloud(mode, email, password, displayName = '') {
  try {
    if (password.length < 8) throw new Error('密码至少需要 8 位。');
    if (mode === 'register') {
      const result = await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
      const name = String(displayName || '').trim().slice(0, 40);
      if (name) await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${firebaseConfig.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: result.idToken, displayName: name, returnSecureToken: false })
      });
      await sendVerificationEmail(result.idToken);
      return { signedIn: false, pendingVerification: true, email: result.email };
    }
    const result = await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const user = await lookupCloudUser(result.idToken);
    if (!user.emailVerified) throw new Error('邮箱尚未验证。请打开验证邮件完成验证，或点击“重新发送验证邮件”。');
    saveCloudAuth({ uid: result.localId, email: result.email, idToken: result.idToken, refreshToken: result.refreshToken, expiresAt: Date.now() + Number(result.expiresIn || 3600) * 1000 });
    cloudSyncEnabled = false;
    return { signedIn: true, email: cloudAuth.email };
  } catch (error) { throw new Error(authMessage(error.message)); }
}

async function resendCloudVerification(email, password) {
  try {
    const result = await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const user = await lookupCloudUser(result.idToken);
    if (user.emailVerified) return { verified: true };
    await sendVerificationEmail(result.idToken); return { verified: false };
  } catch (error) { throw new Error(authMessage(error.message)); }
}

async function sendCloudPasswordReset(email) {
  try {
    await firebaseRequest(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestType: 'PASSWORD_RESET', email })
    });
  } catch (error) {
    if (!['EMAIL_NOT_FOUND', 'INVALID_LOGIN_CREDENTIALS'].includes(String(error.message).split(' : ')[0])) throw new Error(authMessage(error.message));
  }
  return { message: '如果该邮箱已经注册，重置邮件已经发送；请检查收件箱和垃圾邮件。' };
}

async function validIdToken() {
  if (!cloudAuth) loadCloudAuth();
  if (!cloudAuth) throw new Error('请先登录。');
  if (cloudAuth.idToken && Date.now() < (cloudAuth.expiresAt || 0) - 60000) return cloudAuth.idToken;
  const result = await firebaseRequest(`https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cloudAuth.refreshToken }).toString()
  });
  saveCloudAuth({ ...cloudAuth, uid: result.user_id, idToken: result.id_token, refreshToken: result.refresh_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 });
  return cloudAuth.idToken;
}

function workspaceUrl() {
  return `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/users/${cloudAuth.uid}/workspace/current`;
}

async function readCloudWorkspace() {
  const token = await validIdToken();
  const response = await net.fetch(workspaceUrl(), { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || '读取云端数据失败。');
  const fields = body.fields || {};
  return { payload: fields.payload?.stringValue, updatedAt: Number(fields.updatedAt?.integerValue || 0), revision: Number(fields.revision?.integerValue || 0) };
}

async function uploadCloudWorkspace(data = readData()) {
  const token = await validIdToken();
  const updatedAt = Number(data.updatedAt || Date.now());
  const revision = Date.now();
  await firebaseRequest(workspaceUrl(), {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      payload: { stringValue: JSON.stringify(data) }, schemaVersion: { integerValue: '2' },
      updatedAt: { integerValue: String(updatedAt) }, deviceId: { stringValue: process.env.COMPUTERNAME || 'Windows' },
      revision: { integerValue: String(revision) }
    } })
  });
  return updatedAt;
}

async function syncCloudNow() {
  const local = readData();
  const remote = await readCloudWorkspace();
  const localUpdatedAt = Number(local.updatedAt || 0);
  const localItemCount = Array.isArray(local.notes)
    ? local.notes.reduce((sum, note) => sum + (note.todos?.length || 0), 0) + (local.archive?.length || 0) + (local.trash?.length || 0)
    : (local.todos?.length || 0);
  if (remote?.payload && (localItemCount === 0 || remote.updatedAt > localUpdatedAt)) {
    try { createSnapshot(dataPath(), '云同步覆盖前'); } catch {}
    const incoming = migrateData(JSON.parse(remote.payload), 'cloud');
    writeData(incoming, false); mainWindow?.webContents.send('data:changed', incoming);
    cloudSyncEnabled = true; return { direction: 'download', data: incoming, email: cloudAuth.email };
  }
  if (remote && remote.updatedAt === localUpdatedAt) {
    cloudSyncEnabled = true;
    return { direction: 'unchanged', email: cloudAuth.email };
  }
  await uploadCloudWorkspace(local); cloudSyncEnabled = true;
  return { direction: remote ? 'upload' : 'first-upload', email: cloudAuth.email };
}

function scheduleCloudUpload() {
  if (!cloudSyncEnabled || !cloudAuth) return;
  clearTimeout(cloudUploadTimer);
  cloudUploadTimer = setTimeout(() => uploadCloudWorkspace().catch(error => mainWindow?.webContents.send('sync:error', error.message)), 1200);
}

function createSnapshot(source = dataPath(), label = '自动备份') {
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(backupDirectory(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDirectory(), `${label}-${stamp}.json`);
  fs.copyFileSync(source, target);
  return target;
}

function migrateData(value, source) {
  if ((value.schemaVersion || 1) >= 2) return value;
  const marker = path.join(app.getPath('userData'), '.migration-v2-complete');
  if (!fs.existsSync(marker)) {
    try { createSnapshot(source, '升级前-v1'); fs.writeFileSync(marker, new Date().toISOString(), 'utf8'); } catch {}
  }
  const notes = Array.isArray(value.notes) && value.notes.length ? value.notes : [{ id: `note-${Date.now()}`, name: '我的便签', color: value.color || '#FFF3A6', todos: value.todos || [] }];
  notes.forEach((note, index) => {
    note.position ||= { x: 24 + (index % 4) * 235, y: 24 + Math.floor(index / 4) * 175 };
    note.texture ||= 'plain';
    note.opacity ??= value.opacity ?? 100;
    note.todos = (note.todos || []).map(todo => ({ status: todo.done ? 'done' : (todo.status || 'todo'), notes: todo.notes || '', subtasks: todo.subtasks || [], ...todo }));
  });
  return { ...value, schemaVersion: 2, notes, archive: value.archive || [], trash: value.trash || [], shortcut: value.shortcut || 'CommandOrControl+Shift+Space' };
}

function reminderStatePath() {
  return path.join(app.getPath('userData'), 'reminder-state.json');
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const value = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (value.width >= MIN_WINDOW_WIDTH && value.height >= MIN_WINDOW_HEIGHT) return value;
  } catch {}
  return { width: 390, height: 620 };
}

function saveWindowState(bounds = mainWindow?.getBounds()) {
  if (!bounds || edgeHidden || movingForDock) return;
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    try { fs.writeFileSync(windowStatePath(), JSON.stringify(bounds, null, 2), 'utf8'); } catch {}
  }, 300);
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function readReminderState() {
  try { return JSON.parse(fs.readFileSync(reminderStatePath(), 'utf8')); } catch { return {}; }
}

function checkReminders() {
  if (!Notification.isSupported()) return;
  const data = readData();
  const ledger = readReminderState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let changed = false;
  const allTodos = Array.isArray(data.notes) ? data.notes.flatMap(note => (note.todos || []).map(todo => ({ todo, note }))) : (data.todos || []).map(todo => ({ todo, note: null }));
  for (const { todo, note } of allTodos) {
    if (todo.done || !todo.due) continue;
    const due = parseLocalDate(todo.due);
    if (!due) continue;
    const days = Math.round((due - today) / 86400000);
    if (days > 1) continue;
    const reminderKind = days === 1 ? 'tomorrow' : days === 0 ? 'today' : 'overdue';
    const key = `${todo.id}:${localDateKey(today)}:${reminderKind}`;
    if (ledger[key]) continue;
    const body = days === 1 ? `“${todo.text}”将在明天截止` : days === 0 ? `“${todo.text}”今天截止` : `“${todo.text}”已逾期`;
    const notification = new Notification({ title: note?.name || '桌面便签待办', body, silent: false, actions: [{ type: 'button', text: '完成' }, { type: 'button', text: '推迟一天' }], closeButtonText: '稍后' });
    notification.on('click', () => showMainWindow(true));
    notification.on('action', (_event, index) => mutateTodo(todo.id, index === 0 ? 'done' : 'tomorrow'));
    notification.show();
    ledger[key] = Date.now();
    changed = true;
  }
  if (changed) fs.writeFileSync(reminderStatePath(), JSON.stringify(ledger, null, 2), 'utf8');
}

function showMainWindow(focusAdd = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (edgeHidden) revealFromEdge();
  mainWindow.show();
  mainWindow.focus();
  if (focusAdd) mainWindow.webContents.send('focus:add');
}

function createTray() {
  if (tray) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#FFF3A6"/><path d="M9 16l5 5 10-12" fill="none" stroke="#29271f" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 }));
  tray.setToolTip('桌面便签待办');
  refreshTrayMenu();
  tray.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : showMainWindow(false));
}

function refreshTrayMenu() {
  if (!tray) return;
  const data = readData();
  const active = (data.notes || []).flatMap(note => (note.todos || []).filter(todo => !todo.done && todo.status !== 'done').map(todo => ({ ...todo, noteName: note.name }))).sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))).slice(0, 6);
  const taskItems = active.length ? active.map(todo => ({ label: `${todo.text} · ${todo.noteName}`, submenu: [{ label: '完成', click: () => mutateTodo(todo.id, 'done') }, { label: '推迟一天', click: () => mutateTodo(todo.id, 'tomorrow') }, { label: '打开', click: () => showMainWindow(false) }] })) : [{ label: '暂无待办', enabled: false }];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示便签', click: () => showMainWindow(false) },
    { label: '快速记录', accelerator: activeShortcut || undefined, click: () => showMainWindow(true) },
    { label: '近期任务', submenu: taskItems },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function dataCandidates() {
  if (process.env.STICKY_TEST_DATA_PATH) return [path.resolve(process.env.STICKY_TEST_DATA_PATH)];
  const candidates = [
    dataPath(),
    path.join(app.getPath('appData'), 'floating-sticky-todos', 'sticky-todos.json'),
    path.join(app.getPath('appData'), '桌面便签待办', 'sticky-todos.json')
  ];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, '桌面便签待办数据.json'));
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'sticky-todos.json'));
  }
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function readData() {
  const found = [];
  for (const candidate of dataCandidates()) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (value && (Array.isArray(value.todos) || Array.isArray(value.notes))) found.push({ value: migrateData(value, candidate), modified: fs.statSync(candidate).mtimeMs });
    } catch {
      try {
        const backup = `${candidate}.bak`;
        const value = JSON.parse(fs.readFileSync(backup, 'utf8'));
        if (value && (Array.isArray(value.todos) || Array.isArray(value.notes))) found.push({ value: migrateData(value, backup), modified: fs.statSync(backup).mtimeMs });
      } catch {}
    }
  }
  if (!found.length) return { todos: [], color: '#FFF3A6', alwaysOnTop: false };
  const withUpdateTime = found.filter(item => Number.isFinite(item.value.updatedAt));
  const chosen = withUpdateTime.length
    ? withUpdateTime.sort((a, b) => b.value.updatedAt - a.value.updatedAt)[0]
    : found.sort((a, b) => {
        const aCount = Array.isArray(a.value.notes) ? a.value.notes.reduce((sum, note) => sum + (note.todos?.length || 0), 0) : (a.value.todos?.length || 0);
        const bCount = Array.isArray(b.value.notes) ? b.value.notes.reduce((sum, note) => sum + (note.todos?.length || 0), 0) : (b.value.todos?.length || 0);
        return bCount - aCount || b.modified - a.modified;
      })[0];
  return chosen.value;
}

function writeData(data, sync = true) {
  const persisted = { ...data, schemaVersion: 2, updatedAt: Date.now() };
  const json = JSON.stringify(persisted, null, 2);
  const targets = [dataPath()];
  if (process.env.PORTABLE_EXECUTABLE_DIR) targets.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, '桌面便签待办数据.json'));
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, json, 'utf8');
      fs.renameSync(temporary, target);
    } catch (error) {
      console.warn(`Could not save backup to ${target}:`, error.message);
    }
  }
  refreshTrayMenu();
  if (sync) scheduleCloudUpload();
}

function findTodo(data, id) {
  for (const note of data.notes || []) {
    const todo = (note.todos || []).find(item => item.id === id);
    if (todo) return { note, todo };
  }
  return null;
}

function mutateTodo(id, action) {
  const data = readData(); const found = findTodo(data, id); if (!found) return;
  if (action === 'done') { found.todo.done = true; found.todo.status = 'done'; found.todo.completedAt = Date.now(); }
  if (action === 'tomorrow') { const date = parseLocalDate(found.todo.due) || new Date(); date.setDate(date.getDate() + 1); found.todo.due = localDateKey(date); }
  writeData(data); mainWindow?.webContents.send('data:changed', data);
}

function registerQuickShortcut(accelerator) {
  if (accelerator === activeShortcut) return activeShortcut;
  const previous = activeShortcut;
  try {
    if (!accelerator || !globalShortcut.register(accelerator, () => showMainWindow(true))) return null;
    if (previous) globalShortcut.unregister(previous);
    activeShortcut = accelerator;
  } catch { return null; }
  return activeShortcut;
}

function createWindow() {
  const saved = readData();
  const savedWindow = readWindowState();
  mainWindow = new BrowserWindow({
    ...savedWindow,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    frame: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'none',
    resizable: true,
    thickFrame: true,
    alwaysOnTop: Boolean(saved.alwaysOnTop),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  if (process.env.STICKY_CAPTURE_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (process.env.STICKY_CAPTURE_VIEW === 'notes') await mainWindow.webContents.executeJavaScript(`document.getElementById('noteStackBtn').click()`);
      if (process.env.STICKY_CAPTURE_VIEW === 'notes-outside') await mainWindow.webContents.executeJavaScript(`document.getElementById('noteStackBtn').click(); document.querySelector('.summary').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      if (process.env.STICKY_CAPTURE_VIEW === 'edit') await mainWindow.webContents.executeJavaScript(`document.querySelector('.todo-title')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      if (['space', 'board', 'calendar', 'search'].includes(process.env.STICKY_CAPTURE_VIEW)) {
        mainWindow.setSize(900, 700);
        await mainWindow.webContents.executeJavaScript(process.env.STICKY_CAPTURE_VIEW === 'search' ? `document.getElementById('searchBtn').click()` : `document.querySelector('[data-view="${process.env.STICKY_CAPTURE_VIEW}"]').click()`);
      }
      if (['board-narrow', 'calendar-narrow'].includes(process.env.STICKY_CAPTURE_VIEW)) {
        mainWindow.setSize(360, 700);
        const view = process.env.STICKY_CAPTURE_VIEW.replace('-narrow', '');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      const image = await mainWindow.capturePage();
      fs.writeFileSync(process.env.STICKY_CAPTURE_PATH, image.toPNG());
      app.quit();
    });
  }
  if (process.env.STICKY_EDGE_TEST_DIR) {
    mainWindow.webContents.once('did-finish-load', () => {
      dockEdge = 'right';
      hideToEdge();
      setTimeout(async () => {
        const hidden = await mainWindow.capturePage();
        fs.writeFileSync(path.join(process.env.STICKY_EDGE_TEST_DIR, 'edge-hidden.png'), hidden.toPNG());
        const hiddenBounds = mainWindow.getBounds();
        await mainWindow.webContents.executeJavaScript(`window.stickyAPI.startEdgeTabDrag(100, 100); for (let y = 104; y <= 180; y += 4) window.stickyAPI.moveEdgeTabDrag(100, y); window.stickyAPI.endEdgeTabDrag()`);
        await new Promise(resolve => setTimeout(resolve, 100));
        const draggedBounds = mainWindow.getBounds();
        await mainWindow.webContents.executeJavaScript(`const tab = document.getElementById('edgeTab'); tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, screenX: 100, screenY: 180 })); tab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, screenX: 100, screenY: 180 }))`);
        setTimeout(async () => {
          const revealed = await mainWindow.capturePage();
          fs.writeFileSync(path.join(process.env.STICKY_EDGE_TEST_DIR, 'edge-revealed.png'), revealed.toPNG());
          const revealedBounds = mainWindow.getBounds();
          hideToEdge();
          fs.writeFileSync(path.join(process.env.STICKY_EDGE_TEST_DIR, 'edge-bounds.json'), JSON.stringify({ hiddenBounds, draggedBounds, revealedBounds, dockEdgeAfterReveal: dockEdge, boundsAfterHideAttempt: mainWindow.getBounds(), resizableAfterReveal: mainWindow.isResizable(), minimumSizeAfterReveal: mainWindow.getMinimumSize() }, null, 2));
          app.quit();
        }, 500);
      }, 500);
    });
  }
  if (process.env.STICKY_V2_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      await mainWindow.webContents.executeJavaScript(`
        document.querySelector('[data-view="board"]').click();
        document.querySelector('.board-card[data-id="task-a"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        document.querySelector('.board-column[data-status="doing"]').dispatchEvent(new DragEvent('drop', { bubbles: true }));
      `);
      await new Promise(resolve => setTimeout(resolve, 250));
      await mainWindow.webContents.executeJavaScript(`
        document.querySelector('[data-view="list"]').click();
        document.querySelector('.todo-item[data-id="task-a"] .todo-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        document.getElementById('editNotes').value = '自动测试备注';
        document.getElementById('addSubtaskBtn').click();
        [...document.querySelectorAll('.subtask-row input[type="text"]')].at(-1).value = '自动测试子任务';
        document.getElementById('editForm').requestSubmit();
      `);
      await new Promise(resolve => setTimeout(resolve, 300));
      await mainWindow.webContents.executeJavaScript(`
        document.querySelector('[data-view="calendar"]').click();
        document.querySelector('.calendar-task[data-id="task-c"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        document.querySelector('.calendar-day[data-date="2026-09-30"]').dispatchEvent(new DragEvent('drop', { bubbles: true }));
      `);
      await new Promise(resolve => setTimeout(resolve, 250));
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('searchBtn').click();
        document.getElementById('searchScope').value = 'trash';
        document.getElementById('searchScope').dispatchEvent(new Event('change'));
        document.querySelector('.search-actions button').click();
      `);
      await new Promise(resolve => setTimeout(resolve, 250));
      const data = readData(); const found = findTodo(data, 'task-a'); const moved = findTodo(data, 'task-c');
      fs.writeFileSync(process.env.STICKY_V2_TEST_PATH, JSON.stringify({ status: found?.todo.status, notes: found?.todo.notes, subtasks: found?.todo.subtasks, calendarDue: moved?.todo.due, restoredTrashItem: Boolean(findTodo(data, 'trash-a')), trashCount: data.trash?.length, schemaVersion: data.schemaVersion }, null, 2));
      app.quit();
    });
  }
  if (process.env.STICKY_201_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      await mainWindow.webContents.executeJavaScript(`
        document.querySelector('[data-view="space"]').click();
        document.querySelector('.space-task[data-id="task-a"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        document.querySelector('.space-card[data-note-id="note-b"]').dispatchEvent(new DragEvent('drop', { bubbles: true }));
      `);
      await new Promise(resolve => setTimeout(resolve, 250));
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('settingsBtn').click();
        const input = document.getElementById('shortcutInput'); input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, altKey: true, bubbles: true }));
      `);
      await new Promise(resolve => setTimeout(resolve, 300));
      const data = readData(); const moved = findTodo(data, 'task-a');
      fs.writeFileSync(process.env.STICKY_201_TEST_PATH, JSON.stringify({ movedToNote: moved?.note.id, shortcut: data.shortcut }, null, 2));
      app.quit();
    });
  }
  if (process.env.STICKY_BOARD_ORDER_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      const order = await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="board"]').click(); [...document.querySelectorAll('.board-column[data-status="todo"] .board-card')].map(card => card.dataset.id)`);
      fs.writeFileSync(process.env.STICKY_BOARD_ORDER_TEST_PATH, JSON.stringify(order));
      app.quit();
    });
  }
  if (process.env.STICKY_CALENDAR_STYLE_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 400)); mainWindow.setSize(360, 700);
      const result = await mainWindow.webContents.executeJavaScript(`
        document.querySelector('[data-view="calendar"]').click();
        ({ columns: getComputedStyle(document.getElementById('calendarGrid')).gridTemplateColumns.split(' ').length,
           weekend: document.querySelector('[data-date="2026-09-06"]').className,
           adjustedWorkday: document.querySelector('[data-date="2026-09-20"]').className,
           holiday: document.querySelector('[data-date="2026-09-25"]').className,
           holidayName: document.querySelector('[data-date="2026-09-25"] .holiday-name')?.textContent })
      `);
      fs.writeFileSync(process.env.STICKY_CALENDAR_STYLE_TEST_PATH, JSON.stringify(result, null, 2)); app.quit();
    });
  }
  if (process.env.STICKY_RENAME_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      const ui = await mainWindow.webContents.executeJavaScript(`
        document.getElementById('noteStackBtn').click();
        document.querySelector('.note-card[data-note-id="note-a"] .note-rename').click();
        const input = document.querySelector('.note-card[data-note-id="note-a"] .note-name-input');
        const inlineEditorOpened = Boolean(input); input.value = '已重命名便签';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        new Promise(resolve => setTimeout(() => resolve({ inlineEditorOpened, drawerOpen: document.getElementById('noteDrawer').classList.contains('open') }), 250));
      `);
      const data = readData();
      fs.writeFileSync(process.env.STICKY_RENAME_TEST_PATH, JSON.stringify({ ...ui, savedName: data.notes.find(note => note.id === 'note-a')?.name }, null, 2)); app.quit();
    });
  }
  if (process.env.STICKY_RESIZE_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const before = mainWindow.getBounds();
      await mainWindow.webContents.executeJavaScript(`window.stickyAPI.startResize('right', 100, 100)`);
      setTimeout(async () => {
        await mainWindow.webContents.executeJavaScript(`window.stickyAPI.moveResize(200, 100)`);
        setTimeout(async () => {
          await mainWindow.webContents.executeJavaScript(`window.stickyAPI.endResize()`);
          fs.writeFileSync(process.env.STICKY_RESIZE_TEST_PATH, JSON.stringify({ before, after: mainWindow.getBounds() }, null, 2));
          app.quit();
        }, 200);
      }, 80);
    });
  }
  if (process.env.STICKY_MINIMIZE_TEST_PATH) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const before = mainWindow.getBounds();
      await mainWindow.webContents.executeJavaScript(`window.stickyAPI.minimize()`);
      setTimeout(() => {
        fs.writeFileSync(process.env.STICKY_MINIMIZE_TEST_PATH, JSON.stringify({ before, after: mainWindow.getBounds(), edgeHidden, dockEdge }, null, 2));
        app.quit();
      }, 500);
    });
  }

  const updateDockState = () => {
    if (movingForDock || edgeHidden) return;
    const bounds = mainWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const nearTop = bounds.y <= area.y + SNAP_DISTANCE;
    const nearRight = bounds.x + bounds.width >= area.x + area.width - SNAP_DISTANCE;
    dockEdge = nearTop ? 'top' : nearRight ? 'right' : null;
    mainWindow.webContents.send('edge:dock-change', { edge: dockEdge, hidden: false });
    saveWindowState(bounds);
  };
  mainWindow.on('will-move', () => { userMovingWindow = true; });
  mainWindow.on('move', updateDockState);
  mainWindow.on('moved', () => { userMovingWindow = false; updateDockState(); });
  mainWindow.on('resize', () => saveWindowState());
}

function animateWindowBounds(from, to, duration, finished) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(timer); return; }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = key => Math.round(from[key] + (to[key] - from[key]) * eased);
    mainWindow.setBounds({ x: value('x'), y: value('y'), width: value('width'), height: value('height') }, false);
    if (progress === 1) {
      clearInterval(timer);
      finished?.();
    }
  }, 16);
}

function hideToEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || !dockEdge || edgeHidden || userMovingWindow || Date.now() < revealCooldownUntil) return;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  expandedBounds = bounds;
  movingForDock = true;
  edgeHidden = true;
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.webContents.send('edge:dock-change', { edge: dockEdge, hidden: true });
  setTimeout(() => {
    mainWindow.setMinimumSize(1, 1);
    let target;
    const cursor = screen.getCursorScreenPoint();
    if (dockEdge === 'top') {
      const x = Math.min(Math.max(cursor.x - Math.round(TAB_LONG / 2), area.x), area.x + area.width - TAB_LONG);
      target = { x, y: area.y, width: TAB_LONG, height: TAB_SHORT };
    } else {
      const y = Math.min(Math.max(cursor.y - Math.round(TAB_SHORT / 2), area.y), area.y + area.height - TAB_SHORT);
      target = { x: area.x + area.width - TAB_LONG, y, width: TAB_LONG, height: TAB_SHORT };
    }
    animateWindowBounds(bounds, target, 160, () => {
      movingForDock = false;
      setTimeout(() => {
        if (!edgeHidden) return;
        mainWindow.blur();
        mainWindow.moveTop();
      }, 40);
    });
  }, 16);
}

function revealFromEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || !dockEdge || !edgeHidden) return;
  const revealedFrom = dockEdge;
  const tabBounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(tabBounds).workArea;
  const target = expandedBounds || { x: area.x + area.width - 390, y: area.y + 30, width: 390, height: 620 };
  movingForDock = true;
  if (revealedFrom === 'top') {
    target.x = Math.min(Math.max(target.x, area.x), area.x + area.width - target.width);
    target.y = area.y + REVEAL_INSET;
  } else {
    target.x = area.x + area.width - target.width - REVEAL_INSET;
    target.y = Math.min(Math.max(target.y, area.y), area.y + area.height - target.height);
  }
  mainWindow.setBounds(target, true);
  mainWindow.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
  edgeHidden = false;
  revealCooldownUntil = Date.now() + 2000;
  dockEdge = null;
  mainWindow.setAlwaysOnTop(Boolean(readData().alwaysOnTop));
  saveWindowState(target);
  mainWindow.webContents.send('edge:dock-change', { edge: null, hidden: false });
  mainWindow.focus();
  setTimeout(() => { movingForDock = false; }, 250);
}

function minimizeToRightEdge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (edgeHidden) return;
  dockEdge = 'right';
  userMovingWindow = false;
  revealCooldownUntil = 0;
  mainWindow.webContents.send('edge:dock-change', { edge: 'right', hidden: false });
  hideToEdge();
}

app.whenReady().then(() => {
  loadCloudAuth();
  ipcMain.handle('data:load', () => readData());
  ipcMain.handle('data:save', (_event, data) => {
    writeData(data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(Boolean(data.alwaysOnTop));
      mainWindow.setBackgroundColor('#00000000');
    }
    return true;
  });
  ipcMain.handle('data:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出便签数据', defaultPath: `桌面便签备份-${localDateKey()}.json`, filters: [{ name: 'JSON 数据', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(readData(), null, 2), 'utf8'); return result.filePath;
  });
  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入便签数据', properties: ['openFile'], filters: [{ name: 'JSON 数据', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const incoming = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    if (!Array.isArray(incoming.notes) && !Array.isArray(incoming.todos)) throw new Error('不是有效的便签数据文件');
    try { createSnapshot(dataPath(), '导入前'); } catch {}
    const migrated = migrateData(incoming, result.filePaths[0]); writeData(migrated); return migrated;
  });
  ipcMain.handle('data:backup', () => createSnapshot(dataPath(), '手动备份'));
  ipcMain.handle('sync:status', () => ({ signedIn: Boolean(cloudAuth), email: cloudAuth?.email || null, active: cloudSyncEnabled }));
  ipcMain.handle('sync:auth', (_event, mode, email, password, displayName) => authenticateCloud(mode, String(email || '').trim(), String(password || ''), String(displayName || '')));
  ipcMain.handle('sync:resend-verification', (_event, email, password) => resendCloudVerification(String(email || '').trim(), String(password || '')));
  ipcMain.handle('sync:forgot-password', (_event, email) => sendCloudPasswordReset(String(email || '').trim()));
  ipcMain.handle('sync:now', () => syncCloudNow());
  ipcMain.handle('sync:logout', () => { cloudSyncEnabled = false; saveCloudAuth(null); return true; });
  ipcMain.handle('shortcut:set', (_event, accelerator) => {
    const registered = registerQuickShortcut(String(accelerator || '').trim());
    refreshTrayMenu(); return registered;
  });
  ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('autostart:set', (_event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath
    });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.on('window:minimize', minimizeToRightEdge);
  ipcMain.on('window:close', () => mainWindow?.hide());
  ipcMain.on('edge:hide', hideToEdge);
  ipcMain.on('edge:reveal', revealFromEdge);
  ipcMain.on('edge-tab:drag-start', (_event, payload) => {
    if (!mainWindow || !edgeHidden) return;
    edgeTabDrag = { startX: payload.x, startY: payload.y, bounds: mainWindow.getBounds() };
  });
  ipcMain.on('edge-tab:drag-move', (_event, payload) => {
    if (!mainWindow || !edgeHidden || !edgeTabDrag) return;
    const area = screen.getDisplayMatching(edgeTabDrag.bounds).workArea;
    // Keep the requested DIP size constant. Reusing getBounds() dimensions here
    // causes cumulative 1 px growth on fractional Windows display scaling.
    const width = TAB_LONG;
    const height = TAB_SHORT;
    if (dockEdge === 'top') {
      const x = Math.min(Math.max(edgeTabDrag.bounds.x + Math.round(payload.x - edgeTabDrag.startX), area.x), area.x + area.width - width);
      mainWindow.setBounds({ x, y: area.y, width, height }, false);
      if (expandedBounds) expandedBounds.x = Math.min(Math.max(x, area.x), area.x + area.width - expandedBounds.width);
    } else {
      const y = Math.min(Math.max(edgeTabDrag.bounds.y + Math.round(payload.y - edgeTabDrag.startY), area.y), area.y + area.height - height);
      mainWindow.setBounds({ x: area.x + area.width - width, y, width, height }, false);
      if (expandedBounds) expandedBounds.y = Math.min(Math.max(y, area.y), area.y + area.height - expandedBounds.height);
    }
  });
  ipcMain.on('edge-tab:drag-end', () => { edgeTabDrag = null; });
  ipcMain.on('resize:start', (_event, payload) => {
    if (!mainWindow || edgeHidden) return;
    resizeSession = { edge: payload.edge, startX: payload.x, startY: payload.y, bounds: mainWindow.getBounds() };
  });
  ipcMain.on('resize:move', (_event, payload) => {
    if (!mainWindow || !resizeSession || edgeHidden) return;
    const start = resizeSession.bounds;
    const dx = Math.round(payload.x - resizeSession.startX);
    const dy = Math.round(payload.y - resizeSession.startY);
    const next = { ...start };
    if (resizeSession.edge.includes('left')) {
      const right = start.x + start.width;
      next.x = Math.min(start.x + dx, right - MIN_WINDOW_WIDTH);
      next.width = right - next.x;
    }
    if (resizeSession.edge.includes('right')) next.width = Math.max(MIN_WINDOW_WIDTH, start.width + dx);
    if (resizeSession.edge.includes('top')) {
      const bottom = start.y + start.height;
      next.y = Math.min(start.y + dy, bottom - MIN_WINDOW_HEIGHT);
      next.height = bottom - next.y;
    }
    if (resizeSession.edge.includes('bottom')) next.height = Math.max(MIN_WINDOW_HEIGHT, start.height + dy);
    mainWindow.setBounds(next, false);
  });
  ipcMain.on('resize:end', () => { resizeSession = null; });
  createWindow();
  registerQuickShortcut(readData().shortcut || 'CommandOrControl+Shift+Space');
  createTray();
  setTimeout(checkReminders, 2500);
  setInterval(checkReminders, 30 * 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the system tray for reminders.
});

app.on('before-quit', () => { isQuitting = true; globalShortcut.unregisterAll(); });

// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
const DROPBOX_FILE = '/memo-app/memos.json';
const BACKUP_DIR = '/memo-app/backups';
const BACKUP_MAX = 10;
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
let trash = []; // 휴지통: { type: 'memo'|'folder', data: {...}, deletedAt: timestamp }
let deletedIds = []; // 영구 삭제된 항목: { id, at } (동기화 시 복귀 차단, 90일 후 자동 정리)
let currentId = null;
let currentFolder = null; // null = all
let accessToken = localStorage.getItem('dbx_token') || null;
let isOnline = !!accessToken;
let viewerMode = false;
let saveTimer = null;
const unlockedFolders = new Set(); // 현재 세션에서 잠금 해제된 폴더
let masterPasswordHash = null;
let undoStack = [];
let undoTimer = null;
const UNDO_MAX = 50;

// ── DOM ──
const $ = (s) => document.querySelector(s);
const loginScreen = $('#login-screen');
const app = $('#app');
const memoList = $('#memo-list');
const folderList = $('#folder-list');
const editor = $('#editor');
const titleInput = $('#memo-title-input');
const folderSelect = $('#memo-folder-select');
const searchBox = $('#search-box');
const syncStatus = $('#sync-status');
const toast = $('#toast');
const editorToolbar = $('#editor-toolbar');
const editorContainer = $('#editor-container');
const emptyState = $('#empty-state');

// ── Init ──
document.addEventListener('DOMContentLoaded', init);

function init() {
  // 모바일 세로 모드 고정
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (e) {}

  handleOAuthCallback();
  loadLocalData();

  // URL 파라미터로 특정 메모 열기 (새 창)
  const urlParams = new URLSearchParams(location.search);
  const openMemoId = urlParams.get('memo');

  if (accessToken) {
    showApp();
    syncFromDropbox();
  }

  $('#btn-login').addEventListener('click', loginDropbox);
  $('#btn-offline').addEventListener('click', (e) => {
    e.preventDefault();
    isOnline = false;
    showApp();
  });
  $('#btn-new').addEventListener('click', createMemo);
  $('#btn-backup').addEventListener('click', createBackup);
  $('#btn-folder-toggle').addEventListener('click', toggleFolderDropdown);
  $('#btn-folder-add').addEventListener('click', showFolderDialog);
  $('#btn-sync').addEventListener('click', () => {
    if (!accessToken) { loginDropbox(); return; }
    syncFromDropbox();
  });
  $('#btn-logout').addEventListener('click', confirmLogout);
  $('#btn-master-pw').addEventListener('click', showMasterPasswordDialog);
  $('#btn-master-unlock').addEventListener('click', showMasterUnlockPrompt);
  $('#btn-trash').addEventListener('click', showTrashView);
  $('#btn-fav').addEventListener('click', toggleFavorite);
  $('#btn-undo').addEventListener('click', performUndo);
  $('#btn-viewer').addEventListener('click', toggleViewer);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#menu-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  // 에디터 영역 클릭: 사이드바 열려있으면 닫기만, 아니면 빈 화면에서 새 글
  $('#editor-area').addEventListener('click', (e) => {
    const sidebar = $('#sidebar');
    if (sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      e.stopPropagation();
      return;
    }
    if (emptyState.style.display !== 'none' && emptyState.contains(e.target)) {
      createMemo();
    }
  });

  editor.addEventListener('input', onEditorInput);
  titleInput.addEventListener('input', onTitleInput);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
  });
  folderSelect.addEventListener('change', onFolderSelectChange);
  searchBox.addEventListener('input', renderMemoList);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveNow();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      createMemo();
    }
  });

  // 새 창으로 열린 경우 해당 메모 바로 표시
  if (openMemoId) {
    const memo = memos.find((m) => m.id === openMemoId);
    if (memo) {
      if (!accessToken) { isOnline = false; showApp(); }
      loadMemoInEditor(memo);
      // 새 창에서는 사이드바 숨기기
      document.body.classList.add('popup-mode');
    }
  }
}

// ── OAuth ──
function loginDropbox() {
  const state = crypto.randomUUID();
  sessionStorage.setItem('oauth_state', state);
  const params = new URLSearchParams({
    client_id: DROPBOX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'token',
    token_access_type: 'legacy',
    scope: 'files.content.read files.content.write files.metadata.read files.metadata.write',
    state,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
}

function handleOAuthCallback() {
  const hash = location.hash.substring(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const token = params.get('access_token');
  const state = params.get('state');
  if (token && state === sessionStorage.getItem('oauth_state')) {
    accessToken = token;
    isOnline = true;
    localStorage.setItem('dbx_token', token);
    sessionStorage.removeItem('oauth_state');
    history.replaceState(null, '', location.pathname);
  }
}

function logout() {
  accessToken = null;
  isOnline = false;
  localStorage.removeItem('dbx_token');
  location.reload();
}

function confirmLogout() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>로그아웃 하시겠습니까?</p>
      <div>
        <button class="btn btn-secondary" id="logout-cancel">취소</button>
        <button class="btn btn-primary" id="logout-ok">로그아웃</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#logout-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#logout-ok').onclick = () => { overlay.remove(); logout(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Dropbox API ──
async function dbxUpload(content) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: DROPBOX_FILE,
        mode: 'overwrite',
        mute: true,
      }),
    },
    body: content,
  });
  if (res.status === 401) {
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxDownload() {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_FILE }),
    },
  });
  if (res.status === 409 || res.status === 404) return null;
  if (res.status === 401) {
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (!res.ok) throw new Error('download failed: ' + res.status);
  return res.json();
}

// ── Backup ──
async function createBackup() {
  if (!accessToken) {
    showToast('Dropbox에 로그인 후 이용하세요');
    return;
  }
  const btn = $('#btn-backup');
  btn.disabled = true;
  showToast('백업 중...');

  try {
    // 백업 파일명: 날짜시간
    const now = new Date();
    const ts = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_' + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const backupPath = BACKUP_DIR + '/backup_' + ts + '.json';
    const obj = { memos, folders };
    if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
    const data = JSON.stringify(obj, null, 2);

    // 백업 파일 업로드
    await dbxUploadTo(backupPath, data);

    // 기존 백업 파일 목록 조회 후 오래된 것 삭제
    await pruneBackups();

    showToast('백업 완료!');
  } catch (e) {
    console.error('Backup error:', e);
    showToast('백업 실패');
  } finally {
    btn.disabled = false;
  }
}

async function dbxUploadTo(path, content) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', mute: true }),
    },
    body: content,
  });
  if (res.status === 401) { logout(); throw new Error('auth expired'); }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxListFolder(path) {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path, recursive: false }),
  });
  if (res.status === 409 || res.status === 404) return [];
  if (!res.ok) throw new Error('list failed: ' + res.status);
  const data = await res.json();
  return data.entries || [];
}

async function dbxDelete(path) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error('delete failed: ' + res.status);
}

async function pruneBackups() {
  const entries = await dbxListFolder(BACKUP_DIR);
  const backups = entries
    .filter((e) => e['.tag'] === 'file' && e.name.startsWith('backup_'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 10개 초과 시 오래된 것부터 삭제
  while (backups.length > BACKUP_MAX) {
    const old = backups.shift();
    await dbxDelete(old.path_lower);
  }
}

// ── Sync ──
async function syncFromDropbox() {
  if (!accessToken) return;
  setSyncStatus('syncing', '동기화 중...');
  try {
    const remote = await dbxDownload();
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      if (Array.isArray(remote.deletedIds)) deletedIds = mergeDeletedIds(deletedIds, remote.deletedIds);
      if (Array.isArray(remote.trash)) trash = mergeTrash(trash, remote.trash);
      if (Array.isArray(remote.memos)) memos = mergeMemos(memos, remote.memos);
      if (Array.isArray(remote.folders)) folders = mergeFolders(folders, remote.folders);
      if (remote.masterPassword && !masterPasswordHash) masterPasswordHash = remote.masterPassword;
    } else if (remote && Array.isArray(remote)) {
      memos = mergeMemos(memos, remote);
    }
    saveLocalData();
    await syncToDropbox();
    setSyncStatus('synced', '동기화 완료');
    renderAll();
    if (currentId) {
      const memo = memos.find((m) => m.id === currentId);
      if (memo) loadMemoInEditor(memo);
    }
  } catch (e) {
    console.error('Sync error:', e);
    setSyncStatus('error', '동기화 실패');
  }
}

async function syncToDropbox() {
  if (!accessToken) return;
  const obj = { memos, folders, trash, deletedIds };
  if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
  const data = JSON.stringify(obj, null, 2);
  await dbxUpload(data);
}

function mergeMemos(local, remote) {
  const map = new Map();
  for (const m of remote) map.set(m.id, m);
  for (const m of local) {
    const existing = map.get(m.id);
    if (!existing || m.updatedAt > existing.updatedAt) {
      map.set(m.id, m);
    }
  }
  const trashMemoIds = new Set(trash.filter((t) => t.type === 'memo').map((t) => t.data.id));
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  return Array.from(map.values())
    .filter((m) => !m.deleted && !trashMemoIds.has(m.id) && !permDelIds.has(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeFolders(local, remote) {
  const trashFolderIds = new Set(trash.filter((t) => t.type === 'folder').map((t) => t.data.id));
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const f of remote) { if (!trashFolderIds.has(f.id) && !permDelIds.has(f.id)) map.set(f.id, f); }
  for (const f of local) {
    if (!map.has(f.id) && !trashFolderIds.has(f.id) && !permDelIds.has(f.id)) map.set(f.id, f);
  }
  const result = Array.from(map.values());
  result.forEach((f, i) => { if (f.sortOrder === undefined) f.sortOrder = i; });
  return result.sort(sortBySortOrder);
}

function mergeTrash(local, remote) {
  const map = new Map();
  for (const t of remote) map.set(t.data.id + '_' + t.type, t);
  for (const t of local) {
    const key = t.data.id + '_' + t.type;
    if (!map.has(key)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a, b) => b.deletedAt - a.deletedAt);
}

function mergeDeletedIds(local, remote) {
  const map = new Map();
  for (const d of remote) {
    const item = typeof d === 'string' ? { id: d, at: Date.now() } : d;
    map.set(item.id, item);
  }
  for (const d of local) {
    const item = typeof d === 'string' ? { id: d, at: Date.now() } : d;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  // 30일 지난 항목 자동 정리
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return Array.from(map.values()).filter((d) => d.at > cutoff);
}

// ── Local Storage ──
function saveLocalData() {
  localStorage.setItem('memos', JSON.stringify(memos));
  localStorage.setItem('folders', JSON.stringify(folders));
  localStorage.setItem('trash', JSON.stringify(trash));
  localStorage.setItem('deletedIds', JSON.stringify(deletedIds));
  if (masterPasswordHash) localStorage.setItem('master_pw', masterPasswordHash);
  else localStorage.removeItem('master_pw');
}

function loadLocalData() {
  try {
    const md = localStorage.getItem('memos');
    if (md) memos = JSON.parse(md);
    const fd = localStorage.getItem('folders');
    if (fd) folders = JSON.parse(fd);
    const td = localStorage.getItem('trash');
    if (td) trash = JSON.parse(td);
    const dd = localStorage.getItem('deletedIds');
    if (dd) deletedIds = JSON.parse(dd);
    masterPasswordHash = localStorage.getItem('master_pw') || null;
    // 마이그레이션: sortOrder 없는 폴더에 순번 부여
    folders.forEach((f, i) => { if (f.sortOrder === undefined) f.sortOrder = i; });
  } catch {}
}

function sortBySortOrder(a, b) { return (a.sortOrder ?? 999) - (b.sortOrder ?? 999); }

function getChildFolders(parentId) {
  return folders.filter((f) => f.parentId === parentId).sort(sortBySortOrder);
}

function getSiblingFolders(folderId) {
  const f = folders.find((x) => x.id === folderId);
  if (!f) return [];
  return folders.filter((x) => (x.parentId || null) === (f.parentId || null)).sort(sortBySortOrder);
}

function nextSortOrder(parentId) {
  const siblings = folders.filter((f) => (f.parentId || null) === (parentId || null));
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((f) => f.sortOrder ?? 0)) + 1;
}

function getFolderMemoCount(folderId) {
  const childIds = getChildFolders(folderId).map((f) => f.id);
  return memos.filter((m) => m.folder === folderId || childIds.includes(m.folder)).length;
}

function getDormantFolderIds() {
  const ids = new Set();
  for (const f of folders) {
    if (f.dormant) {
      ids.add(f.id);
      getChildFolders(f.id).forEach((c) => ids.add(c.id));
    }
    // 부모가 휴면이면 자식도 휴면
    if (f.parentId) {
      const parent = folders.find((p) => p.id === f.parentId);
      if (parent && parent.dormant) ids.add(f.id);
    }
  }
  return ids;
}

function toggleDormant(folderId) {
  const f = folders.find((x) => x.id === folderId);
  if (!f) return;
  f.dormant = !f.dormant;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast(f.dormant ? '휴면 처리되었습니다' : '휴면이 해제되었습니다');
}

// ── Folder Password ──
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isFolderLocked(folderId) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return false;
  if (f.password && !unlockedFolders.has(folderId)) return true;
  if (f.parentId) return isFolderLocked(f.parentId);
  return false;
}

function getLockedFolderIds() {
  return folders.filter((f) => isFolderLocked(f.id)).map((f) => f.id);
}

function showPasswordPrompt(folderId, onSuccess) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>🔒 "${escapeHtml(f.name)}" 폴더 비밀번호</p>
      <input type="password" id="pw-input" placeholder="비밀번호 입력" autofocus>
      <div>
        <button class="btn btn-secondary" id="pw-cancel">취소</button>
        <button class="btn btn-primary" id="pw-ok">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#pw-input');
  input.focus();

  const check = async () => {
    const hash = await hashPassword(input.value);
    if (hash === f.password || (masterPasswordHash && hash === masterPasswordHash)) {
      unlockedFolders.add(folderId);
      overlay.remove();
      if (onSuccess) onSuccess();
    } else {
      input.value = '';
      input.placeholder = '비밀번호가 틀렸습니다';
      input.classList.add('error');
    }
  };

  overlay.querySelector('#pw-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pw-ok').onclick = check;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showSetPasswordDialog(folderId) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return;
  const hasPassword = !!f.password;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${hasPassword ? '🔒 비밀번호 변경/해제' : '🔓 비밀번호 설정'} — "${escapeHtml(f.name)}"</p>
      ${hasPassword ? '<input type="password" id="pw-old" placeholder="현재 비밀번호" autofocus><br>' : ''}
      <input type="password" id="pw-new" placeholder="새 비밀번호 (해제하려면 비워두세요)" ${hasPassword ? '' : 'autofocus'}>
      <input type="password" id="pw-confirm" placeholder="새 비밀번호 확인">
      <div>
        <button class="btn btn-secondary" id="pw-cancel">취소</button>
        <button class="btn btn-primary" id="pw-ok">${hasPassword ? '변경' : '설정'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  (overlay.querySelector('#pw-old') || overlay.querySelector('#pw-new')).focus();

  const apply = async () => {
    // 기존 비밀번호 확인 (Master도 허용)
    if (hasPassword) {
      const oldInput = overlay.querySelector('#pw-old');
      const oldHash = await hashPassword(oldInput.value);
      if (oldHash !== f.password && !(masterPasswordHash && oldHash === masterPasswordHash)) {
        oldInput.value = '';
        oldInput.placeholder = '현재 비밀번호가 틀렸습니다';
        oldInput.classList.add('error');
        return;
      }
    }
    const newPw = overlay.querySelector('#pw-new').value;
    const confirmPw = overlay.querySelector('#pw-confirm').value;
    if (newPw === '' && confirmPw === '') {
      // 비밀번호 해제
      f.password = null;
      unlockedFolders.delete(folderId);
      showToast('비밀번호가 해제되었습니다');
    } else if (newPw !== confirmPw) {
      overlay.querySelector('#pw-confirm').value = '';
      overlay.querySelector('#pw-confirm').placeholder = '비밀번호가 일치하지 않습니다';
      overlay.querySelector('#pw-confirm').classList.add('error');
      return;
    } else {
      f.password = await hashPassword(newPw);
      unlockedFolders.add(folderId);
      showToast('비밀번호가 설정되었습니다');
    }
    saveLocalData();
    renderAll();
    scheduleSyncToDropbox();
    overlay.remove();
  };

  overlay.querySelector('#pw-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pw-ok').onclick = apply;
  overlay.querySelector('#pw-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Master Password ──
function showMasterPasswordDialog() {
  const hasMaster = !!masterPasswordHash;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${hasMaster ? '🔐 Master 변경/해제' : '🔐 Master 설정'}</p>
      ${hasMaster ? '<input type="password" id="mp-old" placeholder="현재 Master" autofocus>' : ''}
      <input type="password" id="mp-new" placeholder="새 Master (해제하려면 비워두세요)" ${hasMaster ? '' : 'autofocus'}>
      <input type="password" id="mp-confirm" placeholder="새 Master 확인">
      <div>
        <button class="btn btn-secondary" id="mp-cancel">취소</button>
        <button class="btn btn-primary" id="mp-ok">${hasMaster ? '변경' : '설정'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  (overlay.querySelector('#mp-old') || overlay.querySelector('#mp-new')).focus();

  const apply = async () => {
    if (hasMaster) {
      const oldInput = overlay.querySelector('#mp-old');
      const oldHash = await hashPassword(oldInput.value);
      if (oldHash !== masterPasswordHash) {
        oldInput.value = '';
        oldInput.placeholder = '현재 비밀번호가 틀렸습니다';
        oldInput.classList.add('error');
        return;
      }
    }
    const newPw = overlay.querySelector('#mp-new').value;
    const confirmPw = overlay.querySelector('#mp-confirm').value;
    if (newPw === '' && confirmPw === '') {
      masterPasswordHash = null;
      showToast('Master가 해제되었습니다');
    } else if (newPw !== confirmPw) {
      overlay.querySelector('#mp-confirm').value = '';
      overlay.querySelector('#mp-confirm').placeholder = '비밀번호가 일치하지 않습니다';
      overlay.querySelector('#mp-confirm').classList.add('error');
      return;
    } else {
      masterPasswordHash = await hashPassword(newPw);
      showToast('Master가 설정되었습니다');
    }
    saveLocalData();
    scheduleSyncToDropbox();
    overlay.remove();
  };

  overlay.querySelector('#mp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#mp-ok').onclick = apply;
  overlay.querySelector('#mp-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showMasterUnlockPrompt() {
  if (!masterPasswordHash) {
    showToast('Master가 설정되지 않았습니다');
    return;
  }
  const lockedIds = getLockedFolderIds();
  if (lockedIds.length === 0) {
    showToast('잠긴 폴더가 없습니다');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>🔐 Master로 전체 잠금 해제</p>
      <input type="password" id="mu-input" placeholder="Master" autofocus>
      <div>
        <button class="btn btn-secondary" id="mu-cancel">취소</button>
        <button class="btn btn-primary" id="mu-ok">해제</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#mu-input');
  input.focus();

  const check = async () => {
    const hash = await hashPassword(input.value);
    if (hash === masterPasswordHash) {
      lockedIds.forEach((id) => unlockedFolders.add(id));
      overlay.remove();
      renderAll();
      showToast('모든 폴더 잠금이 해제되었습니다');
    } else {
      input.value = '';
      input.placeholder = '비밀번호가 틀렸습니다';
      input.classList.add('error');
    }
  };

  overlay.querySelector('#mu-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#mu-ok').onclick = check;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Folder CRUD ──
function showFolderDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>새 폴더 이름</p>
      <input type="text" id="folder-name-input" placeholder="폴더 이름" autofocus>
      <div>
        <button class="btn btn-secondary" id="folder-cancel">취소</button>
        <button class="btn btn-primary" id="folder-ok">만들기</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#folder-name-input');
  input.focus();

  const create = () => {
    const name = input.value.trim();
    if (name) {
      // 현재 폴더가 최상위 폴더이면 하위 폴더로 생성, 아니면 최상위로
      let parentId = null;
      if (currentFolder && currentFolder !== '__none__') {
        const cur = folders.find((f) => f.id === currentFolder);
        if (cur && !cur.parentId) parentId = cur.id; // 최상위 폴더 아래에만 하위 생성
      }
      folders.push({ id: crypto.randomUUID(), name, parentId, sortOrder: nextSortOrder(parentId) });
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
    }
    overlay.remove();
  };

  overlay.querySelector('#folder-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#folder-ok').onclick = create;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function moveFolderUp(folderId) {
  const siblings = getSiblingFolders(folderId);
  const idx = siblings.findIndex((f) => f.id === folderId);
  if (idx <= 0) return;
  const temp = siblings[idx].sortOrder;
  siblings[idx].sortOrder = siblings[idx - 1].sortOrder;
  siblings[idx - 1].sortOrder = temp;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

function moveFolderDown(folderId) {
  const siblings = getSiblingFolders(folderId);
  const idx = siblings.findIndex((f) => f.id === folderId);
  if (idx < 0 || idx >= siblings.length - 1) return;
  const temp = siblings[idx].sortOrder;
  siblings[idx].sortOrder = siblings[idx + 1].sortOrder;
  siblings[idx + 1].sortOrder = temp;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

function showMoveFolderDialog(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  // 이동 가능한 대상: 최상위로 + 자기 자신과 자기 하위 폴더를 제외한 최상위 폴더
  const childIds = getChildFolders(id).map((f) => f.id);
  const topFolders = folders.filter((f) => !f.parentId && f.id !== id && !childIds.includes(f.id)).sort(sortBySortOrder);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let optionsHtml = `<option value="">-- 최상위 (이동 안 함) --</option>`;
  for (const f of topFolders) {
    const selected = folder.parentId === f.id ? ' selected' : '';
    optionsHtml += `<option value="${f.id}"${selected}>${escapeHtml(f.name)}</option>`;
  }
  overlay.innerHTML = `
    <div class="modal-box">
      <p>"${escapeHtml(folder.name)}" 폴더를 이동</p>
      <select id="move-folder-select" style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:0.9rem;outline:none;margin-bottom:16px;">
        ${optionsHtml}
      </select>
      <button class="btn btn-secondary" id="movef-cancel">취소</button>
      <button class="btn btn-primary" id="movef-ok">이동</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#movef-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#movef-ok').onclick = () => {
    const newParent = overlay.querySelector('#move-folder-select').value || null;
    folder.parentId = newParent;
    folder.sortOrder = nextSortOrder(newParent);
    saveLocalData();
    renderAll();
    scheduleSyncToDropbox();
    overlay.remove();
    showToast('폴더가 이동되었습니다');
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showRenameFolderDialog(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>폴더 이름 수정</p>
      <input type="text" id="rename-folder-input" value="${escapeHtml(folder.name)}" placeholder="폴더 이름">
      <button class="btn btn-secondary" id="rename-cancel">취소</button>
      <button class="btn btn-primary" id="rename-ok">확인</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#rename-folder-input');
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#rename-ok').click(); });
  overlay.querySelector('#rename-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#rename-ok').onclick = () => {
    const newName = input.value.trim();
    if (!newName) return;
    folder.name = newName;
    saveLocalData();
    renderAll();
    scheduleSyncToDropbox();
    overlay.remove();
    showToast('폴더 이름이 변경되었습니다');
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function confirmDeleteFolder(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  const childFolders = getChildFolders(id);
  const allIds = [id, ...childFolders.map((f) => f.id)];
  const folderMemos = memos.filter((m) => allIds.includes(m.folder));
  const childNote = childFolders.length > 0 ? '하위 폴더 ' + childFolders.length + '개, ' : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>"${escapeHtml(folder.name)}" 폴더를 삭제할까요?${(folderMemos.length > 0 || childFolders.length > 0) ? '<br><span style="font-size:0.85rem;color:var(--text2)">' + childNote + '메모 ' + folderMemos.length + '개도 휴지통으로 이동합니다.</span>' : ''}</p>
      <button class="btn btn-secondary" id="fdel-cancel">취소</button>
      <button class="btn btn-primary" id="fdel-ok">삭제</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#fdel-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#fdel-ok').onclick = () => {
    overlay.remove();
    deleteFolder(id);
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function deleteFolder(id) {
  const folder = folders.find((f) => f.id === id);
  const childFolders = getChildFolders(id);
  const allIds = [id, ...childFolders.map((f) => f.id)];
  // 폴더 + 하위 폴더 내 메모들을 휴지통으로 이동
  const folderMemos = memos.filter((m) => allIds.includes(m.folder));
  for (const m of folderMemos) {
    trash.push({ type: 'memo', data: { ...m }, deletedAt: Date.now() });
  }
  memos = memos.filter((m) => !allIds.includes(m.folder));
  // 하위 폴더 휴지통으로
  for (const cf of childFolders) {
    trash.push({ type: 'folder', data: { ...cf }, deletedAt: Date.now() });
  }
  // 폴더 자체도 휴지통으로
  if (folder) {
    trash.push({ type: 'folder', data: { ...folder }, deletedAt: Date.now() });
  }
  folders = folders.filter((f) => !allIds.includes(f.id));
  if (allIds.includes(currentFolder)) currentFolder = null;
  if (currentId && folderMemos.some((m) => m.id === currentId)) {
    currentId = null;
    hideEditor();
  }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('폴더가 휴지통으로 이동되었습니다');
}

// ── Memo CRUD ──
function createMemo() {
  cleanupEmptyMemo();
  const memo = {
    id: crypto.randomUUID(),
    title: '',
    content: '',
    folder: currentFolder,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memos.unshift(memo);
  currentId = memo.id;
  saveLocalData();
  renderAll();
  showEditor(memo);
  titleInput.focus();
  $('#sidebar').classList.remove('open');
  scheduleSyncToDropbox();
}

function deleteMemo(id) {
  const memo = memos.find((m) => m.id === id);
  if (memo) {
    trash.push({ type: 'memo', data: { ...memo }, deletedAt: Date.now() });
  }
  memos = memos.filter((m) => m.id !== id);
  if (currentId === id) {
    currentId = null;
    hideEditor();
  }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('메모가 휴지통으로 이동되었습니다');
}

function confirmDelete() {
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  const title = memo?.title || '제목 없음';

  const overlay = document.createElement('div');
  overlay.className = 'delete-confirm';
  overlay.innerHTML = `
    <div class="delete-confirm-box">
      <p>"${escapeHtml(title)}" 메모를 삭제할까요?</p>
      <button class="btn btn-secondary" id="del-cancel">취소</button>
      <button class="btn btn-primary" id="del-ok">삭제</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#del-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#del-ok').onclick = () => {
    overlay.remove();
    deleteMemo(currentId);
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ── Trash ──
function showTrashView() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  function renderTrashList() {
    if (trash.length === 0) {
      return '<p style="color:var(--text2);font-size:0.9rem;">휴지통이 비어 있습니다.</p>';
    }
    return trash.map((item, i) => {
      const icon = item.type === 'folder' ? '📁' : '📝';
      const name = item.type === 'folder' ? item.data.name : (item.data.title || formatCreatedAt(item.data.createdAt) + ' 새 글');
      const date = formatDate(item.deletedAt);
      const preview = item.type === 'memo' ? escapeHtml((item.data.content || '').substring(0, 200)) : '';
      return `<div class="trash-item" style="border-bottom:1px solid var(--border);font-size:0.85rem;">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;" data-preview="${i}">
          <span>${icon}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
          <span style="font-size:0.7rem;color:var(--text2);flex-shrink:0;">${date}</span>
          <button class="btn btn-secondary" style="padding:3px 8px;font-size:0.75rem;" data-restore="${i}">복원</button>
          <button class="btn btn-primary" style="padding:3px 8px;font-size:0.75rem;" data-permadel="${i}">삭제</button>
        </div>
        ${item.type === 'memo' ? '<div class="trash-preview" id="trash-preview-' + i + '" style="display:none;padding:6px 10px 10px 36px;font-size:0.8rem;color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:150px;overflow-y:auto;background:var(--bg);">' + (preview || '<i>내용 없음</i>') + '</div>' : ''}
      </div>`;
    }).join('');
  }

  function render() {
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:480px;max-height:70vh;display:flex;flex-direction:column;text-align:left;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:1rem;">🗑 휴지통</h3>
          ${trash.length > 0 ? '<button class="btn btn-primary" id="trash-empty" style="padding:4px 10px;font-size:0.75rem;">비우기</button>' : ''}
        </div>
        <div style="overflow-y:auto;flex:1;">${renderTrashList()}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-secondary" id="trash-close">닫기</button>
        </div>
      </div>
    `;

    overlay.querySelector('#trash-close').onclick = () => overlay.remove();

    const emptyBtn = overlay.querySelector('#trash-empty');
    if (emptyBtn) {
      emptyBtn.onclick = () => {
        if (confirm('휴지통을 비우시겠습니까? 영구적으로 삭제됩니다.')) {
          for (const t of trash) deletedIds.push({ id: t.data.id, at: Date.now() });
          trash = [];
          saveLocalData();
          scheduleSyncToDropbox();
          render();
          showToast('휴지통을 비웠습니다');
        }
      };
    }

    overlay.querySelectorAll('[data-preview]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-restore]') || e.target.closest('[data-permadel]')) return;
        const idx = row.dataset.preview;
        const prev = overlay.querySelector('#trash-preview-' + idx);
        if (prev) prev.style.display = prev.style.display === 'none' ? 'block' : 'none';
      };
    });

    overlay.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.restore);
        restoreFromTrash(idx);
        render();
      };
    });

    overlay.querySelectorAll('[data-permadel]').forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.permadel);
        const item = trash[idx];
        const name = item.type === 'folder' ? item.data.name : (item.data.title || '제목 없음');
        if (confirm(`"${name}"을(를) 영구 삭제하시겠습니까?`)) {
          deletedIds.push({ id: item.data.id, at: Date.now() });
          trash.splice(idx, 1);
          saveLocalData();
          scheduleSyncToDropbox();
          render();
          showToast('영구 삭제되었습니다');
        }
      };
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  document.body.appendChild(overlay);
  render();
}

function restoreFromTrash(index) {
  const item = trash[index];
  if (!item) return;
  if (item.type === 'memo') {
    // 원래 폴더가 아직 존재하면 그 폴더로, 없으면 미분류로 복원
    if (item.data.folder && !folders.some((f) => f.id === item.data.folder)) {
      item.data.folder = null;
    }
    memos.unshift(item.data);
  } else if (item.type === 'folder') {
    // 같은 이름의 폴더가 이미 있으면 이름 뒤에 (복원) 추가
    const exists = folders.some((f) => f.name === item.data.name);
    if (exists) item.data.name += ' (복원)';
    // 부모 폴더가 없으면 최상위로 복원
    if (item.data.parentId && !folders.some((f) => f.id === item.data.parentId)) {
      item.data.parentId = null;
    }
    item.data.sortOrder = nextSortOrder(item.data.parentId || null);
    folders.push(item.data);
  }
  trash.splice(index, 1);
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('복원되었습니다');
}

// ── Favorite ──
function toggleFavorite() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.favorite = !memo.favorite;
  memo.favoritedAt = memo.favorite ? Date.now() : null;
  memo.updatedAt = Date.now();
  updateFavButton(memo);
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast(memo.favorite ? '즐겨찾기에 추가됨' : '즐겨찾기 해제됨');
}

function updateFavButton(memo) {
  const btn = $('#btn-fav');
  if (memo && memo.favorite) {
    btn.textContent = '★';
    btn.classList.add('fav-active');
  } else {
    btn.textContent = '☆';
    btn.classList.remove('fav-active');
  }
}

// ── Editor ──
function showEditor(memo) {
  editorToolbar.style.display = 'flex';
  editorContainer.style.display = 'flex';
  emptyState.style.display = 'none';
  titleInput.value = memo.title;
  editor.value = memo.content;
  undoStack = [];
  clearTimeout(undoTimer);
  updateFolderSelect(memo.folder);
  updateFavButton(memo);
  applyViewerMode(!!memo.viewerMode);
}

function hideEditor() {
  cleanupEmptyMemo();
  editorToolbar.style.display = 'none';
  editorContainer.style.display = 'none';
  emptyState.style.display = 'flex';
}

function cleanupEmptyMemo() {
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (memo && !memo.title.trim() && !memo.content.trim()) {
    memos = memos.filter((m) => m.id !== currentId);
    currentId = null;
    saveLocalData();
  }
}

function loadMemoInEditor(memo) {
  cleanupEmptyMemo();
  currentId = memo.id;
  showEditor(memo);
  renderMemoList();
}

function updateFolderSelect(selectedFolder) {
  let options = '<option value="">-- 폴더 없음 --</option>';
  const topFolders = folders.filter((f) => !f.parentId).sort(sortBySortOrder);
  for (const f of topFolders) {
    options += `<option value="${f.id}" ${f.id === selectedFolder ? 'selected' : ''}>${escapeHtml(f.name)}</option>`;
    const children = getChildFolders(f.id);
    for (const c of children) {
      options += `<option value="${c.id}" ${c.id === selectedFolder ? 'selected' : ''}>　${escapeHtml(c.name)}</option>`;
    }
  }
  folderSelect.innerHTML = options;
}

function onFolderSelectChange() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.folder = folderSelect.value || null;
  memo.updatedAt = Date.now();
  scheduleAutoSave();
}

function onEditorInput() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  scheduleUndoSnapshot(memo);
  memo.content = editor.value;
  memo.updatedAt = Date.now();
  scheduleAutoSave();
}

function onTitleInput() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.title = titleInput.value;
  memo.updatedAt = Date.now();
  scheduleAutoSave();
}

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

let syncTimer = null;
function scheduleSyncToDropbox() {
  if (!accessToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    setSyncStatus('syncing', '저장 중...');
    try {
      await syncToDropbox();
      setSyncStatus('synced', '저장 완료');
    } catch {
      setSyncStatus('error', '저장 실패');
    }
  }, 3000);
}

// ── Viewer Mode ──
function toggleViewer() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const newMode = !viewerMode;
  memo.viewerMode = newMode;
  applyViewerMode(newMode);
  saveLocalData();
  scheduleSyncToDropbox();
}

function applyViewerMode(on) {
  viewerMode = on;
  editor.readOnly = on;
  titleInput.readOnly = on;
  editor.classList.toggle('viewer', on);
  $('#btn-viewer').classList.toggle('active', on);
}

// ── Undo ──
let lastSavedContent = '';

function scheduleUndoSnapshot(memo) {
  const cur = editor.value;
  if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== cur) {
    undoStack.push(cur);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
}

function performUndo() {
  if (undoStack.length === 0) {
    showToast('되돌릴 내용이 없습니다');
    return;
  }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;

  // 현재 내용과 같으면 한 단계 더 뒤로
  let prev = undoStack.pop();
  if (prev === editor.value && undoStack.length > 0) {
    prev = undoStack.pop();
  }

  editor.value = prev;
  memo.content = prev;
  memo.updatedAt = Date.now();
  scheduleAutoSave();
  showToast('되돌리기 완료');
}

// ── Render ──
function renderAll() {
  renderFolderList();
  renderMemoList();
}

function toggleFolderDropdown() {
  const dd = $('#folder-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function updateFolderToggleLabel() {
  const btn = $('#btn-folder-toggle');
  let label = '전체';
  if (currentFolder === '__none__') label = '미분류';
  else if (currentFolder) {
    const f = folders.find((f) => f.id === currentFolder);
    if (f) label = f.name;
  }
  btn.textContent = '📁 ' + label;
}

function renderFolderItem(f, isChild) {
  const count = isChild ? memos.filter((m) => m.folder === f.id).length : getFolderMemoCount(f.id);
  const lockIcon = f.password ? (unlockedFolders.has(f.id) ? '🔓' : '🔒') : '';
  const childClass = isChild ? ' folder-item--child' : '';
  const dormantIcon = (!isChild) ? `<span class="folder-dormant" data-dormant="${f.id}" title="${f.dormant ? '휴면 해제' : '휴면 처리'}">${f.dormant ? '☀️' : '💤'}</span>` : '';
  return `<div class="folder-item${childClass} ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
    <span class="folder-item-name">${lockIcon ? lockIcon + ' ' : ''}${escapeHtml(f.name)} <span class="folder-count">(${count})</span></span>
    <span class="folder-actions-left">
      <span class="folder-move" data-moveup="${f.id}" title="위로">▲</span>
      <span class="folder-move" data-movedown="${f.id}" title="아래로">▼</span>
      <span class="folder-edit" data-edit="${f.id}" title="이름 수정">✏️</span>
      <span class="folder-lock" data-lock="${f.id}" title="비밀번호 설정">🔑</span>
      <span class="folder-moveto" data-moveto="${f.id}" title="폴더 이동">📂</span>
      ${dormantIcon}
    </span>
    <span class="folder-actions-right">
      <span class="folder-del" data-del="${f.id}">&times;</span>
    </span>
  </div>`;
}

function renderFolderList() {
  const lockedIds = getLockedFolderIds();
  const dormantIds = getDormantFolderIds();
  const allCount = memos.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder)).length;
  let html = `<div class="folder-item ${currentFolder === null ? 'active' : ''}" data-folder="__all__">
    <span class="folder-item-name">전체 <span class="folder-count">(${allCount})</span></span>
  </div>`;

  // 활성 폴더 (휴면이 아닌 폴더)
  const topFolders = folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder);
  for (const f of topFolders) {
    html += renderFolderItem(f, false);
    const children = getChildFolders(f.id);
    for (const c of children) {
      html += renderFolderItem(c, true);
    }
  }

  const noFolderCount = memos.filter((m) => !m.folder).length;
  if (folders.length > 0) {
    html += `<div class="folder-item ${currentFolder === '__none__' ? 'active' : ''}" data-folder="__none__">
      <span class="folder-item-name">미분류 <span class="folder-count">(${noFolderCount})</span></span>
    </div>`;
  }

  // 휴면 폴더 섹션
  const dormantTopFolders = folders.filter((f) => !f.parentId && f.dormant).sort(sortBySortOrder);
  if (dormantTopFolders.length > 0) {
    const dormantMemoCount = memos.filter((m) => dormantIds.has(m.folder)).length;
    html += `<div class="folder-dormant-toggle" id="dormant-toggle">
      <span>💤 휴면 폴더 <span class="folder-count">(${dormantMemoCount})</span></span>
      <span class="dormant-arrow">▶</span>
    </div>`;
    html += `<div class="folder-dormant-list" id="dormant-list" style="display:none;">`;
    for (const f of dormantTopFolders) {
      html += renderFolderItem(f, false);
      const children = getChildFolders(f.id);
      for (const c of children) {
        html += renderFolderItem(c, true);
      }
    }
    html += `</div>`;
  }

  folderList.innerHTML = html;
  updateFolderToggleLabel();

  // 휴면 폴더 토글
  const dormantToggle = folderList.querySelector('#dormant-toggle');
  if (dormantToggle) {
    dormantToggle.addEventListener('click', () => {
      const list = folderList.querySelector('#dormant-list');
      const arrow = dormantToggle.querySelector('.dormant-arrow');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        arrow.textContent = '▼';
      } else {
        list.style.display = 'none';
        arrow.textContent = '▶';
      }
    });
  }

  folderList.querySelectorAll('.folder-item').forEach((el) => {
    // Long press for mobile: show action icons
    let longPressTimer = null;
    let didLongPress = false;

    el.addEventListener('touchstart', (e) => {
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        folderList.querySelectorAll('.folder-actions-left.show, .folder-actions-right.show').forEach((a) => a.classList.remove('show'));
        el.querySelectorAll('.folder-actions-left, .folder-actions-right').forEach((a) => a.classList.toggle('show'));
      }, 500);
    }, { passive: true });

    el.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
    el.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });

    el.addEventListener('click', (e) => {
      if (didLongPress) { didLongPress = false; return; }

      if (e.target.dataset.moveup) { moveFolderUp(e.target.dataset.moveup); return; }
      if (e.target.dataset.movedown) { moveFolderDown(e.target.dataset.movedown); return; }
      if (e.target.classList.contains('folder-del')) { confirmDeleteFolder(e.target.dataset.del); return; }
      if (e.target.classList.contains('folder-edit')) { showRenameFolderDialog(e.target.dataset.edit); return; }
      if (e.target.classList.contains('folder-lock')) { showSetPasswordDialog(e.target.dataset.lock); return; }
      if (e.target.classList.contains('folder-moveto')) { showMoveFolderDialog(e.target.dataset.moveto); return; }
      if (e.target.classList.contains('folder-dormant')) { toggleDormant(e.target.dataset.dormant); return; }

      const val = el.dataset.folder;
      if (val === '__all__') { currentFolder = null; }
      else if (val === '__none__') { currentFolder = '__none__'; }
      else {
        if (isFolderLocked(val)) {
          showPasswordPrompt(val, () => {
            currentFolder = val;
            renderAll();
            $('#folder-dropdown').style.display = 'none';
          });
          return;
        }
        currentFolder = val;
      }
      renderAll();
      $('#folder-dropdown').style.display = 'none';
    });
  });
}

function renderMemoList() {
  const query = searchBox.value.toLowerCase().trim();
  let filtered = memos;
  const lockedIds = getLockedFolderIds();

  if (currentFolder === '__none__') {
    filtered = filtered.filter((m) => !m.folder);
  } else if (currentFolder) {
    const childIds = getChildFolders(currentFolder).map((f) => f.id);
    filtered = filtered.filter((m) => m.folder === currentFolder || childIds.includes(m.folder));
  } else {
    // 전체 보기: 잠긴 폴더 + 휴면 폴더의 글 숨기기
    const dormantIds = getDormantFolderIds();
    filtered = filtered.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder));
  }

  if (query) {
    filtered = filtered.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(query) ||
        (m.content || '').toLowerCase().includes(query)
    );
  }

  // 폴더 보기일 때(전체 보기가 아닐 때) 즐겨찾기 상단 고정
  if (currentFolder !== null && !query) {
    const favs = filtered.filter((m) => m.favorite);
    const normals = filtered.filter((m) => !m.favorite);
    // 즐겨찾기끼리는 최근 즐겨찾기 지정순
    favs.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
    filtered = [...favs, ...normals];
  }

  memoList.innerHTML = filtered
    .map((m) => {
      const title = m.title || formatCreatedAt(m.createdAt) + ' 새 글';
      const date = formatDate(m.updatedAt);
      const active = m.id === currentId ? 'active' : '';
      const favIcon = m.favorite ? '<span class="memo-item-fav">★</span>' : '';
      return `
        <div class="memo-item ${active}" data-id="${m.id}">
          ${favIcon}
          <div class="memo-item-info">
            <div class="memo-item-title">${escapeHtml(title)}</div>
          </div>
          <div class="memo-item-date">${date}</div>
        </div>
      `;
    })
    .join('');

  memoList.querySelectorAll('.memo-item').forEach((el) => {
    let clickTimer = null;
    el.addEventListener('click', () => {
      if (clickTimer) return; // 더블클릭 대기 중이면 무시
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const memo = memos.find((m) => m.id === el.dataset.id);
        if (memo) loadMemoInEditor(memo);
        $('#sidebar').classList.remove('open');
      }, 250);
    });
    el.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      clickTimer = null;
      const id = el.dataset.id;
      window.open(location.pathname + '?memo=' + id, '_blank', 'width=600,height=700');
    });
  });
}

// ── UI Helpers ──
function showApp() {
  loginScreen.style.display = 'none';
  app.style.display = 'flex';
  renderAll();
  if (accessToken) setSyncStatus('synced', '연결됨');
  else setSyncStatus('', '오프라인');
}

function setSyncStatus(cls, text) {
  syncStatus.className = cls;
  syncStatus.textContent = text;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function formatCreatedAt(ts) {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

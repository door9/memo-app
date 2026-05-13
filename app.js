// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
const DROPBOX_FILE = '/memo-app/memos.json';
const BACKUP_DIR = '/memo-app/backups';
const BACKUP_MAX = 10;
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
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
  const obj = { memos, folders };
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
  return Array.from(map.values())
    .filter((m) => !m.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeFolders(local, remote) {
  const map = new Map();
  for (const f of remote) map.set(f.id, f);
  for (const f of local) {
    if (!map.has(f.id)) map.set(f.id, f);
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Local Storage ──
function saveLocalData() {
  localStorage.setItem('memos', JSON.stringify(memos));
  localStorage.setItem('folders', JSON.stringify(folders));
  if (masterPasswordHash) localStorage.setItem('master_pw', masterPasswordHash);
  else localStorage.removeItem('master_pw');
}

function loadLocalData() {
  try {
    const md = localStorage.getItem('memos');
    if (md) memos = JSON.parse(md);
    const fd = localStorage.getItem('folders');
    if (fd) folders = JSON.parse(fd);
    masterPasswordHash = localStorage.getItem('master_pw') || null;
  } catch {}
}

// ── Folder Password ──
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isFolderLocked(folderId) {
  const f = folders.find((f) => f.id === folderId);
  return f && f.password && !unlockedFolders.has(folderId);
}

function getLockedFolderIds() {
  return folders.filter((f) => f.password && !unlockedFolders.has(f.id)).map((f) => f.id);
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
    // 기존 비밀번호 확인 (마스터 패스워드도 허용)
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
      <p>${hasMaster ? '🔐 마스터 패스워드 변경/해제' : '🔐 마스터 패스워드 설정'}</p>
      ${hasMaster ? '<input type="password" id="mp-old" placeholder="현재 마스터 패스워드" autofocus>' : ''}
      <input type="password" id="mp-new" placeholder="새 마스터 패스워드 (해제하려면 비워두세요)" ${hasMaster ? '' : 'autofocus'}>
      <input type="password" id="mp-confirm" placeholder="새 마스터 패스워드 확인">
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
      showToast('마스터 패스워드가 해제되었습니다');
    } else if (newPw !== confirmPw) {
      overlay.querySelector('#mp-confirm').value = '';
      overlay.querySelector('#mp-confirm').placeholder = '비밀번호가 일치하지 않습니다';
      overlay.querySelector('#mp-confirm').classList.add('error');
      return;
    } else {
      masterPasswordHash = await hashPassword(newPw);
      showToast('마스터 패스워드가 설정되었습니다');
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
    showToast('마스터 패스워드가 설정되지 않았습니다');
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
      <p>🔐 마스터 패스워드로 전체 잠금 해제</p>
      <input type="password" id="mu-input" placeholder="마스터 패스워드" autofocus>
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
      folders.push({ id: crypto.randomUUID(), name });
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

function deleteFolder(id) {
  folders = folders.filter((f) => f.id !== id);
  memos.forEach((m) => { if (m.folder === id) m.folder = null; });
  if (currentFolder === id) currentFolder = null;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

// ── Memo CRUD ──
function createMemo() {
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
  memos = memos.filter((m) => m.id !== id);
  if (currentId === id) {
    currentId = null;
    hideEditor();
  }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('메모가 삭제되었습니다');
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
  editorToolbar.style.display = 'none';
  editorContainer.style.display = 'none';
  emptyState.style.display = 'flex';
}

function loadMemoInEditor(memo) {
  currentId = memo.id;
  showEditor(memo);
  renderMemoList();
}

function updateFolderSelect(selectedFolder) {
  folderSelect.innerHTML = '<option value="">-- 폴더 없음 --</option>' +
    folders.map((f) => `<option value="${f.id}" ${f.id === selectedFolder ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
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
  if (!undoTimer) {
    // 타이핑 시작 시 현재 상태를 즉시 저장
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== memo.content) {
      undoStack.push(memo.content);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
  }
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    // 타이핑 멈춘 후 1초 뒤 현재 상태도 저장
    const cur = editor.value;
    if (undoStack[undoStack.length - 1] !== cur) {
      undoStack.push(cur);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    undoTimer = null;
  }, 1000);
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

function renderFolderList() {
  const lockedIds = getLockedFolderIds();
  const allCount = memos.filter((m) => !lockedIds.includes(m.folder)).length;
  let html = `<div class="folder-item ${currentFolder === null ? 'active' : ''}" data-folder="__all__">
    <span class="folder-item-name">전체</span><span class="folder-count">${allCount}</span>
  </div>`;

  for (const f of folders) {
    const count = memos.filter((m) => m.folder === f.id).length;
    const lockIcon = f.password ? (unlockedFolders.has(f.id) ? '🔓' : '🔒') : '';
    html += `<div class="folder-item ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
      <span class="folder-item-name">${lockIcon ? lockIcon + ' ' : ''}${escapeHtml(f.name)}</span><span class="folder-count">${count}</span><span class="folder-lock" data-lock="${f.id}" title="비밀번호 설정">🔑</span><span class="folder-del" data-del="${f.id}">&times;</span>
    </div>`;
  }

  const noFolderCount = memos.filter((m) => !m.folder).length;
  if (folders.length > 0) {
    html += `<div class="folder-item ${currentFolder === '__none__' ? 'active' : ''}" data-folder="__none__">
      <span class="folder-item-name">미분류</span><span class="folder-count">${noFolderCount}</span>
    </div>`;
  }

  folderList.innerHTML = html;
  updateFolderToggleLabel();

  folderList.querySelectorAll('.folder-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('folder-del')) {
        deleteFolder(e.target.dataset.del);
        return;
      }
      if (e.target.classList.contains('folder-lock')) {
        showSetPasswordDialog(e.target.dataset.lock);
        return;
      }
      const val = el.dataset.folder;
      if (val === '__all__') { currentFolder = null; }
      else if (val === '__none__') { currentFolder = '__none__'; }
      else {
        // 잠긴 폴더면 비밀번호 확인
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
    filtered = filtered.filter((m) => m.folder === currentFolder);
  } else {
    // 전체 보기: 잠긴 폴더의 글 숨기기
    filtered = filtered.filter((m) => !lockedIds.includes(m.folder));
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

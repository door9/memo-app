// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
const DROPBOX_CLIENT_SECRET = 'x9tu1nql7ul9lqd';
const DROPBOX_FILE = '/memo-app/memos.json';
const BACKUP_DIR = '/memo-app/backups';
const BACKUP_MAX = 30;
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
let trash = []; // 휴지통: { type: 'memo'|'folder', data: {...}, deletedAt: timestamp }
let deletedIds = []; // 영구 삭제된 항목: { id, at } (동기화 시 복귀 차단, 30일 후 자동 정리)
let currentId = null;
let currentFolder = null; // null = all
let accessToken = localStorage.getItem('dbx_token') || null;
let refreshToken = localStorage.getItem('dbx_refresh') || null;
let isOnline = !!accessToken;
let viewerMode = false;
let favFilterActive = false;
let selectMode = false;
let folderListCollapsed = false;
let selectedMemos = new Set();
let selectedFolders = new Set();
let lastCheckedMemoIndex = -1;
let lastCheckedFolderIndex = -1;
let touchSelectActive = false; // 모바일 롱프레스 범위 선택 활성 여부
let memoSortKey = 'updatedAt';
let saveTimer = null;
const unlockedFolders = new Set(); // 현재 세션에서 잠금 해제된 폴더
let masterPasswordHash = null;
let templates = [];
let undoStack = [];
let redoStack = [];
const UNDO_MAX = 50;

// ── DOM ──
const $ = (s) => document.querySelector(s);
const loginScreen = $('#login-screen');
const app = $('#app');
const memoList = $('#memo-list');
const folderList = $('#folder-list');
const editor = $('#editor');
const titleInput = $('#memo-title-input');
const searchBox = $('#search-box');
const syncStatus = $('#sync-status');
const toast = $('#toast');
const editorToolbar = $('#editor-toolbar');
const editorContainer = $('#editor-container');
const emptyState = $('#empty-state');

// ── Init ──
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 모바일 세로 모드 고정
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (e) {}

  await handleOAuthCallback();
  loadLocalData();
  cleanupEmptyMemo();

  // URL 파라미터로 특정 메모 열기 (새 창)
  const urlParams = new URLSearchParams(location.search);
  const openMemoId = urlParams.get('memo');

  // 새 창 모드는 URL 감지 즉시 적용 (햄버거 깜빡임·메모 미발견 시 노출 방지)
  if (openMemoId) {
    document.body.classList.add('popup-mode');
  }

  if (accessToken) {
    showApp();
    syncFromDropbox().then(() => checkAutoBackup());
  } else {
    // 오프라인 모드: 백업 필요 플래그만 저장
    markAutoBackupPending();
  }

  // 네트워크 복구 시 자동 동기화 + 보류된 자동 백업 실행
  window.addEventListener('online', () => {
    if (accessToken) {
      syncFromDropbox().then(() => checkAutoBackupPending());
    }
  });

  // 앱을 닫거나(beforeunload/pagehide), 다른 앱·화면으로 가려질 때(visibilitychange) 즉시 저장 + 동기화
  // 특히 휴대폰에서 홈으로 나가거나 앱을 전환할 때 beforeunload는 잘 안 불리므로 visibilitychange가 핵심
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  // 같은 기기의 다른 창에서 저장하면(localStorage 변경) 이 창에 즉시 반영
  window.addEventListener('storage', onExternalStorageChange);

  // 폴더 액션 메뉴 바깥 클릭 시 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-item')) {
      document.querySelectorAll('.folder-actions-left.show, .folder-actions-right.show').forEach((a) => a.classList.remove('show'));
    }
    if (!e.target.closest('#template-wrap')) {
      $('#template-dropdown').style.display = 'none';
    }
    if (!e.target.closest('#folder-select-wrap')) {
      $('#folder-select-dropdown').style.display = 'none';
    }
  });

  $('#btn-login').addEventListener('click', loginDropbox);
  $('#btn-offline').addEventListener('click', (e) => {
    e.preventDefault();
    isOnline = false;
    showApp();
  });
  $('#toolbar-reveal').addEventListener('click', () => {
    document.body.classList.remove('toolbar-hidden');
    lastEditorScrollTop = editor.scrollTop;
  });
  $('#btn-new').addEventListener('click', createMemo);
  $('#btn-backup').addEventListener('click', createBackup);
  $('#btn-folder-toggle').addEventListener('click', toggleFolderDropdown);
  $('#btn-fav-filter').addEventListener('click', toggleFavFilter);
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
  $('#btn-redo').addEventListener('click', performRedo);
  $('#btn-toolbar-more').addEventListener('click', toggleToolbarMore);
  $('#btn-template').addEventListener('click', toggleTemplateDropdown);
  $('#btn-template-save').addEventListener('click', saveAsTemplate);
  $('#btn-find').addEventListener('click', toggleFindReplace);
  $('#btn-copy').addEventListener('click', copyMemoToClipboard);
  $('#btn-share').addEventListener('click', shareMemo);
  $('#btn-viewer').addEventListener('click', toggleViewer);
  $('#btn-help').addEventListener('click', showHelpDialog);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#memo-sort').addEventListener('change', (e) => { memoSortKey = e.target.value; renderMemoList(); });
  $('#btn-select-mode').addEventListener('click', toggleSelectMode);
  $('#btn-bulk-delete').addEventListener('click', bulkDelete);
  $('#btn-bulk-move').addEventListener('click', bulkMoveUnified);
  $('#btn-bulk-cancel').addEventListener('click', () => toggleSelectMode());
  $('#find-input').addEventListener('input', findCountOnly);
  $('#find-btn').addEventListener('click', findAndGo);
  $('#find-all-btn').addEventListener('click', findAllAndGo);
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findAndGo(); } });
  $('#find-next').addEventListener('click', () => findNavigate(1));
  $('#find-prev').addEventListener('click', () => findNavigate(-1));
  $('#replace-one').addEventListener('click', replaceAction);

  // 키보드 단축키
  document.addEventListener('keydown', (e) => {
    // Alt+Shift+D → 하이픈(------) 구분선, Alt+Shift+E → 등호(======) 구분선 (에디터 포커스 시)
    // Ctrl 게이트보다 위에서 처리(Alt는 Ctrl이 아니므로). 글자는 레이아웃 영향 적은 e.code로 판별
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && document.activeElement === editor) {
      if (e.code === 'KeyD') { e.preventDefault(); insertDivider('-'); return; }
      if (e.code === 'KeyE') { e.preventDefault(); insertDivider('='); return; }
    }
    // Alt+; → 현재 날짜, Alt+Shift+; → 날짜+시간 (본문/제목 포커스 시)
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'Semicolon' &&
        (document.activeElement === editor || document.activeElement === titleInput)) {
      e.preventDefault();
      insertTextAtCursor(formatDateStamp(e.shiftKey));
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    // Ctrl+Z → 어절 단위 되돌리기 (에디터 포커스 시에만 가로채 브라우저 기본 동작 대체)
    if (k === 'z' && !e.shiftKey && document.activeElement === editor) {
      e.preventDefault();
      performUndo();
      return;
    }
    // Ctrl+Shift+Z 또는 Ctrl+Y → 되살리기
    if (((k === 'z' && e.shiftKey) || k === 'y') && document.activeElement === editor) {
      e.preventDefault();
      performRedo();
      return;
    }
    // Ctrl+F → 앱 찾기/바꾸기
    if (e.key === 'f') {
      if (!currentId) return;
      e.preventDefault();
      toggleFindReplace();
    }
    // Ctrl+S → 저장 및 동기화
    if (e.key === 's') {
      e.preventDefault();
      saveLocalData();
      if (accessToken) {
        syncToDropbox().then(() => showToast('저장 및 동기화 완료')).catch(() => showToast('동기화 실패'));
      } else {
        showToast('로컬에 저장됨');
      }
    }
  });

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
  editor.addEventListener('scroll', () => {
    $('#editor-highlight').scrollTop = editor.scrollTop;
    handleEditorScroll();
  });
  titleInput.addEventListener('input', onTitleInput);
  titleInput.addEventListener('keydown', (e) => {
    // 제목에서 Enter → 본문 맨앞으로 커서 이동
    if (e.key === 'Enter') { e.preventDefault(); editor.focus(); editor.setSelectionRange(0, 0); editor.scrollTop = 0; }
  });
  $('#btn-folder-select').addEventListener('click', toggleFolderSelectDropdown);
  $('#folder-select-list').addEventListener('click', onFolderSelectItemClick);
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

  // 새 창으로 열린 경우 해당 메모 바로 표시 (popup-mode 클래스는 init 초반에 이미 적용됨)
  if (openMemoId) {
    const memo = memos.find((m) => m.id === openMemoId);
    if (memo) {
      if (!accessToken) { isOnline = false; showApp(); }
      loadMemoInEditor(memo);
    }
  }
}

// ── OAuth (PKCE) ──
function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loginDropbox() {
  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('code_verifier', codeVerifier);
  const params = new URLSearchParams({
    client_id: DROPBOX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    scope: 'files.content.read files.content.write files.metadata.read files.metadata.write',
    state,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
}

async function handleOAuthCallback() {
  // PKCE code flow: code comes in query string
  const urlParams = new URLSearchParams(location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  if (!code || state !== sessionStorage.getItem('oauth_state')) {
    // Fallback: legacy implicit flow (hash-based token)
    const hash = location.hash.substring(1);
    if (!hash) return;
    const hashParams = new URLSearchParams(hash);
    const token = hashParams.get('access_token');
    const hState = hashParams.get('state');
    if (token && hState === sessionStorage.getItem('oauth_state')) {
      accessToken = token;
      isOnline = true;
      localStorage.setItem('dbx_token', token);
      sessionStorage.removeItem('oauth_state');
      history.replaceState(null, '', location.pathname);
    }
    return;
  }

  // Exchange code for tokens
  const codeVerifier = sessionStorage.getItem('code_verifier');
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: DROPBOX_CLIENT_ID,
        client_secret: DROPBOX_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error('token exchange failed: ' + res.status);
    const data = await res.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token || null;
    isOnline = true;
    localStorage.setItem('dbx_token', accessToken);
    if (refreshToken) localStorage.setItem('dbx_refresh', refreshToken);
    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('code_verifier');
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    console.error('Token exchange error:', e);
    showToast('로그인 실패. 다시 시도해주세요.');
  }
}

async function refreshAccessToken() {
  if (!refreshToken) return false;
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: DROPBOX_CLIENT_ID,
        client_secret: DROPBOX_CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      console.error('Token refresh failed:', res.status);
      return false;
    }
    const data = await res.json();
    accessToken = data.access_token;
    localStorage.setItem('dbx_token', accessToken);
    return true;
  } catch (e) {
    console.error('Token refresh error:', e);
    return false;
  }
}

function logout() {
  accessToken = null;
  refreshToken = null;
  isOnline = false;
  localStorage.removeItem('dbx_token');
  localStorage.removeItem('dbx_refresh');
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
// 동시 쓰기 충돌(409 too_many_write_operations)·요청 과다(429) 시 잠깐 기다렸다 재시도.
// 두 창에서 같은 파일에 동시에 저장할 때 한쪽이 거절당하던 문제를 자동으로 넘기기 위함.
const DBX_MAX_RETRY = 3;
const dbxSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dbxRetryDelay(res, attempt) {
  const ra = parseInt((res && res.headers.get('Retry-After')) || '0', 10);
  if (ra > 0) return Math.min(ra * 1000, 10000); // 서버가 알려준 Retry-After(초) 존중, 최대 10초
  return Math.min(2000, 400 * Math.pow(2, attempt)); // 0.4s → 0.8s → 1.6s
}

async function dbxUpload(content, retried, attempt = 0) {
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
    if (!retried && await refreshAccessToken()) {
      return dbxUpload(content, true, attempt);
    }
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  // 동시 쓰기 충돌(409)·요청 과다(429) → 잠깐 대기 후 재시도 (다른 창과 동시 저장 시)
  if ((res.status === 429 || res.status === 409) && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxUpload(content, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxDownload(retried, attempt = 0) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_FILE }),
    },
  });
  if (res.status === 409 || res.status === 404) return null; // 아직 파일 없음
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxDownload(true, attempt);
    }
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxDownload(retried, attempt + 1);
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

async function dbxUploadTo(path, content, retried, attempt = 0) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', mute: true }),
    },
    body: content,
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxUploadTo(path, content, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if ((res.status === 429 || res.status === 409) && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxUploadTo(path, content, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxListFolder(path, retried, attempt = 0) {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path, recursive: false }),
  });
  if (res.status === 409 || res.status === 404) return [];
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxListFolder(path, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxListFolder(path, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('list failed: ' + res.status);
  const data = await res.json();
  return data.entries || [];
}

async function dbxDelete(path, retried, attempt = 0) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxDelete(path, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxDelete(path, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('delete failed: ' + res.status);
}

async function pruneBackups() {
  const entries = await dbxListFolder(BACKUP_DIR);
  const backups = entries
    .filter((e) => e['.tag'] === 'file' && e.name.startsWith('backup_'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 30개 초과 시 오래된 것부터 삭제
  while (backups.length > BACKUP_MAX) {
    const old = backups.shift();
    await dbxDelete(old.path_lower);
  }
}

// ── Auto Backup ──
function getTodayKST() {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function markAutoBackupPending() {
  const today = getTodayKST();
  const lastDate = localStorage.getItem('auto_backup_date');
  if (lastDate !== today) {
    localStorage.setItem('auto_backup_pending', 'true');
  }
}

async function checkAutoBackup() {
  if (!accessToken) return;
  const today = getTodayKST();
  const lastDate = localStorage.getItem('auto_backup_date');
  if (lastDate === today) return; // 오늘 이미 백업함

  // Dropbox에 오늘 날짜 자동 백업 파일이 있는지 확인
  try {
    const entries = await dbxListFolder(BACKUP_DIR);
    const todayTag = today.replace(/-/g, '');
    const alreadyExists = entries.some((e) =>
      e['.tag'] === 'file' && e.name.includes(todayTag) && e.name.includes('(auto backup)')
    );
    if (alreadyExists) {
      localStorage.setItem('auto_backup_date', today);
      return;
    }
    await performAutoBackup(today);
  } catch (e) {
    console.error('Auto backup check error:', e);
  }
}

async function checkAutoBackupPending() {
  if (!accessToken) return;
  const pending = localStorage.getItem('auto_backup_pending');
  if (pending !== 'true') return;
  localStorage.removeItem('auto_backup_pending');
  await checkAutoBackup();
}

async function performAutoBackup(today) {
  try {
    const now = new Date();
    const ts = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_' + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const backupPath = BACKUP_DIR + '/backup_' + ts + ' (auto backup).json';
    const obj = { memos, folders };
    if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
    const data = JSON.stringify(obj, null, 2);

    await dbxUploadTo(backupPath, data);
    await pruneBackups();
    localStorage.setItem('auto_backup_date', today);
    showToast('자동 백업 완료');
  } catch (e) {
    console.error('Auto backup error:', e);
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
      if (Array.isArray(remote.templates)) templates = mergeTemplates(templates, remote.templates);
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
  const obj = { memos, folders, trash, deletedIds, templates };
  if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
  const data = JSON.stringify(obj, null, 2);
  await dbxUpload(data);
  markSynced();
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
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const t of remote) {
    if (!permDelIds.has(t.data.id)) map.set(t.data.id + '_' + t.type, t);
  }
  for (const t of local) {
    const key = t.data.id + '_' + t.type;
    if (!map.has(key) && !permDelIds.has(t.data.id)) map.set(key, t);
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
// 최근 저장/동기화 시각을 연월일시분초로 표시 (햄버거 옆 영역)
function fmtFullTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function updateSaveSyncTimes() {
  const savedEl = $('#last-saved-time');
  const syncedEl = $('#last-synced-time');
  if (savedEl) savedEl.textContent = '최근 저장 ' + fmtFullTime(localStorage.getItem('last_saved_at'));
  if (syncedEl) syncedEl.textContent = '최근 동기화 ' + fmtFullTime(localStorage.getItem('last_synced_at'));
}

function markSynced() {
  localStorage.setItem('last_synced_at', String(Date.now()));
  updateSaveSyncTimes();
}

function saveLocalData() {
  localStorage.setItem('memos', JSON.stringify(memos));
  localStorage.setItem('folders', JSON.stringify(folders));
  localStorage.setItem('trash', JSON.stringify(trash));
  localStorage.setItem('deletedIds', JSON.stringify(deletedIds));
  localStorage.setItem('templates', JSON.stringify(templates));
  if (masterPasswordHash) localStorage.setItem('master_pw', masterPasswordHash);
  else localStorage.removeItem('master_pw');
  localStorage.setItem('last_saved_at', String(Date.now()));
  updateSaveSyncTimes();
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
    const tp = localStorage.getItem('templates');
    if (tp) templates = JSON.parse(tp);
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

function isVisibleMemo(m) {
  return m.title.trim() || m.content.trim();
}

function getFolderMemoCount(folderId) {
  const childIds = getChildFolders(folderId).map((f) => f.id);
  return memos.filter((m) => (m.folder === folderId || childIds.includes(m.folder)) && isVisibleMemo(m)).length;
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
  const name = escapeHtml(folder.name);
  const childFolders = getChildFolders(id);
  const allIds = [id, ...childFolders.map((f) => f.id)];
  const folderMemos = memos.filter((m) => allIds.includes(m.folder));
  const childNote = childFolders.length > 0 ? '하위 폴더 ' + childFolders.length + '개, ' : '';
  const detailNote = (folderMemos.length > 0 || childFolders.length > 0) ? '<br><span style="font-size:0.85rem;color:var(--text2)">' + childNote + '메모 ' + folderMemos.length + '개도 휴지통으로 이동합니다.</span>' : '';

  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'modal-overlay';
  o1.innerHTML = `<div class="modal-box"><p>"${name}" 폴더를 삭제할까요?${detailNote}</p><button class="btn btn-secondary" id="fdel-cancel">취소</button> <button class="btn btn-primary" id="fdel-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#fdel-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#fdel-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'modal-overlay';
    o2.innerHTML = `<div class="modal-box"><p>"${name}" 폴더를 정말 삭제할까요?</p><button class="btn btn-secondary" id="fdel-cancel2">취소</button> <button class="btn btn-primary" id="fdel-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#fdel-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#fdel-ok2').onclick = () => {
      o2.remove();
      deleteFolder(id);
    };
  };
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
  // 새 글이 들어갈 폴더 결정 (cleanupEmptyMemo가 currentId를 비우기 전에 캡처)
  // 1) 특정 폴더를 연 상태면 그 폴더
  // 2) 전체/미분류 보기지만 지금 보고 있는 글이 어떤 폴더에 속하면 그 폴더
  // 3) 둘 다 아니면 폴더 없음
  let targetFolder = (currentFolder && currentFolder !== '__none__') ? currentFolder : null;
  if (!targetFolder && currentId) {
    const cur = memos.find((m) => m.id === currentId);
    if (cur && cur.folder) targetFolder = cur.folder;
  }
  cleanupEmptyMemo();
  const memo = {
    id: crypto.randomUUID(),
    title: '',
    content: '',
    folder: targetFolder,
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
  const title = escapeHtml(memo?.title || '제목 없음');

  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'delete-confirm';
  o1.innerHTML = `<div class="delete-confirm-box"><p>"${title}" 메모를 삭제할까요?</p><button class="btn btn-secondary" id="del-cancel">취소</button> <button class="btn btn-primary" id="del-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#del-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#del-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'delete-confirm';
    o2.innerHTML = `<div class="delete-confirm-box"><p>"${title}" 메모를 정말 삭제할까요?</p><button class="btn btn-secondary" id="del-cancel2">취소</button> <button class="btn btn-primary" id="del-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#del-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#del-ok2').onclick = () => {
      o2.remove();
      deleteMemo(currentId);
    };
  };
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
          syncToDropbox().catch(() => {});
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
          syncToDropbox().catch(() => {});
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

// 다른 창(같은 기기)에서 localStorage가 바뀌면 호출 → 이 창을 최신 상태로 갱신
// (A창에서 수정 → B창이 즉시 반영. 단, 이 창에서 직접 입력 중이면 본문은 건드리지 않음)
function onExternalStorageChange(e) {
  if (e.key === 'last_saved_at' || e.key === 'last_synced_at') { updateSaveSyncTimes(); return; }
  if (e.key !== 'memos') return; // saveLocalData는 항상 memos를 함께 저장하므로 이 키만 보면 됨
  loadLocalData();
  renderAll();
  updateSaveSyncTimes();
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) { currentId = null; hideEditor(); return; } // 다른 창에서 이 글이 삭제됨
  // 이 창에서 직접 입력 중(창이 활성 + 입력칸 포커스)이면 본문을 덮어쓰지 않음(편집 손실 방지)
  const busyHere = document.hasFocus() && (document.activeElement === editor || document.activeElement === titleInput);
  if (!busyHere) {
    if (editor.value !== memo.content) editor.value = memo.content;
    if (titleInput.value !== memo.title) titleInput.value = memo.title;
    updateCharCount();
    updateFavButton(memo);
  }
  updateMemoDates(memo);
}

// ── Editor ──
function showEditor(memo) {
  editorToolbar.style.display = 'flex';
  editorContainer.style.display = 'flex';
  $('#char-count').style.display = 'block';
  emptyState.style.display = 'none';
  titleInput.value = memo.title;
  editor.value = memo.content;
  undoStack = [];
  redoStack = [];
  undoGroupOpen = false;
  updateFolderSelect(memo.folder);
  updateFavButton(memo);
  updateMemoDates(memo);
  updateCharCount();
  applyViewerMode(!!memo.viewerMode);
  // 찾기/바꾸기 패널·더보기 닫기
  $('#find-replace-bar').style.display = 'none';
  document.querySelectorAll('.toolbar-extra').forEach((el) => el.classList.remove('toolbar-show'));
  $('#btn-toolbar-more').classList.remove('active');
  $('#toolbar-right').classList.remove('expanded');
  $('#toolbar-buttons').classList.remove('expanded');
}

function hideEditor() {
  cleanupEmptyMemo();
  editorToolbar.style.display = 'none';
  editorContainer.style.display = 'none';
  $('#char-count').style.display = 'none';
  $('#find-replace-bar').style.display = 'none';
  $('#memo-dates').style.display = 'none';
  emptyState.style.display = 'flex';
}

// 제목·본문이 모두 비어 있고 특정 폴더에도 속하지 않은 메모만 '빈 메모'로 본다.
// 폴더를 지정했다면(미분류가 아닌 특정 폴더) 빈 메모여도 보존한다.
function isBlankMemo(m) {
  return !m.title.trim() && !m.content.trim() && !m.folder;
}

function cleanupEmptyMemo() {
  // 현재 편집 중이 아닌 빈 메모를 모두 삭제
  const before = memos.length;
  memos = memos.filter((m) => m.id === currentId || !isBlankMemo(m));
  // 현재 편집 중인 메모도 빈 상태면 삭제
  if (currentId) {
    const memo = memos.find((m) => m.id === currentId);
    if (memo && isBlankMemo(memo)) {
      memos = memos.filter((m) => m.id !== currentId);
      currentId = null;
    }
  }
  if (memos.length !== before) saveLocalData();
}

async function loadMemoInEditor(memo) {
  // 빈 메모 정리를 동기화보다 먼저 실행
  cleanupEmptyMemo();
  // 글 전환 시 대기 중인 동기화를 즉시 실행
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    syncToDropbox().catch(() => {});
  }
  // 온라인이면 최신 데이터를 먼저 받아온 뒤 열기
  syncFailedForCurrentMemo = false;
  if (accessToken) {
    try {
      setSyncStatus('syncing', '동기화 중...');
      const remote = await dbxDownload();
      if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
        if (Array.isArray(remote.deletedIds)) deletedIds = mergeDeletedIds(deletedIds, remote.deletedIds);
        if (Array.isArray(remote.trash)) trash = mergeTrash(trash, remote.trash);
        if (Array.isArray(remote.memos)) memos = mergeMemos(memos, remote.memos);
        if (Array.isArray(remote.folders)) folders = mergeFolders(folders, remote.folders);
        if (Array.isArray(remote.templates)) templates = mergeTemplates(templates, remote.templates);
      }
      saveLocalData();
      markSynced();
      setSyncStatus('synced', '동기화 완료');
      // 동기화 후 최신 memo 객체 다시 조회
      memo = memos.find((m) => m.id === memo.id);
      if (!memo) { showToast('해당 메모가 삭제되었습니다'); renderAll(); return; }
    } catch {
      setSyncStatus('error', '동기화 실패');
      syncFailedForCurrentMemo = true;
    }
  }
  offlineCopyId = null;
  currentId = memo.id;
  // 폴더에 속한 노트를 열면 사이드바 폴더 선택도 그 폴더로 동기화 (잠긴 폴더는 제외)
  if (memo.folder && folders.some((f) => f.id === memo.folder) && !isFolderLocked(memo.folder)) {
    currentFolder = memo.folder;
  }
  showEditor(memo);
  renderMemoList();
  renderFolderList();
  // 새 메모 열 때 툴바·제목 다시 표시
  document.body.classList.remove('toolbar-hidden');
  lastEditorScrollTop = 0;
}

let offlineCopyId = null; // 오프라인 복사본 추적
let syncFailedForCurrentMemo = false; // 현재 메모 열기 시 동기화 실패 여부

function updateFolderSelect(selectedFolder) {
  // 버튼 title에 현재 폴더 이름 표시
  const folder = selectedFolder ? folders.find((f) => f.id === selectedFolder) : null;
  const folderName = folder ? folder.name : '폴더 없음';
  const btn = $('#btn-folder-select');
  if (btn) btn.title = `폴더: ${folderName}`;

  // 드롭다운 리스트 생성
  let html = `<div class="folder-select-item ${!selectedFolder ? 'active' : ''}" data-folder="">-- 폴더 없음 --</div>`;
  const topFolders = folders.filter((f) => !f.parentId).sort(sortBySortOrder);
  for (const f of topFolders) {
    html += `<div class="folder-select-item ${f.id === selectedFolder ? 'active' : ''}" data-folder="${f.id}">${escapeHtml(f.name)}</div>`;
    const children = getChildFolders(f.id);
    for (const c of children) {
      html += `<div class="folder-select-item folder-select-item--child ${c.id === selectedFolder ? 'active' : ''}" data-folder="${c.id}">└ ${escapeHtml(c.name)}</div>`;
    }
  }
  const list = $('#folder-select-list');
  if (list) list.innerHTML = html;
}

function toggleFolderSelectDropdown() {
  const dd = $('#folder-select-dropdown');
  if (dd.style.display !== 'none') {
    dd.style.display = 'none';
    return;
  }
  // 버튼 위치 기준으로 fixed 좌표 계산 (overflow 탈출 + 화면 우측 잘림 방지)
  positionDropdown(dd, $('#btn-folder-select'));
  dd.style.display = 'block';
}

function positionDropdown(dd, btn) {
  const rect = btn.getBoundingClientRect();
  dd.style.top = rect.bottom + 'px';
  // 우측 잘림 방지: min-width 200px 기준
  const ddWidth = Math.max(200, dd.offsetWidth || 200);
  let left = rect.left;
  if (left + ddWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - ddWidth - 8);
  }
  dd.style.left = left + 'px';
}

function onFolderSelectItemClick(e) {
  const item = e.target.closest('.folder-select-item');
  if (!item) return;
  const folderId = item.dataset.folder || null;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.folder = folderId;
  // 폴더 지정도 '수정'이므로 updatedAt을 갱신한다.
  // (갱신하지 않으면 동기화 병합 시 폴더 없던 원격본과 시간이 같아 폴더 지정이 되돌려지고,
  //  빈 메모로 간주돼 자동 삭제될 수 있다.)
  memo.updatedAt = Date.now();
  $('#folder-select-dropdown').style.display = 'none';
  updateFolderSelect(folderId);
  scheduleAutoSave();
}

function createOfflineCopy(memo) {
  if (offlineCopyId) return memos.find((m) => m.id === offlineCopyId);
  const title = (memo.title || formatCreatedAt(memo.createdAt) + ' 새 글') + ' (Offline Work)';
  const copy = {
    id: crypto.randomUUID(),
    title,
    content: memo.content,
    folder: memo.folder,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memos.unshift(copy);
  currentId = copy.id;
  offlineCopyId = copy.id;
  titleInput.value = copy.title;
  saveLocalData();
  renderMemoList();
  return copy;
}

function onEditorInput() {
  let memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  // 오프라인 상태에서 편집 시 복사본 생성
  if (!accessToken && !offlineCopyId) {
    memo = createOfflineCopy(memo);
  }
  scheduleUndoSnapshot(memo);
  memo.content = editor.value;
  memo.updatedAt = Date.now();
  updateCharCount();
  saveLocalData(); // localStorage는 즉시 저장 (탭 닫혀도 보존)
  scheduleRenderAndSync();
}

function onTitleInput() {
  let memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  if (!accessToken && !offlineCopyId) {
    memo = createOfflineCopy(memo);
  }
  memo.title = titleInput.value;
  memo.updatedAt = Date.now();
  saveLocalData(); // localStorage는 즉시 저장
  scheduleRenderAndSync();
}

// 본문 커서 자리에 구분선 한 줄 삽입 (Alt+Shift+D=하이픈, Alt+Shift+E=등호)
// 길이는 창 크기와 무관하게 고정 (DIVIDER_LEN 글자)
const DIVIDER_LEN = 59;
function insertDivider(ch) {
  if (document.activeElement !== editor) return;
  const line = ch.repeat(DIVIDER_LEN);

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  const pre = (before === '' || before.endsWith('\n')) ? '' : '\n'; // 줄 중간이면 줄바꿈 먼저
  const insert = pre + line + '\n';
  editor.value = before + insert + after;
  const caret = (before + insert).length; // 커서는 구분선 다음 줄로
  editor.setSelectionRange(caret, caret);
  // 기존 입력 처리에 연결 → 저장·되돌리기(Ctrl+Z)·검색 하이라이트 자동 연동
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// 현재 날짜(요일 포함), withTime이면 24시 HH:MM도 붙여 반환 — 예: 2026-06-21(일) 03:10
function formatDateStamp(withTime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  let s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '(' + wd + ')';
  if (withTime) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  return s;
}

// 현재 포커스된 입력칸(본문 또는 제목) 커서 자리에 텍스트 삽입
function insertTextAtCursor(text) {
  const el = document.activeElement;
  if (el !== editor && el !== titleInput) return;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true })); // 저장·되돌리기 연동
}

// 에디터 스크롤 방향에 따라 툴바·제목 숨김/표시
let lastEditorScrollTop = 0;
let editorScrollLock = false;
function handleEditorScroll() {
  // 상태 변경 직후 보정 스크롤 무시 (트랜지션 중 떨림 방지)
  if (editorScrollLock) return;
  const st = editor.scrollTop;
  const delta = st - lastEditorScrollTop;
  // 미세한 변화는 기준점만 갱신
  if (Math.abs(delta) < 5) return;

  const isHidden = document.body.classList.contains('toolbar-hidden');
  if (delta > 0 && !isHidden) {
    // 아래로 스크롤 → 숨김 (펼치기는 ▼ 버튼 클릭으로만)
    document.body.classList.add('toolbar-hidden');
    editorScrollLock = true;
    setTimeout(() => {
      editorScrollLock = false;
      lastEditorScrollTop = editor.scrollTop;
    }, 350);
  } else {
    lastEditorScrollTop = st;
  }
}

function scheduleRenderAndSync() {
  // renderAll + Dropbox 동기화는 1.5초 디바운스
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}

// 폴더 선택, undo/redo 등에서 호출: 즉시 저장 + 디바운스 동기화
function scheduleAutoSave() {
  saveLocalData();
  scheduleRenderAndSync();
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

// 앱을 닫거나 다른 화면으로 넘어갈 때: 현재 내용을 즉시 기기에 저장 + 대기 중인 클라우드 전송을 바로 실행
function flushSave() {
  // 편집 중인 메모가 있을 때만 저장 (메모 미선택 시 빈 상태로 덮어쓰는 것 방지 — 여러 창 동시 사용 대비)
  if (currentId) {
    const memo = memos.find((m) => m.id === currentId);
    if (memo) {
      memo.content = editor.value;
      memo.title = titleInput.value;
      memo.updatedAt = Date.now();
      saveLocalData();
    }
  }
  // 3초 대기 중인 동기화가 있으면 기다리지 않고 지금 바로 보냄
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (accessToken) syncToDropbox().catch(() => {});
  }
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

// ── Undo / Redo (어절 단위) ──
let undoGroupOpen = false;     // 현재 타이핑 묶음이 열려 있는지
let undoIdleTimer = null;
// 어절 경계로 볼 문자: 공백·줄바꿈·구두점
const UNDO_WORD_BOUNDARY = /[\s.,!?;:'"()\[\]{}~…·，。！？；：、]/;

function scheduleUndoSnapshot(memo) {
  const before = memo.content;   // 이번 입력이 반영되기 전 내용
  const after = editor.value;    // 반영된 후 내용
  if (before === after) return;

  // 새 어절 묶음의 시작: '입력 전 상태'를 한 번만 저장
  if (!undoGroupOpen) {
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== before) {
      undoStack.push(before);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    redoStack = []; // 새 입력 시 되살리기 이력 초기화
    undoGroupOpen = true;
  }

  // 어절 경계(공백·구두점)를 입력하면 묶음을 끊어 다음 글자가 새 묶음이 되게 함
  if (UNDO_WORD_BOUNDARY.test(after.slice(-1))) {
    undoGroupOpen = false;
  }

  // 잠시(1.2초) 멈추면 묶음을 끊음
  clearTimeout(undoIdleTimer);
  undoIdleTimer = setTimeout(() => { undoGroupOpen = false; }, 1200);
}

function performUndo() {
  if (undoStack.length === 0) {
    showToast('되돌릴 내용이 없습니다');
    return;
  }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;

  // 현재 상태를 redo 스택에 저장
  redoStack.push(editor.value);

  // 현재 내용과 같으면 한 단계 더 뒤로
  let prev = undoStack.pop();
  if (prev === editor.value && undoStack.length > 0) {
    prev = undoStack.pop();
  }

  editor.value = prev;
  memo.content = prev;
  memo.updatedAt = Date.now();
  undoGroupOpen = false; // 되돌린 뒤 새 입력은 새 묶음으로
  updateCharCount();
  scheduleAutoSave();
  showToast('되돌리기 완료');
}

function performRedo() {
  if (redoStack.length === 0) {
    showToast('되살릴 내용이 없습니다');
    return;
  }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;

  // 현재 상태를 undo 스택에 저장
  undoStack.push(editor.value);

  let next = redoStack.pop();
  if (next === editor.value && redoStack.length > 0) {
    next = redoStack.pop();
  }

  editor.value = next;
  memo.content = next;
  memo.updatedAt = Date.now();
  undoGroupOpen = false; // 되살린 뒤 새 입력은 새 묶음으로
  updateCharCount();
  scheduleAutoSave();
  showToast('되살리기 완료');
}

// ── Char Count ──
function updateCharCount() {
  const el = $('#char-count');
  if (!el) return;
  const len = editor.value.length;
  el.textContent = len.toLocaleString() + '자';
}

// ── Toolbar More ──
function toggleToolbarMore() {
  const extras = document.querySelectorAll('.toolbar-extra');
  const btn = $('#btn-toolbar-more');
  const expanded = btn.classList.toggle('active');
  extras.forEach((el) => el.classList.toggle('toolbar-show', expanded));
  $('#toolbar-right').classList.toggle('expanded', expanded);
  $('#toolbar-buttons').classList.toggle('expanded', expanded);
}

// ── Memo Dates ──
function updateMemoDates(memo) {
  const el = $('#memo-dates');
  if (!el || !memo) return;
  const fmt = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const textEl = $('#memo-dates-text');
  if (textEl) textEl.textContent = '작성: ' + fmt(memo.createdAt) + '　수정: ' + fmt(memo.updatedAt);
  el.style.display = 'flex';
}

// ── Help ──
function showHelpDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box help-box">
      <h3>도움말 · 사용 팁</h3>
      <div class="help-content">
        <p class="help-h">⌨️ 단축키 (PC)</p>
        <ul>
          <li><kbd>Ctrl</kbd>+<kbd>S</kbd> 저장·동기화</li>
          <li><kbd>Ctrl</kbd>+<kbd>N</kbd> 새 글</li>
          <li><kbd>Ctrl</kbd>+<kbd>F</kbd> 찾기·바꾸기</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기 · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 되살리기</li>
          <li><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> 구분선 ------ · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> 구분선 ======</li>
          <li><kbd>Alt</kbd>+<kbd>;</kbd> 날짜 입력 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>;</kbd> 날짜+시간 입력</li>
        </ul>
        <p class="help-h">🗂️ 폴더·정리</p>
        <ul>
          <li>📁 현재 글을 폴더에 지정 — 빈 글도 폴더를 정하면 사라지지 않습니다</li>
          <li>⋮ 더보기에서 즐겨찾기(☆)·삭제(🗑)</li>
          <li>☑ 선택 모드로 여러 글을 한 번에 이동·삭제</li>
        </ul>
        <p class="help-h">📝 작성·보기</p>
        <ul>
          <li>📄 템플릿 저장·불러오기 · 📋 본문만 복사 · 📖 읽기 전용 보기</li>
          <li>글 목록에서 <b>더블클릭</b>하면 새 창으로 열립니다</li>
        </ul>
        <p class="help-h">💾 저장·백업·보안</p>
        <ul>
          <li>입력하면 자동 저장·자동 동기화 (최근 시각은 왼쪽 위에 표시)</li>
          <li>💾 수동 백업 · 매일 자동 백업 · 🗑 휴지통에서 복원</li>
          <li>폴더에 비밀번호 설정 가능 (Master로 전체 해제)</li>
        </ul>
      </div>
      <button class="btn btn-primary" id="help-close">닫기</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#help-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Find & Replace ──
let findMatches = [];
let findIndex = -1;
let findAllMode = false;

function toggleFindReplace() {
  const bar = $('#find-replace-bar');
  const visible = bar.style.display !== 'none';
  bar.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    $('#find-input').value = '';
    $('#replace-input').value = '';
    $('#find-count').textContent = '';
    findMatches = [];
    findIndex = -1;
    findAllMode = false;
    clearHighlight();
    $('#find-input').focus();
  } else {
    clearHighlight();
  }
}

function findCountOnly() {
  const keyword = $('#find-input').value;
  const content = editor.value;
  findMatches = [];
  findIndex = -1;
  findAndGo._lastKeyword = null;
  if (!keyword) { $('#find-count').textContent = ''; return; }
  let idx = 0;
  const lower = content.toLowerCase();
  const keyLower = keyword.toLowerCase();
  while ((idx = lower.indexOf(keyLower, idx)) !== -1) {
    findMatches.push(idx);
    idx += keyLower.length;
  }
  $('#find-count').textContent = findMatches.length + '건';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateHighlight(keyword) {
  const hl = $('#editor-highlight');
  if (!keyword || findMatches.length === 0) { hl.innerHTML = ''; return; }
  const text = editor.value;
  const keyLen = keyword.length;
  let result = '';
  let lastEnd = 0;
  for (const pos of findMatches) {
    result += escHtml(text.substring(lastEnd, pos));
    result += '<mark>' + escHtml(text.substring(pos, pos + keyLen)) + '</mark>';
    lastEnd = pos + keyLen;
  }
  result += escHtml(text.substring(lastEnd)) + '\n';
  hl.innerHTML = result;
  hl.scrollTop = editor.scrollTop;
}

function clearHighlight() {
  $('#editor-highlight').innerHTML = '';
}

function findAndGo() {
  findAllMode = false;
  // 키워드가 바뀌었으면 재검색, 아니면 다음으로 이동
  const keyword = $('#find-input').value;
  if (findMatches.length === 0 || keyword.toLowerCase() !== (findAndGo._lastKeyword || '').toLowerCase()) {
    findCountOnly();
    findAndGo._lastKeyword = keyword;
  }
  if (findMatches.length > 0) findNavigate(1);
}

function findAllAndGo() {
  findAllMode = true;
  findCountOnly();
  if (findMatches.length === 0) { clearHighlight(); return; }
  updateHighlight($('#find-input').value);
  $('#find-count').textContent = findMatches.length + '건 전체';
  showToast(findMatches.length + '건 찾음');
}

function findNavigate(dir) {
  if (findMatches.length === 0) return;
  findAllMode = false;
  findIndex += dir;
  if (findIndex >= findMatches.length) findIndex = 0;
  if (findIndex < 0) findIndex = findMatches.length - 1;
  const pos = findMatches[findIndex];
  const keyword = $('#find-input').value;
  $('#find-count').textContent = (findIndex + 1) + '/' + findMatches.length;
  // 에디터에 포커스를 보내지 않고 하이라이트로 현재 위치 표시
  highlightAllWithCurrent(keyword, pos);
  scrollEditorToPos(pos);
}

function highlightAllWithCurrent(keyword, currentPos) {
  const hl = $('#editor-highlight');
  const text = editor.value;
  const keyLen = keyword.length;
  let result = '';
  let lastEnd = 0;
  for (const pos of findMatches) {
    result += escHtml(text.substring(lastEnd, pos));
    const cls = pos === currentPos ? 'current' : '';
    result += '<mark class="' + cls + '">' + escHtml(text.substring(pos, pos + keyLen)) + '</mark>';
    lastEnd = pos + keyLen;
  }
  result += escHtml(text.substring(lastEnd)) + '\n';
  hl.innerHTML = result;
  hl.scrollTop = editor.scrollTop;
}

function scrollEditorToPos(pos) {
  const textBefore = editor.value.substring(0, pos);
  const lines = textBefore.split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
  const targetScroll = lines * lineHeight - editor.clientHeight / 3;
  editor.scrollTop = Math.max(0, targetScroll);
  $('#editor-highlight').scrollTop = editor.scrollTop;
}

// ── Templates ──
function mergeTemplates(local, remote) {
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const t of remote) { if (!permDelIds.has(t.id)) map.set(t.id, t); }
  for (const t of local) {
    if (permDelIds.has(t.id)) continue;
    const existing = map.get(t.id);
    if (!existing || t.updatedAt > existing.updatedAt) map.set(t.id, t);
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function toggleTemplateDropdown() {
  const dd = $('#template-dropdown');
  const isOpen = dd.style.display !== 'none';
  if (isOpen) { dd.style.display = 'none'; return; }
  renderTemplateList();
  positionDropdown(dd, $('#btn-template'));
  dd.style.display = 'block';
}

function renderTemplateList() {
  const list = $('#template-list');
  if (templates.length === 0) {
    list.innerHTML = '<div class="template-empty">저장된 템플릿이 없습니다</div>';
    return;
  }
  list.innerHTML = templates.map((t) =>
    '<div class="template-item" data-id="' + t.id + '">' +
    '<span class="template-item-name">' + escHtml(t.title || '(제목 없음)') + '</span>' +
    '<button class="template-item-del" data-id="' + t.id + '" title="삭제">×</button>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.template-item-name').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.parentElement.dataset.id;
      applyTemplate(id);
    });
  });
  list.querySelectorAll('.template-item-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplate(btn.dataset.id);
    });
  });
}

function saveAsTemplate() {
  if (!currentId) { showToast('메모를 먼저 선택하세요'); return; }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const name = prompt('템플릿 이름을 입력하세요:', memo.title || '');
  if (name === null) return;
  const tpl = {
    id: crypto.randomUUID(),
    title: name.trim() || '(제목 없음)',
    content: memo.content,
    folder: memo.folder || null,   // 템플릿에 폴더도 함께 저장
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  templates.unshift(tpl);
  saveLocalData();
  scheduleSyncToDropbox();
  renderTemplateList();
  showToast('템플릿이 저장되었습니다');
}

function applyTemplate(templateId) {
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) return;
  $('#template-dropdown').style.display = 'none';

  // 새 글의 폴더 결정 (cleanupEmptyMemo가 currentId를 비우기 전에 캡처)
  // 1) 템플릿에 저장된 폴더(현재 존재할 때) → 그 폴더
  // 2) 없으면 현재 연 폴더 → 3) 지금 보고 있는 글의 폴더 → 4) 폴더 없음
  let targetFolder = null;
  if (tpl.folder && folders.some((f) => f.id === tpl.folder)) {
    targetFolder = tpl.folder;
  } else {
    targetFolder = (currentFolder && currentFolder !== '__none__') ? currentFolder : null;
    if (!targetFolder && currentId) {
      const cur = memos.find((m) => m.id === currentId);
      if (cur && cur.folder) targetFolder = cur.folder;
    }
  }

  cleanupEmptyMemo();
  // 새 메모 생성 후 템플릿 내용 적용
  const memo = {
    id: crypto.randomUUID(),
    title: tpl.title,
    content: tpl.content,
    folder: targetFolder,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    favorite: false,
  };
  memos.unshift(memo);
  currentId = memo.id;
  saveLocalData();
  renderAll();
  showEditor(memo);
  scheduleSyncToDropbox();
  showToast('템플릿이 적용되었습니다');
}

function deleteTemplate(templateId) {
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) return;
  if (!confirm('"' + tpl.title + '" 템플릿을 삭제하시겠습니까?')) return;
  deletedIds.push({ id: templateId, at: Date.now() });
  templates = templates.filter((t) => t.id !== templateId);
  saveLocalData();
  scheduleSyncToDropbox();
  renderTemplateList();
  showToast('템플릿이 삭제되었습니다');
}

function replaceAction() {
  const keyword = $('#find-input').value;
  const replacement = $('#replace-input').value;
  if (!keyword || findMatches.length === 0) return;

  if (findAllMode) {
    // 모두 찾기 상태 → 전체 바꾸기
    const regex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const count = (editor.value.match(regex) || []).length;
    if (count === 0) return;
    editor.value = editor.value.replace(regex, replacement);
    const memo = memos.find((m) => m.id === currentId);
    if (memo) { memo.content = editor.value; memo.updatedAt = Date.now(); }
    saveLocalData();
    scheduleSyncToDropbox();
    updateCharCount();
    findMatches = [];
    findIndex = -1;
    findAllMode = false;
    clearHighlight();
    $('#find-count').textContent = count + '건 바꿈';
    showToast(count + '건 바꿨습니다');
  } else {
    // 찾기 상태 → 현재 1건 바꾸기
    if (findIndex < 0) findIndex = 0;
    const pos = findMatches[findIndex];
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos + keyword.length);
    editor.value = before + replacement + after;
    const memo = memos.find((m) => m.id === currentId);
    if (memo) { memo.content = editor.value; memo.updatedAt = Date.now(); }
    saveLocalData();
    scheduleSyncToDropbox();
    updateCharCount();
    findCountOnly(); // 재검색
    if (findMatches.length > 0) {
      if (findIndex >= findMatches.length) findIndex = 0;
      findNavigate(0);
    }
  }
}

// ── Copy & Share ──
// 제목은 빼고 본문 텍스트만 복사한다.
function copyMemoToClipboard() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  navigator.clipboard.writeText(memo.content || '').then(() => {
    showToast('클립보드에 복사됨');
  }).catch(() => {
    showToast('복사 실패');
  });
}

function shareMemo() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const text = (memo.title ? memo.title + '\n\n' : '') + memo.content;
  if (navigator.share) {
    navigator.share({ title: memo.title || 'Moon\'s Notes', text }).catch(() => {});
  } else {
    // Web Share API 미지원 시 클립보드 복사 대체
    navigator.clipboard.writeText(text).then(() => {
      showToast('공유 미지원 환경 — 클립보드에 복사됨');
    }).catch(() => {
      showToast('공유 실패');
    });
  }
}

// ── Select Mode & Bulk Actions ──
function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) folderListCollapsed = false;
  selectedMemos.clear();
  selectedFolders.clear();
  lastCheckedMemoIndex = -1;
  lastCheckedFolderIndex = -1;
  touchSelectActive = false;
  $('#btn-select-mode').classList.toggle('active', selectMode);
  $('#bulk-actions').style.display = selectMode ? 'flex' : 'none';
  if (selectMode) $('#folder-dropdown').style.display = 'block';
  renderMemoList();
  renderFolderList();
}

function bulkDelete() {
  const hasMemos = selectedMemos.size > 0;
  const hasFolders = selectedFolders.size > 0;
  if (!hasMemos && !hasFolders) { showToast('선택된 항목이 없습니다'); return; }
  if (hasMemos && hasFolders) { showToast('메모와 폴더를 동시에 삭제할 수 없습니다. 하나만 선택해주세요.'); return; }

  const label = hasMemos ? selectedMemos.size + '개 메모' : selectedFolders.size + '개 폴더';
  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'modal-overlay';
  o1.innerHTML = `<div class="modal-box"><p>${label}를 삭제할까요?</p><button class="btn btn-secondary" id="bd-cancel">취소</button> <button class="btn btn-primary" id="bd-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#bd-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#bd-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'modal-overlay';
    o2.innerHTML = `<div class="modal-box"><p>${label}를 정말 삭제할까요?</p><button class="btn btn-secondary" id="bd-cancel2">취소</button> <button class="btn btn-primary" id="bd-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#bd-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#bd-ok2').onclick = () => {
      o2.remove();
      if (hasMemos) {
        for (const id of selectedMemos) {
          const memo = memos.find((m) => m.id === id);
          if (memo) trash.push({ type: 'memo', data: { ...memo }, deletedAt: Date.now() });
        }
        memos = memos.filter((m) => !selectedMemos.has(m.id));
        if (selectedMemos.has(currentId)) { currentId = null; hideEditor(); }
        selectedMemos.clear();
      } else {
        for (const id of selectedFolders) {
          deleteFolder(id);
        }
        selectedFolders.clear();
      }
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('삭제되었습니다');
    };
  };
}

function bulkMoveUnified() {
  const hasMemos = selectedMemos.size > 0;
  const hasFolders = selectedFolders.size > 0;
  if (!hasMemos && !hasFolders) { showToast('선택된 항목이 없습니다'); return; }
  if (hasMemos && hasFolders) { showToast('메모와 폴더를 동시에 이동할 수 없습니다. 하나만 선택해주세요.'); return; }

  if (hasMemos) {
    // 메모 이동
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    let opts = '<option value="">-- 폴더 없음 --</option>';
    const topFolders = folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder);
    for (const f of topFolders) {
      opts += '<option value="' + f.id + '">' + escapeHtml(f.name) + '</option>';
      const children = getChildFolders(f.id);
      for (const c of children) {
        opts += '<option value="' + c.id + '">　' + escapeHtml(c.name) + '</option>';
      }
    }
    overlay.innerHTML = '<div class="modal-box"><p>' + selectedMemos.size + '개 메모를 이동할 폴더를 선택하세요</p><select style="width:100%;padding:8px;margin-bottom:16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">' + opts + '</select><div><button class="btn btn-primary" id="bm-ok">이동</button> <button class="btn btn-secondary" id="bm-cancel">취소</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#bm-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#bm-ok').onclick = () => {
      const folder = overlay.querySelector('select').value || null;
      for (const id of selectedMemos) {
        const m = memos.find((x) => x.id === id);
        if (m) { m.folder = folder; m.updatedAt = Date.now(); }
      }
      selectedMemos.clear();
      overlay.remove();
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('이동되었습니다');
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  } else {
    // 폴더 이동
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const excludeIds = new Set(selectedFolders);
    for (const id of selectedFolders) {
      getChildFolders(id).forEach((c) => excludeIds.add(c.id));
    }
    let opts = '<option value="__top__">-- 최상위 (상위폴더 없음) --</option>';
    const topFolders = folders.filter((f) => !f.parentId && !f.dormant && !excludeIds.has(f.id)).sort(sortBySortOrder);
    for (const f of topFolders) {
      opts += '<option value="' + f.id + '">' + escapeHtml(f.name) + '</option>';
    }
    overlay.innerHTML = '<div class="modal-box"><p>' + selectedFolders.size + '개 폴더를 이동할 상위 폴더를 선택하세요</p><select style="width:100%;padding:8px;margin-bottom:16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">' + opts + '</select><div><button class="btn btn-primary" id="bf-ok">이동</button> <button class="btn btn-secondary" id="bf-cancel">취소</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#bf-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#bf-ok').onclick = () => {
      const target = overlay.querySelector('select').value;
      const newParent = target === '__top__' ? null : target;
      for (const id of selectedFolders) {
        const f = folders.find((x) => x.id === id);
        if (f) {
          f.parentId = newParent;
          f.sortOrder = nextSortOrder(newParent);
        }
      }
      selectedFolders.clear();
      overlay.remove();
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('폴더가 이동되었습니다');
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }
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

function toggleFolderListCollapse() {
  folderListCollapsed = !folderListCollapsed;
  $('#folder-dropdown').style.display = 'block'; // 드롭다운 자체는 항상 유지
  renderFolderList();
}

function toggleFavFilter() {
  favFilterActive = !favFilterActive;
  const btn = $('#btn-fav-filter');
  btn.classList.toggle('active', favFilterActive);
  btn.textContent = favFilterActive ? '★' : '☆';
  renderMemoList();
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
  const count = isChild ? memos.filter((m) => m.folder === f.id && isVisibleMemo(m)).length : getFolderMemoCount(f.id);
  const lockIcon = f.password ? (unlockedFolders.has(f.id) ? '🔓' : '🔒') : '';
  const childClass = isChild ? ' folder-item--child' : '';
  const dormantIcon = (!isChild) ? `<span class="folder-dormant" data-dormant="${f.id}" title="${f.dormant ? '휴면 해제' : '휴면 처리'}">${f.dormant ? '☀️' : '💤'}</span>` : '';
  const folderCheckbox = selectMode ? `<input type="checkbox" class="folder-item-checkbox" data-folder-check="${f.id}"${selectedFolders.has(f.id) ? ' checked' : ''}>` : '';
  return `<div class="folder-item${childClass} ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
    ${folderCheckbox}
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
    </span>
  </div>`;
}

function renderFolderList() {
  const lockedIds = getLockedFolderIds();
  const dormantIds = getDormantFolderIds();
  const allCount = memos.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder) && isVisibleMemo(m)).length;
  const collapseBtn = selectMode
    ? `<button class="folder-collapse-btn">${folderListCollapsed ? '목록 펼치기' : '목록 접기'}</button>`
    : '';
  let html = `<div class="folder-item ${currentFolder === null ? 'active' : ''}" data-folder="__all__">
    <span class="folder-item-name">전체 <span class="folder-count">(${allCount})</span></span>
    ${collapseBtn}
  </div>`;

  // 접힌 상태(선택 모드)에서는 전체 행만 표시, 펼쳐진 상태에서는 나머지 폴더 추가
  if (!selectMode || !folderListCollapsed) {

  // 활성 폴더 (휴면이 아닌 폴더)
  const topFolders = folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder);
  for (const f of topFolders) {
    html += renderFolderItem(f, false);
    const children = getChildFolders(f.id);
    for (const c of children) {
      html += renderFolderItem(c, true);
    }
  }

  const noFolderCount = memos.filter((m) => !m.folder && isVisibleMemo(m)).length;
  if (folders.length > 0) {
    html += `<div class="folder-item ${currentFolder === '__none__' ? 'active' : ''}" data-folder="__none__">
      <span class="folder-item-name">미분류 <span class="folder-count">(${noFolderCount})</span></span>
    </div>`;
  }

  // 휴면 폴더 섹션
  const dormantTopFolders = folders.filter((f) => !f.parentId && f.dormant).sort(sortBySortOrder);
  if (dormantTopFolders.length > 0) {
    const dormantMemoCount = memos.filter((m) => dormantIds.has(m.folder) && isVisibleMemo(m)).length;
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

  } // end: !selectMode || !folderListCollapsed

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

  // 선택 모드: 폴더 체크박스 이벤트
  const selectableFolderItems = Array.from(folderList.querySelectorAll('.folder-item[data-folder]')).filter((el) => el.querySelector('.folder-item-checkbox'));
  folderList.querySelectorAll('.folder-item-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.folderCheck;
      if (cb.checked) selectedFolders.add(id); else selectedFolders.delete(id);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  });

  // 모바일 롱프레스 범위 선택 (폴더)
  if (selectMode) {
    let fTouchStartIdx = -1;
    let fTouchLastIdx = -1;
    selectableFolderItems.forEach((el, idx) => {
      el.addEventListener('touchstart', (e) => {
        touchSelectActive = false;
        fTouchStartIdx = idx;
        fTouchLastIdx = idx;
        el._fLongPress = setTimeout(() => {
          touchSelectActive = true;
          const cb = el.querySelector('.folder-item-checkbox');
          if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          lastCheckedFolderIndex = idx;
        }, 400);
      }, { passive: true });
      el.addEventListener('touchend', () => {
        clearTimeout(el._fLongPress);
        touchSelectActive = false;
      });
    });
    folderList.addEventListener('touchmove', (e) => {
      if (!touchSelectActive) return;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!target) return;
      const item = target.closest('.folder-item');
      if (!item) return;
      const idx = selectableFolderItems.indexOf(item);
      if (idx === -1 || idx === fTouchLastIdx) return;
      fTouchLastIdx = idx;
      const start = Math.min(fTouchStartIdx, idx);
      const end = Math.max(fTouchStartIdx, idx);
      for (let i = start; i <= end; i++) {
        const cb = selectableFolderItems[i].querySelector('.folder-item-checkbox');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      }
    }, { passive: true });
  }

  folderList.querySelectorAll('.folder-item').forEach((el) => {
    // Long press for mobile: show action icons
    let longPressTimer = null;
    let didLongPress = false;

    el.addEventListener('touchstart', (e) => {
      if (selectMode) return; // 선택 모드에서는 롱프레스 비활성화
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        folderList.querySelectorAll('.folder-actions-left.show, .folder-actions-right.show').forEach((a) => a.classList.remove('show'));
        el.querySelectorAll('.folder-actions-left, .folder-actions-right').forEach((a) => a.classList.toggle('show'));
      }, 500);
    }, { passive: true });

    el.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
    el.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });

    // Right-click for PC: show action icons
    el.addEventListener('contextmenu', (e) => {
      if (selectMode) return;
      if (!el.querySelector('.folder-actions-left')) return;
      e.preventDefault();
      folderList.querySelectorAll('.folder-actions-left.show, .folder-actions-right.show').forEach((a) => a.classList.remove('show'));
      el.querySelectorAll('.folder-actions-left, .folder-actions-right').forEach((a) => a.classList.toggle('show'));
    });

    el.addEventListener('click', (e) => {
      if (didLongPress) { didLongPress = false; return; }

      // 선택 모드: 폴더 체크박스 토글 + Shift 범위 선택
      if (selectMode) {
        if (el.dataset.folder === '__all__') { toggleFolderListCollapse(); return; }
        const cb = el.querySelector('.folder-item-checkbox');
        if (!cb) return; // 미분류는 체크박스 없음
        const idx = selectableFolderItems.indexOf(el);
        if (e.shiftKey && lastCheckedFolderIndex >= 0 && idx >= 0) {
          const start = Math.min(lastCheckedFolderIndex, idx);
          const end = Math.max(lastCheckedFolderIndex, idx);
          for (let i = start; i <= end; i++) {
            const c = selectableFolderItems[i].querySelector('.folder-item-checkbox');
            if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); }
          }
          lastCheckedFolderIndex = idx;
          return;
        }
        if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        if (idx >= 0) lastCheckedFolderIndex = idx;
        return;
      }

      // 메뉴가 보이는 상태(.show)일 때만 버튼 동작
      const actionsVisible = el.querySelector('.folder-actions-left.show');
      if (actionsVisible) {
        if (e.target.dataset.moveup) { moveFolderUp(e.target.dataset.moveup); return; }
        if (e.target.dataset.movedown) { moveFolderDown(e.target.dataset.movedown); return; }
        if (e.target.classList.contains('folder-edit')) { showRenameFolderDialog(e.target.dataset.edit); return; }
        if (e.target.classList.contains('folder-lock')) { showSetPasswordDialog(e.target.dataset.lock); return; }
        if (e.target.classList.contains('folder-moveto')) { showMoveFolderDialog(e.target.dataset.moveto); return; }
        if (e.target.classList.contains('folder-dormant')) { toggleDormant(e.target.dataset.dormant); return; }
      }

      const val = el.dataset.folder;
      if (val === '__all__') { currentFolder = null; }
      else if (val === '__none__') { currentFolder = '__none__'; }
      else {
        if (isFolderLocked(val)) {
          showPasswordPrompt(val, () => {
            currentFolder = val;
            renderAll();
            if (!selectMode) $('#folder-dropdown').style.display = 'none';
          });
          return;
        }
        currentFolder = val;
      }
      renderAll();
      if (!selectMode) $('#folder-dropdown').style.display = 'none';
    });
  });
}

function renderMemoList() {
  const query = searchBox.value.toLowerCase().trim();
  // 현재 편집 중이 아닌 빈 메모는 목록에서 숨기기 (폴더 지정된 메모는 표시)
  let filtered = memos.filter((m) => m.id === currentId || !isBlankMemo(m));
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

  if (favFilterActive) {
    filtered = filtered.filter((m) => m.favorite);
  }

  if (query) {
    filtered = filtered.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(query) ||
        (m.content || '').toLowerCase().includes(query)
    );
  }

  // 정렬
  if (memoSortKey === 'title') {
    filtered.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
  } else if (memoSortKey === 'createdAt') {
    filtered.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
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
      const checkbox = selectMode ? '<input type="checkbox" class="memo-item-checkbox" data-check="' + m.id + '"' + (selectedMemos.has(m.id) ? ' checked' : '') + '>' : '';
      return `
        <div class="memo-item ${active}" data-id="${m.id}">
          ${checkbox}
          ${favIcon}
          <div class="memo-item-info">
            <div class="memo-item-title">${escapeHtml(title)}</div>
          </div>
          <div class="memo-item-date">${date}</div>
        </div>
      `;
    })
    .join('');

  // 선택 모드: 체크박스 이벤트
  const memoItems = Array.from(memoList.querySelectorAll('.memo-item'));
  memoList.querySelectorAll('.memo-item-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.check;
      if (cb.checked) selectedMemos.add(id); else selectedMemos.delete(id);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  });

  // 모바일 롱프레스 범위 선택
  if (selectMode) {
    let touchStartIndex = -1;
    let touchLastIndex = -1;
    memoItems.forEach((el, idx) => {
      el.addEventListener('touchstart', (e) => {
        if (!selectMode) return;
        touchSelectActive = false;
        touchStartIndex = idx;
        touchLastIndex = idx;
        el._longPressTimer = setTimeout(() => {
          touchSelectActive = true;
          // 시작점 선택
          const cb = el.querySelector('.memo-item-checkbox');
          if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          lastCheckedMemoIndex = idx;
        }, 400);
      }, { passive: true });
      el.addEventListener('touchend', () => {
        clearTimeout(el._longPressTimer);
        touchSelectActive = false;
      });
    });
    memoList.addEventListener('touchmove', (e) => {
      if (!touchSelectActive) return;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!target) return;
      const item = target.closest('.memo-item');
      if (!item) return;
      const idx = memoItems.indexOf(item);
      if (idx === -1 || idx === touchLastIndex) return;
      touchLastIndex = idx;
      // 범위 내 모두 선택
      const start = Math.min(touchStartIndex, idx);
      const end = Math.max(touchStartIndex, idx);
      for (let i = start; i <= end; i++) {
        const cb = memoItems[i].querySelector('.memo-item-checkbox');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      }
    }, { passive: true });
  }

  memoList.querySelectorAll('.memo-item').forEach((el, idx) => {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      if (selectMode) {
        // Shift+클릭 범위 선택
        if (e.shiftKey && lastCheckedMemoIndex >= 0) {
          const start = Math.min(lastCheckedMemoIndex, idx);
          const end = Math.max(lastCheckedMemoIndex, idx);
          for (let i = start; i <= end; i++) {
            const cb = memoItems[i].querySelector('.memo-item-checkbox');
            if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          }
          lastCheckedMemoIndex = idx;
          return;
        }
        const cb = el.querySelector('.memo-item-checkbox');
        if (cb && e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        lastCheckedMemoIndex = idx;
        return;
      }
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const memo = memos.find((m) => m.id === el.dataset.id);
        if (memo) loadMemoInEditor(memo);
        $('#sidebar').classList.remove('open');
      }, 250);
    });
    el.addEventListener('dblclick', () => {
      if (selectMode) return;
      clearTimeout(clickTimer);
      clickTimer = null;
      const id = el.dataset.id;
      window.open(location.pathname + '?memo=' + id, '_blank', 'width=400,height=700');
    });
  });
}

// ── UI Helpers ──
function showApp() {
  loginScreen.style.display = 'none';
  app.style.display = 'flex';
  renderAll();
  updateSaveSyncTimes();
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

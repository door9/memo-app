// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun'; // Dropbox App Key를 여기에 입력
const DROPBOX_FILE = '/memo-app/memos.json';
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let currentId = null;
let accessToken = localStorage.getItem('dbx_token') || null;
let isOnline = !!accessToken;
let previewVisible = false;
let saveTimer = null;

// ── DOM ──
const $ = (s) => document.querySelector(s);
const loginScreen = $('#login-screen');
const app = $('#app');
const memoList = $('#memo-list');
const editor = $('#editor');
const preview = $('#preview');
const titleInput = $('#memo-title-input');
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
  loadLocalMemos();

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
  $('#btn-sync').addEventListener('click', () => {
    if (!accessToken) {
      loginDropbox();
      return;
    }
    syncFromDropbox();
  });
  $('#btn-preview').addEventListener('click', togglePreview);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#menu-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  editor.addEventListener('input', onEditorInput);
  titleInput.addEventListener('input', onTitleInput);
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
    scope: 'files.content.read files.content.write',
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
  if (res.status === 409 || res.status === 404) return null; // file not found
  if (res.status === 401) {
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (!res.ok) throw new Error('download failed: ' + res.status);
  return res.json();
}

// ── Sync ──
async function syncFromDropbox() {
  if (!accessToken) return;
  setSyncStatus('syncing', '동기화 중...');
  try {
    const remote = await dbxDownload();
    if (remote && Array.isArray(remote)) {
      memos = mergeMemos(memos, remote);
    }
    saveLocalMemos();
    await syncToDropbox();
    setSyncStatus('synced', '동기화 완료');
    renderMemoList();
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
  const data = JSON.stringify(memos, null, 2);
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

// ── Local Storage ──
function saveLocalMemos() {
  localStorage.setItem('memos', JSON.stringify(memos));
}

function loadLocalMemos() {
  try {
    const data = localStorage.getItem('memos');
    if (data) memos = JSON.parse(data);
  } catch {}
}

// ── Memo CRUD ──
function createMemo() {
  const memo = {
    id: crypto.randomUUID(),
    title: '',
    content: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memos.unshift(memo);
  currentId = memo.id;
  saveLocalMemos();
  renderMemoList();
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
  saveLocalMemos();
  renderMemoList();
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

// ── Editor ──
function showEditor(memo) {
  editorToolbar.style.display = 'flex';
  editorContainer.style.display = 'flex';
  emptyState.style.display = 'none';
  titleInput.value = memo.title;
  editor.value = memo.content;
  updatePreview();
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

function onEditorInput() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.content = editor.value;
  memo.updatedAt = Date.now();
  updatePreview();
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
  saveLocalMemos();
  renderMemoList();
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

// ── Preview ──
function togglePreview() {
  previewVisible = !previewVisible;
  preview.classList.toggle('visible', previewVisible);
  $('#btn-preview').classList.toggle('active', previewVisible);
  if (previewVisible) updatePreview();
}

function updatePreview() {
  if (!previewVisible) return;
  const raw = marked.parse(editor.value || '');
  preview.innerHTML = DOMPurify.sanitize(raw);
}

// ── Render ──
function renderMemoList() {
  const query = searchBox.value.toLowerCase().trim();
  let filtered = memos;
  if (query) {
    filtered = memos.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(query) ||
        (m.content || '').toLowerCase().includes(query)
    );
  }

  memoList.innerHTML = filtered
    .map((m) => {
      const title = m.title || '제목 없음';
      const previewText = (m.content || '').replace(/[#*_`>\-\[\]()]/g, '').substring(0, 60);
      const date = formatDate(m.updatedAt);
      const active = m.id === currentId ? 'active' : '';
      return `
        <div class="memo-item ${active}" data-id="${m.id}">
          <div class="memo-item-title">${escapeHtml(title)}</div>
          <div class="memo-item-preview">${escapeHtml(previewText)}</div>
          <div class="memo-item-date">${date}</div>
        </div>
      `;
    })
    .join('');

  memoList.querySelectorAll('.memo-item').forEach((el) => {
    el.addEventListener('click', () => {
      const memo = memos.find((m) => m.id === el.dataset.id);
      if (memo) loadMemoInEditor(memo);
      $('#sidebar').classList.remove('open');
    });
  });
}

// ── UI Helpers ──
function showApp() {
  loginScreen.style.display = 'none';
  app.style.display = 'flex';
  renderMemoList();
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

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

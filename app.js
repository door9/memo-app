// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
const DROPBOX_FILE = '/memo-app/memos.json';
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
let currentId = null;
let currentFolder = null; // null = all
let accessToken = localStorage.getItem('dbx_token') || null;
let isOnline = !!accessToken;
let previewVisible = false;
let saveTimer = null;
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
const preview = $('#preview');
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
  $('#btn-folder-toggle').addEventListener('click', toggleFolderDropdown);
  $('#btn-folder-add').addEventListener('click', showFolderDialog);
  $('#btn-sync').addEventListener('click', () => {
    if (!accessToken) { loginDropbox(); return; }
    syncFromDropbox();
  });
  $('#btn-undo').addEventListener('click', performUndo);
  $('#btn-preview').addEventListener('click', togglePreview);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#menu-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
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
  if (res.status === 409 || res.status === 404) return null;
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
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      if (Array.isArray(remote.memos)) memos = mergeMemos(memos, remote.memos);
      if (Array.isArray(remote.folders)) folders = mergeFolders(folders, remote.folders);
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
  const data = JSON.stringify({ memos, folders }, null, 2);
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
}

function loadLocalData() {
  try {
    const md = localStorage.getItem('memos');
    if (md) memos = JSON.parse(md);
    const fd = localStorage.getItem('folders');
    if (fd) folders = JSON.parse(fd);
  } catch {}
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
  updatePreview();
  scheduleAutoSave();
  showToast('되돌리기 완료');
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
  const allCount = memos.length;
  let html = `<div class="folder-item ${currentFolder === null ? 'active' : ''}" data-folder="__all__">
    <span class="folder-item-name">전체</span><span class="folder-count">${allCount}</span>
  </div>`;

  for (const f of folders) {
    const count = memos.filter((m) => m.folder === f.id).length;
    html += `<div class="folder-item ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
      <span class="folder-item-name">${escapeHtml(f.name)}</span><span class="folder-count">${count}</span><span class="folder-del" data-del="${f.id}">&times;</span>
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
      const val = el.dataset.folder;
      if (val === '__all__') currentFolder = null;
      else if (val === '__none__') currentFolder = '__none__';
      else currentFolder = val;
      renderAll();
      $('#folder-dropdown').style.display = 'none';
    });
  });
}

function renderMemoList() {
  const query = searchBox.value.toLowerCase().trim();
  let filtered = memos;

  if (currentFolder === '__none__') {
    filtered = filtered.filter((m) => !m.folder);
  } else if (currentFolder) {
    filtered = filtered.filter((m) => m.folder === currentFolder);
  }

  if (query) {
    filtered = filtered.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(query) ||
        (m.content || '').toLowerCase().includes(query)
    );
  }

  memoList.innerHTML = filtered
    .map((m) => {
      const title = m.title || '제목 없음';
      const date = formatDate(m.updatedAt);
      const active = m.id === currentId ? 'active' : '';
      return `
        <div class="memo-item ${active}" data-id="${m.id}">
          <div class="memo-item-info">
            <div class="memo-item-title">${escapeHtml(title)}</div>
          </div>
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

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

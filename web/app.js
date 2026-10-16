'use strict';

const ICONS = {
  boards:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  workspace:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/>',
  star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/>',
  code:'<path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  more:'<circle cx="5" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="19" cy="12" r=".9"/>',
  edit:'<path d="m15 5 4 4M4 20l4.5-1L21 6.5 17.5 3 5 15.5Z"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  tag:'<path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/>',
  user:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  'chevron-down':'<path d="m7 10 5 5 5-5"/>',
  columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>',
  list:'<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
  card:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  'check-square':'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  'check-circle':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  circle:'<circle cx="12" cy="12" r="8"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  'alert-circle':'<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>'
};
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.card}</svg>`;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels = Object.create(null);
const priorities = Object.create(null);
const productivity = OpenBoardProductivity;
const covers = [];
const state = {
  boards:[], board:null, storageLabel:'', versionRequested:false, query:'', label:'', assignee:'', priority:'', status:'', sort:'manual',
  archived:false, archivedBoards:false, view:'board', saving:false, loading:true, loadError:false,
  loadSequence:0, cardSequence:0, cardEditor:null, boardEditor:null, columnEditor:null,
  draggedCard:null, toastTimer:null, auth:null, remoteVersion:null, polling:false, panel:null, selectionMode:false, selectedCards:new Map(), boardWatching:false, cardWatching:false
};
function stored(key, fallback = '') { try { return localStorage.getItem(`openboard.${key}`) || fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(`openboard.${key}`, value); } catch { /* Local preferences remain optional. */ } }
function forget(key) { try { localStorage.removeItem(`openboard.${key}`); } catch { /* Storage can be disabled. */ } }
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
state.view = ['board','list','calendar','stats','table'].includes(stored('view')) ? stored('view') : 'board';
document.documentElement.dataset.theme = stored('theme','light');
document.documentElement.dataset.density = stored('density','comfortable');
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); }); }
hydrateIcons();

class APIError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'APIError'; this.status = status; }
}
const pendingPosts = new Map();
async function api(path, method = 'GET', body, options = {}) {
  const headers = {'Accept':'application/json'};
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.auth?.csrf) headers['X-CSRF-Token'] = state.auth.csrf;
  if (options.version !== undefined && options.version !== null) headers['If-Match'] = `"${Number(options.version)}"`;
  const requestId = `${path}:${serialized || ''}`;
  if (method === 'POST') {
    if (!options.key && !pendingPosts.has(requestId)) pendingPosts.set(requestId,uuid());
    headers['Idempotency-Key'] = options.key || pendingPosts.get(requestId);
  }
  // A POST retry reuses the exact serialized body and key, including after a lost response.
  for (let attempt = 0; attempt < (method === 'POST' ? 2 : 1); attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),15000);
    try {
      const response = await fetch(path,{method,headers,body:serialized,signal:controller.signal,credentials:'same-origin',cache:'no-store'});
      let result;
      try { result = await response.json(); } catch { throw new APIError('Risposta del server non valida. Verifica l’esito prima di riprovare.',response.status); }
      if (!response.ok) {
        if (response.status === 401 && state.auth?.enabled && !path.startsWith('/api/auth/')) showAuth(false);
        if (response.status >= 400 && response.status < 500 && ![408,429].includes(response.status)) pendingPosts.delete(requestId);
        throw new APIError(result.error || 'Operazione non riuscita.',response.status);
      }
      pendingPosts.delete(requestId);
      return result;
    } catch (error) {
      if (!(error instanceof APIError) && attempt === 0 && method === 'POST') continue;
      if (error.name === 'AbortError') throw new APIError('Tempo di attesa esaurito. La bozza è conservata; riprova per verificare l’esito.');
      if (error instanceof TypeError) throw new APIError('Server non raggiungibile. La bozza è conservata; controlla la connessione.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
function toast(message, isError = false) {
  clearTimeout(state.toastTimer);
  $('toast-message').textContent = message;
  $('toast').classList.toggle('error',isError);
  $('toast').classList.add('visible');
  state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'),isError ? 7000 : 4500);
}
function canCreateBoard() { return !state.auth?.enabled || (!!state.auth.user && state.auth.user.role !== 'observer'); }
function canWrite() { return canCreateBoard() && state.board?.role !== 'observer' && !state.board?.readonly; }
function canManage() { return !state.auth?.enabled || (!!state.auth.user && state.auth.user.role !== 'observer' && !state.board?.readonly && (state.auth.user.role === 'admin' || state.board?.role === 'admin')); }
function updateBusy() {
  document.querySelectorAll('[data-write]').forEach((element) => { element.disabled = state.saving || state.loading || !canWrite(); });
  document.querySelectorAll('[data-manage]').forEach((element) => { element.disabled = state.saving || state.loading || !canManage(); });
  document.querySelectorAll('dialog[open] input, dialog[open] textarea, dialog[open] select, dialog[open] button').forEach((element) => {
    element.disabled = state.saving || (element.hasAttribute('data-write') && !canWrite()) || (element.hasAttribute('data-manage') && !canManage()) || (element.hasAttribute('data-product-create') && !canCreateBoard());
  });
  document.querySelectorAll('[data-create-board],#create-board-sidebar,#create-board-link').forEach((element) => { element.disabled = state.saving || state.loading || !canCreateBoard(); });
  if ($('board-dialog').open && !state.boardEditor) $('save-board').disabled = state.saving || !canCreateBoard();
  if ($('bookmark-card')) $('bookmark-card').disabled = state.saving || !!state.cardEditor?.bookmarkLoading;
  if ($('timer-toggle')) $('timer-toggle').disabled = state.saving || !canWrite() || !state.cardEditor?.id;
  if ($('add-dependency')) $('add-dependency').disabled = state.saving || !canWrite() || !$('dependency-card').value;
  if ($('bulk-complete')) { $('bulk-complete').disabled = state.saving || !canWrite() || !state.selectedCards.size; $('bulk-archive').disabled = $('bulk-complete').disabled; }
  if ($('confirm-import')) $('confirm-import').disabled = state.saving || state.loading || !canCreateBoard();
  $('add-card-main').disabled = state.saving || state.loading || !canWrite() || !state.board?.columns.length || !!state.board?.archived;
  $('star-board').disabled = state.saving || state.loading || !state.board;
  $('edit-board').disabled = state.saving || state.loading || !state.board || !canWrite();
  $('export-board').disabled = state.loading || !state.board;
  $('members-board').disabled = state.loading || !state.board;
  $('save-status').textContent = state.saving ? 'Salvataggio in corso…' : state.loadError ? 'Connessione da verificare · bozza locale conservata' : `Salvataggio sul server${state.storageLabel ? ' · '+state.storageLabel : ''}`;
  document.body.setAttribute('aria-busy',String(state.saving));
}
async function perform(action, successMessage = '', errorId) {
  if (state.saving) return;
  state.saving = true;
  if (errorId) $(errorId).textContent = '';
  updateBusy();
  try { const result = await action(); if (successMessage) toast(successMessage); return result; }
  catch (error) {
    if (errorId && $(errorId)?.closest('dialog')?.open) $(errorId).textContent = error.message;
    else toast(error.message,true);
  } finally { state.saving = false; updateBusy(); }
}
async function committed(write, refresh, message) {
  const result = await write();
  toast(message || 'Modifica salvata sul server.');
  try { if (refresh) await refresh(result); }
  catch { state.loadError = true; toast('Modifica salvata sul server. L’aggiornamento della vista è fallito: premi Aggiorna, senza ripetere il salvataggio.',true); }
  return result;
}
function allCards() { return state.board?.columns.flatMap((column) => column.cards) || []; }
function assignmentNames(card) { return [...new Set([card.assignee,...(card.assignees || []).map((user) => user.name)].filter(Boolean))]; }
function assignees() { return [...new Set(allCards().flatMap(assignmentNames))].sort((a,b) => a.localeCompare(b,'it')); }
function initials(name) { return String(name).trim().split(/\s+/).slice(0,2).map((part) => part.charAt(0)).join('').toLocaleUpperCase('it'); }
function avatar(name) { return `<span class="avatar a-${Math.max(assignees().indexOf(name),0)%5}" title="${escapeHTML(name)}" aria-label="${escapeHTML(name)}">${escapeHTML(initials(name))}</span>`; }
function cardLabels(card) { return [...new Set([card.label,...(Array.isArray(card.labels) ? card.labels : [])].filter((label) => labels[label]))]; }
function boardLink(board) {
  return `<button type="button" class="board-link ${state.board?.id === board.id ? 'selected' : ''}" data-select-board="${Number(board.id)}" ${state.board?.id === board.id ? 'aria-current="page"' : ''}><span class="board-color ${covers.includes(board.color) ? board.color : 'sage'}"></span><span>${escapeHTML(board.name)}${board.archived ? ' · Archivio' : ''}</span></button>`;
}
function renderSidebar() {
  $('board-count').textContent = state.boards.length;
  $('board-links').innerHTML = state.boards.map(boardLink).join('');
  const starred = state.boards.filter((board) => board.starred);
  $('starred-boards').innerHTML = starred.length ? starred.map(boardLink).join('') : '<p class="empty-starred">Aggiungi una stella alle bacheche che usi più spesso.</p>';
  $('mobile-board-links').innerHTML = state.boards.map(boardLink).join('') + `<button type="button" class="button secondary" data-create-board data-write>${icon('plus')}Nuova bacheca</button>`;
}
function renderHeader() {
  const board = state.board;
  $('board-title').textContent = board?.name || 'Le tue idee, in ordine.';
  $('breadcrumb-board').textContent = board?.name || 'Bacheche';
  $('board-description').textContent = board?.description || 'Il prossimo progetto inizia da una piccola scheda.';
  document.title = board ? `${board.name} · OpenBoard` : 'OpenBoard · Il tuo lavoro, in ordine';
  $('star-board').classList.toggle('starred',!!board?.starred);
  $('star-board').setAttribute('aria-label',board?.starred ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti');
  $('star-board').setAttribute('aria-pressed',String(!!board?.starred));
  $('privacy-badge').textContent = board?.archived ? 'Archiviata' : state.auth?.enabled ? `Team · ${board?.role || state.auth.user?.role || ''}` : 'Workspace locale';
  $('archive-board').textContent = board?.archived ? 'Ripristina dall’archivio' : 'Archivia bacheca';
  $('notifications').hidden = !state.auth?.enabled || !state.auth?.user;
  $('watch-board').hidden = !state.auth?.enabled || !state.auth?.user;
  $('account-menu').textContent = initials(state.auth?.user?.name || 'Studio');
  $('account-menu').setAttribute('aria-label',`Account e preferenze${state.auth?.user ? ': '+state.auth.user.name : ''}`);
  $('avatar-stack').innerHTML = assignees().slice(0,4).map(avatar).join('');
  $('assignee-filter').innerHTML = '<option value="">Responsabile</option><option value="__none">Non assegnate</option>' + assignees().map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
  $('assignee-filter').value = state.assignee;
  $('assignee-options').innerHTML = assignees().map((name) => `<option value="${escapeHTML(name)}">`).join('');
  document.documentElement.dataset.boardColor = covers.includes(board?.color) ? board.color : 'sage';
  $('show-archived-boards').textContent = state.archivedBoards ? 'Nascondi bacheche archiviate' : 'Bacheche archiviate';
  renderPlanningFilters(); updateFilters(); updateBusy();
}
function todayISO() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function overdue(card) { return !!card.due_date && card.due_date < todayISO() && !card.completed; }
function matches(card) {
  const query = state.query.trim().toLocaleLowerCase('it');
  const text = `${card.title} ${card.description || card.description_preview || ''} ${assignmentNames(card).join(' ')}`.toLocaleLowerCase('it');
  return (!query || text.includes(query)) && (!state.label || cardLabels(card).includes(state.label)) &&
    (!state.assignee || (state.assignee === '__none' ? !assignmentNames(card).length : assignmentNames(card).includes(state.assignee))) &&
    (!state.priority || (card.priority || 'normal') === state.priority) &&
    (!state.milestone || card.milestone_key === state.milestone) && (!state.customKey || productivity.fieldMatches(card.custom_values?.[state.customKey],state.customQuery || '')) &&
    (!state.status || (state.status === 'blocked' ? !!card.blocked_reason : state.status === 'completed' ? card.completed : state.status === 'overdue' ? overdue(card) : !card.completed));
}
function sorted(cards) {
  const result = cards.filter(matches);
  if (state.sort === 'due') result.sort((a,b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.position-b.position);
  if (state.sort === 'priority') { const rank = Object.fromEntries(Object.keys(priorities).reverse().map((key,index) => [key,index])); result.sort((a,b) => (rank[a.priority] ?? 2)-(rank[b.priority] ?? 2) || a.position-b.position); }
  return result;
}
function hasFilters() { return !!(state.query || state.label || state.assignee || state.priority || state.status || state.sort !== 'manual' || state.milestone || state.customKey); }
function updateFilters() {
  const cards = allCards();
  $('total-cards').textContent = cards.length;
  $('card-summary').textContent = hasFilters() ? `${cards.filter(matches).length} di ${cards.length} schede` : `${cards.length} schede · ${cards.filter((card) => card.completed).length} completate`;
  $('clear-filters').classList.toggle('selected',!hasFilters());
  ['label','assignee','priority','status'].forEach((key) => $(`${key}-filter`).classList.toggle('filter-active',!!state[key]));
  ['board','list','calendar','stats','table'].forEach((view) => { const button = $(`view-${view}`); button.classList.toggle('selected',state.view === view); button.setAttribute('aria-pressed',String(state.view === view)); });
}
function dueDate(card) {
  if (!card.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(card.due_date)) return '';
  const date = new Date(`${card.due_date}T12:00:00`);
  const status = card.completed ? 'done' : overdue(card) ? 'overdue' : card.due_date === todayISO() ? 'soon' : '';
  return `<span class="card-due ${status}" title="Scadenza: ${escapeHTML(card.due_date)}${overdue(card) ? ' · Scaduta' : ''}">${icon(card.completed ? 'check-circle' : 'calendar')}${escapeHTML(date.toLocaleDateString('it-IT',{day:'numeric',month:'short'}))}</span>`;
}
function checklistBadge(card) {
  const total = card.checklist_total ?? (card.checklist || []).length;
  const done = card.checklist_done ?? (card.checklist || []).filter((item) => item.done).length;
  return total ? `<span class="checklist-count ${total === done ? 'complete' : ''}" aria-label="${done} di ${total} attività completate">${icon('check-square')}${done}/${total}</span>` : '';
}
function completionButton(card) { return `<button class="completion-button ${card.completed ? 'is-completed' : ''}" data-complete-card="${Number(card.id)}" type="button" data-write aria-label="${card.completed ? 'Riapri' : 'Completa'} scheda: ${escapeHTML(card.title)}">${icon(card.completed ? 'check-circle' : 'circle')}</button>`; }
function labelBadges(card) { return cardLabels(card).map((label) => `<span class="card-label label-${label}">${escapeHTML(labels[label])}</span>`).join(''); }
function priorityBadge(card) { const priority = card.priority || 'normal'; return priority !== 'normal' ? `<span class="priority-badge priority-${priority}">${escapeHTML(priorities[priority])}</span>` : ''; }
function selectionCheckbox(card) { return state.selectionMode ? `<label class="card-selection"><input type="checkbox" data-select-card="${Number(card.id)}" ${state.selectedCards.has(card.id) ? 'checked' : ''} aria-label="Seleziona scheda: ${escapeHTML(card.title)}">Seleziona</label>` : ''; }
function blockedBadge(card) { return card.blocked_reason ? `<span class="blocked-badge" title="${escapeHTML(card.blocked_reason)}">Bloccata</span>` : ''; }
function renderCard(card) {
  const cover = covers.includes(card.cover) && card.cover ? `<div class="card-cover cover-${card.cover}" aria-hidden="true"><span class="cover-shape"></span><span class="cover-detail"></span></div>` : '';
  const description = card.description_preview || card.description;
  return `<article class="task-card ${card.completed ? 'completed' : ''}" tabindex="${state.selectionMode ? -1 : 0}" role="${state.selectionMode ? 'group' : 'button'}" aria-label="${state.selectionMode ? 'Scheda' : 'Apri scheda'}: ${escapeHTML(card.title)}" draggable="${canWrite()}" data-card-id="${Number(card.id)}" data-column-id="${Number(card.column_id)}">${cover}<div class="card-body">${selectionCheckbox(card)}<div class="card-tags">${labelBadges(card)}${priorityBadge(card)}${blockedBadge(card)}${planningBadges(card)}${card.archived ? '<span class="priority-badge">Archiviata</span>' : ''}</div><h3>${escapeHTML(card.title)}</h3>${description ? `<p class="card-description">${escapeHTML(description)}</p>` : ''}<div class="card-footer">${completionButton(card)}${dueDate(card)}${checklistBadge(card)}${assignmentNames(card).length ? `<span class="card-assignee">${assignmentNames(card).slice(0,3).map(avatar).join('')}</span>` : ''}</div></div></article>`;
}
function renderColumn(column) {
  const cards = sorted(column.cards);
  const wip = Number(column.wip_limit) || 0;
  const work = column.cards.filter((card) => !card.completed && !card.archived).length;
  return `<section class="kanban-column" aria-label="Lista ${escapeHTML(column.title)}"><div class="column-heading"><span class="column-dot"></span><h2>${escapeHTML(column.title)}</h2><span class="column-count ${wip && work >= wip ? 'at-limit' : ''}" title="${wip ? 'WIP: '+work+'/'+wip : 'Schede nella lista'}">${cards.length}${wip ? ' / '+wip : ''}</span><details class="dropdown"><summary class="icon-button" aria-label="Opzioni lista ${escapeHTML(column.title)}">${icon('more')}</summary><div class="dropdown-menu"><button type="button" data-edit-column="${Number(column.id)}" data-write>${icon('edit')}Modifica, WIP e ordine</button><button type="button" data-shift-column="${Number(column.id)}" data-shift="-1" data-write>← Sposta a sinistra</button><button type="button" data-shift-column="${Number(column.id)}" data-shift="1" data-write>Sposta a destra →</button><button type="button" class="danger" data-delete-column="${Number(column.id)}" data-write>${icon('trash')}Sposta nel cestino</button></div></details></div><div class="column-cards" data-drop-column="${Number(column.id)}">${cards.length ? cards.map(renderCard).join('') : '<div class="empty-column">Nessuna scheda da mostrare.</div>'}</div><button class="add-card-button" type="button" data-add-card="${Number(column.id)}" data-write>${icon('plus')}Aggiungi una scheda</button></section>`;
}
function renderList() {
  return `<div class="list-view"><div class="list-header"><span>Scheda</span><span>Etichette e priorità</span><span>Scadenza</span><span>Responsabile</span></div>${state.board.columns.map((column) => `<div class="list-group-title"><span class="column-dot"></span>${escapeHTML(column.title)}<span>${sorted(column.cards).length}</span><button class="icon-button tiny" type="button" data-add-card="${Number(column.id)}" aria-label="Aggiungi scheda in ${escapeHTML(column.title)}" data-write>${icon('plus')}</button></div>${sorted(column.cards).map((card) => `<article class="list-row ${card.completed ? 'completed' : ''}" data-card-id="${Number(card.id)}" tabindex="${state.selectionMode ? -1 : 0}" role="${state.selectionMode ? 'group' : 'button'}" aria-label="${state.selectionMode ? 'Scheda' : 'Apri scheda'}: ${escapeHTML(card.title)}"><div class="list-row-title">${selectionCheckbox(card)}${completionButton(card)}<h3>${escapeHTML(card.title)}</h3></div><div class="card-tags">${labelBadges(card)}${priorityBadge(card)}${blockedBadge(card)}</div><div>${dueDate(card) || '—'}</div><div class="list-assignee">${assignmentNames(card).length ? `${avatar(assignmentNames(card)[0])}${escapeHTML(assignmentNames(card).join(', '))}` : 'Non assegnata'}</div></article>`).join('')}`).join('')}<div class="list-add-row"><button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div></div>`;
}
function renderCalendar() {
  const cards = allCards().filter(matches);
  const dates = [...new Set(cards.map((card) => card.due_date || ''))].sort((a,b) => (a || '9999').localeCompare(b || '9999'));
  return `<div class="calendar-view">${dates.length ? dates.map((date) => `<section class="calendar-day"><h2>${date ? escapeHTML(new Date(`${date}T12:00:00`).toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'})) : 'Senza scadenza'}</h2>${cards.filter((card) => (card.due_date || '') === date).map(renderCard).join('')}</section>`).join('') : '<p>Nessuna scheda con questi filtri.</p>'}</div>`;
}
async function renderStats() {
  const boardId = state.board?.id;
  if (!boardId) return;
  try {
    const result = await api(`/api/boards/${boardId}/stats`);
    if (state.view !== 'stats' || state.board?.id !== boardId) return;
    const stats = result.stats || result;
    const groups = (value) => Array.isArray(value) ? value.map((item) => [item.label || item.assignee || item.name || 'Non assegnata',item.count ?? item.total ?? 0]) : Object.entries(value || {});
    $('board-canvas').innerHTML = `<div class="dashboard"><div class="stat-grid"><div><strong>${Number(stats.total)||0}</strong><span>Schede totali</span></div><div><strong>${Number(stats.completed)||0}</strong><span>Completate</span></div><div><strong>${Number(stats.overdue)||0}</strong><span>Scadute</span></div><div><strong>${Math.round((stats.completed||0)/Math.max(stats.total||0,1)*100)}%</strong><span>Completamento</span></div></div>${[['Etichette',stats.by_label],['Responsabili',stats.by_assignee]].map(([title,value]) => `<section class="stats-group"><h2>${title}</h2>${groups(value).map(([name,count]) => `<div class="stat-line"><span>${escapeHTML(labels[name] || name || 'Non assegnata')}</span><meter min="0" max="${Math.max(stats.total||0,1)}" value="${Number(count)||0}">${Number(count)||0}</meter><strong>${Number(count)||0}</strong></div>`).join('') || '<p>Nessun dato disponibile.</p>'}</section>`).join('')}</div>`;
  } catch (error) { if (state.view === 'stats') $('board-canvas').innerHTML = `<div class="canvas-message"><h2>Statistiche non disponibili</h2><p>${escapeHTML(error.message)}</p></div>`; }
}
function renderBoard() {
  if (!state.board) $('board-canvas').innerHTML = `<div class="canvas-message"><span class="message-icon">${icon('spark')}</span><h2>Le grandi idee iniziano qui.</h2><p>Crea una bacheca per organizzare il lavoro del team.</p><button class="button primary" type="button" data-create-board data-write>${icon('plus')}Crea una bacheca</button></div>`;
  else if (state.view === 'stats') { $('board-canvas').innerHTML = '<div class="initial-loading"><span class="spinner"></span>Calcolo statistiche…</div>'; renderStats(); }
  else if (state.view === 'calendar') $('board-canvas').innerHTML = renderCalendar();
  else if (state.view === 'table') $('board-canvas').innerHTML = renderTable();
  else if (state.view === 'list') $('board-canvas').innerHTML = renderList();
  else $('board-canvas').innerHTML = `<div class="kanban-board">${state.board.columns.map(renderColumn).join('')}<button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div>`;
  updateSelection(); updateFilters(); updateBusy();
}
function route(boardId, cardId = null, replace = false) {
  const hash = boardId ? `#board/${Number(boardId)}${cardId ? '/card/'+Number(cardId) : ''}` : '#';
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null,'',hash);
}
function currentRoute() { const match = location.hash.match(/^#board\/(\d+)(?:\/card\/(\d+))?$/); return match ? {boardId:Number(match[1]),cardId:Number(match[2]) || null} : {}; }
async function selectBoard(id, {quiet = false,reset = true,navigate = true} = {}) {
  const sequence = ++state.loadSequence;
  if (!quiet) { state.loading = true; updateBusy(); $('board-canvas').innerHTML = '<div class="initial-loading"><span class="spinner"></span>Prepariamo il tuo spazio…</div>'; }
  try {
    const result = await api(`/api/boards/${Number(id)}?summary=1${state.archived || state.archivedBoards ? '&include_archived=1' : ''}`);
    if (sequence !== state.loadSequence) return;
    if (state.board?.id !== (result.board || result).id) { state.selectedCards.clear(); state.selectionMode = false; }
    state.board = result.board || result;
    state.board.columns = state.board.columns || [];
    state.board.columns.forEach((column) => { column.cards = column.cards || []; });
    if (reset) clearFilters(false);
    remember('board',String(state.board.id));
    state.remoteVersion = null; $('remote-change').hidden = true;
    state.loading = false; state.loadError = false;
    if (navigate) route(state.board.id);
    renderSidebar(); renderHeader(); renderBoard(); refreshWatchState();
  } catch (error) {
    if (sequence !== state.loadSequence) return;
    state.loading = false;
    if (quiet) throw error;
    showLoadError(error);
  } finally { if (sequence === state.loadSequence) updateBusy(); }
}
function showLoadError(error) {
  state.loadError = true;
  $('board-canvas').innerHTML = `<div class="canvas-message"><span class="message-icon">${icon('alert-circle')}</span><h2>La bacheca non è disponibile.</h2><p>${escapeHTML(error.message)}</p><button class="button primary" id="retry-load" type="button">${icon('refresh')}Riprova</button></div>`;
  updateBusy();
}
async function loadCatalog() {
  const catalog = productivity.catalog(await api('/api/catalog'));
  for (const object of [labels,priorities,fieldTypes]) for (const key of Object.keys(object)) delete object[key];
  Object.assign(labels,catalog.labels); Object.assign(priorities,catalog.priorities); Object.assign(fieldTypes,catalog.fieldTypes); covers.splice(0,covers.length,...catalog.covers);
  const options = (values) => Object.entries(values).map(([key,name]) => `<option value="${escapeHTML(key)}">${escapeHTML(name)}</option>`).join('');
  $('label-filter').innerHTML = '<option value="">Etichette</option>'+options(labels);
  $('card-label').innerHTML = '<option value="">Nessuna etichetta</option>'+options(labels);
  $('priority-filter').innerHTML = '<option value="">Tutte</option>'+options(priorities);
  $('card-priority').innerHTML = options(priorities);
  $('card-extra-labels').innerHTML = '<legend class="field-label">Etichette aggiuntive</legend>'+Object.entries(labels).map(([key,name]) => `<label><input type="checkbox" name="extra-label" value="${escapeHTML(key)}">${escapeHTML(name)}</label>`).join('');
  $('cover-options').innerHTML = covers.map((cover) => `<button type="button" data-cover="${escapeHTML(cover)}" class="cover-swatch ${cover ? 'swatch-'+escapeHTML(cover) : 'no-cover'}" aria-label="${cover ? 'Copertina '+escapeHTML(cover) : 'Nessuna copertina'}" aria-pressed="${String(!cover)}">${cover ? '' : icon('close')}</button>`).join('');
}
async function loadStorageLabel() {
  if (state.versionRequested) return;
  state.versionRequested = true;
  try { const version = await api('/api/version'); state.storageLabel = productivity.storageLabel(version.storage); }
  catch { state.storageLabel = ''; }
  finally { updateBusy(); }
}
async function loadInitial() {
  loadStorageLabel();
  state.loading = true; updateBusy();
  try {
    state.auth = await api('/api/auth/session');
    if (state.auth.enabled && !state.auth.user) { state.loading = false; showAuth(state.auth.setup_required); return; }
    await loadCatalog();
    await refreshBoards(); refreshNotifications();
    const requested = currentRoute();
    const fallback = state.boards.find((board) => board.id === Number(stored('board'))) || state.boards[0];
    const selectedId = requested.boardId || fallback?.id;
    if (selectedId) {
      await selectBoard(selectedId,{navigate:!requested.boardId});
      if (requested.cardId && state.board?.id === requested.boardId && !state.loadError) await openCard(requested.cardId,null,{navigate:false});
    } else { state.board = null; state.loading = false; renderSidebar(); renderHeader(); renderBoard(); }
  } catch (error) { state.loading = false; showLoadError(error); }
  finally { updateBusy(); }
}
async function refreshBoard() { if (state.board) await selectBoard(state.board.id,{quiet:true,reset:false,navigate:false}); }
async function refreshBoards() { const result = await api(`/api/boards${state.archivedBoards ? '?include_archived=1' : ''}`); state.boards = result.boards || []; renderSidebar(); }
function clearFilters(render = true) {
  ['query','label','assignee','priority','status'].forEach((key) => { state[key] = ''; }); state.sort = 'manual';
  state.milestone = ''; state.customKey = ''; state.customQuery = ''; renderPlanningFilters();
  $('search-input').value = ''; ['label','assignee','priority','status'].forEach((key) => { $(`${key}-filter`).value = ''; }); $('sort-filter').value = 'manual';
  if (render) renderBoard();
}
function closeMenus() { document.querySelectorAll('.dropdown[open]').forEach((details) => { details.open = false; }); }
const dialogFocus = new Map();
function openDialog(id) {
  closeMenus();
  if (!$(id).open) { dialogFocus.set(id,document.activeElement); $(id).showModal(); }
  updateBusy();
}
function cardData() {
  return {
    title:$('card-title').value.trim(), description:$('card-description').value,
    column_id:Number($('card-column').value), label:$('card-label').value,
    labels:[...new Set([$('card-label').value,...Array.from(document.querySelectorAll('input[name="extra-label"]:checked'),(input) => input.value)].filter(Boolean))],
    assignee:$('card-assignee').value.trim(), due_date:$('card-due-date').value,
    cover:state.cardEditor?.cover || '', completed:$('card-completed').checked,
    start_date:$('card-start-date').value, blocked_reason:$('card-blocked-reason').value.trim(),
    actual_minutes:Number($('card-actual').value)||0, reference_url:$('card-reference').value.trim(), assignee_ids:[...(state.cardEditor?.assigneeIds || [])],
    custom_values:readCustomValues(),milestone_key:$('card-milestone').value,
    priority:$('card-priority').value, estimate_minutes:Number($('card-estimate').value)||0,
    checklist:(state.cardEditor?.checklist || []).map((item) => ({...item,text:item.text.trim()})).filter((item) => item.text)
  };
}
function cardSnapshot() { return JSON.stringify({card:cardData(),checklist_new:$('checklist-new').value,comment_body:$('comment-body').value,worklog:pendingWorklog()}); }
function editorDirty(id) {
  if (id === 'card-dialog') return !!state.cardEditor && cardSnapshot() !== state.cardEditor.original;
  if (id === 'board-dialog') return !!state.boardOriginal && JSON.stringify(boardData()) !== state.boardOriginal;
  if (id === 'column-dialog') return !!state.columnOriginal && JSON.stringify(columnData()) !== state.columnOriginal;
  return false;
}
function draftKey() { return `draft.${state.auth?.user?.id || 'local'}.${state.board?.id || 0}.${state.cardEditor?.id || 'new'}`; }
function saveDraft() {
  const editor = state.cardEditor;
  if (!editor || !$('card-dialog').open) return;
  if (!editorDirty('card-dialog')) {
    // A reverted edit may discard only the draft written by this editor. Keep
    // an unread recovery draft, another tab's draft, or an uncertain POST retry.
    if (productivity.shouldDiscardDraft(stored(draftKey()),editor.writtenDraft,editor.pendingAmbiguous)) {
      if (editor.previousDraft) { remember(draftKey(),editor.previousDraft); $('draft-notice').hidden = false; }
      else { forget(draftKey()); $('draft-notice').hidden = true; }
      editor.writtenDraft = null; editor.previousDraft = null;
    }
    return;
  }
  if (!editor.writtenDraft && !editor.previousDraft && readDraft()) editor.previousDraft = stored(draftKey());
  const serialized = JSON.stringify({data:cardData(),version:editor.version,pending:editor.pending,pendingAmbiguous:!!editor.pendingAmbiguous,checklist_new:$('checklist-new').value,comment_body:$('comment-body').value,worklog:pendingWorklog(),updated_at:Date.now()});
  remember(draftKey(),serialized); editor.writtenDraft = serialized;
}
function readDraft() { try { const draft = JSON.parse(stored(draftKey(),'null')); return draft?.data && Date.now()-draft.updated_at < 30*86400000 ? draft : null; } catch { return null; } }
function closeDialog(id, {force = false,navigate = true} = {}) {
  if (id === 'panel-dialog' && state.panel === 'thread') saveReplyDraft();
  if (state.saving && !force) return false;
  if (!force && editorDirty(id) && !confirm('Hai modifiche non salvate. Chiudere l’editor? La bozza della scheda resta disponibile su questo dispositivo.')) return false;
  if (id === 'card-dialog') { if (!force) saveDraft(); if (navigate && state.board) route(state.board.id); ++state.cardSequence; }
  $(id).close();
  return true;
}
function closeEditors() {
  for (const id of ['card-dialog','board-dialog','column-dialog']) { if ($(id).open && !closeDialog(id)) return false; }
  return true;
}
function setCover(cover) {
  if (!state.cardEditor) return;
  state.cardEditor.cover = covers.includes(cover) ? cover : '';
  document.querySelectorAll('[data-cover]').forEach((button) => { button.setAttribute('aria-pressed',String(button.dataset.cover === state.cardEditor.cover)); });
}
function renderChecklist() {
  const active = document.activeElement;
  const index = active?.dataset.checklistText;
  const selection = index === undefined ? null : [active.selectionStart,active.selectionEnd];
  const items = state.cardEditor.checklist;
  $('checklist-items').innerHTML = items.map((item,i) => `<div class="checklist-item ${item.done ? 'done' : ''}"><input type="checkbox" data-checklist-toggle="${i}" ${item.done ? 'checked' : ''} aria-label="Completa: ${escapeHTML(item.text || 'Attività')}"><input type="text" data-checklist-text="${i}" value="${escapeHTML(item.text)}" maxlength="300" required aria-label="Testo attività ${i+1}"><button class="icon-button" type="button" data-checklist-remove="${i}" aria-label="Elimina attività ${i+1}">${icon('close')}</button></div>`).join('');
  updateChecklistProgress();
  if (index !== undefined) { const next = document.querySelector(`[data-checklist-text="${Math.min(Number(index),items.length-1)}"]`); if (next) { next.focus(); next.setSelectionRange(...selection); } }
}
function updateChecklistProgress() { const items = state.cardEditor.checklist; $('checklist-progress').textContent = items.length ? `${items.filter((item) => item.done).length} di ${items.length} completate` : ''; }
function addChecklistItem() {
  const text = $('checklist-new').value.trim();
  if (!text) { $('checklist-new').focus(); return; }
  state.cardEditor.checklist.push({id:uuid(),text,done:false});
  $('checklist-new').value = ''; renderChecklist(); $('checklist-new').focus(); saveDraft();
}
function fillCard(data) {
  $('card-title').value = data.title || ''; $('card-description').value = data.description || '';
  $('card-label').value = data.label || ''; $('card-assignee').value = data.assignee || '';
  $('card-due-date').value = data.due_date || ''; $('card-completed').checked = !!data.completed;
  $('card-priority').value = data.priority || 'normal'; $('card-estimate').value = data.estimate_minutes || 0;
  $('card-column').value = String(data.column_id || state.board.columns[0]?.id || '');
  document.querySelectorAll('input[name="extra-label"]').forEach((input) => { input.checked = Array.isArray(data.labels) && data.labels.includes(input.value); });
  state.cardEditor.checklist = (data.checklist || []).map((item) => ({...item}));
  setCover(data.cover || ''); renderChecklist(); fillProductivityCard(data); fillPlanningCard(data);
}
async function openCard(cardId, columnId, {navigate = true} = {}) {
  if (state.saving || state.loading || !state.board?.columns.length) return;
  if ($('card-dialog').open && state.cardEditor?.id === Number(cardId)) return;
  const sequence = ++state.cardSequence;
  const boardId = state.board.id;
  const boardLoadSequence = state.loadSequence;
  try {
    let card = null;
    if (cardId) { const result = await api(`/api/cards/${Number(cardId)}`); card = result.card || result; }
    if (sequence !== state.cardSequence || state.board?.id !== boardId || state.loadSequence !== boardLoadSequence || state.loading || state.saving) return;
    if (card && !state.board.columns.some((column) => column.id === card.column_id)) throw new APIError('Questa scheda appartiene a un’altra bacheca. Aprila dalla ricerca globale.');
    state.cardEditor = {id:card?.id || null,version:card?.version,cover:card?.cover || '',checklist:[],archived:!!card?.archived,pending:null,persistedMilestone:card?.milestone_key || ''};
    $('card-form').reset();
    $('card-dialog-context').textContent = card ? 'DETTAGLI DELLA SCHEDA' : 'UNA NUOVA IDEA';
    $('card-column').innerHTML = state.board.columns.map((column) => `<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
    fillCard(card || {column_id:columnId || state.board.columns[0].id});
    $('delete-card').hidden = !card;
    ['move-card','duplicate-card','archive-card'].forEach((id) => { $(id).hidden = !card; });
    $('archive-card').textContent = card?.archived ? 'Ripristina' : 'Archivia';
    $('comments-section').hidden = !card;
    $('comments-list').innerHTML = '';
    $('save-card').innerHTML = `${card ? 'Salva modifiche' : 'Crea scheda'}${icon('arrow-right')}`;
    $('card-form-error').textContent = ''; $('conflict-notice').hidden = true;
    state.cardEditor.original = cardSnapshot();
    $('draft-notice').hidden = !readDraft();
    openDialog('card-dialog'); $('card-title').focus();
    if (navigate && cardId) route(state.board.id,cardId);
    loadProductivityCard(cardId,boardId,sequence);
    if (cardId) loadComments(cardId);
  } catch (error) { toast(error.message,true); }
}
function boardData() { return {name:$('board-name').value.trim(),description:$('board-description-input').value.trim(),color:$('board-color').value}; }
function columnData() { return {title:$('column-title').value.trim(),wip_limit:Number($('column-wip').value)||0,position:Math.max(0,Number($('column-position').value)-1)}; }
function openBoardEditor(board = null) {
  if (state.saving || state.loading || !(board ? canWrite() : canCreateBoard())) return;
  state.boardRequest = {};
  state.boardEditor = board ? {...board} : null;
  $('board-form').reset(); $('board-dialog-context').textContent = board ? 'LA TUA BACHECA' : 'NUOVA BACHECA';
  $('board-dialog-heading').textContent = board ? 'Diamo forma al tuo progetto.' : 'Spazio a un nuovo progetto.';
  $('board-name').value = board?.name || ''; $('board-description-input').value = board?.description || '';
  $('board-color').value = covers.includes(board?.color) && board.color ? board.color : 'sage';
  $('delete-board').hidden = !board; $('save-board').innerHTML = `${board ? 'Salva modifiche' : 'Crea bacheca'}${icon('arrow-right')}`;
  $('board-form-error').textContent = ''; state.boardOriginal = JSON.stringify(boardData());
  $('boards-dialog').close(); openDialog('board-dialog'); $('board-name').focus();
}
function openColumnEditor(columnId = null) {
  if (state.saving || state.loading || !state.board || !canWrite()) return;
  const column = state.board.columns.find((item) => item.id === Number(columnId));
  state.columnRequest = {};
  state.columnEditor = column ? {...column} : null;
  $('column-form').reset(); $('column-dialog-context').textContent = column ? 'MODIFICA LISTA' : 'NUOVA LISTA';
  $('column-dialog-heading').textContent = column ? 'Ogni fase ha il suo nome.' : 'Un posto per il prossimo passo.';
  $('column-title').value = column?.title || ''; $('column-wip').value = column?.wip_limit || 0;
  $('column-position').value = column ? state.board.columns.findIndex((item) => item.id === column.id)+1 : state.board.columns.length+1;
  $('column-position').max = state.board.columns.length+(column ? 0 : 1);
  $('delete-column').hidden = !column; $('save-column').innerHTML = `${column ? 'Salva modifiche' : 'Crea lista'}${icon('arrow-right')}`;
  $('column-form-error').textContent = ''; state.columnOriginal = JSON.stringify(columnData());
  openDialog('column-dialog'); $('column-title').focus();
}
function deleteColumn(columnId) {
  const column = state.board?.columns.find((item) => item.id === Number(columnId));
  if (!column || !confirm(`Spostare la lista “${column.title}” e le sue schede nel cestino? Potrai ripristinarle.`)) return;
  perform(() => committed(async () => { await api(`/api/columns/${column.id}`,'DELETE',undefined,{version:column.version}); closeDialog('column-dialog',{force:true}); },refreshBoard,'Lista spostata nel cestino.'),'','column-form-error');
}
async function loadComments(cardId) {
  const editor = state.cardEditor; if (!editor || editor.id !== cardId) return;
  const generation = editor.commentSequence = (editor.commentSequence || 0)+1;
  const current = () => state.cardEditor === editor && editor.commentSequence === generation && $('card-dialog').open;
  try {
    const result = await api(`/api/cards/${cardId}/comments`);
    if (!current()) return;
    state.cardEditor.comments = result.comments || [];
    renderComments();
    updateBusy();
  } catch (error) { if (current()) $('comments-list').textContent = error.message; }
}
function formatDate(value) { if (!value) return ''; const date = new Date(String(value).includes('T') ? value : String(value).replace(' ','T')+'Z'); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('it-IT'); }
function panel(title, body, kind = null) {
  if (state.panel === 'thread') saveReplyDraft();
  state.panelSequence = (state.panelSequence || 0)+1; state.panel = kind; $('panel-heading').textContent = title; $('panel-body').innerHTML = body; hydrateIcons($('panel-body')); openDialog('panel-dialog');
}
async function showPanel(title, loader, kind) {
  panel(title,'<p class="helper-text">Caricamento…</p>',kind);
  const sequence = state.panelSequence;
  try { const body = await loader(); if (state.panel === kind && state.panelSequence === sequence && $('panel-dialog').open) { $('panel-body').innerHTML = body; hydrateIcons($('panel-body')); updateBusy(); } }
  catch (error) { if (state.panel === kind && state.panelSequence === sequence) $('panel-body').innerHTML = `<p class="form-error" role="alert">${escapeHTML(error.message)}</p>`; }
}
function showAuth(setup) {
  $('auth-heading').textContent = setup ? 'Crea il primo amministratore' : 'Accedi a OpenBoard';
  $('auth-description').textContent = setup ? 'Configura l’account che gestirà utenti e permessi.' : 'Accedi al workspace con le tue credenziali.';
  $('auth-name-label').hidden = !setup; $('auth-name').hidden = !setup; $('auth-name').required = !!setup;
  $('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('auth-submit').textContent = setup ? 'Configura workspace' : 'Accedi'; $('auth-error').textContent = '';
  state.setup = !!setup; openDialog('auth-dialog'); (setup ? $('auth-name') : $('auth-username')).focus();
}
function showAccount() {
  const user = state.auth?.user;
  panel('Account e preferenze',`<p>${user ? `<strong>${escapeHTML(user.name)}</strong> · ${escapeHTML(user.username)} · ${escapeHTML(user.role)}` : 'Modalità locale: autenticazione disattivata sul server.'}</p><div class="preferences"><label class="field-label" for="theme-setting">Tema</label><select id="theme-setting"><option value="light">Chiaro</option><option value="dark">Scuro</option></select><label class="field-label" for="density-setting">Densità delle schede</label><select id="density-setting"><option value="comfortable">Comoda</option><option value="compact">Compatta</option></select></div>${user ? `<form id="profile-form"><h3>Il tuo profilo</h3><label class="field-label" for="profile-name">Nome visualizzato</label><input id="profile-name" required maxlength="100" value="${escapeHTML(user.name)}"><button class="button secondary" type="submit">Salva nome</button></form><button id="manage-sessions" class="button secondary" type="button">Sessioni attive</button><form id="password-form"><h3>Cambia password</h3><label class="field-label" for="current-password">Password attuale</label><input id="current-password" type="password" required autocomplete="current-password"><label class="field-label" for="new-password">Nuova password (almeno 12 caratteri)</label><input id="new-password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"><button class="button secondary" type="submit">Aggiorna password</button></form>${user.role === 'admin' ? '<button id="manage-users" class="button secondary" type="button">Gestisci utenti</button>' : ''}<button id="logout" class="button danger-subtle" type="button">Esci dall’account</button>` : ''}<p id="panel-error" class="form-error" role="alert"></p>`,'account');
  $('theme-setting').value = stored('theme','light'); $('density-setting').value = stored('density','comfortable');
}
async function showUsers() {
  await showPanel('Utenti del workspace',async () => {
    const result = await api('/api/users');
    return `<div class="user-list">${(result.users || []).map((user) => `<form class="user-row" data-user-form="${Number(user.id)}"><div><strong>${escapeHTML(user.name)}</strong><span>@${escapeHTML(user.username)} · ID ${Number(user.id)}</span></div><label><span class="sr-only">Ruolo di ${escapeHTML(user.name)}</span><select name="role">${['admin','member','observer'].map((role) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${({admin:'Amministratore',member:'Membro',observer:'Osservatore'})[role]}</option>`).join('')}</select></label><label class="inline-check"><input name="active" type="checkbox" ${user.active ? 'checked' : ''}>Attivo</label><button class="button secondary" type="submit" data-manage>Salva</button></form>`).join('')}</div><form id="create-user-form"><h3>Aggiungi un utente</h3><label class="field-label" for="user-name">Nome</label><input id="user-name" required maxlength="100"><label class="field-label" for="user-username">Nome utente</label><input id="user-username" required minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]+" autocomplete="off"><label class="field-label" for="user-password">Password iniziale (almeno 12 caratteri)</label><input id="user-password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"><label class="field-label" for="user-role">Ruolo globale</label><select id="user-role"><option value="member">Membro</option><option value="observer">Osservatore</option><option value="admin">Amministratore</option></select><button class="button primary" type="submit" data-manage>Crea utente</button></form><p id="panel-error" class="form-error" role="alert"></p>`;
  },'users');
}
async function showMembers() {
  if (!state.auth?.enabled) { panel('Membri e permessi','<p>Il server è in modalità locale. Abilita l’autenticazione nella configurazione del server per usare account, ruoli e membri delle bacheche.</p>','members'); return; }
  await showPanel('Membri della bacheca',async () => {
    const result = await api(`/api/boards/${state.board.id}/members`);
    let users = [];
    if (state.auth.user?.role === 'admin') users = (await api('/api/users')).users || [];
    return `<p>Gli osservatori possono leggere; i membri modificano le schede; gli amministratori gestiscono i permessi.</p><div class="member-list">${(result.members || []).map((member) => `<div class="member-row"><div><strong>${escapeHTML(member.name)}</strong><span>@${escapeHTML(member.username)} · ID ${Number(member.user_id)}</span></div><span>${escapeHTML(({admin:'Amministratore',member:'Membro',observer:'Osservatore'})[member.role] || member.role)}</span>${canManage() ? `<button class="button danger-subtle" type="button" data-remove-member="${Number(member.user_id)}" data-manage>Rimuovi</button>` : ''}</div>`).join('') || '<p>Nessun membro esplicito.</p>'}</div>${canManage() ? `<form id="member-form"><h3>Aggiungi o aggiorna un membro</h3><label class="field-label" for="member-user">Utente ${users.length ? '' : '(ID numerico)'}</label>${users.length ? `<select id="member-user">${users.filter((user) => user.active).map((user) => `<option value="${Number(user.id)}">${escapeHTML(user.name)} · @${escapeHTML(user.username)}</option>`).join('')}</select>` : '<input id="member-user" type="number" min="1" required>'}<label class="field-label" for="member-role">Ruolo nella bacheca</label><select id="member-role"><option value="member">Membro</option><option value="observer">Osservatore</option><option value="admin">Amministratore</option></select><button class="button primary" type="submit" data-manage>Salva membro</button></form>` : ''}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'members');
}
async function showActivity(before = null,append = false) { return showActivityPage(before,append); }
async function showTrash() {
  await showPanel('Cestino',async () => {
    const result = await api('/api/trash');
    return `<p>Ripristina gli elementi eliminati. Liste e schede tornano nella loro bacheca.</p><div class="trash-list">${(result.items || []).map((item) => `<div class="trash-row"><div><strong>${escapeHTML(item.title || item.name)}</strong><span>${escapeHTML(({boards:'Bacheca',columns:'Lista',cards:'Scheda'})[item.kind] || item.kind)} · ${escapeHTML(formatDate(item.deleted_at))}</span></div><button class="button secondary" type="button" data-restore-kind="${escapeHTML(item.kind)}" data-restore-id="${Number(item.id)}" data-write>Ripristina</button></div>`).join('') || '<p>Il cestino è vuoto.</p>'}</div><p id="panel-error" class="form-error" role="alert"></p>`;
  },'trash');
}
function showImport() {
  state.importSequence = (state.importSequence || 0)+1;
  state.importData = null; state.importKey = null;
  panel('Importa una bacheca JSON','<p>Seleziona un’esportazione OpenBoard versione 2. L’importazione crea una nuova bacheca.</p><label class="field-label" for="import-file">File JSON (massimo 2 MB)</label><input id="import-file" type="file" accept=".json,application/json"><div id="import-preview"></div><p id="panel-error" class="form-error" role="alert"></p>','import');
}
async function previewImport(file) {
  const sequence = state.importSequence = (state.importSequence || 0)+1;
  $('panel-error').textContent = ''; $('import-preview').innerHTML = ''; state.importData = null;
  if (!file) return;
  try {
    if (file.size > 2*1024*1024) throw new Error('Il file supera il limite di 2 MB.');
    const data = JSON.parse(await file.text());
    if (sequence !== state.importSequence || state.panel !== 'import' || !$('panel-dialog').open || !$('import-preview')) return;
    if (data.format !== 'openboard' || data.version !== 2 || !data.board || !Array.isArray(data.board.columns)) throw new Error('Serve un’esportazione OpenBoard in formato versione 2.');
    const cards = data.board.columns.reduce((sum,column) => sum+(Array.isArray(column.cards) ? column.cards.length : 0),0);
    state.importData = data; state.importKey = uuid();
    $('import-preview').innerHTML = `<div class="notice"><div><h3>${escapeHTML(data.board.name || 'Bacheca importata')}</h3><p>${data.board.columns.length} liste · ${cards} schede · ${(data.board.custom_fields || []).filter((field) => !field.deleted_at).length} campi personalizzati · ${(data.board.milestones || []).filter((item) => !item.deleted_at).length} traguardi</p><p>${escapeHTML(data.board.description || '')}</p></div></div><button id="confirm-import" class="button primary" type="button" data-write>Importa come nuova bacheca</button>`;
    updateBusy();
  } catch (error) { if (sequence === state.importSequence && state.panel === 'import' && $('panel-error')) $('panel-error').textContent = error instanceof SyntaxError ? 'Il file non contiene JSON valido.' : error.message; }
}
function showGlobalSearch() {
  ++globalSearchSequence; clearTimeout(searchTimer);
  panel('Ricerca in tutte le bacheche','<label class="field-label" for="global-query">Titolo o descrizione della scheda</label><input id="global-query" type="search" maxlength="200" placeholder="Cerca nel workspace…"><div id="global-results" aria-live="polite"></div>','search');
  $('global-query').focus();
}
let globalSearchSequence = 0;
async function globalSearch(query) {
  if (state.panel !== 'search' || !$('global-results') || !$('panel-dialog').open) return;
  const sequence = ++globalSearchSequence;
  if (!query.trim()) { $('global-results').innerHTML = '<p>Scrivi per cercare le schede a cui hai accesso.</p>'; return; }
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(query.trim())}`);
    if (sequence !== globalSearchSequence || state.panel !== 'search') return;
    $('global-results').innerHTML = (result.cards || []).map((card) => `<button type="button" class="search-result" data-search-card="${Number(card.id)}" data-search-board="${Number(card.board_id)}"><strong>${escapeHTML(card.title)}</strong><span>${escapeHTML(card.board_name)} / ${escapeHTML(card.column_title)} · ${escapeHTML(priorities[card.priority] || 'Normale')}${card.due_date ? ' · '+escapeHTML(card.due_date) : ''}</span></button>`).join('') || '<p>Nessuna scheda trovata.</p>';
  } catch (error) { if (sequence === globalSearchSequence && $('global-results')) $('global-results').textContent = error.message; }
}
function showMove() {
  const editor = state.cardEditor;
  if (!editor?.id) return;
  if (editorDirty('card-dialog')) { toast('Salva le modifiche prima di spostare la scheda.',true); return; }
  $('move-column').innerHTML = state.board.columns.map((column) => `<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
  $('move-column').value = $('card-column').value;
  updateMovePosition(); $('move-error').textContent = ''; openDialog('move-dialog'); $('move-column').focus();
}
function updateMovePosition() {
  const column = state.board.columns.find((item) => item.id === Number($('move-column').value));
  const remaining = column?.cards.filter((card) => card.id !== state.cardEditor?.id) || [];
  $('move-position').max = remaining.length+1; $('move-position').value = remaining.length+1;
}
async function showConflict() {
  const editor = state.cardEditor;
  if (!editor?.id) return;
  await showPanel('Confronta con la versione sul server',async () => {
    const result = await api(`/api/cards/${editor.id}`); const card = result.card || result;
    state.conflictVersion = card.version;
    return `<p>La tua bozza resta aperta nell’editor. Confronta i contenuti, poi correggi la bozza prima di salvare.</p><div class="conflict-copy"><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(card.description || '')}</p><p>Responsabile: ${escapeHTML(card.assignee || 'Nessuno')} · Scadenza: ${escapeHTML(card.due_date || 'Nessuna')} · Priorità: ${escapeHTML(priorities[card.priority] || 'Normale')}</p><ul>${(card.checklist || []).map((item) => `<li>${item.done ? '✓ ' : ''}${escapeHTML(item.text)}</li>`).join('')}</ul></div><p>Versione sul server: ${Number(card.version)}. Confermando manterrai il testo della tua bozza per completare l’unione manualmente.</p><button id="adopt-version" class="button primary" type="button">Ho confrontato: continua a modificare la bozza</button>`;
  },'conflict');
}
async function exportBoard() {
  if (!state.board) return;
  const board = state.board;
  try {
    const data = await api(`/api/boards/${board.id}/export`);
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${board.name.toLocaleLowerCase('it').replace(/[^a-z0-9à-ü]+/g,'-').replace(/^-|-$/g,'') || 'bacheca'}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
    toast('Esportazione completa versione 2 scaricata dal server.');
  } catch (error) { toast(error.message,true); }
}
function stableRequest(owner, data) {
  const serialized = JSON.stringify(data);
  if (!owner.pending || owner.pending.body !== serialized) owner.pending = {body:serialized,key:uuid()};
  return owner.pending.key;
}
let searchTimer;
document.addEventListener('click',async (event) => {
  if (event.target.closest('[data-select-card]') || event.target.closest('.card-selection')) return;
  const target = event.target.closest('button,[data-card-id]');
  if (!target) { if (!event.target.closest('details')) closeMenus(); return; }
  if (target.disabled) return;
  if (target.dataset.close) { closeDialog(target.dataset.close); return; }
  if (target.dataset.selectBoard) {
    if (state.saving || !closeEditors()) return;
    $('boards-dialog').close(); closeMenus(); await selectBoard(target.dataset.selectBoard); return;
  }
  if (target.dataset.createBoard !== undefined) { openBoardEditor(); return; }
  if (target.dataset.addColumn !== undefined) { openColumnEditor(); return; }
  if (target.dataset.addCard) { openCard(null,target.dataset.addCard); return; }
  if (target.dataset.editColumn) { openColumnEditor(target.dataset.editColumn); return; }
  if (target.dataset.deleteColumn) { deleteColumn(target.dataset.deleteColumn); return; }
  if (target.dataset.shiftColumn) {
    const column = state.board.columns.find((item) => item.id === Number(target.dataset.shiftColumn));
    const position = state.board.columns.findIndex((item) => item.id === column.id)+Number(target.dataset.shift);
    if (position < 0 || position >= state.board.columns.length) return;
    perform(() => committed(() => api(`/api/columns/${column.id}`,'PATCH',{position},{version:column.version}),refreshBoard,'Lista riordinata.')); return;
  }
  if (target.dataset.completeCard) {
    const card = allCards().find((item) => item.id === Number(target.dataset.completeCard));
    if (card) perform(() => committed(() => api(`/api/cards/${card.id}`,'PATCH',{completed:!card.completed},{version:card.version}),refreshBoard,card.completed ? 'Scheda riaperta.' : 'Scheda completata.')); return;
  }
  if (target.dataset.cardId) { openCard(target.dataset.cardId); return; }
  if (target.dataset.cover !== undefined) { setCover(target.dataset.cover); saveDraft(); return; }
  if (target.dataset.checklistRemove !== undefined) { state.cardEditor.checklist.splice(Number(target.dataset.checklistRemove),1); renderChecklist(); saveDraft(); return; }
  if (target.dataset.deleteComment) {
    if (!confirm('Eliminare questo commento?')) return;
    perform(() => committed(() => api(`/api/comments/${Number(target.dataset.deleteComment)}`,'DELETE'),() => loadComments(state.cardEditor.id),'Commento eliminato.'),'','card-form-error'); return;
  }
  if (target.dataset.restoreKind && ['boards','columns','cards'].includes(target.dataset.restoreKind)) {
    perform(() => committed(() => api(`/api/${target.dataset.restoreKind}/${Number(target.dataset.restoreId)}/restore`,'POST',{}),async () => { await refreshBoards(); await refreshBoard(); await showTrash(); },'Elemento ripristinato.'),'','panel-error'); return;
  }
  if (target.dataset.removeMember) {
    if (!confirm('Rimuovere questo membro dalla bacheca?')) return;
    perform(() => committed(() => api(`/api/boards/${state.board.id}/members/${Number(target.dataset.removeMember)}`,'DELETE'),showMembers,'Membro rimosso.'),'','panel-error'); return;
  }
  if (target.dataset.searchCard) {
    if (!closeEditors()) return;
    closeDialog('panel-dialog');
    await selectBoard(target.dataset.searchBoard);
    await openCard(target.dataset.searchCard); return;
  }
  switch (target.id) {
    case 'retry-load': loadInitial(); break;
    case 'global-search': showGlobalSearch(); break;
    case 'account-menu': showAccount(); break;
    case 'manage-users': showUsers(); break;
    case 'members-board': showMembers(); break;
    case 'activity-board': showActivity(); break;
    case 'trash-board': showTrash(); break;
    case 'import-board': showImport(); break;
    case 'export-board': exportBoard(); break;
    case 'move-card': showMove(); break;
    case 'load-conflict': showConflict(); break;
    case 'adopt-version':
      state.cardEditor.version = state.conflictVersion; $('conflict-notice').hidden = true; saveDraft(); closeDialog('panel-dialog'); toast('Versione corrente acquisita. Completa la tua bozza e salva.'); break;
    case 'recover-draft': {
      const draft = readDraft();
      if (draft) { fillCard(draft.data); $('checklist-new').value = draft.checklist_new || ''; $('comment-body').value = draft.comment_body || ''; $('worklog-date').value = draft.worklog?.date || todayISO(); $('worklog-minutes').value = draft.worklog?.minutes || ''; $('worklog-note').value = draft.worklog?.note || ''; state.cardEditor.version = draft.version; if (draft.pending) state.cardEditor.pending = draft.pending; state.cardEditor.pendingAmbiguous = draft.pendingAmbiguous ?? !!draft.pending; state.cardEditor.writtenDraft = stored(draftKey()); state.cardEditor.previousDraft = null; $('draft-notice').hidden = true; saveDraft(); toast('Bozza recuperata. Verifica e salva quando pronta.'); }
      break;
    }
    case 'discard-draft': forget(draftKey()); state.cardEditor.writtenDraft = null; state.cardEditor.previousDraft = null; $('draft-notice').hidden = true; break;
    case 'refresh-remote': await perform(refreshBoard); break;
    case 'reload-board': await perform(state.board ? refreshBoard : loadInitial); break;
    case 'show-archived-boards': state.archivedBoards = !state.archivedBoards; await perform(async () => { await refreshBoards(); renderHeader(); openDialog('boards-dialog'); }); break;
    case 'duplicate-card': {
      const editor = state.cardEditor;
      if (!editor?.id) break;
      if (editorDirty('card-dialog')) { toast('Salva la bozza prima di duplicare la scheda.',true); break; }
      perform(() => committed(() => api(`/api/cards/${editor.id}/duplicate`,'POST',{}),async () => { closeDialog('card-dialog',{force:true}); await refreshBoard(); },'Scheda duplicata.'),'','card-form-error'); break;
    }
    case 'archive-card': {
      const editor = state.cardEditor;
      if (!editor?.id || (editorDirty('card-dialog') && !confirm('Archiviare la versione salvata sul server? La bozza locale verrà conservata.'))) break;
      saveDraft();
      perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'PATCH',{archived:!editor.archived},{version:editor.version}); closeDialog('card-dialog',{force:true}); },refreshBoard,editor.archived ? 'Scheda ripristinata dall’archivio.' : 'Scheda archiviata.'),'','card-form-error'); break;
    }
    case 'duplicate-board':
      if (state.board) perform(() => committed(() => api(`/api/boards/${state.board.id}/duplicate`,'POST',{}),async (result) => { await refreshBoards(); await selectBoard(result.id || result.board?.id,{quiet:true}); },'Bacheca duplicata.')); break;
    case 'archive-board':
      if (state.board) perform(() => committed(() => api(`/api/boards/${state.board.id}`,'PATCH',{archived:!state.board.archived},{version:state.board.version}),async () => { state.archivedBoards = true; await refreshBoards(); await refreshBoard(); },state.board.archived ? 'Bacheca ripristinata dall’archivio.' : 'Bacheca archiviata.')); break;
    case 'confirm-import':
      if (state.importData) perform(() => committed(() => api('/api/import','POST',state.importData,{key:state.importKey}),async (result) => { closeDialog('panel-dialog',{force:true}); await refreshBoards(); await selectBoard(result.id || result.board?.id,{quiet:true}); },'Bacheca importata.'),'','panel-error'); break;
    case 'logout':
      if (!closeEditors()) break;
      perform(async () => { await api('/api/auth/logout','POST',{}); closeDialog('panel-dialog',{force:true}); state.auth = await api('/api/auth/session'); state.board = null; state.boards = []; renderSidebar(); renderHeader(); renderBoard(); showAuth(false); }); break;
  }
});
document.addEventListener('keydown',(event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) $('search-input').focus(); }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-card-id]')) { event.preventDefault(); openCard(event.target.dataset.cardId); }
  if (event.key.toLowerCase() === 'm' && event.target.matches('[data-card-id]') && canWrite()) { event.preventDefault(); openCard(event.target.dataset.cardId).then(showMove); }
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel',(event) => { event.preventDefault(); if (dialog.id !== 'auth-dialog') closeDialog(dialog.id); });
  dialog.addEventListener('close',() => {
    const previous = dialogFocus.get(dialog.id);
    if (previous?.isConnected) previous.focus();
    else if (dialog.id === 'card-dialog') document.querySelector(`[data-card-id="${state.cardEditor?.id}"]`)?.focus();
    else $('board-canvas').focus();
  });
  dialog.addEventListener('click',(event) => { if (event.target === dialog && dialog.id !== 'auth-dialog') { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog.id); } });
});
$('search-input').addEventListener('input',() => { state.query = $('search-input').value; renderBoard(); });
['label','assignee','priority','status','sort'].forEach((key) => $(`${key}-filter`).addEventListener('change',() => { state[key] = $(`${key}-filter`).value; renderBoard(); }));
$('show-archived').addEventListener('change',() => { state.archived = $('show-archived').checked; perform(refreshBoard); });
$('clear-filters').addEventListener('click',() => clearFilters());
['board','list','calendar','stats','table'].forEach((view) => $(`view-${view}`).addEventListener('click',() => { state.view = view; remember('view',view); renderBoard(); }));
['create-board-sidebar','create-board-link'].forEach((id) => $(id).addEventListener('click',() => openBoardEditor()));
['boards-nav','mobile-boards'].forEach((id) => $(id).addEventListener('click',() => { renderSidebar(); openDialog('boards-dialog'); }));
$('add-card-main').addEventListener('click',() => openCard());
$('edit-board').addEventListener('click',() => openBoardEditor(state.board));
$('star-board').addEventListener('click',() => {
  if (!state.board) return;
  const starred = !state.board.starred;
  perform(() => committed(() => api(`/api/boards/${state.board.id}/star`,'PATCH',{starred}),async () => { await refreshBoards(); await refreshBoard(); },starred ? 'Bacheca aggiunta ai preferiti.' : 'Bacheca rimossa dai preferiti.'));
});
$('checklist-items').addEventListener('input',(event) => {
  if (event.target.dataset.checklistText !== undefined) { state.cardEditor.checklist[Number(event.target.dataset.checklistText)].text = event.target.value; saveDraft(); }
});
$('checklist-items').addEventListener('change',(event) => {
  if (event.target.dataset.checklistToggle !== undefined) {
    state.cardEditor.checklist[Number(event.target.dataset.checklistToggle)].done = event.target.checked;
    event.target.closest('.checklist-item').classList.toggle('done',event.target.checked);
    updateChecklistProgress(); saveDraft();
  }
});
$('add-checklist-item').addEventListener('click',addChecklistItem);
$('checklist-new').addEventListener('keydown',(event) => { if (event.key === 'Enter') { event.preventDefault(); addChecklistItem(); } });
$('card-form').addEventListener('input',saveDraft);
$('card-form').addEventListener('change',saveDraft);
$('move-column').addEventListener('change',updateMovePosition);
document.addEventListener('input',(event) => {
  if (event.target.id === 'global-query') { clearTimeout(searchTimer); searchTimer = setTimeout(() => globalSearch(event.target.value),250); }
});
document.addEventListener('change',(event) => {
  if (event.target.id === 'theme-setting') { document.documentElement.dataset.theme = event.target.value; remember('theme',event.target.value); }
  if (event.target.id === 'density-setting') { document.documentElement.dataset.density = event.target.value; remember('density',event.target.value); }
  if (event.target.id === 'import-file') previewImport(event.target.files[0]);
});
$('auth-form').addEventListener('submit',async (event) => {
  event.preventDefault();
  const previousUserId = state.auth?.user?.id;
  saveDraft();
  const data = {username:$('auth-username').value.trim(),password:$('auth-password').value};
  if (state.setup) data.name = $('auth-name').value.trim();
  state.authRequest = state.authRequest || {};
  const session = await perform(async () => {
    state.auth = await api(state.setup ? '/api/auth/setup' : '/api/auth/login','POST',data,{key:stableRequest(state.authRequest,data)});
    $('auth-password').value = ''; state.authRequest = {}; closeDialog('auth-dialog',{force:true});
    if (previousUserId && previousUserId !== state.auth.user?.id) {
      ['card-dialog','board-dialog','column-dialog','panel-dialog'].forEach((id) => closeDialog(id,{force:true,navigate:false}));
      state.board = null; state.boards = []; renderSidebar(); renderHeader(); renderBoard();
    }
    return state.auth;
  },'','auth-error');
  if (session?.user) await loadInitial();
});
$('card-form').addEventListener('submit',(event) => {
  event.preventDefault();
  if ($('comment-body').value.trim()) {
    saveDraft();
    $('card-form-error').textContent = 'Pubblica o cancella il commento prima di salvare la scheda. La bozza è conservata.';
    $('comment-body').focus();
    return;
  }
  if ($('worklog-minutes').value || $('worklog-note').value.trim()) { saveDraft(); $('card-form-error').textContent = 'Registra o cancella il tempo inserito prima di salvare la scheda. La bozza è conservata.'; $('worklog-minutes').focus(); return; }
  if ($('checklist-new').value.trim()) {
    saveDraft();
    $('card-form-error').textContent = 'Aggiungi l’attività alla checklist oppure cancella il testo prima di salvare la scheda. La bozza è conservata.';
    $('checklist-new').focus();
    return;
  }
  const editor = state.cardEditor; const data = productivity.planningPayload(cardData(),state.board.custom_fields,state.board.milestones,editor.persistedMilestone);
  if (!data.title) { $('card-form-error').textContent = 'Dai un titolo alla tua scheda.'; $('card-title').focus(); return; }
  const key = stableRequest(editor,data); saveDraft();
  perform(() => committed(async () => {
    editor.pendingAmbiguous = true; saveDraft();
    try {
      if (editor.id) await api(`/api/cards/${editor.id}`,'PATCH',data,{version:editor.version});
      else await api(`/api/columns/${data.column_id}/cards`,'POST',data,{key});
    } catch (error) {
      editor.pendingAmbiguous = !error.status || error.status >= 500 || [408,429].includes(error.status);
      saveDraft();
      if (error.status === 412) { $('conflict-notice').hidden = false; saveDraft(); throw new APIError('Conflitto: un’altra sessione ha aggiornato questa scheda. La tua bozza è conservata.',412); }
      throw error;
    }
    editor.pendingAmbiguous = false; forget(draftKey()); closeDialog('card-dialog',{force:true});
  },refreshBoard,editor.id ? 'Scheda aggiornata sul server.' : 'Scheda creata sul server.'),'','card-form-error');
});
$('delete-card').addEventListener('click',() => {
  const editor = state.cardEditor;
  if (!editor?.id || !confirm('Spostare questa scheda nel cestino? Potrai ripristinarla.')) return;
  saveDraft();
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'DELETE',undefined,{version:editor.version}); closeDialog('card-dialog',{force:true}); },refreshBoard,'Scheda spostata nel cestino.'),'','card-form-error');
});
$('board-form').addEventListener('submit',(event) => {
  event.preventDefault(); const data = boardData();
  if (!data.name) { $('board-form-error').textContent = 'Scegli un nome per la bacheca.'; return; }
  const editor = state.boardEditor; state.boardRequest = state.boardRequest || {};
  perform(() => committed(async () => {
    const result = await api(editor ? `/api/boards/${editor.id}` : '/api/boards',editor ? 'PATCH' : 'POST',data,{version:editor?.version,key:stableRequest(state.boardRequest,data)});
    closeDialog('board-dialog',{force:true}); return result;
  },async (result) => { await refreshBoards(); await selectBoard(editor?.id || result.id || result.board?.id,{quiet:true}); },'Bacheca salvata sul server.'),'','board-form-error');
});
$('delete-board').addEventListener('click',() => {
  const board = state.boardEditor;
  if (!board || !confirm(`Spostare “${board.name}”, le liste e le schede nel cestino? Potrai ripristinarle.`)) return;
  perform(() => committed(async () => { await api(`/api/boards/${board.id}`,'DELETE',undefined,{version:board.version}); closeDialog('board-dialog',{force:true}); },async () => {
    await refreshBoards();
    if (state.boards.length) await selectBoard(state.boards[0].id,{quiet:true});
    else { state.board = null; route(null); renderSidebar(); renderHeader(); renderBoard(); }
  },'Bacheca spostata nel cestino.'),'','board-form-error');
});
$('column-form').addEventListener('submit',(event) => {
  event.preventDefault(); const data = columnData(); const editor = state.columnEditor;
  if (!data.title) { $('column-form-error').textContent = 'Scegli un nome per la lista.'; return; }
  state.columnRequest = state.columnRequest || {};
  perform(() => committed(async () => {
    await api(editor ? `/api/columns/${editor.id}` : `/api/boards/${state.board.id}/columns`,editor ? 'PATCH' : 'POST',data,{version:editor?.version,key:stableRequest(state.columnRequest,data)});
    closeDialog('column-dialog',{force:true});
  },refreshBoard,'Lista salvata sul server.'),'','column-form-error');
});
$('delete-column').addEventListener('click',() => { if (state.columnEditor) deleteColumn(state.columnEditor.id); });
$('move-form').addEventListener('submit',(event) => {
  event.preventDefault(); const editor = state.cardEditor;
  const data = {column_id:Number($('move-column').value),position:Number($('move-position').value)-1};
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'PATCH',data,{version:editor.version}); closeDialog('move-dialog',{force:true}); closeDialog('card-dialog',{force:true}); },refreshBoard,'Scheda spostata.'),'','move-error');
});
$('add-comment').addEventListener('click',() => {
  const body = $('comment-body').value.trim(); const editor = state.cardEditor;
  if (!body || !editor?.id) return;
  const data = {body}; editor.commentRequest = editor.commentRequest || {};
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}/comments`,'POST',data,{key:stableRequest(editor.commentRequest,data)}); $('comment-body').value = ''; editor.commentRequest = {}; if (editorDirty('card-dialog')) saveDraft(); else forget(draftKey()); },() => loadComments(editor.id),'Commento pubblicato.'),'','card-form-error');
});
document.addEventListener('submit',(event) => {
  const form = event.target;
  if (!['create-user-form','password-form','member-form'].includes(form.id) && !form.dataset.userForm) return;
  event.preventDefault();
  if (form.id === 'create-user-form') {
    const data = {name:$('user-name').value.trim(),username:$('user-username').value.trim(),password:$('user-password').value,role:$('user-role').value};
    state.userRequest = state.userRequest || {};
    perform(() => committed(() => api('/api/users','POST',data,{key:stableRequest(state.userRequest,data)}),async () => { state.userRequest = {}; await showUsers(); },'Utente creato.'),'','panel-error');
  } else if (form.dataset.userForm) {
    const data = {role:form.elements.role.value,active:form.elements.active.checked};
    perform(() => committed(() => api(`/api/users/${Number(form.dataset.userForm)}`,'PATCH',data),async () => { state.auth = await api('/api/auth/session'); await showUsers(); },'Utente aggiornato.'),'','panel-error');
  } else if (form.id === 'password-form') {
    const data = {current_password:$('current-password').value,password:$('new-password').value};
    perform(() => committed(() => api('/api/auth/password','POST',data),async () => { $('password-form').reset(); state.auth = await api('/api/auth/session'); },'Password aggiornata.'),'','panel-error');
  } else if (form.id === 'member-form') {
    const data = {user_id:Number($('member-user').value),role:$('member-role').value};
    perform(() => committed(() => api(`/api/boards/${state.board.id}/members`,'POST',data),showMembers,'Membro aggiornato.'),'','panel-error');
  }
});
function clearDragStyles() { document.querySelectorAll('.dragging,.drag-over,.drag-before').forEach((element) => element.classList.remove('dragging','drag-over','drag-before')); }
$('board-canvas').addEventListener('dragstart',(event) => {
  const card = event.target.closest('.task-card');
  if (!card || state.saving || !canWrite() || hasFilters() || state.archived) { event.preventDefault(); if (hasFilters()) toast('Ripristina ordine manuale e rimuovi i filtri per trascinare le schede.'); return; }
  state.draggedCard = Number(card.dataset.cardId);
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain',String(state.draggedCard));
  setTimeout(() => card.classList.add('dragging'),0);
});
$('board-canvas').addEventListener('dragover',(event) => {
  const column = event.target.closest('[data-drop-column]');
  if (!column || !state.draggedCard || state.saving) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over,.drag-before').forEach((element) => element.classList.remove('drag-over','drag-before'));
  column.classList.add('drag-over'); const card = event.target.closest('.task-card');
  if (card && Number(card.dataset.cardId) !== state.draggedCard) card.classList.add('drag-before');
});
$('board-canvas').addEventListener('drop',(event) => {
  const targetColumn = event.target.closest('[data-drop-column]'); const cardId = state.draggedCard;
  clearDragStyles(); state.draggedCard = null;
  if (!targetColumn || !cardId || state.saving) return;
  event.preventDefault();
  const columnId = Number(targetColumn.dataset.dropColumn);
  const column = state.board.columns.find((item) => item.id === columnId);
  const targetCardId = Number(event.target.closest('.task-card')?.dataset.cardId) || null;
  if (targetCardId === cardId) return;
  const remaining = column.cards.filter((card) => card.id !== cardId);
  const position = targetCardId ? remaining.findIndex((card) => card.id === targetCardId) : remaining.length;
  const source = allCards().find((card) => card.id === cardId);
  if (!source || (source.column_id === columnId && column.cards.findIndex((card) => card.id === cardId) === position)) return;
  perform(() => committed(() => api(`/api/cards/${cardId}`,'PATCH',{column_id:columnId,position:Math.max(0,position)},{version:source.version}),refreshBoard,'Scheda spostata.'));
});
$('board-canvas').addEventListener('dragend',() => { state.draggedCard = null; clearDragStyles(); });
window.addEventListener('hashchange',async () => {
  if (state.saving || state.loading || (state.auth?.enabled && !state.auth.user)) return;
  const requested = currentRoute();
  const prior = {boardId:state.board?.id,cardId:$('card-dialog').open ? state.cardEditor?.id : null};
  if ($('card-dialog').open && state.cardEditor?.id !== requested.cardId && !closeDialog('card-dialog',{navigate:false})) { route(prior.boardId,prior.cardId,true); return; }
  if (!requested.boardId) return;
  if (requested.boardId !== state.board?.id) {
    if (!closeEditors()) { route(prior.boardId,prior.cardId,true); return; }
    await selectBoard(requested.boardId,{navigate:false});
  }
  if (requested.cardId) await openCard(requested.cardId,null,{navigate:false});
});
window.addEventListener('beforeunload',(event) => {
  saveDraft();
  if (['card-dialog','board-dialog','column-dialog'].some((id) => $(id).open && editorDirty(id))) { event.preventDefault(); event.returnValue = ''; }
});
async function pollRevision() {
  if (document.hidden || state.saving || state.loading || state.polling || !state.board) return;
  const boardId = state.board.id;
  state.polling = true;
  try {
    const result = await api(`/api/boards/${boardId}/revision`);
    if (state.board?.id !== boardId || Number(result.version) === Number(state.board.version)) return;
    state.remoteVersion = result.version;
    if (document.querySelector('dialog[open]')) { saveDraft(); $('remote-change').hidden = false; }
    else await refreshBoard();
  } catch { /* Retain the current board and drafts when the server is temporarily unreachable. */ }
  finally { state.polling = false; }
}

/* OpenBoard 0.3: planning, reusable work, subscriptions and personal tools. */
function updateSelection() {
  $('bulk-toolbar').hidden = !state.selectionMode;
  $('selection-mode').setAttribute('aria-pressed',String(state.selectionMode));
  $('selection-count').textContent = `${state.selectedCards.size} selezionate`;
  $('bulk-complete').disabled = $('bulk-archive').disabled = !canWrite() || !state.selectedCards.size || state.saving;
}
function dateOffset(days) { const date = new Date(); date.setDate(date.getDate()+days); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function renderReference() {
  const url = productivity.safeURL($('card-reference').value.trim());
  $('reference-link').innerHTML = url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Apri riferimento in una nuova scheda</a>` : '';
}
function timerKey() { return `timer.${state.auth?.user?.id || 'local'}.${state.cardEditor?.id || 'new'}`; }
function readTimer() { try { const timer = JSON.parse(stored(timerKey(),'null')); return timer && Number.isFinite(timer.started) && timer.started > 0 && timer.started <= Date.now() && Number.isFinite(timer.base) ? timer : null; } catch { return null; } }
function renderTimer() {
  if (!state.cardEditor || !$('card-dialog').open) return;
  const timer = readTimer();
  $('timer-toggle').disabled = !state.cardEditor.id || !canWrite() || state.saving;
  $('timer-toggle').textContent = timer ? 'Ferma e aggiungi minuti' : 'Avvia timer';
  const seconds = timer ? Math.max(0,Math.floor((Date.now()-timer.started)/1000)) : 0;
  $('timer-value').textContent = timer ? `${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')} · in corso` : state.cardEditor.id ? 'Fermo' : 'Salva la scheda per usare il timer';
}
function fillProductivityCard(data) {
  $('card-start-date').value = data.start_date || '';
  $('card-blocked-reason').value = data.blocked_reason || '';
  $('card-actual').value = data.actual_minutes || 0;
  $('card-reference').value = data.reference_url || '';
  state.cardEditor.assigneeIds = Array.isArray(data.assignee_ids) ? data.assignee_ids.map(Number) : (data.assignees || []).map((user) => Number(user.id));
  if (state.cardEditor.members) renderMemberAssignments(state.cardEditor.members);
  else $('card-assignees').innerHTML = '<p class="helper-text">Caricamento membri…</p>';
  $('dependencies-section').hidden = $('attachments-section').hidden = !state.cardEditor.id;
  $('save-card-template').hidden = !state.cardEditor.id;
  $('watch-card').hidden = !state.cardEditor.id || !state.auth?.enabled;
  $('dependencies-list').innerHTML = ''; $('attachments-list').innerHTML = '';
  $('attachment-file').value = '';
  $('markdown-preview').innerHTML = productivity.markdown(data.description || '');
  renderReference(); renderTimer();
}
function renderMemberAssignments(members) {
  state.cardEditor.members = members;
  const ids = state.cardEditor.assigneeIds || [];
  $('assignees-field').hidden = !state.auth?.enabled;
  $('card-assignees').innerHTML = members.length ? members.map((user) => `<label><input type="checkbox" data-assignee-id="${Number(user.user_id || user.id)}" data-write ${ids.includes(Number(user.user_id || user.id)) ? 'checked' : ''} ${!canWrite() ? 'disabled' : ''}>${escapeHTML(user.name)} <span class="helper-text">@${escapeHTML(user.username)}</span></label>`).join('') : '<p class="helper-text">Aggiungi membri alla bacheca per assegnare account reali.</p>';
}
async function loadProductivityCard(cardId,boardId,sequence) {
  const isCurrent = () => state.board?.id === boardId && state.cardSequence === sequence && state.cardEditor?.id === (Number(cardId)||null) && $('card-dialog').open;
  if (state.auth?.enabled) {
    try { const members = await api(`/api/boards/${boardId}/members`); if (isCurrent()) renderMemberAssignments(members.members || []); }
    catch (error) { if (isCurrent()) $('card-assignees').textContent = error.message; }
  } else if (isCurrent()) renderMemberAssignments([]);
  if (isCurrent()) loadPlanningCard(Number(cardId)||null,boardId,sequence);
  if (!cardId || !isCurrent()) return;
  $('dependency-card').innerHTML = allCards().filter((card) => card.id !== Number(cardId) && !card.archived).map((card) => `<option value="${Number(card.id)}">${escapeHTML(card.title)}</option>`).join('');
  await Promise.allSettled([loadDependencies(Number(cardId)),loadAttachments(Number(cardId)),refreshWatchState(Number(cardId))]);
}
async function loadDependencies(cardId) {
  try {
    const result = await api(`/api/cards/${cardId}/dependencies`);
    if (state.cardEditor?.id !== cardId || !$('card-dialog').open) return;
    const dependencies = result.dependencies || [];
    $('dependencies-list').innerHTML = dependencies.map((card) => `<div class="dependency-row"><span class="dependency-status ${card.completed ? 'complete' : ''}">${card.completed ? '✓ Completata' : '○ Da completare'}</span><button type="button" class="subtle-button" data-dependency-open="${Number(card.id)}">${escapeHTML(card.title)}</button><button type="button" class="button danger-subtle" data-remove-dependency="${Number(card.id)}" data-write>Rimuovi</button></div>`).join('') || '<p class="helper-text">Nessuna dipendenza.</p>';
    const used = new Set(dependencies.map((card) => card.id));
    $('dependency-card').innerHTML = allCards().filter((card) => card.id !== cardId && !card.archived && !used.has(card.id)).map((card) => `<option value="${Number(card.id)}">${escapeHTML(card.title)}</option>`).join('');
    updateBusy();
  } catch (error) { if (state.cardEditor?.id === cardId) $('dependencies-list').textContent = error.message; }
}
async function refreshEditorVersion(cardId) {
  const result = await api(`/api/cards/${cardId}`);
  if (state.cardEditor?.id === cardId && $('card-dialog').open) { state.cardEditor.version = (result.card || result).version; saveDraft(); }
}
async function changeDependency(required,remove) {
  const id = state.cardEditor?.id;
  if (!id || !required) return;
  if (editorDirty('card-dialog')) { toast('Salva la bozza prima di cambiare le dipendenze.',true); return; }
  await perform(() => committed(() => api(`/api/cards/${id}/dependencies${remove ? '/'+Number(required) : ''}`,remove ? 'DELETE':'POST',remove ? undefined : {required_card_id:Number(required)},{version:state.cardEditor.version}),async () => { await refreshEditorVersion(id); await loadDependencies(id); },remove ? 'Dipendenza rimossa.' : 'Dipendenza aggiunta.'),'','card-form-error');
}
async function loadAttachments(cardId) {
  try {
    const result = await api(`/api/cards/${cardId}/attachments`);
    if (state.cardEditor?.id !== cardId || !$('card-dialog').open) return;
    $('attachments-list').innerHTML = (result.attachments || []).map((file) => `<div class="attachment-row"><div><strong>${escapeHTML(file.name)}</strong><span>${Math.ceil(Number(file.size)/1024)} KiB · ${file.deleted_at ? 'Nel cestino' : escapeHTML(formatDate(file.created_at))}</span></div>${file.deleted_at ? `<button type="button" class="button secondary" data-restore-attachment="${Number(file.id)}" data-write>Ripristina</button>` : `<button type="button" class="button secondary" data-download-attachment="${Number(file.id)}">Scarica</button><button type="button" class="button danger-subtle" data-delete-attachment="${Number(file.id)}" data-write>Elimina</button>`}</div>`).join('') || '<p class="helper-text">Nessun allegato.</p>';
    updateBusy();
  } catch (error) { if (state.cardEditor?.id === cardId) $('attachments-list').textContent = error.message; }
}
function downloadBlob(blob,name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = String(name || 'download').replace(/[\x00-\x1f\x7f/\\]/g,'_');
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function uploadAttachment() {
  const id = state.cardEditor?.id, file = $('attachment-file').files[0];
  if (!id || !file) { toast('Scegli un file da caricare.',true); return; }
  if (!file.size || file.size > 1024*1024) { toast('Il file deve contenere da 1 byte a 1 MiB.',true); return; }
  await perform(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let offset=0;offset<bytes.length;offset+=16384) binary += String.fromCharCode(...bytes.subarray(offset,offset+16384));
    if (state.cardEditor?.id !== id || !$('card-dialog').open) return;
    await committed(() => api(`/api/cards/${id}/attachments`,'POST',{name:file.name,mime:file.type || 'application/octet-stream',data_base64:btoa(binary)}),async () => { if (state.cardEditor?.id === id) $('attachment-file').value = ''; await loadAttachments(id); },'Allegato caricato.');
  },'','card-form-error');
}
async function downloadAttachment(id) {
  await perform(async () => {
    const result = await api(`/api/attachments/${Number(id)}`); const binary = atob(result.data_base64), bytes = Uint8Array.from(binary,(char) => char.charCodeAt(0));
    downloadBlob(new Blob([bytes],{type:'application/octet-stream'}),result.name); toast('Allegato scaricato.');
  });
}
async function refreshWatchState(cardId = null) {
  if (!state.auth?.enabled || !state.auth?.user) return;
  const boardId = state.board?.id;
  try {
    const result = await api('/api/me/watches');
    if (state.board?.id === boardId) { state.boardWatching = (result.boards || []).some((board) => board.id === boardId); $('watch-board').textContent = state.boardWatching ? 'Non seguire più la bacheca' : 'Segui bacheca'; }
    if (cardId && state.cardEditor?.id === cardId) { state.cardWatching = (result.cards || []).some((card) => card.id === cardId); $('watch-card').textContent = state.cardWatching ? 'Non seguire' : 'Segui scheda'; }
  } catch { /* A subscription failure never hides the current board. */ }
}
async function toggleWatch(card) {
  const id = card ? state.cardEditor?.id : state.board?.id;
  if (!id || !state.auth?.user) return;
  const watching = !(card ? state.cardWatching : state.boardWatching);
  await perform(() => committed(() => api(`/api/${card ? 'cards':'boards'}/${id}/watch`,'PATCH',{watching}),() => refreshWatchState(card ? id : null),watching ? 'Riceverai le notifiche degli aggiornamenti.' : 'Notifiche disattivate per questo elemento.'));
}
async function refreshNotifications() {
  if (!state.auth?.enabled || !state.auth?.user || document.hidden) return;
  try { const result = await api('/api/notifications/unread-count'); const count = Number(result.unread_count)||0; $('unread-count').textContent = count > 99 ? '99+' : String(count); $('unread-count').hidden = !count; $('notifications').setAttribute('aria-label',`Notifiche: ${count} non lette`); } catch { /* Keep the last verified badge when offline. */ }
}
async function showNotifications(before = null,append = false) { return showFilteredNotifications(before,append); }
function activityLabel(action) { return ({created:'ha creato',updated:'ha modificato',deleted:'ha eliminato',restored:'ha ripristinato',commented:'ha commentato',moved:'ha spostato',archived:'ha archiviato',attached:'ha allegato un file'})[action] || action; }
async function showMyTasks() {
  if (!state.auth?.user) { panel('Mie attività','<p>Accedi con un account per vedere le schede assegnate a te attraverso i membri della bacheca.</p>','mytasks'); return; }
  await showPanel('Mie attività',async () => {
    const result = await api('/api/me/tasks'), cards = result.cards || [];
    return `<p>${cards.length} schede assegnate a ${escapeHTML(state.auth.user.name)} · ${cards.filter((card) => overdue(card)).length} scadute</p>${cards.map((card) => `<button type="button" class="search-result" data-search-card="${Number(card.id)}" data-search-board="${Number(card.board_id)}"><strong>${card.completed ? '✓ ' : ''}${escapeHTML(card.title)}</strong><span>${escapeHTML(card.board_name)} / ${escapeHTML(card.column_title)}${card.due_date ? ' · '+escapeHTML(card.due_date) : ''}${card.blocked_reason ? ' · Bloccata' : ''}</span></button>`).join('') || '<p>Non hai schede assegnate. Apri una scheda e seleziona il tuo account in Membri assegnati.</p>'}`;
  },'mytasks');
}
function currentFilters() { return {search:state.query,label:state.label,assignee:state.assignee,priority:state.priority,status:state.status,sort:state.sort}; }
async function showSavedViews() {
  const boardId = state.board?.id; if (!boardId) return;
  state.savedViewsBoard = boardId;
  await showPanel('Filtri salvati',async () => {
    const result = await api(`/api/boards/${boardId}/views`); state.savedViews = result.views || [];
    return `<p>Salva la ricerca, i filtri e l’ordinamento attuali per questa bacheca.</p><form id="saved-view-form" data-board="${boardId}"><label class="field-label" for="saved-view-name">Nome del filtro</label><input id="saved-view-name" maxlength="100" required><button class="button primary" type="submit">Salva filtri attuali</button></form><div class="saved-views">${state.savedViews.map((view) => `<form data-view-form="${Number(view.id)}"><label><span class="sr-only">Nome filtro salvato</span><input name="name" value="${escapeHTML(view.name)}" required maxlength="100"></label><button type="button" class="button secondary" data-apply-view="${Number(view.id)}">Applica</button><button type="submit" class="subtle-button">Rinomina</button><button type="button" class="button danger-subtle" data-delete-view="${Number(view.id)}">Elimina</button></form>`).join('') || '<p>Nessun filtro salvato.</p>'}</div><p id="panel-error" class="form-error" role="alert"></p>`;
  },'views');
}
function applySavedView(id) {
  if (state.savedViewsBoard !== state.board?.id) { toast('Riapri i filtri salvati per la bacheca corrente.',true); return; }
  const view = (state.savedViews || []).find((item) => item.id === Number(id)); if (!view) return;
  const filters = view.filters || {};
  state.query = filters.search || ''; $('search-input').value = state.query;
  for (const name of ['label','assignee','priority','status','sort']) { const value = filters[name] || (name === 'sort' ? 'manual' : ''); state[name] = value; $(`${name}-filter`).value = value; }
  closeDialog('panel-dialog'); renderBoard(); toast(`Filtro “${view.name}” applicato.`);
}
function saveTemplate(kind) {
  const id = kind === 'cards' ? state.cardEditor?.id : state.board?.id;
  if (!id) return;
  if (kind === 'cards' && editorDirty('card-dialog')) { toast('Salva la bozza prima di creare un modello.',true); return; }
  panel(kind === 'cards' ? 'Salva modello di scheda' : 'Salva modello di bacheca',`<p>Il modello conserva i contenuti salvati. Commenti, allegati e account restano esclusi.</p><form id="save-template-form" data-kind="${kind}" data-source="${Number(id)}"><label class="field-label" for="template-name">Nome del modello</label><input id="template-name" required maxlength="100"><button type="submit" class="button primary" data-write>Salva modello</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'save-template');
  $('template-name').focus();
}
async function showTemplates() {
  const boardId = state.board?.id, columns = [...(state.board?.columns || [])];
  await showPanel('Modelli riutilizzabili',async () => {
    const results = await Promise.all([api('/api/templates/cards'),api('/api/templates/boards')]);
    return `<p>Usa un modello per creare nuovi elementi. La bacheca di partenza conserva i propri dati.</p><section><h3>Modelli di scheda</h3><label class="field-label" for="template-column">Lista di destinazione</label><select id="template-column">${columns.map((column) => `<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('')}</select>${(results[0].templates || []).map((template) => `<div class="template-row"><strong>${escapeHTML(template.name)}</strong><button type="button" class="button secondary" data-instantiate-template="${Number(template.id)}" data-template-kind="cards" data-template-board="${Number(boardId)}" data-write>Crea scheda</button><button type="button" class="button danger-subtle" data-delete-template="${Number(template.id)}" data-template-kind="cards" data-write>Elimina modello</button></div>`).join('') || '<p>Nessun modello di scheda. Usa Salva modello nell’editor.</p>'}</section><section><h3>Modelli di bacheca</h3>${(results[1].templates || []).map((template) => `<div class="template-row"><strong>${escapeHTML(template.name)}</strong><button type="button" class="button secondary" data-instantiate-template="${Number(template.id)}" data-template-kind="boards" data-product-create ${!canCreateBoard() ? 'disabled' : ''}>Crea bacheca</button><button type="button" class="button danger-subtle" data-delete-template="${Number(template.id)}" data-template-kind="boards" data-write>Elimina modello</button></div>`).join('') || '<p>Nessun modello di bacheca. Usa Salva come modello nelle opzioni della bacheca.</p>'}</section><p id="panel-error" class="form-error" role="alert"></p>`;
  },'templates');
}
async function bulkCards(action) {
  const boardId = state.board?.id, cards = [...state.selectedCards].map(([id,version]) => ({id,version}));
  if (!boardId || !cards.length || !canWrite()) return;
  if (action === 'archive' && !confirm(`Archiviare ${cards.length} schede selezionate? Potrai recuperarle mostrando le schede archiviate.`)) return;
  await perform(() => committed(() => api(`/api/boards/${boardId}/bulk`,'POST',{action,cards,value:true}),async () => { state.selectedCards.clear(); await refreshBoard(); },`${cards.length} schede ${action === 'complete' ? 'completate' : 'archiviate'}.`));
}
async function showSessions() {
  await showPanel('Sessioni del tuo account',async () => {
    const result = await api('/api/me/sessions');
    const date = (value) => new Date(Number(value)*1000).toLocaleString('it-IT');
    return `<p>Revoca l’accesso da altri dispositivi. Questa sessione resta aperta.</p><button id="revoke-other-sessions" class="button secondary" type="button">Revoca tutte le altre sessioni</button>${(result.sessions || []).map((session) => `<div class="session-row"><div><strong>${session.current ? 'Questa sessione' : 'Altra sessione'}</strong><span>Accesso: ${escapeHTML(date(session.created_at))}<br>Ultima attività: ${escapeHTML(date(session.last_seen))}<br>Scade: ${escapeHTML(date(session.expires_at))}</span></div>${!session.current ? `<button class="button danger-subtle" type="button" data-revoke-session="${escapeHTML(session.id)}">Revoca</button>` : ''}</div>`).join('')}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'sessions');
}
async function showEditComment(id) {
  const editor = state.cardEditor, comment = (editor?.comments || []).find((item) => item.id === Number(id));
  if (!comment) return;
  panel('Modifica il tuo commento',`<form id="edit-comment-form" data-comment="${Number(id)}" data-version="${Number(comment.version)}" data-card="${Number(editor.id)}"><label class="field-label" for="edit-comment-body">Commento</label><textarea id="edit-comment-body" rows="5" required maxlength="5000">${escapeHTML(comment.body)}</textarea><button class="button primary" type="submit" data-write>Salva commento</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'edit-comment');
}
async function exportProductivity(kind) {
  const board = state.board; if (!board) return;
  await perform(async () => {
    const result = await api(`/api/boards/${board.id}/export`), full = result.board || result;
    const csv = kind === 'csv'; downloadBlob(new Blob([csv ? productivity.csv(full) : productivity.calendar(full)],{type:csv ? 'text/csv;charset=utf-8' : 'text/calendar;charset=utf-8'}),`${board.name}.${csv ? 'csv':'ics'}`);
    toast(csv ? 'CSV completo scaricato con celle protette per i fogli di calcolo.' : 'Calendario scaricato con scadenze e date di inizio.');
  });
}
function showShortcuts() { panel('Scorciatoie da tastiera','<dl class="shortcuts"><dt>⌘ / Ctrl + K</dt><dd>Vai alla ricerca della bacheca</dd><dt>N</dt><dd>Nuova scheda</dd><dt>F</dt><dd>Ricerca nella bacheca</dd><dt>G</dt><dd>Ricerca globale</dd><dt>?</dt><dd>Mostra questa guida</dd><dt>Invio / Spazio su una scheda</dt><dd>Apri scheda</dd><dt>M su una scheda</dt><dd>Apri e sposta scheda</dd><dt>Esc</dt><dd>Chiudi il pannello o editor (con conferma per bozze)</dd></dl><p>Le scorciatoie N, F, G e ? funzionano quando non stai scrivendo e non ci sono finestre aperte.</p>','shortcuts'); }

document.addEventListener('click',async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.dataset.dateOffset !== undefined) { $('card-due-date').value = target.dataset.dateOffset === 'clear' ? '' : dateOffset(Number(target.dataset.dateOffset)); saveDraft(); return; }
  if (target.dataset.removeDependency) { changeDependency(target.dataset.removeDependency,true); return; }
  if (target.dataset.dependencyOpen) { if (closeDialog('card-dialog')) openCard(target.dataset.dependencyOpen); return; }
  if (target.dataset.downloadAttachment) { downloadAttachment(target.dataset.downloadAttachment); return; }
  if (target.dataset.deleteAttachment || target.dataset.restoreAttachment) {
    const id = Number(target.dataset.deleteAttachment || target.dataset.restoreAttachment), cardId = state.cardEditor?.id, restore = !!target.dataset.restoreAttachment;
    if (!restore && !confirm('Spostare questo allegato nel cestino?')) return;
    perform(() => committed(() => api(`/api/attachments/${id}${restore ? '/restore':''}`,restore ? 'POST':'DELETE',restore ? {}:undefined),() => loadAttachments(cardId),restore ? 'Allegato ripristinato.' : 'Allegato eliminato.'),'','card-form-error'); return;
  }
  if (target.dataset.editComment) { showEditComment(target.dataset.editComment); return; }
  if (target.dataset.applyView) { applySavedView(target.dataset.applyView); return; }
  if (target.dataset.deleteView) { perform(() => committed(() => api(`/api/views/${Number(target.dataset.deleteView)}`,'DELETE'),showSavedViews,'Filtro eliminato.'),'','panel-error'); return; }
  if (target.dataset.deleteTemplate) { if (!confirm('Eliminare questo modello? Gli elementi già creati restano disponibili.')) return; perform(() => committed(() => api(`/api/templates/${target.dataset.templateKind}/${Number(target.dataset.deleteTemplate)}`,'DELETE'),showTemplates,'Modello eliminato.'),'','panel-error'); return; }
  if (target.dataset.instantiateTemplate) {
    const kind = target.dataset.templateKind, boardId = state.board?.id;
    if (kind === 'cards' && boardId !== Number(target.dataset.templateBoard)) return;
    const data = kind === 'cards' ? {column_id:Number($('template-column').value)} : {};
    perform(() => committed(() => api(`/api/templates/${kind}/${Number(target.dataset.instantiateTemplate)}/instantiate`,'POST',data),async (result) => { closeDialog('panel-dialog',{force:true}); if (kind === 'boards') { await refreshBoards(); await selectBoard(result.id,{quiet:true}); } else if (state.board?.id === boardId) await refreshBoard(); },kind === 'boards' ? 'Bacheca creata dal modello.' : 'Scheda creata dal modello.'),'','panel-error'); return;
  }
  if (target.dataset.notificationRead) { perform(() => committed(() => api(`/api/notifications/${Number(target.dataset.notificationRead)}`,'PATCH',{read:true}),showNotifications,'Notifica letta.'),'','panel-error'); return; }
  if (target.dataset.notificationOpen) {
    await perform(async () => { await api(`/api/notifications/${Number(target.dataset.notificationOpen)}`,'PATCH',{read:true}); refreshNotifications(); });
    if (!closeEditors()) return; closeDialog('panel-dialog'); await selectBoard(target.dataset.notificationBoard); if (target.dataset.notificationCard && !state.loadError) await openCard(target.dataset.notificationCard); return;
  }
  if (target.dataset.revokeSession) { perform(() => committed(() => api(`/api/me/sessions/${target.dataset.revokeSession}`,'DELETE'),showSessions,'Sessione revocata.'),'','panel-error'); return; }
  switch (target.id) {
    case 'timer-toggle': {
      if (!state.cardEditor?.id || !canWrite()) break;
      const timer = readTimer();
      if (timer) { $('card-actual').value = Math.min(1000000,Math.max(Number($('card-actual').value)||0,timer.base)+Math.ceil(Math.max(0,Date.now()-timer.started)/60000)); forget(timerKey()); saveDraft(); toast('Minuti aggiunti alla bozza. Salva la scheda per registrarli sul server.'); }
      else { remember(timerKey(),JSON.stringify({started:Date.now(),base:Number($('card-actual').value)||0})); toast('Timer avviato. Resta disponibile su questo dispositivo anche dopo un ricaricamento.'); }
      renderTimer(); break;
    }
    case 'add-dependency': changeDependency($('dependency-card').value,false); break;
    case 'upload-attachment': uploadAttachment(); break;
    case 'watch-board': toggleWatch(false); break;
    case 'watch-card': toggleWatch(true); break;
    case 'notifications': showNotifications(); break;
    case 'notifications-read-all': perform(() => committed(() => api('/api/notifications/read-all','POST',{}),showNotifications,'Tutte le notifiche segnate come lette.'),'','panel-error'); break;
    case 'notifications-more': showNotifications(target.dataset.before,true); break;
    case 'my-tasks': showMyTasks(); break;
    case 'saved-views': showSavedViews(); break;
    case 'templates-board': showTemplates(); break;
    case 'save-card-template': saveTemplate('cards'); break;
    case 'save-board-template': saveTemplate('boards'); break;
    case 'selection-mode': state.selectionMode = !state.selectionMode; if (!state.selectionMode) state.selectedCards.clear(); renderBoard(); break;
    case 'clear-selection': state.selectionMode = false; state.selectedCards.clear(); renderBoard(); break;
    case 'select-visible': for (const card of allCards().filter(matches)) state.selectedCards.set(card.id,card.version); renderBoard(); break;
    case 'bulk-complete': bulkCards('complete'); break;
    case 'bulk-archive': bulkCards('archive'); break;
    case 'manage-sessions': showSessions(); break;
    case 'revoke-other-sessions': perform(() => committed(() => api('/api/me/sessions/revoke-others','POST',{}),showSessions,'Altre sessioni revocate.'),'','panel-error'); break;
    case 'export-csv': exportProductivity('csv'); break;
    case 'export-ics': exportProductivity('ics'); break;
    case 'shortcut-help': showShortcuts(); break;
  }
});
document.addEventListener('change',(event) => {
  const target = event.target;
  if (target.dataset.selectCard) { const card = allCards().find((item) => item.id === Number(target.dataset.selectCard)); if (!card) return; if (target.checked) state.selectedCards.set(card.id,card.version); else state.selectedCards.delete(card.id); updateSelection(); }
  if (target.dataset.assigneeId && state.cardEditor) { const id = Number(target.dataset.assigneeId), ids = new Set(state.cardEditor.assigneeIds); if (target.checked) ids.add(id); else ids.delete(id); state.cardEditor.assigneeIds = [...ids].sort((a,b) => a-b); saveDraft(); }
});
document.addEventListener('input',(event) => {
  if (event.target.id === 'card-description') $('markdown-preview').innerHTML = productivity.markdown(event.target.value);
  if (event.target.id === 'card-reference') renderReference();
});
document.addEventListener('submit',(event) => {
  const form = event.target;
  if (!['profile-form','saved-view-form','save-template-form','edit-comment-form'].includes(form.id) && !form.dataset.viewForm) return;
  event.preventDefault();
  if (form.id === 'profile-form') { perform(() => committed(() => api('/api/me/profile','PATCH',{name:$('profile-name').value.trim()}),async () => { state.auth = await api('/api/auth/session'); renderHeader(); showAccount(); },'Nome aggiornato.'),'','panel-error'); }
  else if (form.id === 'saved-view-form') { const boardId = Number(form.dataset.board); if (state.board?.id !== boardId) return; perform(() => committed(() => api(`/api/boards/${boardId}/views`,'POST',{name:$('saved-view-name').value.trim(),filters:currentFilters()}),showSavedViews,'Filtri salvati.'),'','panel-error'); }
  else if (form.dataset.viewForm) { perform(() => committed(() => api(`/api/views/${Number(form.dataset.viewForm)}`,'PATCH',{name:form.elements.name.value.trim()}),showSavedViews,'Filtro rinominato.'),'','panel-error'); }
  else if (form.id === 'save-template-form') { const kind = form.dataset.kind, id = Number(form.dataset.source); perform(() => committed(() => api(`/api/templates/${kind}`,'POST',{name:$('template-name').value.trim(),[kind === 'cards' ? 'card_id':'board_id']:id}),showTemplates,'Modello salvato.'),'','panel-error'); }
  else if (form.id === 'edit-comment-form') { const cardId = Number(form.dataset.card); perform(() => committed(() => api(`/api/comments/${Number(form.dataset.comment)}`,'PATCH',{body:$('edit-comment-body').value.trim()},{version:Number(form.dataset.version)}),async () => { closeDialog('panel-dialog',{force:true}); if (state.cardEditor?.id === cardId) await loadComments(cardId); },'Commento aggiornato.'),'','panel-error'); }
});
document.addEventListener('keydown',(event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (event.key === '?') { event.preventDefault(); showShortcuts(); }
  else if (event.key.toLowerCase() === 'n' && canWrite()) { event.preventDefault(); openCard(); }
  else if (event.key.toLowerCase() === 'f') { event.preventDefault(); $('search-input').focus(); }
  else if (event.key.toLowerCase() === 'g') { event.preventDefault(); showGlobalSearch(); }
});
setInterval(renderTimer,1000);
setInterval(refreshNotifications,15000);

setInterval(pollRevision,5000);
document.addEventListener('visibilitychange',() => { if (!document.hidden) pollRevision(); });
document.addEventListener('DOMContentLoaded',loadInitial,{once:true});

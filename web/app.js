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
const icon = (name) => ui`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.card}</svg>`;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels = Object.create(null);
const priorities = Object.create(null);
const productivity = OpenBoardProductivity;
const covers = [];
const state = {
  boards:[], board:null, storageLabel:'', versionRequested:false, query:'', label:'', assignee:'', priority:'', status:'', sort:'manual',
  archived:false, archivedBoards:false, view:'board', saving:false, loading:true, loadError:false,
  loadSequence:0, cardSequence:0, authGeneration:0, cardEditor:null, boardEditor:null, columnEditor:null,
  draggedCard:null, toastTimer:null, auth:null, remoteVersion:null, polling:false, panel:null, selectionMode:false, selectedCards:new Map(), boardWatching:false, cardWatching:false
};
function stored(key, fallback = '') { try { return localStorage.getItem(`openboard.${key}`) || fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(`openboard.${key}`, value); } catch { /* Local preferences remain optional. */ } }
function forget(key) { try { localStorage.removeItem(`openboard.${key}`); } catch { /* Storage can be disabled. */ } }
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
state.view = ['board','list','calendar','stats','table','timeline'].includes(stored('view')) ? stored('view') : 'board';
function setView(view) {
  if (state.saving || !['board','list','calendar','stats','table','timeline'].includes(view)) return;
  state.timelineSequence = (state.timelineSequence || 0)+1;
  state.view = view; remember('view',view); renderBoard();
}
document.documentElement.dataset.theme = stored('theme','light');
document.documentElement.dataset.density = stored('density','comfortable');
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); }); }
hydrateIcons();

class APIError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'APIError'; this.status = status; }
}
const pendingPosts = new Map();
function sessionOwner(session = state.auth) { return session?.enabled === false ? 'local' : String(session?.user?.id || 'signed-out'); }
function sessionContext() { return {generation:state.authGeneration,owner:sessionOwner()}; }
function sessionCurrent(context) { return context.generation === state.authGeneration && context.owner === sessionOwner(); }
function invalidateSession() {
  state.authGeneration++; state.loadSequence++; state.cardSequence++;
  state.panelSequence = (state.panelSequence || 0)+1;
  state.importSequence = (state.importSequence || 0)+1;
  pendingPosts.clear();
}
function setSession(session,{renewed = false} = {}) {
  const changedOwner = sessionOwner(session) !== sessionOwner();
  const clearView = changedOwner && !!state.auth?.user;
  if (clearView) {
    // Preserve a draft under its original owner before replacing the session.
    saveDraft();
    ['card-dialog','board-dialog','column-dialog','move-dialog','panel-dialog'].forEach((id) => { if ($(id)?.open) closeDialog(id,{force:true,navigate:false}); });
    state.board = null; state.boards = []; state.cardEditor = null; state.boardEditor = null; state.columnEditor = null;
    state.selectedCards.clear(); state.selectionMode = false; state.importData = null; state.importSource = null; state.importContext = null; state.importKey = null; state.conflictVersion = null;
    state.draftCenter = null; state.commandActions = []; state.globalSearch = null; state.timeline = null; state.timelineVisible = null; state.timelineRendered = null;
  }
  if (renewed || changedOwner || session?.csrf !== state.auth?.csrf || session?.user?.role !== state.auth?.user?.role) invalidateSession();
  state.auth = session;
  if(state.panel==='storage-capacity' && !canInspectStorage()) {
    state.panel=null;state.panelSequence=(state.panelSequence || 0)+1;
    if($('panel-dialog').open)closeDialog('panel-dialog',{force:true,navigate:false});
    $('panel-body').innerHTML='';
  }
  if (clearView) { clearFilters(false); $('panel-body').innerHTML = ''; renderSidebar(); renderHeader(); renderBoard(); }
}
function sessionChangedError() { const error = new APIError(tr('L’account è cambiato. Riapri questa vista.')); error.staleSession = true; return error; }
async function api(path, method = 'GET', body, options = {}) {
  const context = sessionContext();
  const headers = {'Accept':'application/json','Accept-Language':OpenBoardI18n.locale};
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
      if (!sessionCurrent(context)) throw sessionChangedError();
      const response = await fetch(path,{method,headers,body:serialized,signal:controller.signal,credentials:'same-origin',cache:'no-store'});
      if (!sessionCurrent(context)) throw sessionChangedError();
      let result;
      try { result = await response.json(); } catch { throw new APIError(tr('Risposta del server non valida. Verifica l’esito prima di riprovare.'),response.status); }
      if (!sessionCurrent(context)) throw sessionChangedError();
      if (!response.ok) {
        if (response.status === 401 && state.auth?.enabled && !path.startsWith('/api/auth/')) showAuth(false);
        if (response.status >= 400 && response.status < 500 && ![408,429].includes(response.status)) pendingPosts.delete(requestId);
        throw new APIError(OpenBoardI18n.error(result.error || 'Operazione non riuscita.',response.status),response.status);
      }
      pendingPosts.delete(requestId);
      return result;
    } catch (error) {
      if (!sessionCurrent(context) || error.staleSession) throw sessionChangedError();
      if (!(error instanceof APIError) && attempt === 0 && method === 'POST') continue;
      if (error.name === 'AbortError') throw new APIError(tr('Tempo di attesa esaurito. La bozza è conservata; riprova per verificare l’esito.'));
      if (error instanceof TypeError) throw new APIError(tr('Server non raggiungibile. La bozza è conservata; controlla la connessione.'));
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
  $('save-status').textContent = state.saving ? tr('Salvataggio in corso…') : state.loadError ? tr('Connessione da verificare · bozza locale conservata') : tr`Salvataggio sul server${state.storageLabel ? ' · '+state.storageLabel : ''}`;
  document.body.setAttribute('aria-busy',String(state.saving));
}
async function perform(action, successMessage = '', errorId) {
  if (state.saving) return;
  state.saving = true;
  if (errorId) $(errorId).textContent = '';
  updateBusy();
  try { const result = await action(); if (successMessage) toast(successMessage); return result; }
  catch (error) {
    if (error.staleSession) return;
    if (errorId && $(errorId)?.closest('dialog')?.open) $(errorId).textContent = error.message;
    else toast(error.message,true);
  } finally { state.saving = false; updateBusy(); }
}
async function committed(write, refresh, message) {
  const context = sessionContext();
  const result = await write();
  if (!sessionCurrent(context)) return result;
  toast(message || tr('Modifica salvata sul server.'));
  try { if (refresh) await refresh(result); }
  catch (error) { if (sessionCurrent(context) && !error.staleSession) { state.loadError = true; toast(tr('Modifica salvata sul server. L’aggiornamento della vista è fallito: premi Aggiorna, senza ripetere il salvataggio.'),true); } }
  return result;
}
function allCards() { return state.board?.columns.flatMap((column) => column.cards) || []; }
function assignmentNames(card) { return [...new Set([card.assignee,...(card.assignees || []).map((user) => user.name)].filter(Boolean))]; }
function assignees() { return [...new Set(allCards().flatMap(assignmentNames))].sort((a,b) => a.localeCompare(b,OpenBoardI18n.locale)); }
function initials(name) { return productivity.initials(name,OpenBoardI18n.locale); }
function avatar(name) { return ui`<span class="avatar a-${Math.max(assignees().indexOf(name),0)%5}" title="${escapeHTML(name)}" aria-label="${escapeHTML(name)}">${escapeHTML(initials(name))}</span>`; }
function roleLabel(role) { return ({admin:tr('Amministratore'),member:tr('Membro'),observer:tr('Osservatore')})[role] || role || ''; }
function coverLabel(cover) { return ({sage:tr('Salvia'),peach:tr('Pesca'),lavender:tr('Lavanda'),blue:tr('Blu')})[cover] || cover; }
function cardLabels(card) { return [...new Set([card.label,...(Array.isArray(card.labels) ? card.labels : [])].filter((label) => labels[label]))]; }
function boardLink(board) {
  return ui`<button type="button" class="board-link ${state.board?.id === board.id ? 'selected' : ''}" data-select-board="${Number(board.id)}" ${state.board?.id === board.id ? 'aria-current="page"' : ''}><span class="board-color ${covers.includes(board.color) ? board.color : 'sage'}"></span><span>${escapeHTML(board.name)}${board.archived ? tr(' · Archivio') : ''}</span></button>`;
}
function renderSidebar() {
  $('board-count').textContent = state.boards.length;
  $('board-links').innerHTML = state.boards.map(boardLink).join('');
  const starred = state.boards.filter((board) => board.starred);
  $('starred-boards').innerHTML = starred.length ? starred.map(boardLink).join('') : ui`<p class="empty-starred">Aggiungi una stella alle bacheche che usi più spesso.</p>`;
  $('mobile-board-links').innerHTML = state.boards.map(boardLink).join('') + ui`<button type="button" class="button secondary" data-create-board data-write>${icon('plus')}Nuova bacheca</button>`;
}
function renderHeader() {
  const board = state.board;
  $('board-title').textContent = board?.name || tr('Le tue idee, in ordine.');
  $('breadcrumb-board').textContent = board?.name || tr('Bacheche');
  $('board-description').textContent = board?.description || tr('Il prossimo progetto inizia da una piccola scheda.');
  document.title = board ? `${board.name} · OpenBoard` : tr('OpenBoard · Il tuo lavoro, in ordine');
  $('star-board').classList.toggle('starred',!!board?.starred);
  $('star-board').setAttribute('aria-label',board?.starred ? tr('Rimuovi dai preferiti') : tr('Aggiungi ai preferiti'));
  $('star-board').setAttribute('aria-pressed',String(!!board?.starred));
  $('privacy-badge').textContent = board?.archived ? tr('Archiviata') : state.auth?.enabled ? tr`Team · ${roleLabel(board?.role || state.auth.user?.role)}` : tr('Workspace locale');
  $('archive-board').textContent = board?.archived ? tr('Ripristina dall’archivio') : tr('Archivia bacheca');
  $('notifications').hidden = !state.auth?.enabled || !state.auth?.user;
  $('watch-board').hidden = !state.auth?.enabled || !state.auth?.user;
  $('account-menu').textContent = initials(state.auth?.user?.name || 'Studio');
  $('account-menu').setAttribute('aria-label',tr`Account e preferenze${state.auth?.user ? ': '+state.auth.user.name : ''}`);
  $('avatar-stack').innerHTML = assignees().slice(0,4).map(avatar).join('');
  $('assignee-filter').innerHTML = ui`<option value="">Responsabile</option><option value="__none">Non assegnate</option>` + assignees().map((name) => ui`<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
  $('assignee-filter').value = state.assignee;
  $('assignee-options').innerHTML = assignees().map((name) => ui`<option value="${escapeHTML(name)}">`).join('');
  document.documentElement.dataset.boardColor = covers.includes(board?.color) ? board.color : 'sage';
  $('show-archived-boards').textContent = state.archivedBoards ? tr('Nascondi bacheche archiviate') : tr('Bacheche archiviate');
  renderPlanningFilters(); updateFilters(); updateBusy();
}
function todayISO() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function overdue(card) { return !!card.due_date && card.due_date < todayISO() && !card.completed; }
function matches(card) {
  const query = state.query.trim().toLocaleLowerCase(OpenBoardI18n.locale);
  const text = `${card.title} ${card.description || card.description_preview || ''} ${assignmentNames(card).join(' ')}`.toLocaleLowerCase(OpenBoardI18n.locale);
  return (!query || text.includes(query)) && (!state.label || cardLabels(card).includes(state.label)) &&
    (!state.assignee || (state.assignee === '__none' ? !assignmentNames(card).length : assignmentNames(card).includes(state.assignee))) &&
    (!state.priority || (card.priority || 'normal') === state.priority) &&
    (!state.milestone || card.milestone_key === state.milestone) && (!state.customKey || customFilterMatches(card)) &&
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
  $('card-summary').textContent = hasFilters()
    ? OpenBoardI18n.count('{shown} di {count} scheda','{shown} di {count} schede',cards.length,{shown:OpenBoardI18n.number(cards.filter(matches).length)})
    : `${OpenBoardI18n.count('{count} scheda','{count} schede',cards.length)} · ${OpenBoardI18n.count('{count} completata','{count} completate',cards.filter((card) => card.completed).length)}`;
  $('clear-filters').classList.toggle('selected',!hasFilters());
  ['label','assignee','priority','status'].forEach((key) => $(`${key}-filter`).classList.toggle('filter-active',!!state[key]));
  ['board','list','calendar','stats','table','timeline'].forEach((view) => { const button = $(`view-${view}`); button.classList.toggle('selected',state.view === view); button.setAttribute('aria-pressed',String(state.view === view)); });
}
function dueDate(card) {
  if (!card.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(card.due_date)) return '';
  const date = new Date(`${card.due_date}T12:00:00`);
  const status = card.completed ? 'done' : overdue(card) ? 'overdue' : card.due_date === todayISO() ? 'soon' : '';
  return ui`<span class="card-due ${status}" title="Scadenza: ${escapeHTML(card.due_date)}${overdue(card) ? tr(' · Scaduta') : ''}">${icon(card.completed ? 'check-circle' : 'calendar')}${escapeHTML(date.toLocaleDateString(OpenBoardI18n.locale,{day:'numeric',month:'short'}))}</span>`;
}
function checklistBadge(card) {
  const total = card.checklist_total ?? (card.checklist || []).length;
  const done = card.checklist_done ?? (card.checklist || []).filter((item) => item.done).length;
  return total ? ui`<span class="checklist-count ${total === done ? 'complete' : ''}" aria-label="${done} di ${total} attività completate">${icon('check-square')}${done}/${total}</span>` : '';
}
function completionButton(card) { return ui`<button class="completion-button ${card.completed ? 'is-completed' : ''}" data-complete-card="${Number(card.id)}" type="button" data-write aria-label="${escapeHTML(card.completed ? tr`Riapri scheda: ${card.title}` : tr`Completa scheda: ${card.title}`)}">${icon(card.completed ? 'check-circle' : 'circle')}</button>`; }
function labelBadges(card) { return cardLabels(card).map((label) => ui`<span class="card-label label-${label}">${escapeHTML(labels[label])}</span>`).join(''); }
function priorityBadge(card) { const priority = card.priority || 'normal'; return priority !== 'normal' ? ui`<span class="priority-badge priority-${priority}">${escapeHTML(priorities[priority])}</span>` : ''; }
function selectionCheckbox(card) { return state.selectionMode ? ui`<label class="card-selection"><input type="checkbox" data-select-card="${Number(card.id)}" ${state.selectedCards.has(card.id) ? 'checked' : ''} aria-label="Seleziona scheda: ${escapeHTML(card.title)}">Seleziona</label>` : ''; }
function blockedBadge(card) { return card.blocked_reason ? ui`<span class="blocked-badge" title="${escapeHTML(card.blocked_reason)}">Bloccata</span>` : ''; }
function renderCard(card) {
  const cover = covers.includes(card.cover) && card.cover ? ui`<div class="card-cover cover-${card.cover}" aria-hidden="true"><span class="cover-shape"></span><span class="cover-detail"></span></div>` : '';
  const description = card.description_preview || card.description;
  return ui`<article class="task-card ${card.completed ? 'completed' : ''}" tabindex="${state.selectionMode ? -1 : 0}" role="${state.selectionMode ? 'group' : 'button'}" aria-label="${state.selectionMode ? tr('Scheda') : tr('Apri scheda')}: ${escapeHTML(card.title)}" draggable="${canWrite()}" data-card-id="${Number(card.id)}" data-column-id="${Number(card.column_id)}">${cover}<div class="card-body">${selectionCheckbox(card)}<div class="card-tags">${labelBadges(card)}${priorityBadge(card)}${blockedBadge(card)}${planningBadges(card)}${card.archived ? ui`<span class="priority-badge">Archiviata</span>` : ''}</div><h3>${escapeHTML(card.title)}</h3>${description ? ui`<p class="card-description">${escapeHTML(description)}</p>` : ''}<div class="card-footer">${completionButton(card)}${dueDate(card)}${checklistBadge(card)}${assignmentNames(card).length ? ui`<span class="card-assignee">${assignmentNames(card).slice(0,3).map(avatar).join('')}</span>` : ''}</div></div></article>`;
}
function renderColumn(column) {
  const cards = sorted(column.cards);
  const wip = Number(column.wip_limit) || 0;
  const work = column.cards.filter((card) => !card.completed && !card.archived).length;
  return ui`<section class="kanban-column" aria-label="Lista ${escapeHTML(column.title)}"><div class="column-heading"><span class="column-dot"></span><h2>${escapeHTML(column.title)}</h2><span class="column-count ${wip && work >= wip ? 'at-limit' : ''}" title="${wip ? 'WIP: '+work+'/'+wip : tr('Schede nella lista')}">${cards.length}${wip ? ' / '+wip : ''}</span><details class="dropdown"><summary class="icon-button" aria-label="Opzioni lista ${escapeHTML(column.title)}">${icon('more')}</summary><div class="dropdown-menu"><button type="button" data-edit-column="${Number(column.id)}" data-write>${icon('edit')}Modifica, WIP e ordine</button><button type="button" data-shift-column="${Number(column.id)}" data-shift="-1" data-write>← Sposta a sinistra</button><button type="button" data-shift-column="${Number(column.id)}" data-shift="1" data-write>Sposta a destra →</button><button type="button" class="danger" data-delete-column="${Number(column.id)}" data-write>${icon('trash')}Sposta nel cestino</button></div></details></div><div class="column-cards" data-drop-column="${Number(column.id)}">${cards.length ? cards.map(renderCard).join('') : ui`<div class="empty-column">Nessuna scheda da mostrare.</div>`}</div><button class="add-card-button" type="button" data-add-card="${Number(column.id)}" data-write>${icon('plus')}Aggiungi una scheda</button></section>`;
}
function renderList() {
  return ui`<div class="list-view"><div class="list-header"><span>Scheda</span><span>Etichette e priorità</span><span>Scadenza</span><span>Responsabile</span></div>${state.board.columns.map((column) => ui`<div class="list-group-title"><span class="column-dot"></span>${escapeHTML(column.title)}<span>${sorted(column.cards).length}</span><button class="icon-button tiny" type="button" data-add-card="${Number(column.id)}" aria-label="Aggiungi scheda in ${escapeHTML(column.title)}" data-write>${icon('plus')}</button></div>${sorted(column.cards).map((card) => ui`<article class="list-row ${card.completed ? 'completed' : ''}" data-card-id="${Number(card.id)}" tabindex="${state.selectionMode ? -1 : 0}" role="${state.selectionMode ? 'group' : 'button'}" aria-label="${state.selectionMode ? tr('Scheda') : tr('Apri scheda')}: ${escapeHTML(card.title)}"><div class="list-row-title">${selectionCheckbox(card)}${completionButton(card)}<h3>${escapeHTML(card.title)}</h3></div><div class="card-tags">${labelBadges(card)}${priorityBadge(card)}${blockedBadge(card)}</div><div>${dueDate(card) || '—'}</div><div class="list-assignee">${assignmentNames(card).length ? `${avatar(assignmentNames(card)[0])}${escapeHTML(assignmentNames(card).join(', '))}` : tr('Non assegnata')}</div></article>`).join('')}`).join('')}<div class="list-add-row"><button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div></div>`;
}
function renderCalendarAgenda() {
  const cards = allCards().filter(matches);
  const dates = [...new Set(cards.map((card) => card.due_date || ''))].sort((a,b) => (a || '9999').localeCompare(b || '9999'));
  return ui`<div class="calendar-view">${dates.length ? dates.map((date) => ui`<section class="calendar-day"><h2>${date ? escapeHTML(new Date(`${date}T12:00:00`).toLocaleDateString(OpenBoardI18n.locale,{weekday:'long',day:'numeric',month:'long',year:'numeric'})) : tr('Senza scadenza')}</h2>${cards.filter((card) => (card.due_date || '') === date).map(renderCard).join('')}</section>`).join('') : ui`<p>Nessuna scheda con questi filtri.</p>`}</div>`;
}
async function renderStats() {
  const context = sessionContext(), boardId = state.board?.id;
  if (!boardId) return;
  try {
    const result = await api(`/api/boards/${boardId}/stats`);
    if (!sessionCurrent(context) || state.view !== 'stats' || state.board?.id !== boardId) return;
    const stats = result.stats || result;
    const groups = (value) => Array.isArray(value) ? value.map((item) => [item.label || item.assignee || item.name || tr('Non assegnata'),item.count ?? item.total ?? 0]) : Object.entries(value || {});
    $('board-canvas').innerHTML = ui`<div class="dashboard"><div class="stat-grid"><div><strong>${Number(stats.total)||0}</strong><span>Schede totali</span></div><div><strong>${Number(stats.completed)||0}</strong><span>Completate</span></div><div><strong>${Number(stats.overdue)||0}</strong><span>Scadute</span></div><div><strong>${Math.round((stats.completed||0)/Math.max(stats.total||0,1)*100)}%</strong><span>Completamento</span></div></div>${[[tr('Etichette'),stats.by_label],[tr('Responsabili'),stats.by_assignee]].map(([title,value]) => ui`<section class="stats-group"><h2>${title}</h2>${groups(value).map(([name,count]) => ui`<div class="stat-line"><span>${escapeHTML(labels[name] || name || tr('Non assegnata'))}</span><meter min="0" max="${Math.max(stats.total||0,1)}" value="${Number(count)||0}">${Number(count)||0}</meter><strong>${Number(count)||0}</strong></div>`).join('') || ui`<p>Nessun dato disponibile.</p>`}</section>`).join('')}</div>`;
  } catch (error) { if (sessionCurrent(context) && !error.staleSession && state.view === 'stats' && state.board?.id === boardId) $('board-canvas').innerHTML = ui`<div class="canvas-message"><h2>Statistiche non disponibili</h2><p>${escapeHTML(error.message)}</p></div>`; }
}
function renderBoard() {
  const focusedCard = document.activeElement?.closest?.('[data-card-id]')?.dataset.cardId;
  if (!state.board) $('board-canvas').innerHTML = ui`<div class="canvas-message"><span class="message-icon">${icon('spark')}</span><h2>Le grandi idee iniziano qui.</h2><p>Crea una bacheca per organizzare il lavoro del team.</p><button class="button primary" type="button" data-create-board data-write>${icon('plus')}Crea una bacheca</button></div>`;
  else if (state.view === 'stats') { $('board-canvas').innerHTML = ui`<div class="initial-loading"><span class="spinner"></span>Calcolo statistiche…</div>`; renderStats(); }
  else if (state.view === 'calendar') $('board-canvas').innerHTML = renderCalendar();
  else if (state.view === 'table') $('board-canvas').innerHTML = renderTable();
  else if (state.view === 'timeline') { $('board-canvas').innerHTML = renderTimeline(); timelineAfterRender(); }
  else if (state.view === 'list') $('board-canvas').innerHTML = renderList();
  else $('board-canvas').innerHTML = ui`<div class="kanban-board">${state.board.columns.map(renderColumn).join('')}<button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div>`;
  updateSelection(); updateFilters(); updateBusy();
  if (focusedCard) $('board-canvas').querySelector(`[data-card-id="${Number(focusedCard)}"]`)?.focus({preventScroll:true});
}
function route(boardId, cardId = null, replace = false) {
  const hash = boardId ? `#board/${Number(boardId)}${cardId ? '/card/'+Number(cardId) : ''}` : '#';
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null,'',hash);
}
function currentRoute() { const match = location.hash.match(/^#board\/(\d+)(?:\/card\/(\d+))?$/); return match ? {boardId:Number(match[1]),cardId:Number(match[2]) || null} : {}; }
async function selectBoard(id, {quiet = false,reset = true,navigate = true} = {}) {
  const context = sessionContext();
  const sequence = ++state.loadSequence;
  if (!quiet) { state.loading = true; updateBusy(); $('board-canvas').innerHTML = ui`<div class="initial-loading"><span class="spinner"></span>Prepariamo il tuo spazio…</div>`; }
  try {
    const result = await api(`/api/boards/${Number(id)}?summary=1${state.archived || state.archivedBoards ? '&include_archived=1' : ''}`);
    if (!sessionCurrent(context) || sequence !== state.loadSequence) return;
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
    if (!sessionCurrent(context) || error.staleSession || sequence !== state.loadSequence) return;
    state.loading = false;
    if (quiet) throw error;
    showLoadError(error);
  } finally { if (sessionCurrent(context) && sequence === state.loadSequence) updateBusy(); }
}
function showLoadError(error) {
  state.loadError = true;
  $('board-canvas').innerHTML = ui`<div class="canvas-message"><span class="message-icon">${icon('alert-circle')}</span><h2>La bacheca non è disponibile.</h2><p>${escapeHTML(error.message)}</p><button class="button primary" id="retry-load" type="button">${icon('refresh')}Riprova</button></div>`;
  updateBusy();
}
async function loadCatalog() {
  const context = sessionContext();
  const catalog = productivity.catalog(await api('/api/catalog'));
  if (!sessionCurrent(context)) return;
  for (const object of [labels,priorities,fieldTypes]) for (const key of Object.keys(object)) delete object[key];
  const localized = (values,known) => Object.fromEntries(Object.entries(values).map(([key,name]) => [key,known[key] || name]));
  Object.assign(labels,localized(catalog.labels,{design:tr('Design'),sviluppo:tr('Sviluppo'),ricerca:tr('Ricerca'),marketing:tr('Marketing'),urgente:tr('Urgente')}));
  Object.assign(priorities,localized(catalog.priorities,{low:tr('Bassa'),normal:tr('Normale'),high:tr('Alta'),urgent:tr('Urgente')}));
  Object.assign(fieldTypes,localized(catalog.fieldTypes,{text:tr('Testo'),number:tr('Numero'),date:tr('Data'),boolean:tr('Sì/No'),select:tr('Scelta')}));
  covers.splice(0,covers.length,...catalog.covers);
  const options = (values) => Object.entries(values).map(([key,name]) => ui`<option value="${escapeHTML(key)}">${escapeHTML(name)}</option>`).join('');
  $('label-filter').innerHTML = ui`<option value="">Etichette</option>`+options(labels);
  $('card-label').innerHTML = ui`<option value="">Nessuna etichetta</option>`+options(labels);
  $('priority-filter').innerHTML = ui`<option value="">Tutte</option>`+options(priorities);
  $('card-priority').innerHTML = options(priorities);
  $('card-extra-labels').innerHTML = ui`<legend class="field-label">Etichette aggiuntive</legend>`+Object.entries(labels).map(([key,name]) => ui`<label><input type="checkbox" name="extra-label" value="${escapeHTML(key)}">${escapeHTML(name)}</label>`).join('');
  $('cover-options').innerHTML = covers.map((cover) => ui`<button type="button" data-cover="${escapeHTML(cover)}" class="cover-swatch ${cover ? 'swatch-'+escapeHTML(cover) : 'no-cover'}" aria-label="${cover ? escapeHTML(tr`Copertina ${coverLabel(cover)}`) : tr('Nessuna copertina')}" aria-pressed="${String(!cover)}">${cover ? '' : icon('close')}</button>`).join('');
}
async function loadStorageLabel() {
  if (state.versionRequested) return;
  state.versionRequested = true;
  try { const version = await api('/api/version'); state.storageLabel = productivity.storageLabel(version.storage); }
  catch (error) { state.storageLabel = ''; if (error.staleSession) { state.versionRequested = false; loadStorageLabel(); } }
  finally { updateBusy(); }
}
async function loadInitial() {
  loadStorageLabel();
  let context = sessionContext();
  state.loading = true; updateBusy();
  try {
    const session = await api('/api/auth/session');
    if (!sessionCurrent(context)) return;
    setSession(session); context = sessionContext();
    if (state.auth.enabled && !state.auth.user) { state.loading = false; showAuth(state.auth.setup_required); return; }
    await loadCatalog();
    if (!sessionCurrent(context)) return;
    await refreshBoards();
    if (!sessionCurrent(context)) return;
    refreshNotifications();
    const requested = currentRoute();
    const fallback = state.boards.find((board) => board.id === Number(stored('board'))) || state.boards[0];
    const selectedId = requested.boardId || fallback?.id;
    if (selectedId) {
      await selectBoard(selectedId,{navigate:!requested.boardId});
      if (!sessionCurrent(context)) return;
      if (requested.cardId && state.board?.id === requested.boardId && !state.loadError) await openCard(requested.cardId,null,{navigate:false});
    } else { state.board = null; state.loading = false; renderSidebar(); renderHeader(); renderBoard(); }
  } catch (error) { if (sessionCurrent(context) && !error.staleSession) { state.loading = false; showLoadError(error); } }
  finally { if (sessionCurrent(context)) updateBusy(); }
}
async function refreshBoard() { if (state.board) await selectBoard(state.board.id,{quiet:true,reset:false,navigate:false}); }
async function refreshBoards() { const context = sessionContext(); const result = await api(`/api/boards${state.archivedBoards ? '?include_archived=1' : ''}`); if (!sessionCurrent(context)) return; state.boards = result.boards || []; renderSidebar(); }
function clearFilters(render = true) {
  ['query','label','assignee','priority','status'].forEach((key) => { state[key] = ''; }); state.sort = 'manual';
  state.milestone = ''; state.customKey = ''; state.customQuery = ''; state.customOp = ''; renderPlanningFilters();
  $('search-input').value = ''; ['label','assignee','priority','status'].forEach((key) => { $(`${key}-filter`).value = ''; }); $('sort-filter').value = 'manual';
  if (render) renderBoard();
}
function closeMenus() { document.querySelectorAll('.dropdown[open]').forEach((details) => { details.open = false; }); }
const dialogFocus = new Map();
function openDialog(id) {
  closeMenus();
  if (!$(id).open) { for(const form of $(id).querySelectorAll('form'))clearFormErrors(form);dialogFocus.set(id,document.activeElement); $(id).showModal(); }
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
  if (id === 'card-dialog') {
    const editor = state.cardEditor; if (!editor) return false;
    if (!editor.baseData || typeof OpenBoardConflicts === 'undefined') return cardSnapshot() !== editor.original;
    try {
      const current = JSON.parse(cardSnapshot()), original = JSON.parse(editor.original);
      const auxiliary = value => ({checklist_new:value.checklist_new,comment_body:value.comment_body,worklog:value.worklog});
      return !OpenBoardConflicts.equal(OpenBoardConflicts.snapshot(current.card),cardConflictBaseline(editor.baseData)) || !OpenBoardConflicts.equal(auxiliary(current),auxiliary(original));
    } catch { return true; }
  }
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
  const serialized = JSON.stringify({data:cardData(),version:editor.version,base_data:editor.baseData || null,base_version:editor.baseVersion || null,pending:editor.pending,pendingAmbiguous:!!editor.pendingAmbiguous,checklist_new:$('checklist-new').value,comment_body:$('comment-body').value,worklog:pendingWorklog(),updated_at:Date.now()});
  remember(draftKey(),serialized); editor.writtenDraft = serialized;
}
function cardDraftVersionValid(draft) { return !state.cardEditor?.id || (Number.isSafeInteger(draft?.version) && draft.version > 0); }
function readDraft() {
  try {
    const raw = stored(draftKey(),'null'); if (raw.length > 2*1024*1024) return null;
    const draft = JSON.parse(raw), now = Date.now();
    if (!draft?.data || typeof draft.data !== 'object' || Array.isArray(draft.data) || !cardDraftVersionValid(draft) || !Number.isFinite(draft.updated_at) || draft.updated_at > now+60000 || now-draft.updated_at >= 30*86400000) return null;
    if (typeof OpenBoardConflicts !== 'undefined') OpenBoardConflicts.snapshot(draft.data);
    return draft;
  } catch { return null; }
}
function closeDialog(id, {force = false,navigate = true} = {}) {
  if (id === 'panel-dialog' && state.panel === 'thread') saveReplyDraft();
  if (state.saving && !force) return false;
  if (!force && editorDirty(id) && !confirm(tr('Hai modifiche non salvate. Chiudere l’editor? La bozza della scheda resta disponibile su questo dispositivo.'))) return false;
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
  $('checklist-items').innerHTML = items.map((item,i) => ui`<div class="checklist-item ${item.done ? 'done' : ''}"><input type="checkbox" data-checklist-toggle="${i}" ${item.done ? 'checked' : ''} aria-label="Completa: ${escapeHTML(item.text || tr('Attività'))}"><input type="text" data-checklist-text="${i}" value="${escapeHTML(item.text)}" maxlength="300" required aria-label="Testo attività ${i+1}"><button class="icon-button" type="button" data-checklist-remove="${i}" aria-label="Elimina attività ${i+1}">${icon('close')}</button></div>`).join('');
  updateChecklistProgress();
  if (index !== undefined) { const next = document.querySelector(`[data-checklist-text="${Math.min(Number(index),items.length-1)}"]`); if (next) { next.focus(); next.setSelectionRange(...selection); } }
}
function updateChecklistProgress() { const items = state.cardEditor.checklist; $('checklist-progress').textContent = items.length ? tr`${items.filter((item) => item.done).length} di ${items.length} completate` : ''; }
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
    if (card && !state.board.columns.some((column) => column.id === card.column_id)) throw new APIError(tr('Questa scheda appartiene a un’altra bacheca. Aprila dalla ricerca globale.'));
    const editor=state.cardEditor = {id:card?.id || null,version:card?.version,cover:card?.cover || '',checklist:[],archived:!!card?.archived,pending:null,persistedMilestone:card?.milestone_key || '',baseData:card && typeof OpenBoardConflicts !== 'undefined' ? OpenBoardConflicts.snapshot(card):null,baseVersion:card?.version || null};
    $('card-form').reset();
    $('card-dialog-context').textContent = card ? tr('DETTAGLI DELLA SCHEDA') : tr('UNA NUOVA IDEA');
    $('card-column').innerHTML = state.board.columns.map((column) => ui`<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
    fillCard(card || {column_id:columnId || state.board.columns[0].id});
    $('delete-card').hidden = !card;
    ['move-card','duplicate-card','archive-card'].forEach((id) => { $(id).hidden = !card; });
    $('archive-card').textContent = card?.archived ? tr('Ripristina') : tr('Archivia');
    $('comments-section').hidden = !card;
    $('comments-list').innerHTML = '';
    $('save-card').innerHTML = `${card ? tr('Salva modifiche') : tr('Crea scheda')}${icon('arrow-right')}`;
    $('card-form-error').textContent = ''; $('conflict-notice').hidden = true;
    state.cardEditor.original = cardSnapshot();
    $('draft-notice').hidden = !readDraft();
    openDialog('card-dialog'); $('card-title').focus();
    if (navigate && cardId) route(state.board.id,cardId);
    loadProductivityCard(cardId,boardId,sequence);
    if (cardId) loadComments(cardId);
    return editor;
  } catch (error) { if (!error.staleSession) toast(error.message,true); }
}
function boardData() { return {name:$('board-name').value.trim(),description:$('board-description-input').value.trim(),color:$('board-color').value}; }
function columnData() { return {title:$('column-title').value.trim(),wip_limit:Number($('column-wip').value)||0,position:Math.max(0,Number($('column-position').value)-1)}; }
function openBoardEditor(board = null) {
  if (state.saving || state.loading || !(board ? canWrite() : canCreateBoard())) return;
  state.boardRequest = {};
  state.boardEditor = board ? {...board} : null;
  $('board-form').reset(); $('board-dialog-context').textContent = board ? tr('LA TUA BACHECA') : tr('NUOVA BACHECA');
  $('board-dialog-heading').textContent = board ? tr('Diamo forma al tuo progetto.') : tr('Spazio a un nuovo progetto.');
  $('board-name').value = board?.name || ''; $('board-description-input').value = board?.description || '';
  $('board-color').value = covers.includes(board?.color) && board.color ? board.color : 'sage';
  $('delete-board').hidden = !board; $('save-board').innerHTML = `${board ? tr('Salva modifiche') : tr('Crea bacheca')}${icon('arrow-right')}`;
  $('board-form-error').textContent = ''; state.boardOriginal = JSON.stringify(boardData());
  $('boards-dialog').close(); openDialog('board-dialog'); $('board-name').focus();
}
function openColumnEditor(columnId = null) {
  if (state.saving || state.loading || !state.board || !canWrite()) return;
  const column = state.board.columns.find((item) => item.id === Number(columnId));
  state.columnRequest = {};
  state.columnEditor = column ? {...column} : null;
  $('column-form').reset(); $('column-dialog-context').textContent = column ? tr('MODIFICA LISTA') : tr('NUOVA LISTA');
  $('column-dialog-heading').textContent = column ? tr('Ogni fase ha il suo nome.') : tr('Un posto per il prossimo passo.');
  $('column-title').value = column?.title || ''; $('column-wip').value = column?.wip_limit || 0;
  $('column-position').value = column ? state.board.columns.findIndex((item) => item.id === column.id)+1 : state.board.columns.length+1;
  $('column-position').max = state.board.columns.length+(column ? 0 : 1);
  $('delete-column').hidden = !column; $('save-column').innerHTML = `${column ? tr('Salva modifiche') : tr('Crea lista')}${icon('arrow-right')}`;
  $('column-form-error').textContent = ''; state.columnOriginal = JSON.stringify(columnData());
  openDialog('column-dialog'); $('column-title').focus();
}
function deleteColumn(columnId) {
  const column = state.board?.columns.find((item) => item.id === Number(columnId));
  if (!column || !confirm(tr`Spostare la lista “${column.title}” e le sue schede nel cestino? Potrai ripristinarle.`)) return;
  perform(() => committed(async () => { await api(`/api/columns/${column.id}`,'DELETE',undefined,{version:column.version}); closeDialog('column-dialog',{force:true}); },refreshBoard,tr('Lista spostata nel cestino.')),'','column-form-error');
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
  } catch (error) { if (!error.staleSession && current()) $('comments-list').textContent = error.message; }
}
function formatDate(value) { if (!value) return ''; const date = new Date(String(value).includes('T') ? value : String(value).replace(' ','T')+'Z'); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(OpenBoardI18n.locale); }
function panel(title, body, kind = null) {
  if (state.panel === 'thread') saveReplyDraft();
  state.panelSequence = (state.panelSequence || 0)+1; state.panel = kind; $('panel-heading').textContent = title; $('panel-body').innerHTML = body; hydrateIcons($('panel-body')); openDialog('panel-dialog');
}
async function showPanel(title, loader, kind) {
  panel(title,ui`<p class="helper-text">Caricamento…</p>`,kind);
  const sequence = state.panelSequence;
  try { const body = await loader(); if (state.panel === kind && state.panelSequence === sequence && $('panel-dialog').open) { $('panel-body').innerHTML = body; hydrateIcons($('panel-body')); updateBusy(); } }
  catch (error) { if (!error.staleSession && state.panel === kind && state.panelSequence === sequence) $('panel-body').innerHTML = ui`<p class="form-error" role="alert">${escapeHTML(error.message)}</p>`; }
}
function showAuth(setup) {
  $('auth-heading').textContent = setup ? tr('Crea il primo amministratore') : tr('Accedi a OpenBoard');
  $('auth-description').textContent = setup ? tr('Configura l’account che gestirà utenti e permessi.') : tr('Accedi al workspace con le tue credenziali.');
  $('auth-name-label').hidden = !setup; $('auth-name').hidden = !setup; $('auth-name').required = !!setup;
  $('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('auth-submit').textContent = setup ? tr('Configura workspace') : tr('Accedi'); $('auth-error').textContent = '';
  state.setup = !!setup; openDialog('auth-dialog'); (setup ? $('auth-name') : $('auth-username')).focus();
}
function showAccount() {
  const user = state.auth?.user;
  panel(tr('Account e preferenze'),ui`<p>${user ? ui`<strong>${escapeHTML(user.name)}</strong> · ${escapeHTML(user.username)} · ${escapeHTML(roleLabel(user.role))}` : tr('Modalità locale: autenticazione disattivata sul server.')}</p><div class="personal-tools"><button type="button" class="button secondary" data-show-drafts>Bozze delle schede</button><button type="button" class="button secondary" data-show-commands>Comandi</button>${canInspectStorage() ? ui`<button type="button" class="button secondary" data-show-storage>Capacità e conservazione</button>` : ''}</div><div class="preferences"><label class="field-label" for="theme-setting">Tema</label><select id="theme-setting"><option value="light">Chiaro</option><option value="dark">Scuro</option></select><label class="field-label" for="density-setting">Densità delle schede</label><select id="density-setting"><option value="comfortable">Comoda</option><option value="compact">Compatta</option></select></div>${user ? ui`<form id="profile-form"><h3>Il tuo profilo</h3><label class="field-label" for="profile-name">Nome visualizzato</label><input id="profile-name" required maxlength="100" value="${escapeHTML(user.name)}"><button class="button secondary" type="submit">Salva nome</button></form><button id="manage-sessions" class="button secondary" type="button">Sessioni attive</button><form id="password-form"><h3>Cambia password</h3><label class="field-label" for="current-password">Password attuale</label><input id="current-password" type="password" required autocomplete="current-password"><label class="field-label" for="new-password">Nuova password (almeno 12 caratteri)</label><input id="new-password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"><button class="button secondary" type="submit">Aggiorna password</button></form>${user.role === 'admin' ? ui`<button id="manage-users" class="button secondary" type="button">Gestisci utenti</button>` : ''}<button id="logout" class="button danger-subtle" type="button">Esci dall’account</button>` : ''}<p id="panel-error" class="form-error" role="alert"></p>`,'account');
  $('theme-setting').value = stored('theme','light'); $('density-setting').value = stored('density','comfortable');
}
async function showUsers() {
  await showPanel(tr('Utenti del workspace'),async () => {
    const result = await api('/api/users');
    return ui`<div class="user-list">${(result.users || []).map((user) => ui`<form class="user-row" data-user-form="${Number(user.id)}"><div><strong>${escapeHTML(user.name)}</strong><span>@${escapeHTML(user.username)} · ID ${Number(user.id)}</span></div><label><span class="sr-only">Ruolo di ${escapeHTML(user.name)}</span><select name="role">${['admin','member','observer'].map((role) => ui`<option value="${role}" ${user.role === role ? 'selected' : ''}>${({admin:tr('Amministratore'),member:tr('Membro'),observer:tr('Osservatore')})[role]}</option>`).join('')}</select></label><label class="inline-check"><input name="active" type="checkbox" ${user.active ? 'checked' : ''}>Attivo</label><button class="button secondary" type="submit" data-manage>Salva</button></form>`).join('')}</div><form id="create-user-form"><h3>Aggiungi un utente</h3><label class="field-label" for="user-name">Nome</label><input id="user-name" required maxlength="100"><label class="field-label" for="user-username">Nome utente</label><input id="user-username" required minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]+" autocomplete="off"><label class="field-label" for="user-password">Password iniziale (almeno 12 caratteri)</label><input id="user-password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"><label class="field-label" for="user-role">Ruolo globale</label><select id="user-role"><option value="member">Membro</option><option value="observer">Osservatore</option><option value="admin">Amministratore</option></select><button class="button primary" type="submit" data-manage>Crea utente</button></form><p id="panel-error" class="form-error" role="alert"></p>`;
  },'users');
}
async function showMembers() {
  if (!state.auth?.enabled) { panel(tr('Membri e permessi'),ui`<p>Il server è in modalità locale. Abilita l’autenticazione nella configurazione del server per usare account, ruoli e membri delle bacheche.</p>`,'members'); return; }
  await showPanel(tr('Membri della bacheca'),async () => {
    const result = await api(`/api/boards/${state.board.id}/members`);
    let users = [];
    if (state.auth.user?.role === 'admin') users = (await api('/api/users')).users || [];
    return ui`<p>Gli osservatori possono leggere; i membri modificano le schede; gli amministratori gestiscono i permessi.</p><div class="member-list">${(result.members || []).map((member) => ui`<div class="member-row"><div><strong>${escapeHTML(member.name)}</strong><span>@${escapeHTML(member.username)} · ID ${Number(member.user_id)}</span></div><span>${escapeHTML(({admin:tr('Amministratore'),member:tr('Membro'),observer:tr('Osservatore')})[member.role] || member.role)}</span>${canManage() ? ui`<button class="button danger-subtle" type="button" data-remove-member="${Number(member.user_id)}" data-manage>Rimuovi</button>` : ''}</div>`).join('') || ui`<p>Nessun membro esplicito.</p>`}</div>${canManage() ? ui`<form id="member-form"><h3>Aggiungi o aggiorna un membro</h3><label class="field-label" for="member-user">Utente ${users.length ? '' : tr('(ID numerico)')}</label>${users.length ? ui`<select id="member-user">${users.filter((user) => user.active).map((user) => ui`<option value="${Number(user.id)}">${escapeHTML(user.name)} · @${escapeHTML(user.username)}</option>`).join('')}</select>` : ui`<input id="member-user" type="number" min="1" required>`}<label class="field-label" for="member-role">Ruolo nella bacheca</label><select id="member-role"><option value="member">Membro</option><option value="observer">Osservatore</option><option value="admin">Amministratore</option></select><button class="button primary" type="submit" data-manage>Salva membro</button></form>` : ''}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'members');
}
async function showActivity(before = null,append = false) { return showActivityPage(before,append); }
async function showTrash() {
  await showPanel(tr('Cestino'),async () => {
    const result = await api('/api/trash');
    return ui`<p>Ripristina gli elementi eliminati. Liste e schede tornano nella loro bacheca.</p><div class="trash-list">${(result.items || []).map((item) => ui`<div class="trash-row"><div><strong>${escapeHTML(item.title || item.name)}</strong><span>${escapeHTML(({boards:tr('Bacheca'),columns:tr('Lista'),cards:tr('Scheda')})[item.kind] || item.kind)} · ${escapeHTML(formatDate(item.deleted_at))}</span></div><button class="button secondary" type="button" data-restore-kind="${escapeHTML(item.kind)}" data-restore-id="${Number(item.id)}" data-write>Ripristina</button></div>`).join('') || ui`<p>Il cestino è vuoto.</p>`}</div><p id="panel-error" class="form-error" role="alert"></p>`;
  },'trash');
}
function showImport() {
  if (state.saving || !canCreateBoard()) return;
  state.importSequence = (state.importSequence || 0)+1;
  state.importData = null; state.importKey = null; state.importSource = null; state.importContext = null;
  panel(tr('Importa una bacheca'),ui`<p>L’importazione crea una nuova bacheca dopo la conferma. Seleziona il formato e controlla l’anteprima.</p><label class="field-label" for="import-format">Formato del file</label><select id="import-format" data-product-create><option value="openboard">OpenBoard JSON</option><option value="trello">Trello JSON</option><option value="csv">CSV</option></select><label class="field-label" for="import-file">File da importare (massimo 2 MiB)</label><input id="import-file" type="file" accept=".json,application/json" data-product-create><div id="csv-import-options" hidden><label class="field-label" for="csv-import-name">Nome della nuova bacheca</label><input id="csv-import-name" maxlength="200" required value="${escapeHTML(tr('Bacheca importata'))}" data-product-create><label class="field-label" for="csv-import-delimiter">Separatore CSV</label><select id="csv-import-delimiter" data-product-create><option value=",">Virgola</option><option value=";">Punto e virgola</option></select><label><input id="csv-import-header" type="checkbox" checked data-product-create> La prima riga contiene intestazioni</label><div id="csv-import-mapping"></div></div><div id="import-preview" aria-live="polite"></div><p id="panel-error" class="form-error" role="alert"></p>`,'import');
  updateBusy();
}
function importFormat() { return $('import-format')?.value || 'openboard'; }
function importCurrent(context) {
  return !!context && sessionCurrent(context) && context.sequence === state.importSequence &&
    context.panelSequence === state.panelSequence && state.panel === 'import' &&
    $('panel-dialog').open && !!$('import-preview') && canCreateBoard();
}
function clearImportPreview() {
  state.importData = null; state.importKey = null; state.importContext = null;
  if ($('import-preview')) $('import-preview').innerHTML = '';
  if ($('panel-error')) $('panel-error').textContent = '';
}
function changeImportFormat() {
  if (state.saving || state.panel !== 'import' || !canCreateBoard()) return;
  state.importSequence = (state.importSequence || 0)+1;
  clearImportPreview(); state.importSource = null;
  $('import-file').value = '';
  $('import-file').accept = importFormat() === 'csv' ? '.csv,text/csv' : '.json,application/json';
  $('csv-import-options').hidden = importFormat() !== 'csv';
  $('csv-import-mapping').innerHTML = '';
  updateBusy();
}
function importCSVOptions() {
  const mapping = {};
  for (const key of OpenBoardImporters.fields) {
    const value = $('csv-map-'+key)?.value;
    if (value !== undefined && value !== '') mapping[key] = Number(value);
  }
  return {name:$('csv-import-name').value,delimiter:$('csv-import-delimiter').value || ',',
    header:$('csv-import-header').checked,mapping,defaultList:tr('Importate')};
}
function renderCSVMapping() {
  clearImportPreview(); $('csv-import-mapping').innerHTML = '';
  const source = state.importSource;
  if (!source || source.format !== 'csv' || !importCurrent(source.context)) return;
  try {
    const options = {delimiter:$('csv-import-delimiter').value || ',',header:$('csv-import-header').checked};
    const csv = OpenBoardImporters.inspectCSV(source.text,options);
    const names = {title:tr('Titolo (obbligatorio)'),list:tr('Lista'),description:tr('Descrizione'),
      due_date:tr('Scadenza (YYYY-MM-DD)'),priority:tr('Priorità (low, normal, high, urgent)'),
      assignee:tr('Responsabile (testo)'),estimate_minutes:tr('Stima in minuti')};
    $('csv-import-mapping').innerHTML = ui`<p>Ogni riga crea una scheda. Seleziona le colonne da importare e prepara l’anteprima.</p><p>${csv.rowCount} righe · ${csv.width} colonne CSV</p>${OpenBoardImporters.fields.map(key=>ui`<label class="field-label" for="csv-map-${key}">${escapeHTML(names[key])}</label><select id="csv-map-${key}" data-import-mapping="${key}" data-product-create><option value="">Non importare</option>${csv.headers.map((header,index)=>ui`<option value="${index}" ${key === 'title' && index === 0 ? 'selected' : ''}>${index+1}: ${escapeHTML(header)}</option>`).join('')}</select>`).join('')}<button id="prepare-csv-import" class="button secondary" type="button" data-product-create>Prepara anteprima CSV</button>`;
    updateBusy();
  } catch (error) { if (importCurrent(source.context)) $('panel-error').textContent = tr(error.message); }
}
function importPreview(result,context) {
  if (!importCurrent(context)) return;
  const data = result.data;
  if (!data || data.format !== 'openboard' || data.version !== 2 || !data.board ||
      typeof data.board !== 'object' || Array.isArray(data.board) || !Array.isArray(data.board.columns))
    throw new Error(tr('Serve un’esportazione OpenBoard in formato versione 2.'));
  if (new TextEncoder().encode(JSON.stringify(data)).length > 2*1024*1024) throw new Error(tr('Il file supera il limite di 2 MB.'));
  const cards = data.board.columns.reduce((sum,column) => sum+(Array.isArray(column?.cards) ? column.cards.length : 0),0);
  if (data.board.columns.length>100 || cards>10000) throw new Error(tr('La conversione richiede al massimo 100 liste e 10000 schede.'));
  const same = state.importData && JSON.stringify(state.importData) === JSON.stringify(data);
  state.importKey = same && state.importKey ? state.importKey:uuid();
  state.importData = data; state.importContext = context;
  const fields = Array.isArray(data.board.custom_fields) ? data.board.custom_fields.filter(field=>field && !field.deleted_at).length:0;
  const milestones = Array.isArray(data.board.milestones) ? data.board.milestones.filter(item=>item && !item.deleted_at).length:0;
  const counts = result.counts;
  const warnings = Array.isArray(result.warnings) ? result.warnings:[];
  $('import-preview').innerHTML = ui`<div class="notice"><div><h3>${escapeHTML(data.board.name || tr('Bacheca importata'))}</h3><p>${data.board.columns.length} liste · ${cards} schede · ${fields} campi personalizzati · ${milestones} traguardi</p><p>${escapeHTML(data.board.description || '')}</p>${counts ? ui`<p>${counts.checklistItems} elementi checklist · ${counts.archivedCards} schede archiviate · ${counts.completedCards} schede completate</p>` : ''}${warnings.length ? ui`<h4>Avvisi di conversione</h4><ul>${warnings.map(warning=>ui`<li>${escapeHTML(tr(warning))}</li>`).join('')}</ul>` : ''}</div></div><button id="confirm-import" class="button primary" type="button" data-write>Importa come nuova bacheca</button>`;
  updateBusy();
}
function prepareCSVImport() {
  const source = state.importSource;
  if (state.saving || !source || source.format !== 'csv' || importFormat() !== 'csv' || !importCurrent(source.context)) return;
  $('panel-error').textContent = '';
  try { importPreview(OpenBoardImporters.parseCSV(source.text,importCSVOptions()),source.context); }
  catch (error) { if (importCurrent(source.context)) { clearImportPreview(); $('panel-error').textContent = tr(error.message); } }
}
function confirmImport() {
  const context = state.importContext, data = state.importData, key = state.importKey;
  if (state.saving || state.loading || !data || !key || !importCurrent(context)) return;
  return perform(() => committed(async () => {
    if (!importCurrent(context) || data !== state.importData || key !== state.importKey) throw sessionChangedError();
    try { return await api('/api/import','POST',data,{key}); }
    catch (error) { if (!importCurrent(context)) throw sessionChangedError(); throw error; }
  },async (result) => {
    const current = importCurrent(context);
    if (current) { closeDialog('panel-dialog',{force:true}); state.importSource = null; state.importData = null; state.importContext = null; state.importKey = null; }
    const navigation = current ? {panel:state.panelSequence,load:state.loadSequence,file:state.importSequence}:null;
    const selectedId = result?.id ?? result?.board?.id;
    await refreshBoards();
    if (navigation && sessionCurrent(context) && !state.loading && canCreateBoard() &&
        navigation.panel === state.panelSequence && navigation.load === state.loadSequence &&
        navigation.file === state.importSequence && Number.isSafeInteger(selectedId) && selectedId>0)
      await selectBoard(selectedId,{quiet:true});
  },tr('Bacheca importata.')),'','panel-error');
}
async function previewImport(file) {
  if (state.saving || state.panel !== 'import' || !$('panel-dialog').open || !canCreateBoard()) return;
  const sequence = state.importSequence = (state.importSequence || 0)+1;
  const context = {...sessionContext(),sequence,panelSequence:state.panelSequence};
  const format = importFormat();
  clearImportPreview(); state.importSource = null; $('csv-import-mapping').innerHTML = '';
  if (!file) return;
  try {
    if (file.size > 2*1024*1024) throw new Error(tr('Il file supera il limite di 2 MB.'));
    let buffer;
    try { buffer = await file.arrayBuffer(); }
    catch { throw new Error(tr('Impossibile leggere il file selezionato.')); }
    if (!importCurrent(context)) return;
    if (buffer.byteLength>2*1024*1024) throw new Error(tr('Il file supera il limite di 2 MB.'));
    let text;
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer); }
    catch { throw new Error(tr('Il file non contiene testo UTF-8 valido.')); }
    state.importSource = {text,format,context};
    if (format === 'csv') renderCSVMapping();
    else {
      const data = JSON.parse(text.replace(/^\uFEFF/,''));
      importPreview(format === 'trello' ? OpenBoardImporters.parseTrello(data):{data},context);
    }
  } catch (error) { if (importCurrent(context) && $('panel-error')) { clearImportPreview(); state.importSource = null; $('panel-error').textContent = error instanceof SyntaxError ? tr('Il file non contiene JSON valido.') : tr(error.message); } }
}
function showGlobalSearch() {
  ++globalSearchSequence; clearTimeout(searchTimer);
  state.globalSearch=null;
  panel(tr('Ricerca in tutte le bacheche'),ui`<label class="field-label" for="global-query">Testo da cercare</label><input id="global-query" type="search" maxlength="200" placeholder="Cerca nel workspace…"><label class="field-label" for="global-kind">Contenuti</label><select id="global-kind"><option value="cards">Schede</option><option value="all">Tutti i contenuti collaborativi</option><option value="comment">Commenti e risposte</option><option value="request">Richieste e risposte ai moduli</option><option value="request_note">Note delle richieste</option><option value="form">Moduli interni</option></select><div id="global-results" aria-live="polite"></div>`,'search');
  $('global-query').focus();
}
let globalSearchSequence = 0;
async function globalSearch(query,append=false) {
  if (state.panel !== 'search' || !$('global-results') || !$('panel-dialog').open) return;
  query=query.trim();
  const context = sessionContext();
  const previous=state.globalSearch;
  const kind=$('global-kind')?.value || 'cards',content=kind!=='cards';
  if (append && (!previous || previous.query!==query || previous.kind!==kind || previous.loading || !previous.next || !sessionCurrent(previous.context))) return;
  const sequence = ++globalSearchSequence;
  if (!query) { state.globalSearch=null;$('global-results').innerHTML = ui`<p>Scrivi per cercare le schede a cui hai accesso.</p>`; return; }
  const search=state.globalSearch={query,kind,content,context,cards:append ? [...previous.cards]:[],next:append ? previous.next:null,loading:true};
  if(append){$('global-more')?.setAttribute('aria-disabled','true');$('global-more')?.setAttribute('aria-busy','true');}
  else $('global-results').innerHTML=ui`<p class="helper-text">Caricamento…</p>`;
  try {
    const result = await api(content ? `/api/search/content?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}&limit=30${append ? '&cursor='+encodeURIComponent(search.next):''}` : `/api/search?q=${encodeURIComponent(query)}&limit=30${append ? '&before='+search.next:''}`);
    if (!sessionCurrent(context) || sequence !== globalSearchSequence || state.panel !== 'search' || !$('panel-dialog').open || state.globalSearch!==search) return;
    const key=item=>content ? item.key:item.id,items=content ? result.items || []:result.cards || [];
    const known=new Set(search.cards.map(key));
    const firstNew=items.find(item=>!known.has(key(item)));
    for(const item of items)if(!known.has(key(item))){search.cards.push(item);known.add(key(item));}
    search.next=content ? (typeof result.next_cursor==='string' && /^[0-4]:[1-9]\d{0,18}$/.test(result.next_cursor) ? result.next_cursor:null) : (Number.isSafeInteger(result.next_cursor) && result.next_cursor>0 ? result.next_cursor:null);
    search.loading=false;renderGlobalSearch(firstNew ? key(firstNew):null);
  } catch (error) {
    if (sessionCurrent(context) && !error.staleSession && sequence === globalSearchSequence && state.panel==='search' && state.globalSearch===search) {
      search.loading=false;
      if(append){renderGlobalSearch();toast(error.message,true);}else $('global-results').textContent=error.message;
    }
  }
}
function renderGlobalSearch(firstNewId=null) {
  const search=state.globalSearch;
  if(!search || !sessionCurrent(search.context) || state.panel!=='search')return;
  const moreFocused=document.activeElement?.id==='global-more';
  const focusedCard=search.content ? document.activeElement?.dataset?.searchContent:document.activeElement?.dataset?.searchCard;
  $('global-results').innerHTML = search.cards.map((card) => search.content ? contentSearchRow(card) : ui`<button type="button" class="search-result" data-search-card="${Number(card.id)}" data-search-board="${Number(card.board_id)}"><strong>${escapeHTML(card.title)}</strong><span>${escapeHTML(card.board_name)} / ${escapeHTML(card.column_title)} · ${escapeHTML(priorities[card.priority] || tr('Normale'))}${card.due_date ? ' · '+escapeHTML(card.due_date) : ''}</span></button>`).join('') || ui`<p>Nessun contenuto trovato.</p>`;
  if(search.next)$('global-results').innerHTML+=ui`<button type="button" class="button secondary" id="global-more">Carica altri</button>`;
  const selector=key=>search.content && /^[0-4]:[1-9]\d{0,18}$/.test(String(key)) ? `[data-search-content="${key}"]`:`[data-search-card="${Number(key)}"]`;
  if(moreFocused){const target=search.next ? $('global-more'):$('global-results').querySelector(selector(firstNewId)) || $('global-query');target?.focus();}
  else if(focusedCard)$('global-results').querySelector(selector(focusedCard))?.focus();
}
function contentSearchRow(item) {
  const kinds={card:tr('Scheda'),comment:tr('Commento'),request:tr('Richiesta'),request_note:tr('Nota della richiesta'),form:tr('Modulo')};
  if(!Object.hasOwn(kinds,item.kind) || !/^[0-4]:[1-9]\d{0,18}$/.test(item.key))return '';
  return ui`<button type="button" class="search-result" data-search-content="${escapeHTML(item.key)}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(kinds[item.kind])} · ${escapeHTML(item.board_name)}${item.context ? ' / '+escapeHTML(item.context):''}</span><span class="search-snippet">${escapeHTML(item.snippet || '')}</span></button>`;
}
async function openContentSearchResult(key) {
  const search=state.globalSearch,context=sessionContext();
  const item=search?.content && search.cards.find(row=>row.key===key);
  if(!item || !sessionCurrent(search.context) || !closeEditors())return;
  if(!Number.isSafeInteger(item.board_id) || item.board_id<1)return;
  closeDialog('panel-dialog');
  const sequence=state.panelSequence;
  try {
    const selection=selectBoard(item.board_id),loadSequence=state.loadSequence;
    await selection;
    const current=()=>sessionCurrent(context) && !state.loading && !state.loadError && state.loadSequence===loadSequence && state.board?.id===item.board_id && state.panelSequence===sequence;
    if(!current())return;
    if(item.kind==='card' || item.kind==='comment') {
      if(!Number.isSafeInteger(item.card_id) || item.card_id<1)return;
      await openCard(item.card_id);
      if(item.kind==='comment' && current() && state.cardEditor?.id===item.card_id)await showThread(item.id);
    } else if(item.kind==='form')await workflows.showForm(item.form_id);
    else await workflows.showRequest(item.request_id);
  } catch(error) { if(sessionCurrent(context) && !error.staleSession)toast(error.message,true); }
}
function showMove() {
  const editor = state.cardEditor;
  if (!editor?.id) return;
  if (editorDirty('card-dialog')) { toast(tr('Salva le modifiche prima di spostare la scheda.'),true); return; }
  $('move-column').innerHTML = state.board.columns.map((column) => ui`<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
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
  if (!editor?.id || !$('card-dialog').open || state.saving || state.loading || !cardConflictCanWrite()) return;
  saveDraft(); state.cardConflict = null;
  panel(tr('Confronta con la versione sul server'),ui`<p>Caricamento…</p>`,'conflict');
  const context = cardConflictContext(editor);
  try {
    const local = OpenBoardConflicts.snapshot(cardData()), snapshot = JSON.stringify(cardData());
    const current = await readCardConflict(editor,context); if (!current || !cardConflictCurrent(editor,context) || JSON.stringify(cardData()) !== snapshot) return;
    const plan = OpenBoardConflicts.compare(editor.baseData,local,current.card);
    state.cardConflict = {editor,context,plan,server:current.card,board:current.board,members:current.members,snapshot,busy:false};
    $('panel-body').innerHTML = renderCardConflict(state.cardConflict);
  } catch (error) { if (cardConflictCurrent(editor,context) && !error.staleSession) $('panel-body').innerHTML = ui`<p class="form-error" role="alert">${escapeHTML(cardConflictError(error))}</p>`; }
}
function cardConflictCanWrite(board = state.board) {
  const session = state.auth, allowed = session?.enabled === false || (session?.enabled === true && ['admin','member'].includes(session.user?.role));
  return !!(allowed && board?.id && !board.deleted_at && board.readonly === false && ['admin','member'].includes(board.role));
}
function cardConflictContext(editor) { return {session:sessionContext(),boardId:state.board.id,cardId:editor.id,cardSequence:state.cardSequence,loadSequence:state.loadSequence,panelSequence:state.panelSequence}; }
function cardConflictBaseline(data) {
  const snapshot = OpenBoardConflicts.snapshot(data);
  // Empty active inputs are read as null by fieldValue(), and null clears a
  // custom value. Retained values of deleted fields never pass through inputs.
  for (const field of state.board.custom_fields || []) if (!field.deleted_at && OpenBoardConflicts.customValue(snapshot,field.key) === '') delete snapshot.custom_values[field.key];
  return snapshot;
}
function cardConflictCurrent(editor,context) { return sessionCurrent(context.session) && state.cardEditor === editor && editor.id === context.cardId && state.board?.id === context.boardId && state.cardSequence === context.cardSequence && state.loadSequence === context.loadSequence && state.panelSequence === context.panelSequence && state.panel === 'conflict' && $('card-dialog').open && $('panel-dialog').open && !state.loading; }
function cardConflictError(error) { return error?.message === 'invalid_card_snapshot' ? tr('I dati da confrontare non sono validi o superano i limiti. La bozza è conservata.'):error?.message || tr('Operazione non riuscita.'); }
async function readCardConflict(editor,context) {
  const results = await Promise.all([api(`/api/cards/${editor.id}`),api(`/api/boards/${context.boardId}?summary=1&include_archived=1`),state.auth?.enabled ? api(`/api/boards/${context.boardId}/members`):Promise.resolve({members:[]})]);
  if (!cardConflictCurrent(editor,context)) return null;
  const card = results[0].card || results[0], board = results[1].board || results[1];
  if (!cardConflictCanWrite(board)) throw new APIError(tr('Non hai più il permesso di modificare la scheda. La bozza è conservata.'),403);
  if (card.id !== editor.id || board.id !== context.boardId || card.deleted_at || !Number.isSafeInteger(card.version) || card.version < 1 || !(board.columns || []).some(column => !column.deleted_at && column.id === card.column_id)) throw new APIError(tr('La scheda o la lista non è più disponibile. La bozza è conservata.'),404);
  return {card,board,members:results[2].members || []};
}
function cardConflictLabel(row,board) {
  if (row.custom) return tr`Campo personalizzato: ${(board.custom_fields || []).find(field => field.key === row.key)?.name || row.key}`;
  const names={title:tr('Titolo'),description:tr('Descrizione'),column_id:tr('Lista'),assignee:tr('Responsabile'),due_date:tr('Scadenza'),cover:tr('Copertina'),completed:tr('Completato'),start_date:tr('Data di inizio'),blocked_reason:tr('Motivo del blocco'),actual_minutes:tr('Tempo manuale (min)'),reference_url:tr('URL di riferimento'),milestone_key:tr('Traguardo'),priority:tr('Priorità'),estimate_minutes:tr('Stima (min)'),labels:tr('Etichette: primaria e aggiuntive'),assignee_ids:tr('Assegnatari'),checklist:tr('Checklist')};
  return names[row.key];
}
function cardConflictValue(value,row,comparison) {
  if (value === undefined || value === null || value === '') return tr('Non impostato');
  if (row.key === 'column_id' && !row.custom) return comparison.board.columns.find(column => column.id === value)?.title || String(value);
  if (row.key === 'assignee_ids' && !row.custom) return value.map(id => comparison.members.find(member => Number(member.user_id || member.id) === id)?.name || String(id)).join(', ') || tr('Nessuno');
  if (typeof value === 'boolean') return value ? tr('Sì'):tr('No');
  return typeof value === 'object' ? JSON.stringify(value,null,2):String(value);
}
function renderCardConflict(comparison) {
  const rows = comparison.plan.rows.filter(row => !OpenBoardConflicts.equal(row.local,row.server));
  return ui`<p>Le modifiche indipendenti sono unite automaticamente. Scegli la bozza o il server per ogni campo in conflitto.</p>${!comparison.plan.base ? ui`<p class="notice">Questa bozza non contiene una versione iniziale verificabile. Ogni differenza richiede una scelta esplicita.</p>`:''}<p>Checklist, assegnatari ed etichette sono gruppi indivisibili. I campi personalizzati sono confrontati singolarmente.</p><p>Applicare l’anteprima aggiorna solo l’editor. Salva esplicitamente la scheda per inviare le modifiche.</p><div class="conflict-fields">${rows.map(row => {
    const index = comparison.plan.rows.indexOf(row), name = cardConflictLabel(row,comparison.board);
    return ui`<section class="conflict-field" aria-labelledby="conflict-heading-${index}"><h3 id="conflict-heading-${index}">${escapeHTML(name)}</h3><div class="conflict-values"><div><h4>Versione iniziale</h4><pre>${escapeHTML(comparison.plan.base ? cardConflictValue(row.base,row,comparison):tr('Non disponibile'))}</pre></div><div><h4>La tua bozza</h4><pre>${escapeHTML(cardConflictValue(row.local,row,comparison))}</pre></div><div><h4>Versione sul server</h4><pre>${escapeHTML(cardConflictValue(row.server,row,comparison))}</pre></div></div>${row.automatic ? ui`<p class="helper-text">${row.automatic === 'local' ? tr('Unione automatica: modifica locale.'):tr('Unione automatica: modifica sul server.')}</p>`:ui`<label for="conflict-choice-${index}">Valore da mantenere</label><select id="conflict-choice-${index}" aria-labelledby="conflict-heading-${index}" required><option value="">Scegli esplicitamente</option><option value="local">La tua bozza</option><option value="server">Versione sul server</option></select>`}</section>`;
  }).join('') || ui`<p>Non ci sono differenze nei campi modificabili.</p>`}</div><p id="conflict-error" class="form-error" role="alert"></p><button id="adopt-version" class="button primary" type="button">Applica anteprima all’editor</button><button id="load-conflict" class="button secondary" type="button">Ricarica confronto</button>`;
}
function validateCardConflict(data,current) {
  const {board,card,members} = current;
  if (!data.title.trim() || data.estimate_minutes < 0 || data.estimate_minutes > 100000 || data.actual_minutes < 0 || data.actual_minutes > 1000000 || !Object.hasOwn(priorities,data.priority) || !covers.includes(data.cover) || (data.label && !Object.hasOwn(labels,data.label)) || data.labels.some(label => !Object.hasOwn(labels,label)) || (data.reference_url && !productivity.safeURL(data.reference_url))) return tr('I valori uniti non sono validi. Correggi la bozza o modifica le scelte.');
  if ([data.start_date,data.due_date].some(value => value && (!productivity.validDate(value) || value < '0001-01-01')) || (data.start_date && data.due_date && data.start_date > data.due_date)) return tr('Le date unite non sono valide: l’inizio deve precedere la scadenza.');
  if (!board.columns.some(column => !column.deleted_at && column.id === data.column_id)) return tr('La lista scelta non è più disponibile. La bozza è conservata.');
  // The explicit membership list is incomplete: active global administrators
  // may be assigned without membership. Absence is not proof of ineligibility;
  // the eventual Save validates every ID in the backend write transaction.
  if (data.assignee_ids.some(id => members.some(member => Number(member.user_id || member.id) === id && member.active === false))) return tr('Un assegnatario non è più disponibile. Correggi gli assegnatari nella bozza.');
  for (const key of new Set([...Object.keys(data.custom_values),...Object.keys(card.custom_values || {})])) {
    const field = (board.custom_fields || []).find(item => item.key === key), value = OpenBoardConflicts.customValue(data,key);
    if (!field || field.deleted_at) { if (!OpenBoardConflicts.equal(value,OpenBoardConflicts.customValue(card,key) ?? undefined)) return tr('Un campo personalizzato non è più disponibile. Mantieni il valore sul server.'); }
    else if (value !== undefined && !productivity.fieldMatchesAdvanced(value,field,{op:'eq',value})) return tr('Un valore personalizzato non è più valido per la definizione corrente.');
  }
  if (data.milestone_key && !(board.milestones || []).some(item => !item.deleted_at && item.key === data.milestone_key) && data.milestone_key !== (card.milestone_key || '')) return tr('Il traguardo scelto non è più disponibile. La bozza è conservata.');
  return '';
}
function fillCardConflict(data,current) {
  const editor = state.cardEditor, controls={title:'card-title',description:'card-description',column_id:'card-column',assignee:'card-assignee',due_date:'card-due-date',start_date:'card-start-date',blocked_reason:'card-blocked-reason',actual_minutes:'card-actual',reference_url:'card-reference',priority:'card-priority',estimate_minutes:'card-estimate',label:'card-label'};
  state.board.custom_fields = current.board.custom_fields || []; state.board.milestones = current.board.milestones || []; state.board.role = current.board.role; state.board.readonly = current.board.readonly;
  $('card-column').innerHTML = current.board.columns.filter(column => !column.deleted_at).map(column => ui`<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
  for (const [key,id]of Object.entries(controls)) $(id).value = String(data[key]);
  $('card-completed').checked = data.completed; setCover(data.cover);
  document.querySelectorAll('input[name="extra-label"]').forEach(input => { input.checked = data.labels.includes(input.value); });
  editor.checklist = data.checklist.map(item => ({...item})); renderChecklist(); editor.assigneeIds = [...data.assignee_ids];
  const roster = current.members.filter(member => member.active);
  for (const id of data.assignee_ids) if (!roster.some(member => Number(member.user_id || member.id) === id)) roster.push({user_id:id,name:current.card.assignees?.find(member => member.id === id)?.name || tr`Assegnatario non elencato: ${id}`,username:''});
  renderMemberAssignments(roster);
  editor.customValues = {...data.custom_values};
  $('card-custom-fields').innerHTML = activeFields().map(field => ui`<label class="form-field" for="custom-${Number(field.id)}"><span class="field-label">${escapeHTML(field.name)}</span>${customInput(field,OpenBoardConflicts.customValue(data,field.key))}</label>`).join('');
  const milestones = activeMilestones(); if (data.milestone_key && !milestones.some(item => item.key === data.milestone_key)) milestones.push({key:data.milestone_key,title:milestoneName(data.milestone_key)+tr(' (eliminato)')});
  $('card-milestone').innerHTML = ui`<option value="">Nessuno</option>`+milestones.map(item => ui`<option value="${escapeHTML(item.key)}">${escapeHTML(item.title)}</option>`).join(''); $('card-milestone').value = data.milestone_key;
  $('markdown-preview').innerHTML = productivity.markdown(data.description); renderReference();
}
async function applyCardConflict() {
  const comparison = state.cardConflict;
  if (!comparison || comparison.busy || state.saving || !cardConflictCurrent(comparison.editor,comparison.context) || !cardConflictCanWrite()) return;
  const choices = {};
  comparison.plan.rows.forEach((row,index) => { if (!row.automatic) choices[index] = $(`conflict-choice-${index}`)?.value; });
  let resolved;
  try { resolved = OpenBoardConflicts.resolve(comparison.plan,choices); }
  catch (error) { $('conflict-error').textContent = cardConflictError(error); return; }
  if (resolved.unresolved.length) { $('conflict-error').textContent = tr('Scegli un valore per ogni campo in conflitto.'); $(`conflict-choice-${resolved.unresolved[0]}`)?.focus(); return; }
  if (JSON.stringify(cardData()) !== comparison.snapshot) { $('conflict-error').textContent = tr('La bozza è cambiata durante il confronto. Ricarica il confronto prima di applicarlo.'); return; }
  comparison.busy = true; $('adopt-version').disabled = true; $('conflict-error').textContent = '';
  try {
    const current = await readCardConflict(comparison.editor,comparison.context);
    if (!current || state.cardConflict !== comparison || !cardConflictCurrent(comparison.editor,comparison.context)) return;
    const currentData = OpenBoardConflicts.snapshot(current.card);
    if (current.card.version !== comparison.server.version || !OpenBoardConflicts.equal(currentData,comparison.plan.server)) throw new APIError(tr('Il server è cambiato di nuovo. Ricarica il confronto; la bozza è conservata.'),412);
    if (JSON.stringify(cardData()) !== comparison.snapshot) throw new APIError(tr('La bozza è cambiata durante il confronto. Ricarica il confronto prima di applicarlo.'));
    const error = validateCardConflict(resolved.data,current); if (error) throw new APIError(error);
    fillCardConflict(resolved.data,current);
    comparison.editor.version = current.card.version; comparison.editor.baseVersion = current.card.version; comparison.editor.baseData = currentData; comparison.editor.persistedMilestone = current.card.milestone_key || ''; comparison.editor.pending = null; comparison.editor.pendingAmbiguous = false;
    $('conflict-notice').hidden = true; saveDraft(); state.cardConflict = null; closeDialog('panel-dialog',{force:true}); toast(tr('Anteprima applicata all’editor. Controlla i valori e salva esplicitamente.'));
  } catch (error) { if (state.cardConflict === comparison && cardConflictCurrent(comparison.editor,comparison.context) && !error.staleSession) $('conflict-error').textContent = cardConflictError(error); }
  finally { comparison.busy = false; if (state.cardConflict === comparison && cardConflictCurrent(comparison.editor,comparison.context)) $('adopt-version').disabled = false; }
}
function restoreCardConflictBase(draft) {
  const editor = state.cardEditor; editor.baseData = null; editor.baseVersion = null;
  try { if (draft.base_data && Number.isSafeInteger(draft.base_version) && draft.base_version > 0 && draft.base_version <= draft.version) { editor.baseData = OpenBoardConflicts.snapshot(draft.base_data); editor.baseVersion = draft.base_version; } } catch { /* Legacy or invalid bases require explicit choices. */ }
}
async function exportBoard() {
  if (!state.board) return;
  const context = sessionContext();
  const board = state.board;
  try {
    const data = await api(`/api/boards/${board.id}/export`);
    if (!sessionCurrent(context)) return;
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${board.name.toLocaleLowerCase(OpenBoardI18n.locale).replace(/[^a-z0-9à-ü]+/g,'-').replace(/^-|-$/g,'') || 'bacheca'}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
    toast(tr('Esportazione completa versione 2 scaricata dal server.'));
  } catch (error) { if (sessionCurrent(context) && !error.staleSession) toast(error.message,true); }
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
    perform(() => committed(() => api(`/api/columns/${column.id}`,'PATCH',{position},{version:column.version}),refreshBoard,tr('Lista riordinata.'))); return;
  }
  if (target.dataset.completeCard) {
    const card = allCards().find((item) => item.id === Number(target.dataset.completeCard));
    if (card) perform(() => committed(() => api(`/api/cards/${card.id}`,'PATCH',{completed:!card.completed},{version:card.version}),refreshBoard,card.completed ? tr('Scheda riaperta.') : tr('Scheda completata.'))); return;
  }
  if (target.dataset.cardId) { openCard(target.dataset.cardId); return; }
  if (target.dataset.cover !== undefined) { setCover(target.dataset.cover); saveDraft(); return; }
  if (target.dataset.checklistRemove !== undefined) { state.cardEditor.checklist.splice(Number(target.dataset.checklistRemove),1); renderChecklist(); saveDraft(); return; }
  if (target.dataset.deleteComment) {
    if (!confirm(tr('Eliminare questo commento?'))) return;
    perform(() => committed(() => api(`/api/comments/${Number(target.dataset.deleteComment)}`,'DELETE'),() => loadComments(state.cardEditor.id),tr('Commento eliminato.')),'','card-form-error'); return;
  }
  if (target.dataset.restoreKind && ['boards','columns','cards'].includes(target.dataset.restoreKind)) {
    perform(() => committed(() => api(`/api/${target.dataset.restoreKind}/${Number(target.dataset.restoreId)}/restore`,'POST',{}),async () => { await refreshBoards(); await refreshBoard(); await showTrash(); },tr('Elemento ripristinato.')),'','panel-error'); return;
  }
  if (target.dataset.removeMember) {
    if (!confirm(tr('Rimuovere questo membro dalla bacheca?'))) return;
    perform(() => committed(() => api(`/api/boards/${state.board.id}/members/${Number(target.dataset.removeMember)}`,'DELETE'),showMembers,tr('Membro rimosso.')),'','panel-error'); return;
  }
  if (target.dataset.searchContent) { await openContentSearchResult(target.dataset.searchContent); return; }
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
      await applyCardConflict(); break;
    case 'recover-draft': {
      const draft = readDraft();
      if (draft && cardDraftVersionValid(draft)) { fillCard(draft.data); restoreCardConflictBase(draft); $('checklist-new').value = draft.checklist_new || ''; $('comment-body').value = draft.comment_body || ''; $('worklog-date').value = draft.worklog?.date || todayISO(); $('worklog-minutes').value = draft.worklog?.minutes || ''; $('worklog-note').value = draft.worklog?.note || ''; state.cardEditor.version = draft.version; if (draft.pending) state.cardEditor.pending = draft.pending; state.cardEditor.pendingAmbiguous = draft.pendingAmbiguous ?? !!draft.pending; state.cardEditor.writtenDraft = stored(draftKey()); state.cardEditor.previousDraft = null; $('draft-notice').hidden = true; saveDraft(); toast(tr('Bozza recuperata. Verifica e salva quando pronta.')); }
      break;
    }
    case 'discard-draft': forget(draftKey()); state.cardEditor.writtenDraft = null; state.cardEditor.previousDraft = null; $('draft-notice').hidden = true; break;
    case 'refresh-remote': await perform(refreshBoard); break;
    case 'reload-board': await perform(state.board ? refreshBoard : loadInitial); break;
    case 'show-archived-boards': state.archivedBoards = !state.archivedBoards; await perform(async () => { await refreshBoards(); renderHeader(); openDialog('boards-dialog'); }); break;
    case 'duplicate-card': {
      const editor = state.cardEditor;
      if (!editor?.id) break;
      if (editorDirty('card-dialog')) { toast(tr('Salva la bozza prima di duplicare la scheda.'),true); break; }
      perform(() => committed(() => api(`/api/cards/${editor.id}/duplicate`,'POST',{}),async () => { closeDialog('card-dialog',{force:true}); await refreshBoard(); },tr('Scheda duplicata.')),'','card-form-error'); break;
    }
    case 'archive-card': {
      const editor = state.cardEditor;
      if (!editor?.id || (editorDirty('card-dialog') && !confirm(tr('Archiviare la versione salvata sul server? La bozza locale verrà conservata.')))) break;
      saveDraft();
      perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'PATCH',{archived:!editor.archived},{version:editor.version}); closeDialog('card-dialog',{force:true}); },refreshBoard,editor.archived ? tr('Scheda ripristinata dall’archivio.') : tr('Scheda archiviata.')),'','card-form-error'); break;
    }
    case 'duplicate-board': {
      const suffix = tr(' (copia)');
      if (state.board) perform(() => committed(() => api(`/api/boards/${state.board.id}/duplicate`,'POST',{name:Array.from(state.board.name).slice(0,200-Array.from(suffix).length).join('')+suffix}),async (result) => { await refreshBoards(); await selectBoard(result.id || result.board?.id,{quiet:true}); },tr('Bacheca duplicata.'))); break;
    }
    case 'archive-board':
      if (state.board) perform(() => committed(() => api(`/api/boards/${state.board.id}`,'PATCH',{archived:!state.board.archived},{version:state.board.version}),async () => { state.archivedBoards = true; await refreshBoards(); await refreshBoard(); },state.board.archived ? tr('Bacheca ripristinata dall’archivio.') : tr('Bacheca archiviata.'))); break;
    case 'prepare-csv-import': prepareCSVImport(); break;
    case 'confirm-import': await confirmImport(); break;
    case 'logout':
      if (!closeEditors()) break;
      perform(async () => { invalidateSession(); await api('/api/auth/logout','POST',{}); sessionTabs.publish(); closeDialog('panel-dialog',{force:true}); setSession(await api('/api/auth/session')); state.board = null; state.boards = []; renderSidebar(); renderHeader(); renderBoard(); showAuth(false); }); break;
  }
});
document.addEventListener('keydown',(event) => {
  if (productivity.composing(event)) return;
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
['board','list','calendar','stats','table','timeline'].forEach((view) => $(`view-${view}`).addEventListener('click',() => setView(view)));
['create-board-sidebar','create-board-link'].forEach((id) => $(id).addEventListener('click',() => openBoardEditor()));
['boards-nav','mobile-boards'].forEach((id) => $(id).addEventListener('click',() => { renderSidebar(); openDialog('boards-dialog'); }));
$('add-card-main').addEventListener('click',() => openCard());
$('edit-board').addEventListener('click',() => openBoardEditor(state.board));
$('star-board').addEventListener('click',() => {
  if (!state.board) return;
  const starred = !state.board.starred;
  perform(() => committed(() => api(`/api/boards/${state.board.id}/star`,'PATCH',{starred}),async () => { await refreshBoards(); await refreshBoard(); },starred ? tr('Bacheca aggiunta ai preferiti.') : tr('Bacheca rimossa dai preferiti.')));
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
$('checklist-new').addEventListener('keydown',(event) => { if (event.key === 'Enter' && !productivity.composing(event)) { event.preventDefault(); addChecklistItem(); } });
$('card-form').addEventListener('input',saveDraft);
$('card-form').addEventListener('change',saveDraft);
$('move-column').addEventListener('change',updateMovePosition);
document.addEventListener('input',(event) => {
  if (state.panel === 'import' && !state.saving && (event.target.id === 'csv-import-name' || event.target.dataset.importMapping !== undefined)) clearImportPreview();
  if (event.target.id === 'global-query') { clearTimeout(searchTimer);++globalSearchSequence;state.globalSearch=null;if(!productivity.composing(event))searchTimer = setTimeout(() => globalSearch(event.target.value),250); }
});
document.addEventListener('change',(event) => {
  if(event.target.id==='global-kind') { clearTimeout(searchTimer);++globalSearchSequence;state.globalSearch=null;globalSearch($('global-query').value); }
  if (event.target.id === 'theme-setting') { document.documentElement.dataset.theme = event.target.value; remember('theme',event.target.value); }
  if (event.target.id === 'density-setting') { document.documentElement.dataset.density = event.target.value; remember('density',event.target.value); }
  if (event.target.id === 'import-file') previewImport(event.target.files[0]);
  if (event.target.id === 'import-format') changeImportFormat();
  if (state.panel === 'import' && !state.saving && ['csv-import-delimiter','csv-import-header'].includes(event.target.id)) renderCSVMapping();
  if (state.panel === 'import' && !state.saving && (event.target.id === 'csv-import-name' || event.target.dataset.importMapping !== undefined)) clearImportPreview();
});
$('auth-form').addEventListener('submit',async (event) => {
  event.preventDefault();
  const previousUserId = state.auth?.user?.id;
  saveDraft();
  const data = {username:$('auth-username').value.trim(),password:$('auth-password').value};
  if (state.setup) data.name = $('auth-name').value.trim();
  state.authRequest = state.authRequest || {};
  const session = await perform(async () => {
    invalidateSession();
    setSession(await api(state.setup ? '/api/auth/setup' : '/api/auth/login','POST',data,{key:stableRequest(state.authRequest,data)}),{renewed:true});
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
    $('card-form-error').textContent = tr('Pubblica o cancella il commento prima di salvare la scheda. La bozza è conservata.');
    $('comment-body').focus();
    return;
  }
  if ($('worklog-minutes').value || $('worklog-note').value.trim()) { saveDraft(); $('card-form-error').textContent = tr('Registra o cancella il tempo inserito prima di salvare la scheda. La bozza è conservata.'); $('worklog-minutes').focus(); return; }
  if ($('checklist-new').value.trim()) {
    saveDraft();
    $('card-form-error').textContent = tr('Aggiungi l’attività alla checklist oppure cancella il testo prima di salvare la scheda. La bozza è conservata.');
    $('checklist-new').focus();
    return;
  }
  const editor = state.cardEditor; const data = productivity.planningPayload(cardData(),state.board.custom_fields,state.board.milestones,editor.persistedMilestone);
  if (!data.title) { fieldError($('card-title'),tr('Dai un titolo alla tua scheda.')); $('card-title').focus(); return; }
  const key = stableRequest(editor,data); saveDraft();
  perform(() => committed(async () => {
    editor.pendingAmbiguous = true; saveDraft();
    try {
      if (editor.id) await api(`/api/cards/${editor.id}`,'PATCH',data,{version:editor.version});
      else await api(`/api/columns/${data.column_id}/cards`,'POST',data,{key});
    } catch (error) {
      editor.pendingAmbiguous = !error.status || error.status >= 500 || [408,429].includes(error.status);
      saveDraft();
      if (error.status === 412) { $('conflict-notice').hidden = false; saveDraft(); throw new APIError(tr('Conflitto: un’altra sessione ha aggiornato questa scheda. La tua bozza è conservata.'),412); }
      throw error;
    }
    editor.pendingAmbiguous = false; forget(draftKey()); closeDialog('card-dialog',{force:true});
  },refreshBoard,editor.id ? tr('Scheda aggiornata sul server.') : tr('Scheda creata sul server.')),'','card-form-error');
});
$('delete-card').addEventListener('click',() => {
  const editor = state.cardEditor;
  if (!editor?.id || !confirm(tr('Spostare questa scheda nel cestino? Potrai ripristinarla.'))) return;
  saveDraft();
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'DELETE',undefined,{version:editor.version}); closeDialog('card-dialog',{force:true}); },refreshBoard,tr('Scheda spostata nel cestino.')),'','card-form-error');
});
$('board-form').addEventListener('submit',(event) => {
  event.preventDefault(); const data = boardData();
  if (!data.name) { fieldError($('board-name'),tr('Scegli un nome per la bacheca.')); $('board-name').focus(); return; }
  const editor = state.boardEditor; state.boardRequest = state.boardRequest || {};
  if(!editor)data.language=OpenBoardI18n.locale;
  perform(() => committed(async () => {
    const result = await api(editor ? `/api/boards/${editor.id}` : '/api/boards',editor ? 'PATCH' : 'POST',data,{version:editor?.version,key:stableRequest(state.boardRequest,data)});
    closeDialog('board-dialog',{force:true}); return result;
  },async (result) => { await refreshBoards(); await selectBoard(editor?.id || result.id || result.board?.id,{quiet:true}); },tr('Bacheca salvata sul server.')),'','board-form-error');
});
$('delete-board').addEventListener('click',() => {
  const board = state.boardEditor;
  if (!board || !confirm(tr`Spostare “${board.name}”, le liste e le schede nel cestino? Potrai ripristinarle.`)) return;
  perform(() => committed(async () => { await api(`/api/boards/${board.id}`,'DELETE',undefined,{version:board.version}); closeDialog('board-dialog',{force:true}); },async () => {
    await refreshBoards();
    if (state.boards.length) await selectBoard(state.boards[0].id,{quiet:true});
    else { state.board = null; route(null); renderSidebar(); renderHeader(); renderBoard(); }
  },tr('Bacheca spostata nel cestino.')),'','board-form-error');
});
$('column-form').addEventListener('submit',(event) => {
  event.preventDefault(); const data = columnData(); const editor = state.columnEditor;
  if (!data.title) { $('column-form-error').textContent = tr('Scegli un nome per la lista.'); return; }
  state.columnRequest = state.columnRequest || {};
  perform(() => committed(async () => {
    await api(editor ? `/api/columns/${editor.id}` : `/api/boards/${state.board.id}/columns`,editor ? 'PATCH' : 'POST',data,{version:editor?.version,key:stableRequest(state.columnRequest,data)});
    closeDialog('column-dialog',{force:true});
  },refreshBoard,tr('Lista salvata sul server.')),'','column-form-error');
});
$('delete-column').addEventListener('click',() => { if (state.columnEditor) deleteColumn(state.columnEditor.id); });
$('move-form').addEventListener('submit',(event) => {
  event.preventDefault(); const editor = state.cardEditor;
  const data = {column_id:Number($('move-column').value),position:Number($('move-position').value)-1};
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}`,'PATCH',data,{version:editor.version}); closeDialog('move-dialog',{force:true}); closeDialog('card-dialog',{force:true}); },refreshBoard,tr('Scheda spostata.')),'','move-error');
});
$('add-comment').addEventListener('click',() => {
  const body = $('comment-body').value.trim(); const editor = state.cardEditor;
  if (!body || !editor?.id) return;
  const data = {body}; editor.commentRequest = editor.commentRequest || {};
  perform(() => committed(async () => { await api(`/api/cards/${editor.id}/comments`,'POST',data,{key:stableRequest(editor.commentRequest,data)}); $('comment-body').value = ''; editor.commentRequest = {}; if (editorDirty('card-dialog')) saveDraft(); else forget(draftKey()); },() => loadComments(editor.id),tr('Commento pubblicato.')),'','card-form-error');
});
document.addEventListener('submit',(event) => {
  const form = event.target;
  if (!['create-user-form','password-form','member-form'].includes(form.id) && !form.dataset.userForm) return;
  event.preventDefault();
  if (form.id === 'create-user-form') {
    const data = {name:$('user-name').value.trim(),username:$('user-username').value.trim(),password:$('user-password').value,role:$('user-role').value};
    state.userRequest = state.userRequest || {};
    perform(() => committed(() => api('/api/users','POST',data,{key:stableRequest(state.userRequest,data)}),async () => { state.userRequest = {}; await showUsers(); },tr('Utente creato.')),'','panel-error');
  } else if (form.dataset.userForm) {
    const data = {role:form.elements.role.value,active:form.elements.active.checked};
    perform(() => committed(() => api(`/api/users/${Number(form.dataset.userForm)}`,'PATCH',data),async () => { setSession(await api('/api/auth/session')); await showUsers(); },tr('Utente aggiornato.')),'','panel-error');
  } else if (form.id === 'password-form') {
    const data = {current_password:$('current-password').value,password:$('new-password').value};
    perform(() => committed(() => api('/api/auth/password','POST',data),async () => { $('password-form').reset(); setSession(await api('/api/auth/session')); },tr('Password aggiornata.')),'','panel-error');
  } else if (form.id === 'member-form') {
    const data = {user_id:Number($('member-user').value),role:$('member-role').value};
    perform(() => committed(() => api(`/api/boards/${state.board.id}/members`,'POST',data),showMembers,tr('Membro aggiornato.')),'','panel-error');
  }
});
function clearDragStyles() { document.querySelectorAll('.dragging,.drag-over,.drag-before').forEach((element) => element.classList.remove('dragging','drag-over','drag-before')); }
$('board-canvas').addEventListener('dragstart',(event) => {
  const card = event.target.closest('.task-card');
  if (!card || state.saving || !canWrite() || hasFilters() || state.archived) { event.preventDefault(); if (hasFilters()) toast(tr('Ripristina ordine manuale e rimuovi i filtri per trascinare le schede.')); return; }
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
  perform(() => committed(() => api(`/api/cards/${cardId}`,'PATCH',{column_id:columnId,position:Math.max(0,position)},{version:source.version}),refreshBoard,tr('Scheda spostata.')));
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
  $('selection-count').textContent = OpenBoardI18n.count('{count} scheda selezionata','{count} schede selezionate',state.selectedCards.size);
  $('bulk-complete').disabled = $('bulk-archive').disabled = !canWrite() || !state.selectedCards.size || state.saving;
}
function dateOffset(days) { const date = new Date(); date.setDate(date.getDate()+days); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function renderReference() {
  const url = productivity.safeURL($('card-reference').value.trim());
  $('reference-link').innerHTML = url ? ui`<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Apri riferimento in una nuova scheda</a>` : '';
}
function timerKey() { return `timer.${state.auth?.user?.id || 'local'}.${state.cardEditor?.id || 'new'}`; }
function readTimer() { try { const timer = JSON.parse(stored(timerKey(),'null')); return timer && Number.isFinite(timer.started) && timer.started > 0 && timer.started <= Date.now() && Number.isFinite(timer.base) ? timer : null; } catch { return null; } }
function renderTimer() {
  if (!state.cardEditor || !$('card-dialog').open) return;
  const timer = readTimer();
  $('timer-toggle').disabled = !state.cardEditor.id || !canWrite() || state.saving;
  $('timer-toggle').textContent = timer ? tr('Ferma e aggiungi minuti') : tr('Avvia timer');
  const seconds = timer ? Math.max(0,Math.floor((Date.now()-timer.started)/1000)) : 0;
  $('timer-value').textContent = timer ? tr`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')} · in corso` : state.cardEditor.id ? tr('Fermo') : tr('Salva la scheda per usare il timer');
}
function fillProductivityCard(data) {
  $('card-start-date').value = data.start_date || '';
  $('card-blocked-reason').value = data.blocked_reason || '';
  $('card-actual').value = data.actual_minutes || 0;
  $('card-reference').value = data.reference_url || '';
  state.cardEditor.assigneeIds = Array.isArray(data.assignee_ids) ? data.assignee_ids.map(Number) : (data.assignees || []).map((user) => Number(user.id));
  if (state.cardEditor.members) renderMemberAssignments(state.cardEditor.members);
  else $('card-assignees').innerHTML = ui`<p class="helper-text">Caricamento membri…</p>`;
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
  $('card-assignees').innerHTML = members.length ? members.map((user) => ui`<label><input type="checkbox" data-assignee-id="${Number(user.user_id || user.id)}" data-write ${ids.includes(Number(user.user_id || user.id)) ? 'checked' : ''} ${!canWrite() ? 'disabled' : ''}>${escapeHTML(user.name)} <span class="helper-text">@${escapeHTML(user.username)}</span></label>`).join('') : ui`<p class="helper-text">Aggiungi membri alla bacheca per assegnare account reali.</p>`;
}
async function loadProductivityCard(cardId,boardId,sequence) {
  const isCurrent = () => state.board?.id === boardId && state.cardSequence === sequence && state.cardEditor?.id === (Number(cardId)||null) && $('card-dialog').open;
  if (state.auth?.enabled) {
    try { const members = await api(`/api/boards/${boardId}/members`); if (isCurrent()) renderMemberAssignments(members.members || []); }
    catch (error) { if (!error.staleSession && isCurrent()) $('card-assignees').textContent = error.message; }
  } else if (isCurrent()) renderMemberAssignments([]);
  if (isCurrent()) loadPlanningCard(Number(cardId)||null,boardId,sequence);
  if (!cardId || !isCurrent()) return;
  $('dependency-card').innerHTML = allCards().filter((card) => card.id !== Number(cardId) && !card.archived).map((card) => ui`<option value="${Number(card.id)}">${escapeHTML(card.title)}</option>`).join('');
  await Promise.allSettled([loadDependencies(Number(cardId)),loadAttachments(Number(cardId)),refreshWatchState(Number(cardId))]);
}
async function loadDependencies(cardId) {
  try {
    const result = await api(`/api/cards/${cardId}/dependencies`);
    if (state.cardEditor?.id !== cardId || !$('card-dialog').open) return;
    const dependencies = result.dependencies || [];
    $('dependencies-list').innerHTML = dependencies.map((card) => ui`<div class="dependency-row"><span class="dependency-status ${card.completed ? 'complete' : ''}">${card.completed ? tr('✓ Completata') : tr('○ Da completare')}</span><button type="button" class="subtle-button" data-dependency-open="${Number(card.id)}">${escapeHTML(card.title)}</button><button type="button" class="button danger-subtle" data-remove-dependency="${Number(card.id)}" data-write>Rimuovi</button></div>`).join('') || ui`<p class="helper-text">Nessuna dipendenza.</p>`;
    const used = new Set(dependencies.map((card) => card.id));
    $('dependency-card').innerHTML = allCards().filter((card) => card.id !== cardId && !card.archived && !used.has(card.id)).map((card) => ui`<option value="${Number(card.id)}">${escapeHTML(card.title)}</option>`).join('');
    updateBusy();
  } catch (error) { if (!error.staleSession && state.cardEditor?.id === cardId) $('dependencies-list').textContent = error.message; }
}
async function refreshEditorVersion(cardId) {
  const result = await api(`/api/cards/${cardId}`);
  if (state.cardEditor?.id === cardId && $('card-dialog').open) { state.cardEditor.version = (result.card || result).version; saveDraft(); }
}
async function changeDependency(required,remove) {
  const id = state.cardEditor?.id;
  if (!id || !required) return;
  if (editorDirty('card-dialog')) { toast(tr('Salva la bozza prima di cambiare le dipendenze.'),true); return; }
  await perform(() => committed(() => api(`/api/cards/${id}/dependencies${remove ? '/'+Number(required) : ''}`,remove ? 'DELETE':'POST',remove ? undefined : {required_card_id:Number(required)},{version:state.cardEditor.version}),async () => { await refreshEditorVersion(id); await loadDependencies(id); },remove ? tr('Dipendenza rimossa.') : tr('Dipendenza aggiunta.')),'','card-form-error');
}
async function loadAttachments(cardId) {
  try {
    const result = await api(`/api/cards/${cardId}/attachments`);
    if (state.cardEditor?.id !== cardId || !$('card-dialog').open) return;
    $('attachments-list').innerHTML = (result.attachments || []).map((file) => ui`<div class="attachment-row"><div><strong>${escapeHTML(file.name)}</strong><span>${Math.ceil(Number(file.size)/1024)} KiB · ${file.deleted_at ? tr('Nel cestino') : escapeHTML(formatDate(file.created_at))}</span></div>${file.deleted_at ? ui`<button type="button" class="button secondary" data-restore-attachment="${Number(file.id)}" data-write>Ripristina</button>` : ui`<button type="button" class="button secondary" data-download-attachment="${Number(file.id)}">Scarica</button><button type="button" class="button danger-subtle" data-delete-attachment="${Number(file.id)}" data-write>Elimina</button>`}</div>`).join('') || ui`<p class="helper-text">Nessun allegato.</p>`;
    updateBusy();
  } catch (error) { if (!error.staleSession && state.cardEditor?.id === cardId) $('attachments-list').textContent = error.message; }
}
function downloadBlob(blob,name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = String(name || 'download').replace(/[\x00-\x1f\x7f/\\]/g,'_');
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function uploadAttachment() {
  const id = state.cardEditor?.id, file = $('attachment-file').files[0];
  if (!id || !file) { toast(tr('Scegli un file da caricare.'),true); return; }
  if (!file.size || file.size > 1024*1024) { toast(tr('Il file deve contenere da 1 byte a 1 MiB.'),true); return; }
  await perform(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let offset=0;offset<bytes.length;offset+=16384) binary += String.fromCharCode(...bytes.subarray(offset,offset+16384));
    if (state.cardEditor?.id !== id || !$('card-dialog').open) return;
    await committed(() => api(`/api/cards/${id}/attachments`,'POST',{name:file.name,mime:file.type || 'application/octet-stream',data_base64:btoa(binary)}),async () => { if (state.cardEditor?.id === id) $('attachment-file').value = ''; await loadAttachments(id); },tr('Allegato caricato.'));
  },'','card-form-error');
}
async function downloadAttachment(id) {
  await perform(async () => {
    const result = await api(`/api/attachments/${Number(id)}`); const binary = atob(result.data_base64), bytes = Uint8Array.from(binary,(char) => char.charCodeAt(0));
    downloadBlob(new Blob([bytes],{type:'application/octet-stream'}),result.name); toast(tr('Allegato scaricato.'));
  });
}
async function refreshWatchState(cardId = null) {
  if (!state.auth?.enabled || !state.auth?.user) return;
  const boardId = state.board?.id;
  try {
    const result = await api('/api/me/watches');
    if (state.board?.id === boardId) { state.boardWatching = (result.boards || []).some((board) => board.id === boardId); $('watch-board').textContent = state.boardWatching ? tr('Non seguire più la bacheca') : tr('Segui bacheca'); }
    if (cardId && state.cardEditor?.id === cardId) { state.cardWatching = (result.cards || []).some((card) => card.id === cardId); $('watch-card').textContent = state.cardWatching ? tr('Non seguire') : tr('Segui scheda'); }
  } catch { /* A subscription failure never hides the current board. */ }
}
async function toggleWatch(card) {
  const id = card ? state.cardEditor?.id : state.board?.id;
  if (!id || !state.auth?.user) return;
  const watching = !(card ? state.cardWatching : state.boardWatching);
  await perform(() => committed(() => api(`/api/${card ? 'cards':'boards'}/${id}/watch`,'PATCH',{watching}),() => refreshWatchState(card ? id : null),watching ? tr('Riceverai le notifiche degli aggiornamenti.') : tr('Notifiche disattivate per questo elemento.')));
}
async function refreshNotifications() {
  if (!state.auth?.enabled || !state.auth?.user || document.hidden) return;
  try { const result = await api('/api/notifications/unread-count'); const count = Number(result.unread_count)||0; $('unread-count').textContent = count > 99 ? '99+' : String(count); $('unread-count').hidden = !count; $('notifications').setAttribute('aria-label',tr`Notifiche: ${count} non lette`); } catch { /* Keep the last verified badge when offline. */ }
}
async function showNotifications(before = null,append = false) { return showFilteredNotifications(before,append); }
function activityLabel(action) {
  const names={
    created:tr('ha creato'),updated:tr('ha modificato'),deleted:tr('ha eliminato'),restored:tr('ha ripristinato'),
    commented:tr('ha commentato'),moved:tr('ha spostato'),archived:tr('ha archiviato'),attached:tr('ha allegato un file'),
    unarchived:tr('ha ripristinato dall’archivio'),duplicated:tr('ha duplicato'),imported:tr('ha importato'),
    assigned:tr('ha aggiornato gli assegnatari'),completed:tr('ha completato'),reopened:tr('ha riaperto'),
    comment_deleted:tr('Commento eliminato'),comment_edited:tr('Commento modificato'),comment_replied:tr('Risposta pubblicata'),
    comment_pinned:tr('Commento in evidenza'),comment_unpinned:tr('Evidenza del commento rimossa'),
    reacted:tr('Reazione aggiunta'),reaction_removed:tr('Reazione rimossa'),
    field_created:tr('Campo creato'),field_updated:tr('Campo aggiornato'),fields_updated:tr('Valori dei campi aggiornati'),
    milestone_created:tr('Traguardo creato'),milestone_updated:tr('Traguardo aggiornato'),planning_updated:tr('Pianificazione aggiornata'),
    dependency_added:tr('Dipendenza aggiunta'),dependency_removed:tr('Dipendenza rimossa'),
    attachment_added:tr('Allegato aggiunto'),attachment_deleted:tr('Allegato eliminato'),attachment_restored:tr('Allegato ripristinato'),
    membership_updated:tr('Permessi del membro aggiornati'),membership_removed:tr('Membro rimosso'),
    time_logged:tr('Tempo registrato'),time_edited:tr('Registrazione del tempo modificata'),
    time_deleted:tr('Registrazione del tempo eliminata'),time_restored:tr('Registrazione del tempo ripristinata'),
    review_created:tr('Richiesta creata'),review_edited:tr('Dettagli modificati'),review_reviewers_changed:tr('Revisori cambiati'),
    review_voted:tr('Decisione registrata'),review_vote_withdrawn:tr('Decisione ritirata'),review_cancelled:tr('Richiesta annullata'),
    review_reopened:tr('Richiesta riaperta'),review_deleted:tr('Richiesta spostata nel cestino'),
    review_restored:tr('Richiesta ripristinata'),review_duplicated:tr('Richiesta duplicata'),
    sprint_created:tr('Sprint creato'),sprint_edited:tr('Sprint modificato'),sprint_activated:tr('Sprint attivato'),
    sprint_closed:tr('Sprint chiuso'),sprint_reopened:tr('Sprint riaperto'),sprint_deleted:tr('Sprint nel cestino'),
    sprint_restored:tr('Sprint ripristinato'),sprint_cards_added:tr('Schede aggiunte allo Sprint'),
    sprint_cards_removed:tr('Schede rimosse dallo Sprint'),sprint_capacity_set:tr('Capacità aggiornata'),
    sprint_snapshot_captured:tr('Osservazione salvata'),sprint_snapshot_deleted:tr('Osservazione eliminata')
  };
  return Object.hasOwn(names,action) ? names[action]:tr('Aggiornamento');
}
function entityLabel(kind) {
  const names={boards:tr('Bacheca'),columns:tr('Lista'),cards:tr('Scheda'),members:tr('Membro'),
    custom_fields:tr('Campo personalizzato'),milestones:tr('Traguardo'),sprints:tr('Sprint')};
  return Object.hasOwn(names,kind) ? names[kind]:tr('Elemento');
}
async function showMyTasks() {
  if (!state.auth?.user) { panel(tr('Mie attività'),ui`<p>Accedi con un account per vedere le schede assegnate a te attraverso i membri della bacheca.</p>`,'mytasks'); return; }
  await showPanel(tr('Mie attività'),async () => {
    const result = await api('/api/me/tasks'), cards = result.cards || [];
    return ui`<p>${cards.length} schede assegnate a ${escapeHTML(state.auth.user.name)} · ${cards.filter((card) => overdue(card)).length} scadute</p>${cards.map((card) => ui`<button type="button" class="search-result" data-search-card="${Number(card.id)}" data-search-board="${Number(card.board_id)}"><strong>${card.completed ? '✓ ' : ''}${escapeHTML(card.title)}</strong><span>${escapeHTML(card.board_name)} / ${escapeHTML(card.column_title)}${card.due_date ? ' · '+escapeHTML(card.due_date) : ''}${card.blocked_reason ? tr(' · Bloccata') : ''}</span></button>`).join('') || ui`<p>Non hai schede assegnate. Apri una scheda e seleziona il tuo account in Membri assegnati.</p>`}`;
  },'mytasks');
}
function currentFilters() { return {search:state.query,label:state.label,assignee:state.assignee,priority:state.priority,status:state.status,sort:state.sort}; }
async function showSavedViews() {
  const boardId = state.board?.id; if (!boardId) return;
  state.savedViewsBoard = boardId;
  await showPanel(tr('Filtri salvati'),async () => {
    const result = await api(`/api/boards/${boardId}/views`); state.savedViews = result.views || [];
    return ui`<p>Salva la ricerca, i filtri e l’ordinamento attuali per questa bacheca.</p><form id="saved-view-form" data-board="${boardId}"><label class="field-label" for="saved-view-name">Nome del filtro</label><input id="saved-view-name" maxlength="100" required><button class="button primary" type="submit">Salva filtri attuali</button></form><div class="saved-views">${state.savedViews.map((view) => ui`<form data-view-form="${Number(view.id)}"><label><span class="sr-only">Nome filtro salvato</span><input name="name" value="${escapeHTML(view.name)}" required maxlength="100"></label><button type="button" class="button secondary" data-apply-view="${Number(view.id)}">Applica</button><button type="submit" class="subtle-button">Rinomina</button><button type="button" class="button danger-subtle" data-delete-view="${Number(view.id)}">Elimina</button></form>`).join('') || ui`<p>Nessun filtro salvato.</p>`}</div><p id="panel-error" class="form-error" role="alert"></p>`;
  },'views');
}
function applySavedView(id) {
  if (state.savedViewsBoard !== state.board?.id) { toast(tr('Riapri i filtri salvati per la bacheca corrente.'),true); return; }
  const view = (state.savedViews || []).find((item) => item.id === Number(id)); if (!view) return;
  const filters = view.filters || {};
  state.query = filters.search || ''; $('search-input').value = state.query;
  for (const name of ['label','assignee','priority','status','sort']) { const value = filters[name] || (name === 'sort' ? 'manual' : ''); state[name] = value; $(`${name}-filter`).value = value; }
  closeDialog('panel-dialog'); renderBoard(); toast(tr`Filtro “${view.name}” applicato.`);
}
function saveTemplate(kind) {
  const id = kind === 'cards' ? state.cardEditor?.id : state.board?.id;
  if (!id) return;
  if (kind === 'cards' && editorDirty('card-dialog')) { toast(tr('Salva la bozza prima di creare un modello.'),true); return; }
  panel(kind === 'cards' ? tr('Salva modello di scheda') : tr('Salva modello di bacheca'),ui`<p>Il modello conserva i contenuti salvati. Commenti, allegati e account restano esclusi.</p><form id="save-template-form" data-kind="${kind}" data-source="${Number(id)}"><label class="field-label" for="template-name">Nome del modello</label><input id="template-name" required maxlength="100"><button type="submit" class="button primary" data-write>Salva modello</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'save-template');
  $('template-name').focus();
}
async function showTemplates() {
  const boardId = state.board?.id, columns = [...(state.board?.columns || [])];
  await showPanel(tr('Modelli riutilizzabili'),async () => {
    const results = await Promise.all([api('/api/templates/cards'),api('/api/templates/boards')]);
    return ui`<p>Usa un modello per creare nuovi elementi. La bacheca di partenza conserva i propri dati.</p><section><h3>Modelli di scheda</h3><label class="field-label" for="template-column">Lista di destinazione</label><select id="template-column">${columns.map((column) => ui`<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('')}</select>${(results[0].templates || []).map((template) => ui`<div class="template-row"><strong>${escapeHTML(template.name)}</strong><button type="button" class="button secondary" data-instantiate-template="${Number(template.id)}" data-template-kind="cards" data-template-board="${Number(boardId)}" data-write>Crea scheda</button><button type="button" class="button danger-subtle" data-delete-template="${Number(template.id)}" data-template-kind="cards" data-write>Elimina modello</button></div>`).join('') || ui`<p>Nessun modello di scheda. Usa Salva modello nell’editor.</p>`}</section><section><h3>Modelli di bacheca</h3>${(results[1].templates || []).map((template) => ui`<div class="template-row"><strong>${escapeHTML(template.name)}</strong><button type="button" class="button secondary" data-instantiate-template="${Number(template.id)}" data-template-kind="boards" data-product-create ${!canCreateBoard() ? 'disabled' : ''}>Crea bacheca</button><button type="button" class="button danger-subtle" data-delete-template="${Number(template.id)}" data-template-kind="boards" data-write>Elimina modello</button></div>`).join('') || ui`<p>Nessun modello di bacheca. Usa Salva come modello nelle opzioni della bacheca.</p>`}</section><p id="panel-error" class="form-error" role="alert"></p>`;
  },'templates');
}
async function bulkCards(action) {
  const boardId = state.board?.id, cards = [...state.selectedCards].map(([id,version]) => ({id,version}));
  if (!boardId || !cards.length || !canWrite()) return;
  if (action === 'archive' && !confirm(tr`Archiviare ${cards.length} schede selezionate? Potrai recuperarle mostrando le schede archiviate.`)) return;
  await perform(() => committed(() => api(`/api/boards/${boardId}/bulk`,'POST',{action,cards,value:true}),async () => { state.selectedCards.clear(); await refreshBoard(); },action === 'complete' ? tr`${cards.length} schede completate.` : tr`${cards.length} schede archiviate.`));
}
async function showSessions() {
  await showPanel(tr('Sessioni del tuo account'),async () => {
    const result = await api('/api/me/sessions');
    const date = (value) => new Date(Number(value)*1000).toLocaleString(OpenBoardI18n.locale);
    return ui`<p>Revoca l’accesso da altri dispositivi. Questa sessione resta aperta.</p><button id="revoke-other-sessions" class="button secondary" type="button">Revoca tutte le altre sessioni</button>${(result.sessions || []).map((session) => ui`<div class="session-row"><div><strong>${session.current ? tr('Questa sessione') : tr('Altra sessione')}</strong><span>Accesso: ${escapeHTML(date(session.created_at))}<br>Ultima attività: ${escapeHTML(date(session.last_seen))}<br>Scade: ${escapeHTML(date(session.expires_at))}</span></div>${!session.current ? ui`<button class="button danger-subtle" type="button" data-revoke-session="${escapeHTML(session.id)}">Revoca</button>` : ''}</div>`).join('')}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'sessions');
}
async function showEditComment(id) {
  const editor = state.cardEditor, comment = (editor?.comments || []).find((item) => item.id === Number(id));
  if (!comment) return;
  panel(tr('Modifica il tuo commento'),ui`<form id="edit-comment-form" data-comment="${Number(id)}" data-version="${Number(comment.version)}" data-card="${Number(editor.id)}"><label class="field-label" for="edit-comment-body">Commento</label><textarea id="edit-comment-body" rows="5" required maxlength="5000">${escapeHTML(comment.body)}</textarea><button class="button primary" type="submit" data-write>Salva commento</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'edit-comment');
}
async function exportProductivity(kind) {
  const board = state.board; if (!board) return;
  await perform(async () => {
    const result = await api(`/api/boards/${board.id}/export`), full = result.board || result;
    const csv = kind === 'csv'; downloadBlob(new Blob([csv ? productivity.csv(full) : productivity.calendar(full)],{type:csv ? 'text/csv;charset=utf-8' : 'text/calendar;charset=utf-8'}),`${board.name}.${csv ? 'csv':'ics'}`);
    toast(csv ? tr('CSV completo scaricato con celle protette per i fogli di calcolo.') : tr('Calendario scaricato con scadenze e date di inizio.'));
  });
}
function showShortcuts() { panel(tr('Scorciatoie da tastiera'),ui`<dl class="shortcuts"><dt>⌘ / Ctrl + K</dt><dd>Vai alla ricerca della bacheca</dd><dt>⌘ / Ctrl + Shift + P</dt><dd>Comandi</dd><dt>N</dt><dd>Nuova scheda</dd><dt>F</dt><dd>Ricerca nella bacheca</dd><dt>G</dt><dd>Ricerca globale</dd><dt>?</dt><dd>Mostra questa guida</dd><dt>Invio / Spazio su una scheda</dt><dd>Apri scheda</dd><dt>M su una scheda</dt><dd>Apri e sposta scheda</dd><dt>↑ ↓ ← → / Home / End</dt><dd>Naviga fra le schede; Ctrl + Home / End va alla prima o ultima scheda.</dd><dt>Esc</dt><dd>Chiudi il pannello o editor (con conferma per bozze)</dd></dl><p>Le scorciatoie N, F, G e ? funzionano quando non stai scrivendo e non ci sono finestre aperte.</p>`,'shortcuts'); }

document.addEventListener('click',async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.dataset.dateOffset !== undefined) { $('card-due-date').value = target.dataset.dateOffset === 'clear' ? '' : dateOffset(Number(target.dataset.dateOffset)); saveDraft(); return; }
  if (target.dataset.removeDependency) { changeDependency(target.dataset.removeDependency,true); return; }
  if (target.dataset.dependencyOpen) { if (closeDialog('card-dialog')) openCard(target.dataset.dependencyOpen); return; }
  if (target.dataset.downloadAttachment) { downloadAttachment(target.dataset.downloadAttachment); return; }
  if (target.dataset.deleteAttachment || target.dataset.restoreAttachment) {
    const id = Number(target.dataset.deleteAttachment || target.dataset.restoreAttachment), cardId = state.cardEditor?.id, restore = !!target.dataset.restoreAttachment;
    if (!restore && !confirm(tr('Spostare questo allegato nel cestino?'))) return;
    perform(() => committed(() => api(`/api/attachments/${id}${restore ? '/restore':''}`,restore ? 'POST':'DELETE',restore ? {}:undefined),() => loadAttachments(cardId),restore ? tr('Allegato ripristinato.') : tr('Allegato eliminato.')),'','card-form-error'); return;
  }
  if (target.dataset.editComment) { showEditComment(target.dataset.editComment); return; }
  if (target.dataset.applyView) { applySavedView(target.dataset.applyView); return; }
  if (target.dataset.deleteView) { perform(() => committed(() => api(`/api/views/${Number(target.dataset.deleteView)}`,'DELETE'),showSavedViews,tr('Filtro eliminato.')),'','panel-error'); return; }
  if (target.dataset.deleteTemplate) { if (!confirm(tr('Eliminare questo modello? Gli elementi già creati restano disponibili.'))) return; perform(() => committed(() => api(`/api/templates/${target.dataset.templateKind}/${Number(target.dataset.deleteTemplate)}`,'DELETE'),showTemplates,tr('Modello eliminato.')),'','panel-error'); return; }
  if (target.dataset.instantiateTemplate) {
    const kind = target.dataset.templateKind, boardId = state.board?.id;
    if (kind === 'cards' && boardId !== Number(target.dataset.templateBoard)) return;
    const data = kind === 'cards' ? {column_id:Number($('template-column').value)} : {};
    perform(() => committed(() => api(`/api/templates/${kind}/${Number(target.dataset.instantiateTemplate)}/instantiate`,'POST',data),async (result) => { closeDialog('panel-dialog',{force:true}); if (kind === 'boards') { await refreshBoards(); await selectBoard(result.id,{quiet:true}); } else if (state.board?.id === boardId) await refreshBoard(); },kind === 'boards' ? tr('Bacheca creata dal modello.') : tr('Scheda creata dal modello.')),'','panel-error'); return;
  }
  if (target.dataset.notificationRead) { perform(() => committed(() => api(`/api/notifications/${Number(target.dataset.notificationRead)}`,'PATCH',{read:true}),showNotifications,tr('Notifica letta.')),'','panel-error'); return; }
  if (target.dataset.notificationOpen) {
    await perform(async () => { await api(`/api/notifications/${Number(target.dataset.notificationOpen)}`,'PATCH',{read:true}); refreshNotifications(); });
    if (!closeEditors()) return; closeDialog('panel-dialog'); await selectBoard(target.dataset.notificationBoard); if (target.dataset.notificationCard && !state.loadError) await openCard(target.dataset.notificationCard); return;
  }
  if (target.dataset.revokeSession) { perform(() => committed(() => api(`/api/me/sessions/${target.dataset.revokeSession}`,'DELETE'),showSessions,tr('Sessione revocata.')),'','panel-error'); return; }
  switch (target.id) {
    case 'timer-toggle': {
      if (!state.cardEditor?.id || !canWrite()) break;
      const timer = readTimer();
      if (timer) { $('card-actual').value = Math.min(1000000,Math.max(Number($('card-actual').value)||0,timer.base)+Math.ceil(Math.max(0,Date.now()-timer.started)/60000)); forget(timerKey()); saveDraft(); toast(tr('Minuti aggiunti alla bozza. Salva la scheda per registrarli sul server.')); }
      else { remember(timerKey(),JSON.stringify({started:Date.now(),base:Number($('card-actual').value)||0})); toast(tr('Timer avviato. Resta disponibile su questo dispositivo anche dopo un ricaricamento.')); }
      renderTimer(); break;
    }
    case 'add-dependency': changeDependency($('dependency-card').value,false); break;
    case 'upload-attachment': uploadAttachment(); break;
    case 'watch-board': toggleWatch(false); break;
    case 'watch-card': toggleWatch(true); break;
    case 'notifications': showNotifications(); break;
    case 'notifications-read-all': perform(() => committed(() => api('/api/notifications/read-all','POST',{}),showNotifications,tr('Tutte le notifiche segnate come lette.')),'','panel-error'); break;
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
    case 'revoke-other-sessions': perform(() => committed(() => api('/api/me/sessions/revoke-others','POST',{}),showSessions,tr('Altre sessioni revocate.')),'','panel-error'); break;
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
  if (form.id === 'profile-form') { perform(() => committed(() => api('/api/me/profile','PATCH',{name:$('profile-name').value.trim()}),async () => { setSession(await api('/api/auth/session')); renderHeader(); showAccount(); },tr('Nome aggiornato.')),'','panel-error'); }
  else if (form.id === 'saved-view-form') { const boardId = Number(form.dataset.board); if (state.board?.id !== boardId) return; perform(() => committed(() => api(`/api/boards/${boardId}/views`,'POST',{name:$('saved-view-name').value.trim(),filters:currentFilters()}),showSavedViews,tr('Filtri salvati.')),'','panel-error'); }
  else if (form.dataset.viewForm) { perform(() => committed(() => api(`/api/views/${Number(form.dataset.viewForm)}`,'PATCH',{name:form.elements.name.value.trim()}),showSavedViews,tr('Filtro rinominato.')),'','panel-error'); }
  else if (form.id === 'save-template-form') { const kind = form.dataset.kind, id = Number(form.dataset.source); perform(() => committed(() => api(`/api/templates/${kind}`,'POST',{name:$('template-name').value.trim(),[kind === 'cards' ? 'card_id':'board_id']:id}),showTemplates,tr('Modello salvato.')),'','panel-error'); }
  else if (form.id === 'edit-comment-form') { const cardId = Number(form.dataset.card); perform(() => committed(() => api(`/api/comments/${Number(form.dataset.comment)}`,'PATCH',{body:$('edit-comment-body').value.trim()},{version:Number(form.dataset.version)}),async () => { closeDialog('panel-dialog',{force:true}); if (state.cardEditor?.id === cardId) await loadComments(cardId); },tr('Commento aggiornato.')),'','panel-error'); }
});
document.addEventListener('keydown',(event) => {
  if (productivity.composing(event)) return;
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
document.addEventListener('openboard:languagechange',(event) => {
  const openEditor=document.querySelector('dialog[open]:not(#auth-dialog)');
  if(state.saving || openEditor) {
    event.preventDefault();
    const message=state.saving ? tr('Attendi il completamento del salvataggio prima di cambiare lingua.'):tr('Chiudi l’editor o il pannello prima di cambiare lingua. Le bozze restano conservate.');
    document.querySelectorAll('[data-language-status]').forEach(node=>{node.textContent=message;});
  }
});
document.addEventListener('DOMContentLoaded',loadInitial,{once:true});

/* Personal browser tools. Storage and tab messages never grant authorization. */
function localDrafts() {
  const owner=sessionOwner();
  try { return productivity.listCardDrafts(localStorage,owner); } catch { return []; }
}
function showDraftCenter() {
  if (state.saving || (state.auth?.enabled && !state.auth.user) || !closeEditors()) return;
  saveDraft();
  const context=sessionContext();
  state.draftCenter={context,items:localDrafts()};
  panel(tr('Bozze delle schede'),ui`<p>Bozze locali delle schede per questo account. La riapertura verifica i permessi sul server. Le bozze di revisioni, commenti e moduli restano nei rispettivi editor.</p><div class="draft-center">${state.draftCenter.items.map((item,index)=>ui`<article class="draft-row"><div><strong>${escapeHTML(item.title || tr('Nuova scheda'))}</strong><time>${escapeHTML(formatDate(new Date(item.updatedAt).toISOString()))}</time><span>${item.cardId ? tr('Scheda esistente'):tr('Nuova scheda')}</span></div><button type="button" class="button secondary" data-draft-resume="${index}">Riprendi</button><button type="button" class="button danger-subtle" data-draft-discard="${index}">Scarta</button></article>`).join('') || ui`<p>Nessuna bozza di scheda disponibile.</p>`}</div><p id="panel-error" class="form-error" role="alert"></p>`,'draft-center');
}
async function resumeCardDraft(index) {
  const center=state.draftCenter,item=center?.items[index];
  if (!item || !sessionCurrent(center.context) || !closeEditors()) return;
  // Rehydrate the current authorized board and card, then use the existing
  // recovery action rather than trusting board/card data found in local storage.
  closeDialog('panel-dialog',{force:true});
  await selectBoard(item.boardId,{reset:false,quiet:true});
  if (!sessionCurrent(center.context) || state.board?.id!==item.boardId) return;
  const editor=await openCard(item.cardId);
  if (!editor || !sessionCurrent(center.context) || state.board?.id!==item.boardId || state.cardEditor!==editor || editor.id!==item.cardId || !$('card-dialog').open) return;
  $('recover-draft').click();
}
let tabChannel;
try { if (typeof BroadcastChannel==='function') tabChannel=new BroadcastChannel('openboard.session-events.v1'); } catch { /* Storage fallback below. */ }
let tabStorage;
try { tabStorage=localStorage; } catch { /* Browser storage can be disabled. */ }
const sessionTabs=productivity.tabSessionBridge({storage:tabStorage,channel:tabChannel,id:uuid,onLogout() {
  if (!state.auth?.user) return;
  saveDraft(); invalidateSession();
  setSession({enabled:true,setup_required:false,user:null,csrf:''});
  state.draftCenter=null;state.commandActions=[];
  showAuth(false);
  toast(tr('Disconnessione da un’altra scheda del browser. Accedi di nuovo.'),true);
}});
if (tabChannel) tabChannel.onmessage=event=>sessionTabs.receive(event.data);
window.addEventListener('storage',event=>{if(event.key===sessionTabs.key && event.newValue)sessionTabs.receive(event.newValue);});

function calendarControls(mode,anchor) {
  return ui`<div class="calendar-controls" role="group" aria-label="Periodo del calendario">${mode==='agenda' ? '':ui`<button type="button" class="button secondary" data-calendar-shift="-1" aria-label="Periodo precedente">←</button><button type="button" class="button secondary" data-calendar-today>Oggi</button><button type="button" class="button secondary" data-calendar-shift="1" aria-label="Periodo successivo">→</button><label>Data di riferimento<input id="calendar-anchor" type="date" min="0001-01-01" max="9999-12-31" value="${anchor}"></label>`}${[['agenda',tr('Agenda')],['month',tr('Mese')],['week',tr('Settimana')]].map(([value,label])=>ui`<button type="button" class="button secondary" data-calendar-mode="${value}" aria-pressed="${mode===value}">${label}</button>`).join('')}</div>`;
}
function refreshCalendarControl(selector) {
  renderBoard();$('board-canvas').querySelector(selector)?.focus({preventScroll:true});
}
function renderCalendar() {
  const mode=['month','week'].includes(state.calendarMode) ? state.calendarMode:'agenda';
  const anchor=state.calendarAnchor || todayISO();
  if (mode==='agenda') return calendarControls(mode,anchor)+renderCalendarAgenda();
  const period=productivity.calendarPeriod(mode,anchor),cards=allCards().filter(matches);
  const title=mode==='month' ? new Intl.DateTimeFormat(OpenBoardI18n.locale,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(period.anchor+'T12:00:00Z')):period.days.filter(Boolean).filter((day,index,days)=>index===0 || index===days.length-1).map(productivity.dateText).join(' – ');
  const weekdays=period.days.slice(0,7).map(day=>day ? new Intl.DateTimeFormat(OpenBoardI18n.locale,{weekday:'short',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z')):'');
  return calendarControls(mode,anchor)+ui`<h2 class="calendar-heading">${escapeHTML(title)}</h2><div class="calendar-grid-scroll" tabindex="0" role="region" aria-label="Calendario schede"><div class="calendar-grid">${weekdays.map(day=>ui`<div class="calendar-weekday">${escapeHTML(day)}</div>`).join('')}${period.days.map(day=>day ? ui`<section class="calendar-cell ${day.slice(0,7)!==period.anchor.slice(0,7) ? 'outside-period':''}"><h3><time datetime="${day}">${escapeHTML(productivity.dateText(day))}</time></h3>${cards.filter(card=>card.due_date===day).map(renderCard).join('')}</section>`:ui`<div aria-hidden="true"></div>`).join('')}</div></div><section class="calendar-undated"><h2>Senza scadenza</h2>${cards.filter(card=>!card.due_date).map(renderCard).join('')}</section>`;
}
function commandActions() {
  const signedIn=!state.auth?.enabled || !!state.auth.user;
  if (!signedIn) return [];
  return [
    {id:'drafts',name:tr('Bozze delle schede'),run:showDraftCenter},
    {id:'search',name:tr('Ricerca in tutte le bacheche'),run:showGlobalSearch},
    {id:'account',name:tr('Il tuo profilo'),run:showAccount},
    {id:'shortcuts',name:tr('Scorciatoie da tastiera'),run:showShortcuts},
    ...(canCreateBoard() ? [{id:'board',name:tr('Nuova bacheca'),run:()=>openBoardEditor()}]:[]),
    ...(state.board ? [{id:'calendar',name:tr('Calendario'),run:()=>setView('calendar')},{id:'table',name:tr('Tabella'),run:()=>setView('table')},{id:'timeline',name:tr('Timeline'),run:()=>setView('timeline')}]:[]),
    ...(state.board?.columns.length && canWrite() ? [{id:'card',name:tr('Nuova scheda'),run:()=>openCard()}]:[])
  ];
}
function showCommandPalette() {
  if (state.saving || !closeEditors()) return;
  state.commandContext=sessionContext();state.commandActions=commandActions();
  panel(tr('Comandi'),ui`<label class="field-label" for="command-query">Cerca comandi</label><input id="command-query" type="search" autocomplete="off"><div id="command-results"></div>`,'commands');
  renderCommands('');$('command-query').focus();
}
function renderCommands(query) {
  if (state.panel!=='commands' || !sessionCurrent(state.commandContext)) return;
  const needle=query.trim().toLocaleLowerCase(OpenBoardI18n.locale);
  $('command-results').innerHTML=(state.commandActions || []).filter(item=>item.name.toLocaleLowerCase(OpenBoardI18n.locale).includes(needle)).map(item=>ui`<button type="button" class="command-option button secondary" data-command="${item.id}">${escapeHTML(item.name)}</button>`).join('') || ui`<p>Nessun comando disponibile.</p>`;
}
function fieldError(input,message) {
  if (!input?.form) return;
  if (!input.id) input.id=`field-${uuid()}`;
  const id=input.id+'-validation';
  let error=$(id);
  if (!error) { error=document.createElement('span');error.id=id;error.className='field-validation';input.insertAdjacentElement('afterend',error); }
  error.textContent=message;
  input.setAttribute('aria-invalid','true');
  const descriptions=new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));descriptions.add(id);
  input.setAttribute('aria-describedby',[...descriptions].join(' '));
}
function clearFieldError(input) {
  if (!input?.id) return;
  const id=input.id+'-validation';$(id)?.remove();input.removeAttribute('aria-invalid');
  const descriptions=(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(value=>value && value!==id);
  if(descriptions.length)input.setAttribute('aria-describedby',descriptions.join(' '));else input.removeAttribute('aria-describedby');
}
function clearFormErrors(form) {
  if(!form)return;
  for(const input of form.elements)clearFieldError(input);
  form.querySelector('.validation-summary')?.remove();
}
function showFormErrors(form) {
  if (!form) return;
  const invalid=[...form.elements].filter(input=>input.willValidate && !input.validity.valid);
  let summary=form.querySelector('.validation-summary');
  if (!invalid.length) { summary?.remove();return; }
  if (!summary) { summary=document.createElement('div');summary.className='validation-summary';summary.setAttribute('role','alert');form.prepend(summary); }
  invalid.forEach(input=>fieldError(input,input.validationMessage));
  summary.innerHTML=ui`<p>Controlla i campi indicati.</p><ul>${invalid.map(input=>ui`<li><button class="subtle-button" type="button" data-error-field="${escapeHTML(input.id)}">${escapeHTML(input.labels?.[0]?.textContent?.trim() || input.name || tr('Campo'))}: ${escapeHTML(input.validationMessage)}</button></li>`).join('')}</ul>`;
}
document.addEventListener('invalid',event=>{fieldError(event.target,event.target.validationMessage);showFormErrors(event.target.form);},true);
document.addEventListener('reset',event=>clearFormErrors(event.target),true);
document.addEventListener('input',event=>{if(event.target.validity?.valid){clearFieldError(event.target);if(event.target.form?.querySelector('.validation-summary'))showFormErrors(event.target.form);}if(event.target.id==='command-query' && !productivity.composing(event))renderCommands(event.target.value);});
document.addEventListener('compositionend',event=>{if(event.target.id==='command-query')renderCommands(event.target.value);if(event.target.id==='global-query')globalSearch(event.target.value);});
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target || target.disabled)return;
  if(target.id==='drafts-nav' || target.hasAttribute('data-show-drafts'))showDraftCenter();
  if(target.id==='commands-nav' || target.hasAttribute('data-show-commands'))showCommandPalette();
  if(target.id==='global-more' && state.globalSearch?.query===$('global-query').value.trim())globalSearch(state.globalSearch.query,true);
  if(target.dataset.errorField)$(target.dataset.errorField)?.focus();
  if(target.dataset.draftResume!==undefined)resumeCardDraft(Number(target.dataset.draftResume)).catch(error=>{if(!error.staleSession)toast(error.message,true);});
  if(target.dataset.draftDiscard!==undefined){const center=state.draftCenter,item=center?.items[Number(target.dataset.draftDiscard)];if(item && sessionCurrent(center.context)){const removed=productivity.removeOwnedDraft(tabStorage,item,sessionOwner());if(!removed)toast(tr('La bozza è cambiata. Aggiorna l’elenco prima di eliminarla.'),true);showDraftCenter();}}
  if(target.dataset.command){if(state.panel!=='commands' || !sessionCurrent(state.commandContext))return;const action=commandActions().find(item=>item.id===target.dataset.command);if(action){closeDialog('panel-dialog',{force:true});action.run();}}
  if(target.dataset.calendarMode && ['agenda','month','week'].includes(target.dataset.calendarMode)){state.calendarMode=target.dataset.calendarMode;refreshCalendarControl(`[data-calendar-mode="${target.dataset.calendarMode}"]`);}
  if(target.dataset.calendarShift && ['-1','1'].includes(target.dataset.calendarShift)){state.calendarAnchor=productivity.calendarPeriod(state.calendarMode==='week' ? 'week':'month',state.calendarAnchor || todayISO(),Number(target.dataset.calendarShift)).anchor;refreshCalendarControl(`[data-calendar-shift="${target.dataset.calendarShift}"]`);}
  if(target.hasAttribute('data-calendar-today')){state.calendarAnchor=todayISO();refreshCalendarControl('[data-calendar-today]');}
});
document.addEventListener('change',event=>{if(event.target.id==='calendar-anchor' && productivity.validDate(event.target.value) && event.target.value>='0001-01-01'){state.calendarAnchor=event.target.value;refreshCalendarControl('#calendar-anchor');}});
document.addEventListener('keydown',event=>{
  if(productivity.composing(event))return;
  if((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase()==='p'){event.preventDefault();if(!document.querySelector('dialog[open]'))showCommandPalette();return;}
  if(event.target.id==='command-query' && event.key==='ArrowDown'){event.preventDefault();$('command-results').querySelector('button')?.focus();return;}
  const card=event.target.matches?.('[data-card-id]') ? event.target:null;
  if(!card || event.altKey || event.metaKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const groups=[...$('board-canvas').querySelectorAll('.column-cards')].map(column=>[...column.querySelectorAll('[data-card-id]')].map(node=>node.dataset.cardId));
  if(!groups.length)groups.push([...$('board-canvas').querySelectorAll('[data-card-id]')].map(node=>node.dataset.cardId));
  const id=productivity.navigateCards(groups,card.dataset.cardId,event.key,event.ctrlKey);
  if(id!==null){event.preventDefault();$('board-canvas').querySelector(`[data-card-id="${Number(id)}"]`)?.focus();}
});

/* Administrator-only capacity measurements. Refresh is explicit; no data is
 * cached in browser storage and late replies cannot populate another panel. */
function canInspectStorage() {
  return state.auth?.enabled===false || (state.auth?.enabled===true && state.auth.user?.role==='admin');
}
function storageCount(value) {
  return Number.isSafeInteger(value) && value>=0 ? OpenBoardI18n.number(value):tr('Non disponibile');
}
function storageBytes(value) {
  if(!Number.isSafeInteger(value) || value<0)return tr('Non disponibile');
  if(value<1024)return new Intl.NumberFormat(OpenBoardI18n.locale,{style:'unit',unit:'byte',unitDisplay:'short',maximumFractionDigits:0}).format(value);
  const units=[tr('KiB'),tr('MiB'),tr('GiB'),tr('TiB'),tr('PiB')];let amount=value/1024,index=0;
  while(amount>=1024 && index<units.length-1){amount/=1024;index++;}
  return OpenBoardI18n.number(amount,{maximumFractionDigits:2})+' '+units[index];
}
function storageBytesCell(value) {
  const exact=Number.isSafeInteger(value) && value>=0 ? new Intl.NumberFormat(OpenBoardI18n.locale,{style:'unit',unit:'byte',unitDisplay:'short',maximumFractionDigits:0}).format(value):tr('Non disponibile');
  return ui`<span title="${escapeHTML(exact)}">${escapeHTML(storageBytes(value))}</span>`;
}
function renderStorageCapacity(result) {
  const attachments=result?.attachments || {},cache=result?.cache || {},history=result?.history || {};
  const number=value=>escapeHTML(storageCount(value)),bytes=storageBytesCell;
  const unlimited=()=>escapeHTML(tr('Illimitato'));
  const limit=(value,formatter)=>value===0 ? unlimited():formatter(value);
  const remaining=(value,maximum,formatter)=>maximum===0 ? unlimited():formatter(value);
  const row=(label,value)=>ui`<tr><th scope="row">${escapeHTML(label)}</th><td>${value}</td></tr>`;
  const pair=(label,group)=>ui`<tr><th scope="row">${escapeHTML(label)}</th><td>${number(group?.files)}</td><td>${bytes(group?.bytes)}</td></tr>`;
  const boolean=value=>escapeHTML(value===true ? tr('Sì'):value===false ? tr('No'):tr('Non disponibile'));
  const external=result?.storage_mode==='postgresql+mongodb';
  return ui`<p><strong>Archivio:</strong> ${escapeHTML(productivity.storageLabel(result?.storage_mode) || tr('Non disponibile'))}</p>
    ${attachments.over_limit===true ? ui`<p class="capacity-warning" role="alert">Quota totale degli allegati superata. I dati conservati restano inclusi nel conteggio.</p>`:''}
    <div class="capacity-table-scroll"><table class="capacity-table"><caption>Allegati conservati</caption><thead><tr><th scope="col">Stato</th><th scope="col">File</th><th scope="col">Byte decodificati</th></tr></thead><tbody>
    ${pair(tr('Attivi'),attachments.active)}${pair(tr('Nel cestino o con antenati eliminati'),attachments.trashed)}${pair(tr('Totale conservato'),attachments.total)}
    <tr><th scope="row">Limite totale</th><td>${limit(attachments.limits?.files,number)}</td><td>${limit(attachments.limits?.bytes,bytes)}</td></tr>
    <tr><th scope="row">Residuo della quota</th><td>${remaining(attachments.remaining?.files,attachments.limits?.files,number)}</td><td>${remaining(attachments.remaining?.bytes,attachments.limits?.bytes,bytes)}</td></tr></tbody></table></div>
    <p>Le quote includono tutti gli allegati trattenuti, anche nel cestino o sotto schede, liste e bacheche eliminate. Eliminare o ripristinare non libera la quota totale.</p>
    <p>Il totale misura i byte decodificati degli allegati. Non comprende cronologia, replay, indici, WAL, backup o lo spazio fisico complessivo.</p>
    <div class="capacity-table-scroll"><table class="capacity-table"><caption>Database SQLite locale</caption><tbody>
    ${row(tr('File database'),bytes(cache.database_bytes))}${row(tr('Dimensione logica del database'),bytes(cache.logical_database_bytes))}${row(tr('File WAL'),bytes(cache.wal_bytes))}${row(tr('File SHM'),bytes(cache.shm_bytes))}${row(tr('Pagine libere nel database'),bytes(cache.freelist_bytes))}${row(tr('Spazio disponibile sul filesystem'),bytes(cache.filesystem_available_bytes))}
    ${row(tr('Minimo libero richiesto'),cache.minimum_free_bytes===0 ? escapeHTML(tr('Disattivato')):bytes(cache.minimum_free_bytes))}${row(tr('Massimo database configurato'),limit(cache.maximum_database_bytes,bytes))}${row(tr('Misurazione disponibile'),boolean(cache.measurement_available))}${row(tr('Controllo capacità superato'),boolean(cache.capacity_ok))}</tbody></table></div>
    ${external ? ui`<p>In modalità PostgreSQL + MongoDB queste misure riguardano la cache SQLite locale. Le dimensioni fisiche dei database esterni e i documenti MongoDB orfani non sono misurati.</p>`:''}
    <p>Le pagine libere sono riutilizzabili da SQLite: non sono spazio libero del filesystem.</p>
    <div class="capacity-table-scroll"><table class="capacity-table"><caption>Cronologia e replay</caption><tbody>
    ${row(tr('Attività'),number(history.activity_rows))}${row(tr('Commenti'),number(history.comments_rows))}${row(tr('Eventi revisioni'),number(history.review_events_rows))}${row(tr('Eventi Sprint'),number(history.sprint_events_rows))}${row(tr('Eventi richieste'),number(history.intake_events_rows))}${row(tr('Record di idempotenza'),number(history.idempotency_rows))}${row(tr('Corpi richieste idempotenti'),bytes(history.idempotency_request_bytes))}${row(tr('Corpi risposte idempotenti'),bytes(history.idempotency_response_bytes))}</tbody></table></div>
    <p>Il pannello è di sola lettura. La gestione della conservazione dei dati resta un’operazione separata.</p>`;
}
async function showStorageCapacity() {
  if(!canInspectStorage() || state.saving || !closeEditors())return;
  panel(tr('Capacità e conservazione'),ui`<button id="storage-refresh" type="button" class="button secondary">Aggiorna misure</button><p id="storage-status" role="status" aria-live="polite"></p><div id="storage-content"></div><p id="storage-error" class="form-error" role="alert"></p>`,'storage-capacity');
  await refreshStorageCapacity();
}
async function refreshStorageCapacity() {
  if(!canInspectStorage() || state.panel!=='storage-capacity' || !$('panel-dialog').open)return;
  const context=sessionContext(),panelSequence=state.panelSequence,sequence=state.storageSequence=(state.storageSequence || 0)+1;
  const current=()=>canInspectStorage() && sessionCurrent(context) && state.panel==='storage-capacity' && state.panelSequence===panelSequence && state.storageSequence===sequence && $('panel-dialog').open;
  $('storage-refresh').disabled=true;$('storage-content').setAttribute('aria-busy','true');$('storage-status').textContent=tr('Caricamento…');$('storage-error').textContent='';
  try {
    const result=await api('/api/admin/storage');
    if(!current())return;
    $('storage-content').innerHTML=renderStorageCapacity(result);
    $('storage-status').textContent=tr`Ultimo aggiornamento: ${formatDate(new Date().toISOString())}`;
  } catch(error) {
    if(!current() || error.staleSession)return;
    if(error.status===401 || error.status===403)$('storage-content').innerHTML='';
    $('storage-error').textContent=error.message;$('storage-status').textContent=tr('Misure non aggiornate.');
  } finally {
    if(current()){$('storage-refresh').disabled=false;$('storage-content').setAttribute('aria-busy','false');}
  }
}
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target || target.disabled)return;
  if(target.hasAttribute('data-show-storage'))showStorageCapacity();
  if(target.id==='storage-refresh')refreshStorageCapacity();
});

/* Delegated table controls survive filtering and background refreshes. */
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target || target.disabled)return;
  if(target.hasAttribute('data-table-edit'))tableBeginEdit(Number(target.dataset.tableEdit));
  if(target.hasAttribute('data-table-cancel'))tableCancel(Number(target.dataset.tableCancel));
  if(target.hasAttribute('data-table-reload'))tableReload(Number(target.dataset.tableReload));
});
document.addEventListener('input',event=>{if(event.target.closest?.('[data-table-editor]'))tableCaptureInput(event.target);});
document.addEventListener('change',event=>{if(event.target.closest?.('[data-table-editor]'))tableCaptureInput(event.target);});
document.addEventListener('compositionstart',event=>{if(event.target.closest?.('[data-table-editor]'))tableComposition(event.target,true);});
document.addEventListener('compositionend',event=>{if(event.target.closest?.('[data-table-editor]'))tableComposition(event.target,false);});
document.addEventListener('submit',event=>{
  const form=event.target;if(!form.hasAttribute('data-table-editor'))return;
  event.preventDefault();
  if(productivity.composing(event))return;
  for(const input of form.querySelectorAll('input,select'))tableCaptureInput(input);
  tableSave(Number(form.dataset.tableEditor));
});
/* End delegated table controls. */

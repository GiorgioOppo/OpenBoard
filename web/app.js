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
const labels = {design:'Design',sviluppo:'Sviluppo',ricerca:'Ricerca',marketing:'Marketing',urgente:'Urgente'};
const covers = ['', 'sage', 'peach', 'lavender', 'blue'];
const baseAssignees = ['Giulia', 'Marco', 'Sofia', 'Luca'];
const state = {boards:[],board:null,query:'',label:'',assignee:'',view:'board',saving:false,loading:true,loadError:false,loadSequence:0,cardEditor:null,boardEditor:null,columnEditor:null,draggedCard:null,toastTimer:null};

function stored(key, fallback = '') { try { return localStorage.getItem(`openboard.${key}`) || fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(`openboard.${key}`, value); } catch { /* Preferences are optional. */ } }
state.view = stored('view') === 'list' ? 'list' : 'board';

function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); }); }
hydrateIcons();

async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {method,headers:body !== undefined ? {'Content-Type':'application/json'} : {},body:body !== undefined ? JSON.stringify(body) : undefined,signal:controller.signal});
    let result;
    try { result = await response.json(); } catch { throw new Error('Il server ha restituito una risposta non valida.'); }
    if (!response.ok) throw new Error(result.error || 'Non è stato possibile completare l’operazione.');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Il server sta impiegando troppo tempo. Riprova tra poco.');
    if (error instanceof TypeError) throw new Error('Impossibile raggiungere il server. Controlla che OpenBoard sia in esecuzione.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function toast(message, isError = false) {
  clearTimeout(state.toastTimer);
  $('toast-message').textContent = message;
  $('toast').classList.toggle('error', isError);
  $('toast').classList.add('visible');
  state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4000);
}

function updateBusy() {
  document.querySelectorAll('[data-write]').forEach((button) => { button.disabled = state.saving || state.loading; });
  document.querySelectorAll('dialog[open] input, dialog[open] textarea, dialog[open] select, dialog[open] button').forEach((element) => { element.disabled = state.saving; });
  $('add-card-main').disabled = state.saving || state.loading || !state.board?.columns.length;
  $('star-board').disabled = state.saving || state.loading || !state.board;
  $('edit-board').disabled = state.saving || state.loading || !state.board;
  $('export-board').disabled = state.loading || !state.board;
  $('save-status').textContent = state.saving ? 'Salvataggio in corso…' : state.loadError ? 'Connessione al server non disponibile' : 'Salvataggio locale · SQLite';
  document.body.setAttribute('aria-busy', String(state.saving));
}

async function perform(action, successMessage, errorId) {
  if (state.saving || state.loading) return;
  state.saving = true;
  if (errorId) $(errorId).textContent = '';
  updateBusy();
  try {
    await action();
    if (successMessage) toast(successMessage);
  } catch (error) {
    if (errorId && $(errorId).closest('dialog')?.open) $(errorId).textContent = error.message;
    else toast(error.message, true);
  } finally {
    state.saving = false;
    updateBusy();
  }
}

function allCards() { return state.board?.columns.flatMap((column) => column.cards) || []; }
function assignees() { return [...new Set([...baseAssignees,...allCards().map((card) => card.assignee).filter(Boolean)])]; }
function initials(name) { return String(name).trim().split(/\s+/).slice(0,2).map((part) => part.charAt(0)).join('').toLocaleUpperCase('it'); }
function avatar(name) {
  const index = assignees().indexOf(name);
  return `<span class="avatar a-${Math.max(index,0) % 5}" title="${escapeHTML(name)}" aria-label="${escapeHTML(name)}">${escapeHTML(initials(name))}</span>`;
}
function boardLink(board) {
  const color = covers.includes(board.color) ? board.color : 'sage';
  return `<button type="button" class="board-link ${state.board?.id === board.id ? 'selected' : ''}" data-select-board="${Number(board.id)}" ${state.board?.id === board.id ? 'aria-current="page"' : ''}><span class="board-color ${color}"></span><span>${escapeHTML(board.name)}</span></button>`;
}
function renderSidebar() {
  $('board-count').textContent = state.boards.length;
  $('board-links').innerHTML = state.boards.map(boardLink).join('');
  const starred = state.boards.filter((board) => board.starred);
  $('starred-boards').innerHTML = starred.length ? starred.map(boardLink).join('') : '<p class="empty-starred">Le tue preferite, a portata di mano.<br>Aggiungi una stella alla bacheca.</p>';
  $('mobile-board-links').innerHTML = state.boards.map(boardLink).join('') + `<button type="button" class="button secondary" id="mobile-create-board" data-write>${icon('plus')}Nuova bacheca</button>`;
}

function renderHeader() {
  const board = state.board;
  $('board-title').textContent = board?.name || 'Le tue idee, in ordine.';
  $('breadcrumb-board').textContent = board?.name || 'Bacheche';
  $('board-description').textContent = board?.description || 'Il prossimo grande progetto inizia da una piccola scheda.';
  document.title = board ? `${board.name} · OpenBoard` : 'OpenBoard · Il tuo lavoro, in ordine';
  $('star-board').classList.toggle('starred', !!board?.starred);
  $('star-board').setAttribute('aria-label', board?.starred ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti');
  $('star-board').setAttribute('aria-pressed', String(!!board?.starred));
  const unique = [...new Set(allCards().map((card) => card.assignee).filter(Boolean))];
  $('avatar-stack').innerHTML = unique.slice(0,4).map(avatar).join('') + (unique.length > 4 ? `<span class="avatar" title="Altri assegnatari">+${unique.length-4}</span>` : '');
  const priorAssignee = state.assignee;
  $('assignee-filter').innerHTML = '<option value="">Responsabile</option><option value="__none">Non assegnate</option>' + assignees().map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
  $('assignee-filter').value = priorAssignee;
  $('assignee-options').innerHTML = assignees().map((name) => `<option value="${escapeHTML(name)}">`).join('');
  const color = covers.includes(board?.color) ? board.color : 'sage';
  document.documentElement.dataset.boardColor = color;
  updateFilters();
  updateBusy();
}

function matches(card) {
  const query = state.query.trim().toLocaleLowerCase('it');
  const haystack = `${card.title} ${card.description} ${card.assignee} ${(card.checklist || []).map((item) => item.text).join(' ')}`.toLocaleLowerCase('it');
  return (!query || haystack.includes(query)) && (!state.label || card.label === state.label) && (!state.assignee || (state.assignee === '__none' ? !card.assignee : card.assignee === state.assignee));
}
function updateFilters() {
  const total = allCards().length;
  const shown = allCards().filter(matches).length;
  $('total-cards').textContent = total;
  $('card-summary').textContent = state.query || state.label || state.assignee ? `${shown} di ${total} schede` : `${total} schede · ${allCards().filter((card) => card.completed).length} completate`;
  const filtered = !!(state.query || state.label || state.assignee);
  $('clear-filters').classList.toggle('selected', !filtered);
  $('label-filter').classList.toggle('filter-active', !!state.label);
  $('assignee-filter').classList.toggle('filter-active', !!state.assignee);
  $('view-board').classList.toggle('selected', state.view === 'board');
  $('view-list').classList.toggle('selected', state.view === 'list');
  $('view-board').setAttribute('aria-pressed', String(state.view === 'board'));
  $('view-list').setAttribute('aria-pressed', String(state.view === 'list'));
}

function dueDate(card) {
  if (!card.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(card.due_date)) return '';
  const date = new Date(`${card.due_date}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const deadline = new Date(date); deadline.setHours(0,0,0,0);
  const distance = Math.round((deadline - today)/86400000);
  const status = card.completed ? 'done' : distance < 0 ? 'overdue' : distance <= 3 ? 'soon' : '';
  const formatted = date.toLocaleDateString('it-IT',{day:'numeric',month:'short'}).replace('.','');
  return `<span class="card-due ${status}" title="Scadenza: ${escapeHTML(date.toLocaleDateString('it-IT'))}${status === 'overdue' ? ' · Scaduta' : ''}">${icon(card.completed ? 'check-circle' : 'calendar')}${escapeHTML(formatted)}</span>`;
}
function checklistBadge(card) {
  const checklist = Array.isArray(card.checklist) ? card.checklist : [];
  if (!checklist.length) return '';
  const complete = checklist.filter((item) => item.done).length;
  return `<span class="checklist-count ${complete === checklist.length ? 'complete' : ''}" aria-label="${complete} di ${checklist.length} attività completate">${icon('check-square')}${complete}/${checklist.length}</span>`;
}
function completionButton(card) {
  return `<button class="completion-button ${card.completed ? 'is-completed' : ''}" data-complete-card="${Number(card.id)}" type="button" data-write aria-label="${card.completed ? 'Riapri scheda' : 'Completa scheda'}: ${escapeHTML(card.title)}" title="${card.completed ? 'Riapri scheda' : 'Segna come completata'}">${icon(card.completed ? 'check-circle' : 'circle')}</button>`;
}
function renderCard(card) {
  const cover = covers.includes(card.cover) && card.cover ? `<div class="card-cover cover-${card.cover}" aria-hidden="true"><span class="cover-shape"></span><span class="cover-detail"></span></div>` : '';
  const label = labels[card.label] ? `<span class="card-label label-${card.label}">${labels[card.label]}</span>` : '';
  return `<article class="task-card ${card.completed ? 'completed' : ''}" tabindex="0" role="button" aria-label="Apri scheda: ${escapeHTML(card.title)}" draggable="true" data-card-id="${Number(card.id)}" data-column-id="${Number(card.column_id)}">${cover}<div class="card-body">${label}<h3>${escapeHTML(card.title)}</h3>${card.description ? `<p class="card-description">${escapeHTML(card.description)}</p>` : ''}<div class="card-footer">${completionButton(card)}${dueDate(card)}${checklistBadge(card)}${card.assignee ? `<span class="card-assignee">${avatar(card.assignee)}</span>` : ''}</div></div></article>`;
}
function renderColumn(column) {
  const cards = column.cards.filter(matches);
  return `<section class="kanban-column" aria-label="Lista ${escapeHTML(column.title)}"><div class="column-heading"><span class="column-dot"></span><h2>${escapeHTML(column.title)}</h2><span class="column-count">${cards.length}</span><details class="dropdown"><summary class="icon-button" aria-label="Opzioni lista ${escapeHTML(column.title)}">${icon('more')}</summary><div class="dropdown-menu"><button type="button" data-edit-column="${Number(column.id)}" data-write>${icon('edit')}Modifica lista</button><button type="button" class="danger" data-delete-column="${Number(column.id)}" data-write>${icon('trash')}Elimina lista</button></div></details></div><div class="column-cards" data-drop-column="${Number(column.id)}">${cards.length ? cards.map(renderCard).join('') : `<div class="empty-column">${column.cards.length ? 'Nessuna scheda con questi filtri.' : 'Ogni grande idea<br>inizia con una scheda.'}</div>`}</div><button class="add-card-button" type="button" data-add-card="${Number(column.id)}" data-write>${icon('plus')}Aggiungi una scheda</button></section>`;
}
function renderList() {
  return `<div class="list-view"><div class="list-header"><span>Scheda</span><span>Etichetta</span><span>Scadenza</span><span>Responsabile</span></div>${state.board.columns.map((column) => { const cards = column.cards.filter(matches); return `<div class="list-group-title"><span class="column-dot"></span>${escapeHTML(column.title)}<span>${cards.length}</span><button class="icon-button tiny" type="button" data-add-card="${Number(column.id)}" aria-label="Aggiungi scheda in ${escapeHTML(column.title)}" data-write>${icon('plus')}</button></div>${cards.length ? cards.map((card) => `<article class="list-row ${card.completed ? 'completed' : ''}" data-card-id="${Number(card.id)}" tabindex="0" role="button" aria-label="Apri scheda: ${escapeHTML(card.title)}"><div class="list-row-title">${completionButton(card)}<h3>${escapeHTML(card.title)}</h3></div><div>${labels[card.label] ? `<span class="card-label label-${card.label}">${labels[card.label]}</span>` : '<span class="card-description">—</span>'}</div><div>${dueDate(card) || '<span class="card-description">—</span>'}</div><div class="list-assignee">${card.assignee ? `${avatar(card.assignee)}${escapeHTML(card.assignee)}` : 'Non assegnata'}</div></article>`).join('') : '<div class="list-row empty-row">Nessuna scheda in questa lista.</div>'}`; }).join('')}<div class="list-add-row"><button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div></div>`;
}
function renderBoard() {
  if (!state.board) {
    $('board-canvas').innerHTML = `<div class="canvas-message"><span class="message-icon">${icon('spark')}</span><h2>Le grandi idee iniziano qui.</h2><p>Crea la tua prima bacheca. Un posto per organizzare il lavoro, un passo alla volta.</p><button class="button primary" type="button" data-create-board data-write>${icon('plus')}Crea una bacheca</button></div>`;
    return;
  }
  if (!state.board.columns.length) {
    $('board-canvas').innerHTML = `<div class="canvas-message"><span class="message-icon">${icon('columns')}</span><h2>Facciamo spazio al lavoro.</h2><p>Aggiungi una lista per iniziare a organizzare le tue schede.</p><button class="button primary" type="button" data-add-column data-write>${icon('plus')}Crea la prima lista</button></div>`;
  } else if (state.view === 'list') $('board-canvas').innerHTML = renderList();
  else $('board-canvas').innerHTML = `<div class="kanban-board">${state.board.columns.map(renderColumn).join('')}<button class="add-column-button" type="button" data-add-column data-write>${icon('plus')}Aggiungi una lista</button></div>`;
  updateFilters();
  updateBusy();
}

async function selectBoard(id, {quiet = false,reset = true} = {}) {
  const sequence = ++state.loadSequence;
  if (!quiet) {
    state.loading = true; updateBusy();
    $('board-canvas').innerHTML = '<div class="initial-loading"><span class="spinner"></span>Prepariamo il tuo spazio…</div>';
  }
  try {
    const result = await api(`/api/boards/${Number(id)}`);
    if (sequence !== state.loadSequence) return;
    state.board = result.board || result;
    state.board.columns = state.board.columns || [];
    state.board.columns.forEach((column) => { column.cards = column.cards || []; column.cards.forEach((card) => { if (!Array.isArray(card.checklist)) card.checklist = []; }); });
    if (reset) clearFilters(false);
    remember('board',String(state.board.id));
    state.loading = false; state.loadError = false;
    renderSidebar(); renderHeader(); renderBoard();
  } catch (error) {
    if (sequence !== state.loadSequence) return;
    state.loading = false;
    if (quiet) throw error;
    showLoadError(error);
  } finally { if (sequence === state.loadSequence) updateBusy(); }
}
function showLoadError(error) {
  state.loadError = true;
  $('board-canvas').innerHTML = `<div class="canvas-message"><span class="message-icon">${icon('alert-circle')}</span><h2>Qualcosa ci ha fermato.</h2><p>${escapeHTML(error.message)}</p><button class="button primary" id="retry-load" type="button">${icon('refresh')}Riprova</button></div>`;
  $('save-status').textContent = 'Connessione al server non disponibile';
}
async function loadInitial() {
  state.loading = true; updateBusy();
  $('board-canvas').innerHTML = '<div class="initial-loading"><span class="spinner"></span>Prepariamo il tuo spazio…</div>';
  try {
    const result = await api('/api/boards');
    state.boards = result.boards || [];
    const remembered = Number(stored('board'));
    const selected = state.boards.find((board) => board.id === remembered) || state.boards[0];
    if (selected) await selectBoard(selected.id);
    else { state.board = null; state.loading = false; state.loadError = false; renderSidebar(); renderHeader(); renderBoard(); }
  } catch (error) { state.loading = false; showLoadError(error); }
  finally { updateBusy(); }
}
async function refreshBoard() { if (state.board) await selectBoard(state.board.id,{quiet:true,reset:false}); }
async function refreshBoards() { const result = await api('/api/boards'); state.boards = result.boards || []; renderSidebar(); }
function clearFilters(render = true) {
  state.query = ''; state.label = ''; state.assignee = '';
  $('search-input').value = ''; $('label-filter').value = ''; $('assignee-filter').value = '';
  if (render) renderBoard();
}
function closeMenus() { document.querySelectorAll('details[open]').forEach((details) => { details.open = false; }); }
function openDialog(id) { closeMenus(); $(id).showModal(); updateBusy(); }
function closeDialog(id) { if (state.saving) return; $(id).close(); }

function setCover(cover) {
  state.cardEditor.cover = covers.includes(cover) ? cover : '';
  document.querySelectorAll('[data-cover]').forEach((button) => { button.setAttribute('aria-pressed',String(button.dataset.cover === state.cardEditor.cover)); });
}
function renderChecklist() {
  const items = state.cardEditor.checklist;
  $('checklist-items').innerHTML = items.map((item,index) => `<div class="checklist-item ${item.done ? 'done' : ''}"><input type="checkbox" data-checklist-toggle="${index}" ${item.done ? 'checked' : ''} aria-label="Completa: ${escapeHTML(item.text || 'Attività')}"><input type="text" data-checklist-text="${index}" value="${escapeHTML(item.text)}" maxlength="300" required aria-label="Testo attività ${index+1}"><button class="icon-button" type="button" data-checklist-remove="${index}" aria-label="Elimina attività ${index+1}">${icon('close')}</button></div>`).join('');
  $('checklist-progress').textContent = items.length ? `${items.filter((item) => item.done).length} di ${items.length} completate` : '';
}
function addChecklistItem() {
  const text = $('checklist-new').value.trim();
  if (!text) { $('checklist-new').focus(); return; }
  state.cardEditor.checklist.push({id:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,text,done:false});
  $('checklist-new').value = ''; renderChecklist(); $('checklist-new').focus();
}
function openCard(cardId, columnId) {
  if (state.saving || state.loading || !state.board?.columns.length) return;
  const card = cardId ? allCards().find((item) => item.id === Number(cardId)) : null;
  if (cardId && !card) return;
  state.cardEditor = {id:card?.id || null,cover:card?.cover || '',checklist:(card?.checklist || []).map((item) => ({...item}))};
  $('card-form').reset();
  $('card-dialog-context').textContent = card ? 'DENTRO LA TUA BACHECA' : 'UNA NUOVA IDEA';
  $('card-title').value = card?.title || '';
  $('card-description').value = card?.description || '';
  $('card-label').value = card?.label || '';
  $('card-assignee').value = card?.assignee || '';
  $('card-due-date').value = card?.due_date || '';
  $('card-completed').checked = !!card?.completed;
  $('card-column').innerHTML = state.board.columns.map((column) => `<option value="${Number(column.id)}">${escapeHTML(column.title)}</option>`).join('');
  $('card-column').value = String(card?.column_id || columnId || state.board.columns[0].id);
  $('delete-card').hidden = !card;
  $('save-card').innerHTML = `${card ? 'Salva modifiche' : 'Crea scheda'}${icon('arrow-right')}`;
  $('card-form-error').textContent = '';
  setCover(card?.cover || ''); renderChecklist(); openDialog('card-dialog'); $('card-title').focus();
}
function openBoardEditor(board = null) {
  if (state.saving || state.loading) return;
  state.boardEditor = board ? {...board} : null;
  $('board-form').reset();
  $('board-dialog-context').textContent = board ? 'LA TUA BACHECA' : 'NUOVA BACHECA';
  $('board-dialog-heading').textContent = board ? 'Diamo forma al tuo progetto.' : 'Spazio a un nuovo progetto.';
  $('board-name').value = board?.name || '';
  $('board-description-input').value = board?.description || '';
  $('board-color').value = covers.includes(board?.color) && board.color ? board.color : 'sage';
  $('delete-board').hidden = !board;
  $('save-board').innerHTML = `${board ? 'Salva modifiche' : 'Crea bacheca'}${icon('arrow-right')}`;
  $('board-form-error').textContent = '';
  $('boards-dialog').close();
  openDialog('board-dialog'); $('board-name').focus();
}
function openColumnEditor(columnId = null) {
  if (state.saving || state.loading || !state.board) return;
  const column = state.board.columns.find((item) => item.id === Number(columnId));
  state.columnEditor = column ? {...column} : null;
  $('column-form').reset();
  $('column-dialog-context').textContent = column ? 'MODIFICA LISTA' : 'NUOVA LISTA';
  $('column-dialog-heading').textContent = column ? 'Ogni fase ha il suo nome.' : 'Un posto per il prossimo passo.';
  $('column-title').value = column?.title || '';
  $('delete-column').hidden = !column;
  $('save-column').innerHTML = `${column ? 'Salva modifiche' : 'Crea lista'}${icon('arrow-right')}`;
  $('column-form-error').textContent = '';
  openDialog('column-dialog'); $('column-title').focus();
}

function deleteColumn(columnId) {
  const column = state.board?.columns.find((item) => item.id === Number(columnId));
  if (!column || !confirm(`Eliminare la lista “${column.title}”${column.cards.length ? ` e le sue ${column.cards.length} schede` : ''}? Questa operazione è definitiva.`)) return;
  closeMenus();
  perform(async () => { await api(`/api/columns/${column.id}`,'DELETE'); $('column-dialog').close(); await refreshBoard(); },'Lista eliminata.','column-form-error');
}

document.addEventListener('click',(event) => {
  const target = event.target.closest('button, [data-card-id]');
  if (!target) { if (!event.target.closest('details')) closeMenus(); return; }
  if (target.dataset.close) { closeDialog(target.dataset.close); return; }
  if (target.dataset.selectBoard) { if (state.saving) return; $('boards-dialog').close(); closeMenus(); selectBoard(target.dataset.selectBoard); return; }
  if (target.dataset.createBoard !== undefined || target.id === 'mobile-create-board') { openBoardEditor(); return; }
  if (target.dataset.addColumn !== undefined) { openColumnEditor(); return; }
  if (target.dataset.addCard) { openCard(null,target.dataset.addCard); return; }
  if (target.dataset.editColumn) { openColumnEditor(target.dataset.editColumn); return; }
  if (target.dataset.deleteColumn) { deleteColumn(target.dataset.deleteColumn); return; }
  if (target.dataset.completeCard) {
    const card = allCards().find((item) => item.id === Number(target.dataset.completeCard));
    if (card) perform(async () => { await api(`/api/cards/${card.id}`,'PATCH',{completed:!card.completed}); await refreshBoard(); },card.completed ? 'Scheda riaperta.' : 'Un altro passo avanti. Scheda completata!');
    return;
  }
  if (target.dataset.cardId) { openCard(target.dataset.cardId); return; }
  if (target.dataset.cover !== undefined) { setCover(target.dataset.cover); return; }
  if (target.dataset.checklistRemove !== undefined) { state.cardEditor.checklist.splice(Number(target.dataset.checklistRemove),1); renderChecklist(); return; }
  if (target.id === 'retry-load') loadInitial();
});
document.addEventListener('keydown',(event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) $('search-input').focus(); }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-card-id]')) { event.preventDefault(); openCard(event.target.dataset.cardId); }
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel',(event) => { if (state.saving) event.preventDefault(); });
  dialog.addEventListener('click',(event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog.id); } });
});
$('search-input').addEventListener('input',() => { state.query = $('search-input').value; renderBoard(); });
$('label-filter').addEventListener('change',() => { state.label = $('label-filter').value; renderBoard(); });
$('assignee-filter').addEventListener('change',() => { state.assignee = $('assignee-filter').value; renderBoard(); });
$('clear-filters').addEventListener('click',() => clearFilters());
['view-board','view-list'].forEach((id) => $(id).addEventListener('click',() => { state.view = id === 'view-board' ? 'board' : 'list'; remember('view',state.view); renderBoard(); }));
['create-board-sidebar','create-board-link'].forEach((id) => $(id).addEventListener('click',() => openBoardEditor()));
['boards-nav','mobile-boards'].forEach((id) => $(id).addEventListener('click',() => { renderSidebar(); openDialog('boards-dialog'); }));
$('add-card-main').addEventListener('click',() => openCard());
$('edit-board').addEventListener('click',() => openBoardEditor(state.board));
$('star-board').addEventListener('click',() => { if (!state.board) return; const starred = !state.board.starred; perform(async () => { await api(`/api/boards/${state.board.id}`,'PATCH',{starred}); await refreshBoards(); await refreshBoard(); },starred ? 'Bacheca aggiunta ai preferiti.' : 'Bacheca rimossa dai preferiti.'); });
$('export-board').addEventListener('click',() => {
  if (!state.board) return;
  closeMenus();
  const blob = new Blob([JSON.stringify(state.board,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${state.board.name.toLocaleLowerCase('it').replace(/[^a-z0-9à-ü]+/g,'-').replace(/^-|-$/g,'') || 'bacheca'}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  toast('Bacheca esportata in JSON.');
});
$('checklist-items').addEventListener('input',(event) => {
  if (event.target.dataset.checklistText !== undefined) state.cardEditor.checklist[Number(event.target.dataset.checklistText)].text = event.target.value;
});
$('checklist-items').addEventListener('change',(event) => {
  if (event.target.dataset.checklistToggle !== undefined) { state.cardEditor.checklist[Number(event.target.dataset.checklistToggle)].done = event.target.checked; renderChecklist(); }
});
$('add-checklist-item').addEventListener('click',addChecklistItem);
$('checklist-new').addEventListener('keydown',(event) => { if (event.key === 'Enter') { event.preventDefault(); addChecklistItem(); } });

$('card-form').addEventListener('submit',(event) => {
  event.preventDefault();
  const title = $('card-title').value.trim();
  if (!title) { $('card-form-error').textContent = 'Dai un titolo alla tua scheda.'; $('card-title').focus(); return; }
  if ($('checklist-new').value.trim()) addChecklistItem();
  const data = {title,description:$('card-description').value.trim(),label:$('card-label').value,assignee:$('card-assignee').value.trim(),due_date:$('card-due-date').value,cover:state.cardEditor.cover,completed:$('card-completed').checked,checklist:state.cardEditor.checklist.map((item) => ({...item,text:item.text.trim()})).filter((item) => item.text)};
  const columnId = Number($('card-column').value);
  const cardId = state.cardEditor.id;
  perform(async () => { if (cardId) await api(`/api/cards/${cardId}`,'PATCH',{...data,column_id:columnId}); else await api(`/api/columns/${columnId}/cards`,'POST',data); $('card-dialog').close(); await refreshBoard(); },cardId ? 'Scheda aggiornata.' : 'Una nuova idea è al suo posto.','card-form-error');
});
$('delete-card').addEventListener('click',() => {
  const cardId = state.cardEditor?.id;
  if (!cardId || !confirm('Eliminare questa scheda? Questa operazione è definitiva.')) return;
  perform(async () => { await api(`/api/cards/${cardId}`,'DELETE'); $('card-dialog').close(); await refreshBoard(); },'Scheda eliminata.','card-form-error');
});
$('board-form').addEventListener('submit',(event) => {
  event.preventDefault();
  const name = $('board-name').value.trim();
  if (!name) { $('board-form-error').textContent = 'Scegli un nome per la bacheca.'; return; }
  const boardId = state.boardEditor?.id;
  const data = {name,description:$('board-description-input').value.trim(),color:$('board-color').value};
  perform(async () => { const result = await api(boardId ? `/api/boards/${boardId}` : '/api/boards',boardId ? 'PATCH' : 'POST',data); $('board-dialog').close(); await refreshBoards(); await selectBoard(boardId || result.id,{quiet:true}); },boardId ? 'Bacheca aggiornata.' : 'La tua nuova bacheca è pronta.','board-form-error');
});
$('delete-board').addEventListener('click',() => {
  const board = state.boardEditor;
  if (!board || !confirm(`Eliminare “${board.name}” e tutte le sue liste e schede? Questa operazione è definitiva.`)) return;
  perform(async () => { await api(`/api/boards/${board.id}`,'DELETE'); $('board-dialog').close(); await refreshBoards(); if (state.boards.length) await selectBoard(state.boards[0].id,{quiet:true}); else { state.board = null; renderSidebar(); renderHeader(); renderBoard(); } },'Bacheca eliminata.','board-form-error');
});
$('column-form').addEventListener('submit',(event) => {
  event.preventDefault();
  const title = $('column-title').value.trim();
  if (!title) { $('column-form-error').textContent = 'Scegli un nome per la lista.'; return; }
  const columnId = state.columnEditor?.id;
  perform(async () => { await api(columnId ? `/api/columns/${columnId}` : `/api/boards/${state.board.id}/columns`,columnId ? 'PATCH' : 'POST',{title}); $('column-dialog').close(); await refreshBoard(); },columnId ? 'Lista aggiornata.' : 'Lista creata.','column-form-error');
});
$('delete-column').addEventListener('click',() => { if (state.columnEditor) deleteColumn(state.columnEditor.id); });

function clearDragStyles() { document.querySelectorAll('.dragging,.drag-over,.drag-before').forEach((element) => element.classList.remove('dragging','drag-over','drag-before')); }
$('board-canvas').addEventListener('dragstart',(event) => {
  const cardElement = event.target.closest('.task-card');
  if (!cardElement || state.saving || state.query || state.label || state.assignee) { event.preventDefault(); if (state.query || state.label || state.assignee) toast('Rimuovi i filtri per riordinare le schede.'); return; }
  state.draggedCard = Number(cardElement.dataset.cardId);
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain',String(state.draggedCard));
  setTimeout(() => cardElement.classList.add('dragging'),0);
});
$('board-canvas').addEventListener('dragover',(event) => {
  const dropColumn = event.target.closest('[data-drop-column]');
  if (!dropColumn || !state.draggedCard || state.saving) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over,.drag-before').forEach((element) => element.classList.remove('drag-over','drag-before'));
  dropColumn.classList.add('drag-over');
  const card = event.target.closest('.task-card');
  if (card && Number(card.dataset.cardId) !== state.draggedCard) card.classList.add('drag-before');
});
$('board-canvas').addEventListener('drop',(event) => {
  const targetColumn = event.target.closest('[data-drop-column]');
  const cardId = state.draggedCard;
  clearDragStyles(); state.draggedCard = null;
  if (!targetColumn || !cardId || state.saving) return;
  event.preventDefault();
  const columnId = Number(targetColumn.dataset.dropColumn);
  const column = state.board.columns.find((item) => item.id === columnId);
  const targetCard = event.target.closest('.task-card');
  const targetCardId = targetCard ? Number(targetCard.dataset.cardId) : null;
  if (targetCardId === cardId) return;
  const remaining = column.cards.filter((card) => card.id !== cardId);
  const position = targetCardId ? remaining.findIndex((card) => card.id === targetCardId) : remaining.length;
  const source = allCards().find((card) => card.id === cardId);
  if (!source || (source.column_id === columnId && column.cards.findIndex((card) => card.id === cardId) === position)) return;
  perform(async () => { await api(`/api/cards/${cardId}`,'PATCH',{column_id:columnId,position:Math.max(0,position)}); await refreshBoard(); },'Scheda spostata.');
});
$('board-canvas').addEventListener('dragend',() => { state.draggedCard = null; clearDragStyles(); });

loadInitial();

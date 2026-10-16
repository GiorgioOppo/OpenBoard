'use strict';

/* Planning and collaboration UI. Kept separate so the base board stays small. */
const fieldTypes = Object.create(null);
const reactionNames = {like:'👍 Mi piace',heart:'❤️ Grazie',celebrate:'🎉 Ottimo',eyes:'👀 Visto',question:'❓ Domanda',done:'✅ Fatto'};
function activeFields() { return (state.board?.custom_fields || []).filter((field) => !field.deleted_at).sort((a,b) => a.position-b.position); }
function activeMilestones() { return (state.board?.milestones || []).filter((item) => !item.deleted_at); }
function milestoneName(key) { return (state.board?.milestones || []).find((item) => item.key === key)?.title || key || 'Nessuno'; }
function renderPlanningFilters() {
  if (!$('milestone-filter')) return;
  $('milestone-filter').innerHTML = '<option value="">Tutti</option>'+activeMilestones().map((item) => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.title)}</option>`).join('');
  $('milestone-filter').value = state.milestone || '';
  $('custom-filter-key').innerHTML = '<option value="">Nessuno</option>'+activeFields().map((field) => `<option value="${escapeHTML(field.key)}">${escapeHTML(field.name)}</option>`).join('');
  $('custom-filter-key').value = state.customKey || ''; $('custom-filter-value').value = state.customQuery || '';
}
function planningBadges(card) {
  return (card.milestone_key ? `<span class="planning-badge">◎ ${escapeHTML(milestoneName(card.milestone_key))}</span>` : '')+activeFields().filter((field) => card.custom_values?.[field.key] !== null && card.custom_values?.[field.key] !== undefined).slice(0,3).map((field) => `<span class="planning-badge" title="${escapeHTML(field.name)}">${escapeHTML(field.name)}: ${escapeHTML(productivity.fieldText(card.custom_values[field.key]))}</span>`).join('');
}
function customInput(field,value) {
  const attributes = `id="custom-${Number(field.id)}" data-custom-key="${escapeHTML(field.key)}" data-custom-type="${escapeHTML(field.type)}" data-write`;
  if (field.type === 'boolean') return `<select ${attributes}><option value="">Non impostato</option><option value="true" ${value === true ? 'selected':''}>Sì</option><option value="false" ${value === false ? 'selected':''}>No</option></select>`;
  if (field.type === 'select') return `<select ${attributes}><option value="">Non impostato</option>${(field.options || []).map((option) => `<option value="${escapeHTML(option)}" ${value === option ? 'selected':''}>${escapeHTML(option)}</option>`).join('')}</select>`;
  return `<input ${attributes} type="${field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}" ${field.type === 'number' ? 'step="any" min="-1000000000000" max="1000000000000"' : field.type === 'text' ? 'maxlength="2000"':''} value="${escapeHTML(value ?? '')}">`;
}
function fillPlanningCard(data) {
  state.cardEditor.customValues = {...(data.custom_values || {})};
  const milestones = activeMilestones();
  if (data.milestone_key && !milestones.some((item) => item.key === data.milestone_key)) milestones.push({key:data.milestone_key,title:milestoneName(data.milestone_key)+' (eliminato)'});
  $('card-milestone').innerHTML = '<option value="">Nessuno</option>'+milestones.map((item) => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.title)}</option>`).join(''); $('card-milestone').value = data.milestone_key || '';
  $('card-custom-fields').innerHTML = activeFields().map((field) => `<label class="form-field" for="custom-${Number(field.id)}"><span class="field-label">${escapeHTML(field.name)}</span>${customInput(field,data.custom_values?.[field.key])}</label>`).join('') || '<p class="helper-text">Definisci campi nella sezione Pianificazione della bacheca.</p>';
  state.cardEditor.bookmarkReady = false; state.cardEditor.bookmarkLoading = !!state.cardEditor.id; $('bookmark-card').hidden = !state.cardEditor.id || !state.auth?.user; $('bookmark-card').dataset.bookmarked = 'false'; $('bookmark-card').setAttribute('aria-pressed','false'); $('bookmark-card').textContent = 'Salva scheda';
  $('worklogs-section').hidden = !state.cardEditor.id; $('worklogs-list').innerHTML = ''; $('card-time-summary').textContent = ''; $('worklog-date').value = todayISO(); $('worklog-minutes').value = ''; $('worklog-note').value = ''; $('worklog-deleted').checked = false;
  $('comments-author').innerHTML = '<option value="">Tutti</option>'; $('comments-query').value = '';
}
function readCustomValues() {
  const values = {...(state.cardEditor?.customValues || {})};
  document.querySelectorAll('[data-custom-key]').forEach((input) => { try { values[input.dataset.customKey] = productivity.fieldValue(input.dataset.customType,input.value); } catch { values[input.dataset.customKey] = input.value; } });
  return values;
}
function renderTable() {
  const fields = activeFields(), cards = state.board.columns.flatMap((column) => sorted(column.cards).map((card) => ({card,column})));
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Tabella schede, scorri orizzontalmente per tutti i campi"><table class="board-table"><caption>Schede di ${escapeHTML(state.board.name)} · ${cards.length} risultati</caption><thead><tr><th scope="col">Scheda</th><th scope="col">Lista</th><th scope="col">Traguardo</th><th scope="col">Priorità</th><th scope="col">Scadenza</th><th scope="col">Stima (min)</th><th scope="col">Tempo totale (min)</th>${fields.map((field) => `<th scope="col">${escapeHTML(field.name)}</th>`).join('')}</tr></thead><tbody>${cards.map(({card,column}) => `<tr><th scope="row">${selectionCheckbox(card)}<button type="button" class="table-card-link" data-table-card="${Number(card.id)}">${card.completed ? '✓ ':''}${escapeHTML(card.title)}</button></th><td>${escapeHTML(column.title)}</td><td>${escapeHTML(milestoneName(card.milestone_key))}</td><td>${escapeHTML(priorities[card.priority] || card.priority || '—')}</td><td>${escapeHTML(card.due_date || '—')}</td><td>${Number(card.estimate_minutes)||0}</td><td>${Number(card.total_minutes ?? card.actual_minutes)||0}</td>${fields.map((field) => `<td>${productivity.fieldCell(card.custom_values?.[field.key])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${7+fields.length}">Nessuna scheda con questi filtri.</td></tr>`}</tbody></table></div>`;
}
function planningTabs(current) { return `<nav class="panel-tabs" aria-label="Pianificazione">${[['overview','Traguardi'],['fields','Campi'],['guidelines','Linee guida'],['workload','Carico']].map(([id,label]) => `<button type="button" class="button ${id === current ? 'primary':'secondary'}" data-planning-tab="${id}" ${id === current ? 'aria-current="page"':''}>${label}</button>`).join('')}</nav>`; }
async function showPlanning(tab = 'overview') {
  const boardId = state.board?.id; if (!boardId) return;
  state.planningBoard = boardId; state.planningTab = tab;
  const generation = state.planningSequence = (state.planningSequence || 0)+1;
  const current = () => state.planningSequence === generation && state.board?.id === boardId && state.panel === 'planning' && $('panel-dialog').open;
  await showPanel('Pianificazione della bacheca',async () => {
    let body = planningTabs(tab);
    if (tab === 'fields') {
      const fields = (await api(`/api/boards/${boardId}/fields?include_deleted=1`)).fields || [];
      body += '<h3>Campi personalizzati</h3><p>I valori sono conservati anche quando un campo è nel cestino. La chiave e il tipo restano stabili.</p>'+fields.map((field) => `<form class="planning-row" data-field-edit="${Number(field.id)}"><div><strong>${escapeHTML(field.key)}</strong><span>${escapeHTML(fieldTypes[field.type])}${field.deleted_at ? ' · Eliminato':''}</span></div>${field.deleted_at ? `<button type="button" class="button secondary" data-field-restore="${Number(field.id)}" data-write>Ripristina campo</button>` : `<label>Nome<input name="name" required maxlength="100" value="${escapeHTML(field.name)}" data-write></label><label>Posizione<input name="position" type="number" min="1" max="1000" value="${Number(field.position)+1}" data-write></label><button class="button secondary" type="submit" data-write>Salva campo</button><button class="button danger-subtle" type="button" data-field-delete="${Number(field.id)}" data-write>Elimina campo</button>`}</form>`).join('');
      body += `<form id="field-create-form"><h3>Nuovo campo</h3><div class="form-grid"><label>Nome<input name="name" required maxlength="100" data-write></label><label>Chiave stabile<input name="key" pattern="[a-z][a-z0-9_]{0,31}" maxlength="32" required placeholder="costo" data-write></label><label>Tipo<select name="type" id="field-type" data-write>${Object.entries(fieldTypes).map(([value,name]) => `<option value="${value}">${escapeHTML(name)}</option>`).join('')}</select></label><label id="field-options-label" hidden>Opzioni, una per riga<textarea name="options" rows="3" maxlength="2000" data-write></textarea></label></div><button class="button primary" type="submit" data-write>Crea campo</button></form>`;
    } else if (tab === 'guidelines') {
      const result = await api(`/api/boards/${boardId}`), board = result.board || result;
      if (!current()) return '';
      state.guidelinesVersion = board.version;
      body += `<h3>Linee guida del team</h3><div class="markdown-preview">${productivity.markdown(board.guidelines || '')}</div><details class="editor-section"><summary>Modifica le linee guida</summary><form id="guidelines-form"><label class="field-label" for="guidelines-body">Testo Markdown</label><textarea id="guidelines-body" rows="10" maxlength="10000" data-write>${escapeHTML(board.guidelines || '')}</textarea><button class="button primary" type="submit" data-write>Salva linee guida</button></form></details>`;
    } else if (tab === 'workload') {
      const report = await api(`/api/boards/${boardId}/workload`);
      body += `<h3>Carico della bacheca</h3><div class="stat-grid">${[['Schede',report.total],['Completate',report.completed],['Bloccate',report.blocked],['Stima (min)',report.estimate_minutes],['Tempo manuale (min)',report.actual_minutes],['Tempo registrato (min)',report.logged_minutes],['Tempo totale (min)',report.total_minutes]].map(([name,value]) => `<div><strong>${Number(value)||0}</strong><span>${name}</span></div>`).join('')}</div>${planningReportGroup('Per priorità',report.by_priority,(key) => priorities[key] || key)}${planningReportGroup('Per traguardo',report.by_milestone,milestoneName)}`;
    } else {
      const milestones = (await api(`/api/boards/${boardId}/milestones?include_deleted=1`)).milestones || [];
      if (!current()) return '';
      state.planningMilestones = milestones;
      const overdueItems = milestones.filter((item) => !item.deleted_at && item.overdue);
      body += `<h3>Avanzamento dei traguardi</h3>${overdueItems.length ? `<section class="notice overdue-panel"><h4>Traguardi scaduti</h4><ul>${overdueItems.map((item) => `<li>${escapeHTML(item.title)} · ${escapeHTML(item.due_date)}</li>`).join('')}</ul></section>`:''}<div class="milestone-grid">${milestones.map((item) => `<section class="milestone-card"><h4>${escapeHTML(item.title)}${item.completed ? ' · Completato':''}${item.deleted_at ? ' · Eliminato':''}</h4><p>${escapeHTML(item.due_date || 'Senza scadenza')} · ${Number(item.done)||0} / ${Number(item.total)||0} schede</p><progress max="${Math.max(Number(item.total)||0,1)}" value="${Number(item.done)||0}">${Number(item.done)||0}</progress>${item.deleted_at ? `<button type="button" class="button secondary" data-milestone-restore="${Number(item.id)}" data-write>Ripristina traguardo</button>` : `<form data-milestone-edit="${Number(item.id)}"><label>Titolo<input name="title" value="${escapeHTML(item.title)}" required maxlength="200" data-write></label><label>Scadenza<input name="due_date" type="date" value="${escapeHTML(item.due_date || '')}" data-write></label><label class="inline-check"><input name="completed" type="checkbox" ${item.completed ? 'checked':''} data-write>Completato</label><button class="button secondary" type="submit" data-write>Salva traguardo</button><button class="button danger-subtle" type="button" data-milestone-delete="${Number(item.id)}" data-write>Elimina traguardo</button></form>`}</section>`).join('') || '<p>Nessun traguardo definito.</p>'}</div><form id="milestone-create-form"><h3>Nuovo traguardo</h3><div class="form-grid"><label>Titolo<input name="title" required maxlength="200" data-write></label><label>Chiave stabile<input name="key" required maxlength="32" pattern="[a-z][a-z0-9_]{0,31}" placeholder="lancio" data-write></label><label>Scadenza<input name="due_date" type="date" data-write></label></div><button class="button primary" type="submit" data-write>Crea traguardo</button></form>`;
    }
    return body+'<p id="panel-error" class="form-error" role="alert"></p>';
  },'planning');
}
function planningReportGroup(title,values,names) {
  const rows = Array.isArray(values) ? values.map((item) => [item.priority || item.milestone_key || item.key || '',item]) : Object.entries(values || {});
  return `<section class="stats-group"><h3>${escapeHTML(title)}</h3>${rows.map(([key,item]) => `<div class="stat-line"><span>${escapeHTML(names(key))}</span><strong>${Number(typeof item === 'number' ? item : item.total ?? item.count)||0} schede</strong><span>${Number(item.estimate_minutes)||0} min stimati · ${Number(item.total_minutes ?? item.actual_minutes)||0} min effettivi</span></div>`).join('') || '<p>Nessun dato.</p>'}</section>`;
}
async function refreshPlanning(tab = state.planningTab || 'overview') { await refreshBoard(); await showPlanning(tab); }
function showBulkPlanning(action) {
  if (!state.selectedCards.size) return;
  const input = action === 'priority' ? `<label>Priorità<select name="value">${Object.entries(priorities).map(([key,name]) => `<option value="${key}">${escapeHTML(name)}</option>`).join('')}</select></label>` : action === 'labels' ? `<fieldset class="multi-labels"><legend>Nuove etichette (sostituiscono le attuali)</legend>${Object.entries(labels).map(([key,name]) => `<label><input type="checkbox" name="labels" value="${key}">${escapeHTML(name)}</label>`).join('')}</fieldset>` : `<label>Traguardo<select name="value"><option value="">Nessuno</option>${activeMilestones().map((item) => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.title)}</option>`).join('')}</select></label>`;
  panel('Modifica schede selezionate',`<p>${state.selectedCards.size} schede. Il server verifica tutte le versioni prima di applicare il cambiamento.</p><form id="bulk-planning-form" data-action="${action}" data-board="${Number(state.board.id)}">${input}<button class="button primary" type="submit" data-write>Applica a tutte</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'bulk-planning');
}
async function loadPlanningCard(cardId,boardId,sequence) {
  if (!cardId) return;
  await Promise.allSettled([loadWorklogs(cardId),state.auth?.user ? loadBookmarkStatus(cardId,boardId,sequence) : Promise.resolve()]);
}
async function loadBookmarkStatus(cardId,boardId = state.board?.id,sequence = state.cardSequence) {
  const editor = state.cardEditor; if (!editor || editor.id !== cardId) return;
  const generation = editor.bookmarkSequence = (editor.bookmarkSequence || 0)+1;
  const current = () => state.cardEditor === editor && state.board?.id === boardId && state.cardSequence === sequence && editor.bookmarkSequence === generation && $('card-dialog').open;
  editor.bookmarkLoading = true; updateBusy();
  try {
    const result = await api(`/api/cards/${cardId}/bookmark`);
    if (current()) { editor.bookmarkReady = true; setBookmark(!!result.bookmarked); }
  } catch (error) {
    if (current()) { editor.bookmarkReady = false; $('bookmark-card').textContent = 'Riprova stato segnalibro'; $('bookmark-card').title = error.message; }
  } finally { if (current()) { editor.bookmarkLoading = false; updateBusy(); } }
}
function pendingWorklog() { const minutes = $('worklog-minutes').value, note = $('worklog-note').value; return {minutes,note,date:minutes || note ? $('worklog-date').value : ''}; }
function setBookmark(value) { $('bookmark-card').dataset.bookmarked = String(value); $('bookmark-card').setAttribute('aria-pressed',String(value)); $('bookmark-card').textContent = value ? 'Scheda salvata ★' : 'Salva scheda'; }
async function loadWorklogs(cardId,before = null,append = false) {
  const editor = state.cardEditor; if (!editor || editor.id !== cardId) return;
  const generation = editor.worklogSequence = (editor.worklogSequence || 0)+1, cardSequence = state.cardSequence, deleted = $('worklog-deleted').checked;
  const current = () => state.cardEditor === editor && state.cardSequence === cardSequence && editor.worklogSequence === generation && $('card-dialog').open && $('worklog-deleted').checked === deleted;
  try {
    const [result,summary] = await Promise.all([api(`/api/cards/${cardId}/worklogs?limit=20${before ? '&before='+Number(before):''}${deleted ? '&include_deleted=1':''}`),api(`/api/cards/${cardId}/time-summary`)]);
    if (!current()) return;
    editor.worklogs = append ? [...(editor.worklogs || []),...(result.items || [])] : (result.items || []);
    $('card-time-summary').textContent = `${Number(summary.manual_minutes)||0} min manuali + ${Number(summary.logged_minutes)||0} min registrati = ${Number(summary.total_minutes)||0} min totali`;
    $('worklogs-list').innerHTML = editor.worklogs.map((log) => `<article class="worklog-row ${log.deleted_at ? 'deleted':''}"><div><strong>${Number(log.minutes)} min · ${escapeHTML(log.date)}</strong><p>${escapeHTML(log.author || 'Workspace locale')}${log.deleted_at ? ' · Eliminato':''}</p><p>${escapeHTML(log.note || '')}</p></div>${canWrite() && (!state.auth?.enabled || Number(log.user_id) === state.auth?.user?.id || state.auth?.user?.role === 'admin') ? `<div>${log.deleted_at ? `<button type="button" class="button secondary" data-log-restore="${Number(log.id)}" data-log-version="${Number(log.version)}" data-write>Ripristina registrazione</button>` : `<button type="button" class="subtle-button" data-log-edit="${Number(log.id)}" data-write>Modifica tempo</button><button type="button" class="button danger-subtle" data-log-delete="${Number(log.id)}" data-log-version="${Number(log.version)}" data-write>Elimina registrazione</button>`}</div>`:''}</article>`).join('') || '<p class="helper-text">Nessuna registrazione del tempo.</p>';
    if (result.next_cursor) $('worklogs-list').insertAdjacentHTML('beforeend',`<button type="button" class="button secondary" data-logs-more="${Number(result.next_cursor)}">Carica registrazioni precedenti</button>`);
    updateBusy();
  } catch (error) { if (current()) $('worklogs-list').textContent = error.message; }
}
function showEditWorklog(id) {
  const log = state.cardEditor?.worklogs?.find((item) => item.id === Number(id)); if (!log) return;
  panel('Modifica registrazione del tempo',`<form id="worklog-edit-form" data-log="${Number(log.id)}" data-version="${Number(log.version)}" data-card="${Number(log.card_id)}"><label>Giorno<input name="date" type="date" required value="${escapeHTML(log.date)}" data-write></label><label>Minuti<input name="minutes" type="number" min="1" max="1000000" required value="${Number(log.minutes)}" data-write></label><label>Nota<textarea name="note" rows="3" maxlength="2000" data-write>${escapeHTML(log.note)}</textarea></label><button class="button primary" type="submit" data-write>Salva registrazione</button></form><p id="panel-error" class="form-error" role="alert"></p>`,'worklog-edit');
}
function timeRows(rows) { return `<div class="time-report-rows">${rows.map((row) => `<article class="worklog-row"><div><strong>${escapeHTML(row.card_title || '')}</strong><p>${escapeHTML(row.author || '')} · ${escapeHTML(row.date)} · ${Number(row.minutes)||0} min</p><p>${escapeHTML(row.note || '')}</p></div>${row.board_id && row.card_id ? `<button type="button" class="subtle-button" data-search-board="${Number(row.board_id)}" data-search-card="${Number(row.card_id)}">Apri scheda</button>`:''}</article>`).join('') || '<p>Nessuna registrazione in questo intervallo.</p>'}</div>`; }
async function showTimeReport(personal = false) {
  const boardId = state.board?.id; if (!boardId) return;
  state.timeBoard = boardId; state.timePersonal = personal;
  const filter = state.timeFilter || {};
  await showPanel(personal ? 'La tua settimana di lavoro' : 'Tempo del team',async () => {
    const suffix = new URLSearchParams(); if (personal) { if (filter.week) suffix.set('week',filter.week); } else { if (filter.from) suffix.set('from',filter.from); if (filter.to) suffix.set('to',filter.to); }
    const result = await api(`${personal ? '/api/me/time-report' : `/api/boards/${boardId}/time-report`}?${suffix}`);
    return `<nav class="panel-tabs"><button type="button" id="time-team" class="button ${!personal ? 'primary':'secondary'}">Team</button>${state.auth?.user ? `<button type="button" id="time-personal" class="button ${personal ? 'primary':'secondary'}">La mia settimana</button>`:''}</nav><form id="time-filter-form"><div class="form-grid">${personal ? `<label>Settimana contenente<input name="week" type="date" value="${escapeHTML(filter.week || todayISO())}"></label>` : `<label>Dal giorno<input name="from" type="date" value="${escapeHTML(filter.from || '')}"></label><label>Al giorno<input name="to" type="date" value="${escapeHTML(filter.to || '')}"></label>`}</div><button class="button secondary" type="submit">Applica intervallo</button>${!personal ? '<button id="time-export" class="button secondary" type="button">Esporta registro CSV</button>':''}</form>${result.truncated ? '<p class="notice">Risultato limitato a 10000 registrazioni. Riduci l’intervallo per un report completo.</p>':''}<h3>${personal ? `${escapeHTML(result.week_start)} — ${escapeHTML(result.week_end)}`:`Tempo per persona · ${escapeHTML(result.from || '')} — ${escapeHTML(result.to || '')}`}</h3><p><strong>${Number(personal ? result.total_minutes : result.totals?.logged_minutes)||0} minuti registrati</strong></p>${personal ? `<div class="stat-grid">${(result.daily || []).map((day) => `<div><strong>${Number(day.minutes)||0}</strong><span>${escapeHTML(day.date)}</span></div>`).join('')}</div>` : `<div class="report-users">${(result.by_user || []).map((user) => `<div class="stat-line"><span>${escapeHTML(user.author || 'Workspace locale')}</span><strong>${Number(user.minutes)||0} min</strong></div>`).join('')}</div>`}${timeRows(result.rows || [])}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'time-report');
}
async function showBookmarks(before = null,append = false) {
  before = Number.isFinite(Number(before)) ? Number(before) : null;
  if (!state.auth?.user) { panel('Le mie schede salvate','<p>Accedi con un account per salvare le schede che vuoi ritrovare.</p>','bookmarks'); return; }
  const generation = state.bookmarkListSequence = (state.bookmarkListSequence || 0)+1;
  await showPanel('Le mie schede salvate',async () => {
    const result = await api(`/api/me/bookmarks?limit=30${before ? '&before='+before:''}`);
    if (generation !== state.bookmarkListSequence || state.panel !== 'bookmarks' || !$('panel-dialog').open) return '';
    state.bookmarkItems = append ? [...(state.bookmarkItems || []),...(result.items || [])] : (result.items || []);
    return (state.bookmarkItems.map((item) => `<button type="button" class="search-result" data-search-board="${Number(item.board_id)}" data-search-card="${Number(item.card_id || item.id)}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.board_name)} / ${escapeHTML(item.column_name)}</span></button>`).join('') || '<p>Apri una scheda e premi Salva scheda per aggiungerla qui.</p>')+(result.next_cursor ? `<button type="button" class="button secondary" data-bookmarks-more="${Number(result.next_cursor)}">Carica altri segnalibri</button>`:'');
  },'bookmarks');
}
function commentHTML(comment,thread = false) {
  const own = !state.auth?.enabled || Number(comment.author_id) === state.auth?.user?.id;
  const reactions = comment.reactions || [];
  return `<article class="comment ${comment.pinned ? 'pinned-comment':''}"><header><strong>${escapeHTML(comment.author || 'Utente')}</strong>${comment.pinned ? '<span class="planning-badge">In evidenza</span>':''}<time>${escapeHTML(formatDate(comment.edited_at || comment.created_at))}${comment.edited_at ? ' · modificato':''}</time>${canWrite() && (own || state.auth?.user?.role === 'admin') && !thread ? `<button type="button" class="subtle-button" data-edit-comment="${Number(comment.id)}" data-write>Modifica</button>`:''}${canWrite() && (canManage() || own) && !thread ? `<button type="button" class="icon-button tiny" data-delete-comment="${Number(comment.id)}" aria-label="Elimina commento" data-write>${icon('trash')}</button>`:''}${canWrite() && !thread ? `<button type="button" class="subtle-button" data-pin-comment="${Number(comment.id)}" data-comment-version="${Number(comment.version)}" data-pinned="${String(!!comment.pinned)}" data-write>${comment.pinned ? 'Togli evidenza':'Metti in evidenza'}</button>`:''}</header><div class="markdown-preview comment-markdown">${productivity.markdown(comment.body)}</div><div class="comment-actions">${state.auth?.user ? Object.entries(reactionNames).map(([reaction,name]) => { const item = reactions.find((row) => row.reaction === reaction); return `<button type="button" class="reaction-button ${item?.mine ? 'mine':''}" data-reaction="${reaction}" data-reaction-comment="${Number(comment.id)}" data-mine="${String(!!item?.mine)}" aria-pressed="${String(!!item?.mine)}" aria-label="${escapeHTML(name)}: ${Number(item?.count)||0}${item?.mine ? ', rimuovi la tua reazione':''}">${name} <span>${Number(item?.count)||0}</span></button>`; }).join(''):reactions.filter((item) => item.count).map((item) => `<span class="planning-badge">${escapeHTML(reactionNames[item.reaction] || item.reaction)} ${Number(item.count)}</span>`).join('')}${!thread ? `<button type="button" class="subtle-button" data-comment-thread="${Number(comment.parent_id || comment.id)}">${comment.parent_id ? 'Apri discussione':'Discussione e risposte'}</button>`:''}</div></article>`;
}
function renderComments() {
  const editor = state.cardEditor; if (!editor) return;
  const author = $('comments-author').value, query = $('comments-query').value.trim().toLocaleLowerCase('it');
  const authors = [...new Map((editor.comments || []).map((item) => [String(item.author_id),item.author || 'Utente'])).entries()];
  $('comments-author').innerHTML = '<option value="">Tutti</option>'+authors.map(([id,name]) => `<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join(''); $('comments-author').value = author;
  const comments = (editor.comments || []).filter((item) => (!author || String(item.author_id) === author) && (!query || item.body.toLocaleLowerCase('it').includes(query))).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || a.id-b.id);
  const pinned = comments.filter((item) => item.pinned), regular = comments.filter((item) => !item.pinned);
  $('comments-list').innerHTML = (pinned.length ? `<section aria-label="Commenti in evidenza"><h3>In evidenza</h3>${pinned.map((item) => commentHTML(item)).join('')}</section>`:'')+regular.map((item) => commentHTML(item)).join('') || '<p class="helper-text">Nessun commento con questi filtri.</p>';
}
function replyDraftKey(id,cardId) { return `reply.${state.auth?.user?.id || 'local'}.${cardId || 0}.${id}`; }
function saveReplyDraft() {
  const input = $('reply-body');
  if (state.panel !== 'thread' || !$('panel-dialog').open || !input || !state.threadId) return;
  const form = $('reply-form'), parent = Number(form?.dataset.parent) || state.threadId, card = Number(form?.dataset.card) || state.threadCard;
  const key = replyDraftKey(parent,card);
  if (input.value) remember(key,input.value); else forget(key);
}
async function showThread(id) {
  saveReplyDraft();
  state.threadId = Number(id); const cardId = state.cardEditor?.id; state.threadCard = cardId;
  await showPanel('Discussione del commento',async () => {
    const result = await api(`/api/comments/${Number(id)}/thread`);
    return commentHTML(result.parent,true)+`<section aria-label="Risposte">${(result.replies || []).map((item) => commentHTML(item,true)).join('') || '<p>Nessuna risposta.</p>'}</section>${canWrite() ? `<form id="reply-form" data-parent="${Number(id)}" data-card="${Number(cardId)}"><label class="field-label" for="reply-body">Rispondi con Markdown</label><textarea id="reply-body" rows="3" required maxlength="5000" data-write>${escapeHTML(stored(replyDraftKey(Number(id),cardId)))}</textarea><p class="helper-text">La risposta non pubblicata resta su questo dispositivo.</p><button type="submit" class="button primary" data-write>Pubblica risposta</button></form>`:''}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'thread');
}
async function showActivityPage(before = null,append = false) {
  before = Number.isFinite(Number(before)) ? Number(before) : null;
  const boardId = state.board?.id; if (!boardId) return;
  const generation = state.activitySequence = (state.activitySequence || 0)+1;
  await showPanel('Registro attività',async () => {
    const result = await api(`/api/boards/${boardId}/activity-page?limit=30${before ? '&before='+before:''}`);
    if (generation !== state.activitySequence || state.panel !== 'activity' || state.board?.id !== boardId || !$('panel-dialog').open) return '';
    state.activityItems = append ? [...(state.activityItems || []),...(result.events || result.items || [])] : (result.events || result.items || []);
    return `<ol class="activity-feed">${state.activityItems.map((event) => `<li><div><strong>${escapeHTML(event.actor || 'Workspace locale')}</strong><span>${escapeHTML(activityLabel(event.action))} · ${escapeHTML(event.entity_type)}</span><p>${escapeHTML(event.title || '')}</p></div><time>${escapeHTML(formatDate(event.created_at))}</time></li>`).join('') || '<li>Nessuna attività registrata.</li>'}</ol>${result.next_cursor ? `<button type="button" class="button secondary" data-activity-more="${Number(result.next_cursor)}">Carica attività precedenti</button>`:''}`;
  },'activity');
}
async function showFilteredNotifications(before = null,append = false) {
  before = Number.isFinite(Number(before)) ? Number(before) : null;
  const filter = {...(state.notificationFilter || {})}, generation = state.notificationSequence = (state.notificationSequence || 0)+1;
  await showPanel('Le tue notifiche',async () => {
    const params = new URLSearchParams({limit:'30'}); if (filter.unread) params.set('unread','1'); if (filter.q) params.set('q',filter.q); if (before) params.set('before',String(before));
    const result = await api(`/api/notifications-filtered?${params}`);
    if (generation !== state.notificationSequence || state.panel !== 'notifications' || !$('panel-dialog').open) return '';
    state.notificationsItems = append ? [...(state.notificationsItems || []),...(result.items || [])] : (result.items || []);
    return `<form id="notification-filter-form"><label class="inline-check"><input name="unread" type="checkbox" ${filter.unread ? 'checked':''}>Solo non lette</label><label>Cerca nelle notifiche<input name="q" type="search" maxlength="200" value="${escapeHTML(filter.q || '')}"></label><button type="submit" class="button secondary">Applica filtri</button></form><p>${Number(result.unread_count)||0} notifiche non lette</p><button id="notifications-read-all" type="button" class="button secondary">Segna tutte come lette</button><div class="notifications-list">${state.notificationsItems.map((item) => `<article class="notification-item ${item.read ? 'read':'unread'}"><div><strong>${escapeHTML(item.title || 'Aggiornamento')}</strong><p>${escapeHTML(item.actor || 'Un membro')} · ${escapeHTML(activityLabel(item.action))}</p><time>${escapeHTML(formatDate(item.created_at))}</time></div><button type="button" class="button secondary" data-notification-open="${Number(item.id)}" data-notification-board="${Number(item.board_id)}" ${item.entity_type === 'cards' ? `data-notification-card="${Number(item.entity_id)}"`:''}>Apri</button>${!item.read ? `<button type="button" class="subtle-button" data-notification-read="${Number(item.id)}">Segna letta</button>`:'<span class="helper-text">Letta</span>'}</article>`).join('') || '<p>Nessuna notifica con questi filtri.</p>'}</div>${result.next_cursor ? `<button id="notifications-more" type="button" class="button secondary" data-before="${Number(result.next_cursor)}">Carica precedenti</button>`:''}<p id="panel-error" class="form-error" role="alert"></p>`;
  },'notifications'); refreshNotifications();
}
function planningWrite(write,refresh,message,error = 'panel-error') { return perform(() => committed(write,refresh,message),'',error); }
document.addEventListener('click',(event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.dataset.planningTab) { showPlanning(target.dataset.planningTab); return; }
  if (target.dataset.tableCard) { openCard(target.dataset.tableCard); return; }
  for (const kind of ['field','milestone']) for (const action of ['delete','restore']) {
    const id = target.dataset[kind+action[0].toUpperCase()+action.slice(1)];
    if (!id) continue;
    const path = `/api/${kind === 'field' ? 'fields':'milestones'}/${Number(id)}${action === 'restore' ? '/restore':''}`;
    planningWrite(() => api(path,action === 'restore' ? 'POST':'DELETE',action === 'restore' ? {}:undefined),() => refreshPlanning(),action === 'restore' ? 'Elemento ripristinato.':'Elemento spostato nel cestino. Puoi ripristinarlo da questo pannello.'); return;
  }
  if (target.dataset.logEdit) { showEditWorklog(target.dataset.logEdit); return; }
  if (target.dataset.logsMore) { loadWorklogs(state.cardEditor.id,target.dataset.logsMore,true); return; }
  if (target.dataset.logDelete || target.dataset.logRestore) {
    const cardId = state.cardEditor?.id, restore = !!target.dataset.logRestore, id = Number(target.dataset.logDelete || target.dataset.logRestore);
    planningWrite(() => api(`/api/worklogs/${id}${restore ? '/restore':''}`,restore ? 'POST':'DELETE',restore ? {}:undefined,{version:Number(target.dataset.logVersion)}),() => loadWorklogs(cardId),restore ? 'Registrazione ripristinata.':'Registrazione eliminata. Attiva “Mostra registrazioni eliminate” per ripristinarla.','card-form-error'); return;
  }
  if (target.dataset.reaction) {
    const id = Number(target.dataset.reactionComment), cardId = state.cardEditor?.id, thread = state.panel === 'thread' && $('panel-dialog').open;
    planningWrite(() => api(`/api/comments/${id}/reactions`,target.dataset.mine === 'true' ? 'DELETE':'POST',{reaction:target.dataset.reaction}),async () => { await loadComments(cardId); if (thread) await showThread(state.threadId); },'Reazione aggiornata.',thread ? 'panel-error':'card-form-error'); return;
  }
  if (target.dataset.pinComment) { const cardId = state.cardEditor?.id; planningWrite(() => api(`/api/comments/${Number(target.dataset.pinComment)}/pin`,'PATCH',{pinned:target.dataset.pinned !== 'true'},{version:Number(target.dataset.commentVersion)}),() => loadComments(cardId),'Evidenza del commento aggiornata.','card-form-error'); return; }
  if (target.dataset.commentThread) { showThread(target.dataset.commentThread); return; }
  if (target.dataset.bookmarksMore) { showBookmarks(target.dataset.bookmarksMore,true); return; }
  if (target.dataset.activityMore) { showActivityPage(target.dataset.activityMore,true); return; }
  switch (target.id) {
    case 'planning-board': showPlanning(); break;
    case 'time-board': showTimeReport(); break;
    case 'time-team': showTimeReport(false); break;
    case 'time-personal': showTimeReport(true); break;
    case 'bookmarks': showBookmarks(); break;
    case 'bulk-priority': showBulkPlanning('priority'); break;
    case 'bulk-labels': showBulkPlanning('labels'); break;
    case 'bulk-milestone': showBulkPlanning('milestone'); break;
    case 'bookmark-card': {
      const editor = state.cardEditor, id = editor?.id, bookmarked = target.dataset.bookmarked !== 'true'; if (!id) break;
      if (!editor.bookmarkReady) { loadBookmarkStatus(id); break; }
      ++editor.bookmarkSequence;
      planningWrite(() => api(`/api/cards/${id}/bookmark`,'PATCH',{bookmarked}),() => { if (state.cardEditor === editor) { editor.bookmarkReady = true; editor.bookmarkLoading = false; setBookmark(bookmarked); } },bookmarked ? 'Scheda aggiunta ai tuoi segnalibri.':'Scheda rimossa dai tuoi segnalibri.','card-form-error'); break;
    }
    case 'add-worklog': {
      const cardId = state.cardEditor?.id, minutes = Number($('worklog-minutes').value); if (!cardId) break;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1000000 || !$('worklog-date').value) { $('card-form-error').textContent = 'Inserisci un giorno e un numero intero di minuti tra 1 e 1000000.'; break; }
      const data = {date:$('worklog-date').value,minutes,note:$('worklog-note').value.trim()};
      planningWrite(() => api(`/api/cards/${cardId}/worklogs`,'POST',data),async () => { if (state.cardEditor?.id !== cardId) return; $('worklog-minutes').value = ''; $('worklog-note').value = ''; saveDraft(); await loadWorklogs(cardId); },'Tempo registrato sul server.','card-form-error'); break;
    }
    case 'time-export': {
      if (state.timeBoard !== state.board?.id) break;
      const params = new URLSearchParams(); if (state.timeFilter?.from) params.set('from',state.timeFilter.from); if (state.timeFilter?.to) params.set('to',state.timeFilter.to);
      perform(async () => { const result = await api(`/api/boards/${state.timeBoard}/time-export?${params}`); downloadBlob(new Blob([result.csv],{type:'text/csv;charset=utf-8'}),result.filename || 'tempo-team.csv'); toast('Registro CSV scaricato dal server.'); },'','panel-error'); break;
    }
  }
});
document.addEventListener('submit',(event) => {
  const form = event.target;
  if (!['field-create-form','milestone-create-form','guidelines-form','bulk-planning-form','worklog-edit-form','time-filter-form','reply-form','notification-filter-form'].includes(form.id) && !form.dataset.fieldEdit && !form.dataset.milestoneEdit) return;
  event.preventDefault();
  const boardId = state.board?.id;
  if ((form.id === 'field-create-form' || form.id === 'milestone-create-form' || form.id === 'guidelines-form' || form.dataset.fieldEdit || form.dataset.milestoneEdit) && state.planningBoard !== boardId) { toast('Riapri Pianificazione per questa bacheca.',true); return; }
  if (form.id === 'field-create-form') {
    const type = form.elements.type.value, options = type === 'select' ? [...new Set(form.elements.options.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]:[];
    planningWrite(() => api(`/api/boards/${boardId}/fields`,'POST',{name:form.elements.name.value.trim(),key:form.elements.key.value.trim(),type,options}),() => refreshPlanning('fields'),'Campo creato.');
  } else if (form.dataset.fieldEdit) {
    planningWrite(() => api(`/api/fields/${Number(form.dataset.fieldEdit)}`,'PATCH',{name:form.elements.name.value.trim(),position:Number(form.elements.position.value)-1}),() => refreshPlanning('fields'),'Campo aggiornato.');
  } else if (form.id === 'milestone-create-form') {
    planningWrite(() => api(`/api/boards/${boardId}/milestones`,'POST',{key:form.elements.key.value.trim(),title:form.elements.title.value.trim(),due_date:form.elements.due_date.value}),() => refreshPlanning('overview'),'Traguardo creato.');
  } else if (form.dataset.milestoneEdit) {
    planningWrite(() => api(`/api/milestones/${Number(form.dataset.milestoneEdit)}`,'PATCH',{title:form.elements.title.value.trim(),due_date:form.elements.due_date.value,completed:form.elements.completed.checked}),() => refreshPlanning('overview'),'Traguardo aggiornato.');
  } else if (form.id === 'guidelines-form') {
    planningWrite(() => api(`/api/boards/${boardId}`,'PATCH',{guidelines:$('guidelines-body').value},{version:state.guidelinesVersion}),() => refreshPlanning('guidelines'),'Linee guida salvate.');
  } else if (form.id === 'bulk-planning-form') {
    if (Number(form.dataset.board) !== boardId) return;
    const action = form.dataset.action, value = action === 'labels' ? [...form.querySelectorAll('[name="labels"]:checked')].map((input) => input.value) : form.elements.value.value;
    planningWrite(() => api(`/api/boards/${boardId}/bulk`,'POST',{action,value,cards:[...state.selectedCards].map(([id,version]) => ({id,version}))}),async () => { state.selectedCards.clear(); closeDialog('panel-dialog',{force:true}); await refreshBoard(); },'Schede selezionate aggiornate.');
  } else if (form.id === 'worklog-edit-form') {
    const cardId = Number(form.dataset.card);
    planningWrite(() => api(`/api/worklogs/${Number(form.dataset.log)}`,'PATCH',{date:form.elements.date.value,minutes:Number(form.elements.minutes.value),note:form.elements.note.value.trim()},{version:Number(form.dataset.version)}),async () => { closeDialog('panel-dialog',{force:true}); if (state.cardEditor?.id === cardId) await loadWorklogs(cardId); },'Registrazione aggiornata.');
  } else if (form.id === 'time-filter-form') {
    state.timeFilter = state.timePersonal ? {week:form.elements.week.value} : {from:form.elements.from.value,to:form.elements.to.value}; showTimeReport(state.timePersonal);
  } else if (form.id === 'reply-form') {
    const id = Number(form.dataset.parent), cardId = Number(form.dataset.card), body = $('reply-body').value.trim(); if (!body) return;
    saveReplyDraft();
    planningWrite(async () => { const result = await api(`/api/comments/${id}/replies`,'POST',{body}); if (state.threadId === id && state.threadCard === cardId && $('reply-body')) $('reply-body').value = ''; forget(replyDraftKey(id,cardId)); return result; },async () => { await loadComments(cardId); await showThread(id); },'Risposta pubblicata.');
  } else if (form.id === 'notification-filter-form') {
    state.notificationFilter = {unread:form.elements.unread.checked,q:form.elements.q.value.trim()}; showFilteredNotifications();
  }
});
document.addEventListener('change',(event) => {
  const input = event.target;
  if (input.id === 'milestone-filter') { state.milestone = input.value; renderBoard(); }
  if (input.id === 'custom-filter-key') { state.customKey = input.value; renderBoard(); }
  if (input.id === 'field-type') $('field-options-label').hidden = input.value !== 'select';
  if (input.id === 'comments-author') renderComments();
  if (input.id === 'worklog-deleted' && state.cardEditor?.id) loadWorklogs(state.cardEditor.id);
});
document.addEventListener('input',(event) => {
  if (event.target.id === 'reply-body') saveReplyDraft();
  if (event.target.id === 'custom-filter-value') { state.customQuery = event.target.value; renderBoard(); }
  if (event.target.id === 'comments-query') renderComments();
});

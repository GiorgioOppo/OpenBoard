'use strict';

/* Authenticated review workflows and cross-board reports. All business options
 * and results come from the API; local storage contains only this user's drafts
 * and filter preferences. The base editor remains open beneath these panels. */
const OpenBoardEnterprise = (() => {
  const memory = {sequence:0, owner:null, catalog:null, filters:{}, reviews:{}, reviewItems:[], history:[], cards:[], reports:[], summary:null, insights:null};
  const filterKeys = ['q','status','assignee_id','priority','label','board_id','from','to','include_archived'];
  const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const e = (value) => escapeHTML(value);
  const day = (value) => globalThis.OpenBoardI18n?.isoDate?.(value) ?? value;
  const button = (label,attribute,value,style = 'secondary') => ui`<button type="button" class="button ${style}" ${attribute}="${e(value)}">${e(label)}</button>`;
  const empty = (text) => ui`<p class="enterprise-empty">${e(text)}</p>`;
  const errorHTML = ui`<p id="panel-error" class="form-error" role="alert"></p>`;
  function owner() { return String(state.auth?.user?.id || 'local'); }
  function namespace(kind,id = '') { return `enterprise.${owner()}.${kind}.${id}`; }
  function parseStored(key,fallback = {}) { try { const value = JSON.parse(stored(key)); return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback; } catch { return fallback; } }
  function cleanFilters(input = {}) {
    const result = {};
    for (const key of filterKeys) {
      const value = input[key];
      if (key === 'include_archived') { if (value === true || value === '1') result[key] = true; }
      else if (key === 'assignee_id' || key === 'board_id') { if (Number.isSafeInteger(Number(value)) && Number(value) > 0) result[key] = Number(value); }
      else if (typeof value === 'string' && value) result[key] = value.slice(0,key === 'q' ? 200:100);
    }
    return result;
  }
  function query(input = {},before) {
    const params = new URLSearchParams();
    Object.entries(input).forEach(([key,value]) => { if (value !== '' && value !== undefined && value !== false && value !== null) params.set(key,value === true ? '1':String(value)); });
    if (n(before) > 0) params.set('before',String(n(before)));
    params.set('limit','30'); return params.toString();
  }
  function session() {
    if (memory.owner !== owner()) {
      memory.owner = owner(); memory.sequence++; memory.catalog = null; memory.filters = cleanFilters(parseStored(namespace('filters')));
      memory.reviews = {}; memory.reviewItems = []; memory.cards = []; memory.reports = []; memory.summary = null; memory.insights = null;
    }
  }
  function authorized(title) {
    session();
    if (state.auth?.user) return true;
    panel(title,empty(tr('Accedi con un account per usare revisioni e report personali.')),'enterprise-account'); return false;
  }
  async function catalog() {
    if (!memory.catalog) {
      const user = owner(), result = await api('/api/catalog');
      const parsed = {};
      for (const key of ['review_statuses','review_policies','review_decisions','portfolio_statuses']) {
        if (!Array.isArray(result[key]) || !result[key].length || result[key].some((item) => !item || typeof item.value !== 'string' || !/^[a-z_]{1,40}$/.test(item.value) || typeof item.label !== 'string')) throw new Error(tr('Catalogo revisioni/report non disponibile. Aggiorna il server.'));
        parsed[key] = result[key].map((item) => ({value:item.value,label:tr(item.label)}));
      }
      if (owner() === user) memory.catalog = parsed;
      return parsed;
    }
    return memory.catalog;
  }
  function optionRows(items,value = '',blank = tr('Tutti')) {
    return (blank === null ? '' : ui`<option value="">${e(blank)}</option>`)+(items || []).map((item) => ui`<option value="${e(item.value)}" ${String(item.value) === String(value) ? 'selected':''}>${e(item.label)}</option>`).join('');
  }
  function nameFrom(key,value) { return memory.catalog?.[key]?.find((item) => item.value === value)?.label || value || '—'; }
  function start(kind,boardId = null) {
    const sequence = ++memory.sequence, user = owner();
    return () => memory.sequence === sequence && owner() === user && state.panel === kind && $('panel-dialog').open && (boardId === null || state.board?.id === boardId);
  }
  function tabs(kind) {
    return ui`<nav class="panel-tabs enterprise-tabs" aria-label="Spazio di lavoro">${button(tr('Portfolio'),'data-ent-portfolio','overview',kind === 'portfolio' ? 'primary':'secondary')}${button(tr('Revisioni della bacheca'),'data-ent-reviews','board',kind === 'reviews' ? 'primary':'secondary')}${button(tr('Le mie revisioni'),'data-ent-reviews','mine',kind === 'mine' ? 'primary':'secondary')}</nav>`;
  }
  function stats(values,title = tr('Riepilogo'),kind = 'cards') {
    const rows = Object.entries(values || {}).filter(([,value]) => typeof value === 'number');
    const names = {boards:tr('Bacheche'),total:tr('Schede'),open:tr('Aperte'),completed:tr('Completate'),blocked:tr('Bloccate'),overdue:tr('Scadute'),due_soon:tr('In scadenza'),unassigned:tr('Non assegnate'),estimate_minutes:tr('Minuti stimati'),manual_minutes:tr('Minuti manuali'),logged_minutes:tr('Minuti registrati'),variance_minutes:tr('Scostamento (minuti)'),total_minutes:tr('Minuti effettivi'),checklist_total:tr('Attività checklist'),checklist_done:tr('Checklist completate'),pending:tr('In attesa'),approved:tr('Approvate'),changes_requested:tr('Modifiche richieste'),cancelled:tr('Annullate')};
    if (kind === 'reviews') names.total = tr('Revisioni');
    return ui`<section class="enterprise-section"><h3>${e(title)}</h3><div class="stat-grid enterprise-stats">${rows.map(([key,value]) => ui`<div><strong>${n(value)}</strong><span>${e(names[key] || key)}</span></div>`).join('')}</div></section>`;
  }
  function reviewRows(items) {
    return ui`<div class="enterprise-list">${items.map((item) => ui`<article class="enterprise-row ${item.deleted_at ? 'enterprise-deleted':''}"><div><h3>${button(item.title,'data-ent-review',n(item.id),'text-button')}</h3><p>${e(nameFrom('review_statuses',item.status))}${item.deleted_at ? tr(' · Nel cestino'):''}${item.overdue ? tr(' · Scaduta'):''}</p><p>${e(item.requester || '')} · ${e(day(item.due_date) || tr('Senza scadenza'))} · ${n(item.approved_count)}/${n(item.reviewer_count)} approvazioni</p></div>${button(tr('Apri scheda'),'data-ent-card',`${n(item.board_id)}:${n(item.card_id)}`)}</article>`).join('') || empty(tr('Nessuna revisione corrisponde ai filtri.'))}</div>`;
  }
  function reviewFilterHTML(filter,members) {
    const users = members.map((item) => ({value:n(item.user_id || item.id),label:item.name || item.username}));
    return ui`<form id="enterprise-review-filter" class="enterprise-filter"><div class="form-grid"><label>Stato<select name="status">${optionRows(memory.catalog.review_statuses,filter.status)}</select></label><label>Revisore<select name="reviewer_id">${optionRows(users,filter.reviewer_id)}</select></label><label>Richiedente<select name="requester_id">${optionRows(users,filter.requester_id)}</select></label></div><div class="enterprise-actions"><label class="inline-check"><input type="checkbox" name="overdue" ${filter.overdue ? 'checked':''}>Solo scadute</label><label class="inline-check"><input type="checkbox" name="include_deleted" ${filter.include_deleted ? 'checked':''}>Includi cestino</label><button class="button secondary" type="submit">Applica filtri</button>${button(tr('Azzera filtri'),'data-ent-review-reset','')}${memory.reviews.scope === 'board' ? button(tr('Esporta CSV filtrato'),'data-ent-review-csv',''):''}</div></form>`;
  }
  async function showReviews(scope = 'board',before = null,append = false) {
    if (!authorized(tr('Revisioni'))) return;
    const boardId = state.board?.id, cardId = scope === 'card' ? state.cardEditor?.id:null;
    if (scope !== 'mine' && (!boardId || (scope === 'card' && !cardId))) { toast(tr('Apri una scheda salvata o una bacheca per leggere le revisioni.'),true); return; }
    const context = {scope,boardId,cardId}; memory.reviews = context;
    const filterKey = namespace('reviews',scope === 'mine' ? 'mine':`${boardId}.${scope}.${cardId || 0}`), filter = parseStored(filterKey);
    const kind = 'enterprise-reviews', current = start(kind,scope === 'mine' ? null:boardId);
    await showPanel(scope === 'card' ? tr('Revisioni della scheda') : scope === 'mine' ? tr('Revisioni assegnate a me'):tr('Revisioni della bacheca'),async () => {
      const path = scope === 'mine' ? '/api/me/reviews':scope === 'card' ? `/api/cards/${cardId}/reviews`:`/api/boards/${boardId}/reviews`;
      const [options,result,membership,summary] = await Promise.all([catalog(),api(`${path}?${query(filter,before)}`),scope === 'mine' ? api('/api/portfolio'):boardId ? api(`/api/boards/${boardId}/members`):Promise.resolve({members:[]}),scope === 'card' ? api(`/api/cards/${cardId}/review-summary`):scope === 'board' ? api(`/api/boards/${boardId}/review-stats`):Promise.resolve(null)]);
      if (!current()) return '';
      memory.catalog = options; memory.reviewItems = append ? [...memory.reviewItems,...(result.items || [])]:(result.items || []); memory.reviewNext = result.next_cursor;
      return tabs(scope === 'mine' ? 'mine':'reviews')+(scope === 'card' && canWrite() ? ui`<div class="enterprise-actions">${button(tr('Richiedi una revisione'),'data-ent-review-create',cardId,'primary')}</div>`:'')+reviewFilterHTML(filter,membership.members || membership.users || [])+(summary ? stats(summary,tr('Riepilogo revisioni'),'reviews'):empty(tr('Le revisioni personali mostrano solo le richieste assegnate al tuo account.')))+reviewRows(memory.reviewItems)+(result.next_cursor ? button(tr('Carica altre revisioni'),'data-ent-review-more',n(result.next_cursor)):'')+errorHTML;
    },kind);
  }
  function eligibleMembers(members,requesterId) { return members.filter((item) => item.active !== false && item.role !== 'observer' && item.global_role !== 'observer' && n(item.user_id || item.id) !== n(requesterId)); }
  function reviewerInputs(members,ids = [],requesterId) {
    const users = eligibleMembers(members,requesterId);
    return ui`<fieldset class="enterprise-reviewers"><legend>Revisori</legend>${users.map((item) => { const id = n(item.user_id || item.id); return ui`<label class="inline-check"><input type="checkbox" name="reviewer_ids" value="${id}" ${ids.includes(id) ? 'checked':''}>${e(item.name)} <span class="helper-text">@${e(item.username || '')}</span></label>`; }).join('') || empty(tr('Aggiungi alla bacheca un membro che possa modificare le schede. Il richiedente non può revisionare la propria richiesta.'))}<p class="helper-text">Da 1 a 20 revisori. Cambiare revisori o criterio azzera i voti precedenti.</p></fieldset>`;
  }
  function reviewFields(item = {}) {
    return ui`<label>Titolo della richiesta<input name="title" required maxlength="200" value="${e(item.title || '')}"></label><label>Contesto della revisione<textarea name="description" rows="4" maxlength="4000">${e(item.description || '')}</textarea></label><div class="form-grid"><label>Scadenza della revisione<input name="due_date" type="date" value="${e(item.due_date || '')}"></label><label>Criterio di approvazione<select name="policy">${optionRows(memory.catalog.review_policies,item.policy || memory.catalog.review_policies[0]?.value,null)}</select></label></div>`;
  }
  function draft(kind,id) { return parseStored(namespace(`draft.${kind}`,id)); }
  async function showReviewCreate(cardId) {
    if (!authorized(tr('Richiedi revisione')) || !canWrite() || state.cardEditor?.id !== n(cardId)) return;
    saveDraft(); const boardId = state.board.id, current = start('enterprise-review-create',boardId);
    await showPanel(tr('Richiedi una revisione'),async () => {
      const [options,members] = await Promise.all([catalog(),api(`/api/boards/${boardId}/members`)]);
      if (!current()) return ''; memory.catalog = options;
      const data = draft('review-new',cardId);
      return ui`<p>La richiesta riguarda la versione della scheda salvata sul server. La bozza della scheda rimane nell’editor.</p><form id="enterprise-review-create" data-card="${n(cardId)}" data-board="${n(boardId)}" data-ent-draft="review-new" data-ent-draft-id="${n(cardId)}">${reviewFields(data)}${reviewerInputs(members.members || [],data.reviewer_ids || [],state.auth.user.id)}<button class="button primary" type="submit">Invia richiesta di revisione</button></form><p class="helper-text">La bozza resta su questo dispositivo per il tuo account.</p>${errorHTML}`;
    },'enterprise-review-create');
  }
  function reviewDetails(item) {
    const reviewers = item.reviewers || [];
    return ui`<article class="enterprise-detail"><p class="enterprise-kicker">${e(nameFrom('review_statuses',item.status))}${item.overdue ? tr(' · Scaduta'):''}${item.deleted_at ? tr(' · Nel cestino'):''}</p><h3>${e(item.title)}</h3><p class="enterprise-prose">${e(item.description || tr('Nessun contesto aggiuntivo.'))}</p><dl class="enterprise-meta"><div><dt>Richiedente</dt><dd>${e(item.requester || '')}</dd></div><div><dt>Scadenza</dt><dd>${e(day(item.due_date) || tr('Senza scadenza'))}</dd></div><div><dt>Criterio</dt><dd>${e(nameFrom('review_policies',item.policy))}</dd></div><div><dt>Versione</dt><dd>${n(item.version)}</dd></div></dl><section><h4>Decisioni dei revisori</h4>${reviewers.map((user) => ui`<article class="enterprise-vote"><strong>${e(user.name || user.username)}</strong><span>${e(user.decision ? nameFrom('review_decisions',user.decision):tr('In attesa'))}${user.eligible === false ? tr(' · Permesso revocato'):''}</span><p class="enterprise-prose">${e(user.note || '')}</p>${user.voted_at ? ui`<time>${e(formatDate(user.voted_at))}</time>`:''}</article>`).join('') || empty(tr('Nessun revisore.'))}</section></article>`;
  }
  async function showReview(id) {
    if (!authorized(tr('Revisione'))) return;
    const current = start('enterprise-review');
    await showPanel(tr('Dettagli della revisione'),async () => {
      const [options,result] = await Promise.all([catalog(),api(`/api/reviews/${n(id)}?include_deleted=1`)]);
      if (!current()) return ''; memory.catalog = options;
      const item = result.review || result; memory.review = item;
      const ownVote = (item.reviewers || []).find((user) => n(user.user_id) === n(state.auth.user.id))?.decision;
      const voteDraft = draft('vote',id);
      return ui`<div class="enterprise-actions">${button(tr('Torna alle revisioni'),'data-ent-reviews',memory.reviews.scope || 'board')}${button(tr('Apri scheda'),'data-ent-card',`${n(item.board_id)}:${n(item.card_id)}`)}${button(tr('Cronologia'),'data-ent-history',n(item.id))}</div>${reviewDetails(item)}${item.can_vote && !item.deleted_at ? ui`<form id="enterprise-review-vote" data-id="${n(item.id)}" data-version="${n(item.version)}" data-ent-draft="vote" data-ent-draft-id="${n(item.id)}"><h4>La tua decisione</h4><label>Decisione<select name="decision">${optionRows(memory.catalog.review_decisions,voteDraft.decision || ownVote,null)}</select></label><label>Nota per il richiedente<textarea name="note" maxlength="2000" rows="3">${e(voteDraft.note || '')}</textarea></label><p class="helper-text">Per richiedere modifiche occorre una nota.</p><div class="enterprise-actions"><button type="submit" class="button primary">Invia decisione</button>${ownVote ? button(tr('Ritira il mio voto'),'data-ent-review-action','withdraw'):''}</div></form>`:''}${item.can_manage ? ui`<div class="enterprise-actions">${item.deleted_at ? button(tr('Ripristina richiesta'),'data-ent-review-action','restore'):button(tr('Modifica richiesta'),'data-ent-review-edit',n(item.id))+button(tr('Cambia revisori'),'data-ent-reviewers-edit',n(item.id))+button(tr('Duplica richiesta'),'data-ent-review-duplicate',n(item.id))+(!item.cancelled_at ? button(tr('Annulla richiesta'),'data-ent-review-action','cancel'):button(tr('Riapri richiesta'),'data-ent-review-action','reopen'))+button(tr('Sposta nel cestino'),'data-ent-review-action','delete','danger-subtle')}</div>`:''}${errorHTML}`;
    },'enterprise-review');
  }
  async function showReviewEdit(id,reviewersOnly = false) {
    const item = memory.review;
    if (!item || item.id !== n(id) || !item.can_manage) return;
    const kind = reviewersOnly ? 'enterprise-reviewers-edit':'enterprise-review-edit', current = start(kind);
    await showPanel(reviewersOnly ? tr('Cambia i revisori'):tr('Modifica la richiesta'),async () => {
      const members = reviewersOnly ? await api(`/api/boards/${n(item.board_id)}/members`):null;
      if (!current()) return '';
      const saved = draft(reviewersOnly ? 'reviewers':'review-edit',id), data = Object.keys(saved).length ? saved:item;
      return ui`<form id="${kind}" data-id="${n(id)}" data-version="${n(saved.version || item.version)}" data-ent-draft="${reviewersOnly ? 'reviewers':'review-edit'}" data-ent-draft-id="${n(id)}">${reviewersOnly ? reviewerInputs(members.members || [],saved.reviewer_ids || (item.reviewers || []).map((user) => n(user.user_id)),item.requester_id):reviewFields(data)}<div class="enterprise-actions"><button class="button primary" type="submit">Salva modifiche</button>${button(tr('Rileggi versione dal server'),'data-ent-review',n(id))}${button(tr('Scarta bozza e ricarica'),'data-ent-draft-discard',n(id))}</div><p class="helper-text">La bozza locale rimane disponibile anche in caso di conflitto. Riapri il dettaglio per verificare gli aggiornamenti.</p></form>${errorHTML}`;
    },kind);
  }
  async function showHistory(id,before = null,append = false) {
    const current = start('enterprise-history');
    await showPanel(tr('Cronologia della revisione'),async () => {
      const result = await api(`/api/reviews/${n(id)}/history?${query({},before)}`);
      if (!current()) return ''; memory.history = append ? [...memory.history,...(result.items || result.events || [])]:(result.items || result.events || []);
      const actions = {review_created:tr('Richiesta creata'),review_edited:tr('Dettagli modificati'),review_reviewers_changed:tr('Revisori cambiati'),review_voted:tr('Decisione registrata'),review_vote_withdrawn:tr('Decisione ritirata'),review_cancelled:tr('Richiesta annullata'),review_reopened:tr('Richiesta riaperta'),review_deleted:tr('Richiesta spostata nel cestino'),review_restored:tr('Richiesta ripristinata'),review_duplicated:tr('Richiesta duplicata'),review_eligibility_changed:tr('Permessi del revisore cambiati')};
      return button(tr('Torna al dettaglio'),'data-ent-review',n(id))+ui`<ol class="enterprise-history">${memory.history.map((event) => ui`<li><strong>${e(event.actor || event.author || '')}</strong> · ${e(actions[event.action] || tr('Revisione aggiornata'))}${event.decision ? ` · ${e(nameFrom('review_decisions',event.decision))}`:''}<p class="enterprise-prose">${e(event.note || event.details || '')}</p><time>${e(formatDate(event.created_at))}</time></li>`).join('') || ui`<li>Nessun evento registrato.</li>`}</ol>`+(result.next_cursor ? ui`<button type="button" class="button secondary" data-ent-history-more="${n(result.next_cursor)}" data-review="${n(id)}">Carica eventi precedenti</button>`:'')+errorHTML;
    },'enterprise-history');
  }
  async function showDuplicate(id) {
    const item = memory.review; if (!item || item.id !== n(id) || !item.can_manage) return;
    const current = start('enterprise-review-duplicate');
    await showPanel(tr('Duplica la richiesta'),async () => {
      const result = await api(`/api/boards/${n(item.board_id)}`); if (!current()) return '';
      const board = result.board || result, cards = (board.columns || []).flatMap((column) => column.cards || []);
      return ui`<form id="enterprise-review-duplicate" data-id="${n(id)}" data-version="${n(item.version)}"><label>Scheda destinataria<select name="card_id" required>${cards.map((card) => ui`<option value="${n(card.id)}" ${card.id === item.card_id ? 'selected':''}>${e(card.title)}</option>`).join('')}</select></label><p>La nuova richiesta riparte senza voti.</p><button class="button primary" type="submit">Duplica richiesta</button></form>${errorHTML}`;
    },'enterprise-review-duplicate');
  }
  function portfolioTabs(tab) { return tabs('portfolio')+ui`<nav class="panel-tabs" aria-label="Portfolio">${[['overview',tr('Panoramica')],['cards',tr('Ricerca schede')],['insights',tr('Indicatori')],['reports',tr('Report salvati')]].map(([value,label]) => button(label,'data-ent-portfolio',value,value === tab ? 'primary':'secondary')).join('')}</nav>`; }
  function portfolioFiltersHTML(filters,summary,insights) {
    const boards = (summary.boards || []).map((board) => ({value:n(board.id),label:board.name}));
    const users = (summary.users || []).map((user) => ({value:n(user.id || user.user_id),label:user.name}));
    if (filters.board_id && !boards.some((board) => board.value === filters.board_id)) boards.push({value:filters.board_id,label:tr`Bacheca ${filters.board_id} (non disponibile)`});
    if (filters.assignee_id && !users.some((user) => user.value === filters.assignee_id)) users.push({value:filters.assignee_id,label:tr`Utente ${filters.assignee_id} (non disponibile)`});
    return ui`<form id="enterprise-portfolio-filter" class="enterprise-filter"><div class="form-grid"><label>Cerca nelle schede<input name="q" type="search" maxlength="200" value="${e(filters.q || '')}" placeholder="Titolo o descrizione…"></label><label>Stato<select name="status">${optionRows(memory.catalog.portfolio_statuses,filters.status || memory.catalog.portfolio_statuses[0]?.value,null)}</select></label><label>Bacheca<select name="board_id">${optionRows(boards,filters.board_id)}</select></label><label>Assegnatario<select name="assignee_id">${optionRows(users,filters.assignee_id)}</select></label><label>Priorità<select name="priority">${optionRows(Object.entries(priorities).map(([value,label]) => ({value,label})),filters.priority)}</select></label><label>Etichetta<select name="label">${optionRows(Object.entries(labels).map(([value,label]) => ({value,label})),filters.label)}</select></label><label>Scadenza dal<input name="from" type="date" value="${e(filters.from || '')}"></label><label>Scadenza al<input name="to" type="date" value="${e(filters.to || '')}"></label></div><div class="enterprise-actions"><label class="inline-check"><input name="include_archived" type="checkbox" ${filters.include_archived ? 'checked':''}>Includi schede archiviate</label><button type="submit" class="button primary">Cerca</button>${button(tr('Azzera filtri'),'data-ent-portfolio-reset','')}${button(tr('Salva questo report'),'data-ent-report-new','')}${button(tr('Esporta CSV filtrato'),'data-ent-portfolio-csv','')}</div></form>`;
  }
  function portfolioCards(items) {
    return ui`<div class="enterprise-list">${items.map((card) => ui`<article class="enterprise-row"><div><h3>${button(card.title,'data-ent-card',`${n(card.board_id)}:${n(card.id)}`,'text-button')}</h3><p>${e(card.board_name)} / ${e(card.column_title)} · ${e(priorities[card.priority] || card.priority || '')}</p><p>${e(day(card.due_date) || tr('Senza scadenza'))}${card.completed ? tr(' · Completata'):''}${card.blocked_reason || card.dependency_blocked ? tr(' · Bloccata'):''}</p><p>${e((card.assignees || []).map((user) => user.name).filter(Boolean).join(', ') || card.assignee || tr('Non assegnata'))}</p></div><div class="enterprise-card-metrics"><span>${n(card.estimate_minutes)} min stimati</span><strong>${n(card.total_minutes ?? card.actual_minutes)} min effettivi</strong></div></article>`).join('') || empty(tr('Nessuna scheda corrisponde ai filtri.'))}</div>`;
  }
  function table(title,heads,rows,caption = '') {
    return ui`<section class="enterprise-section"><h3>${e(title)}</h3><div class="table-scroll" tabindex="0" role="region" aria-label="${e(title)}"><table class="board-table"><caption>${e(caption || title)}</caption><thead><tr>${heads.map((head) => ui`<th scope="col">${e(head)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => ui`<tr>${cells.map((cell,index) => ui`<${index ? 'td':'th scope="row"'}>${cell}</${index ? 'td':'th'}>`).join('')}</tr>`).join('') || ui`<tr><td colspan="${heads.length}">Nessun dato disponibile.</td></tr>`}</tbody></table></div></section>`;
  }
  function progress(done,total) { return ui`<progress max="${Math.max(n(total),1)}" value="${Math.max(0,Math.min(n(done),n(total)))}">${n(done)}/${n(total)}</progress><span>${n(done)} / ${n(total)}</span>`; }
  function insightsHTML(data) {
    const buckets = {'1-7':tr('1–7 giorni'),'8-30':tr('8–30 giorni'),'31+':tr('Oltre 30 giorni')};
    return table(tr('Attività giornaliera'),[tr('Giorno'),tr('Eventi')],(data.activity || []).map((entry) => [e(day(entry.date)),n(entry.count)]))+table(tr('Anzianità delle scadenze'),[tr('Intervallo'),tr('Schede')],(data.overdue_buckets || []).map((item) => [e(buckets[item.bucket] || item.bucket),n(item.count)]))+table(tr('Carico per persona'),[tr('Persona'),tr('Schede aperte'),tr('Stima (min)'),tr('Tempo (min)')],(data.capacity || []).map((user) => [e(user.name || tr('Non assegnate')),n(user.cards),n(user.estimate_minutes),n(user.total_minutes)]))+stats(data.time,tr('Stima e tempo effettivo'))+ui`<p class="helper-text">Scostamento (effettivo − stimato): <strong>${n(data.time?.variance_minutes)} minuti</strong>. I valori dipendono dalle schede accessibili al tuo account.</p>`+table(tr('Limiti WIP e colli di bottiglia'),[tr('Bacheca / lista'),tr('Aperte'),tr('Limite'),tr('Eccedenza')],(data.bottlenecks || []).map((column) => [e(`${column.board_name} / ${column.title}`),n(column.open),n(column.wip_limit),n(column.over_limit)]))+ui`<section class="enterprise-section"><h3>Avanzamento delle checklist</h3><div class="enterprise-progress">${progress(data.checklists?.done,data.checklists?.total)}</div></section>`+table(tr('Dipendenze da completare'),[tr('Scheda'),tr('Bacheca'),tr('Dipendenze aperte')],(data.dependency_blocks || []).map((card) => [button(card.title,'data-ent-card',`${n(card.board_id)}:${n(card.id)}`,'text-button'),e(card.board_name),n(card.remaining)]))+table(tr('Traguardi delle bacheche'),[tr('Traguardo'),tr('Bacheca'),tr('Scadenza'),tr('Avanzamento')],(data.milestones || []).map((item) => [e(item.title)+(item.completed ? tr(' · Completato'):'')+(item.overdue ? tr(' · Scaduto'):''),button(item.board_name,'data-ent-board',n(item.board_id),'text-button'),e(day(item.due_date) || tr('Senza scadenza')),progress(item.done,item.total)]));
  }
  function reportsHTML(reports) {
    return ui`<p>I report salvano filtri personali. I risultati vengono ricalcolati con i permessi attuali a ogni apertura.</p>${button(tr('Salva i filtri correnti'),'data-ent-report-new','','primary')}<div class="enterprise-list">${reports.slice().sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || n(b.id)-n(a.id)).map((report) => ui`<article class="enterprise-row"><div><h3>${button(report.name,'data-ent-report-apply',n(report.id),'text-button')}${report.pinned ? ui`<span class="planning-badge">In evidenza</span>`:''}</h3><p>${e(formatDate(report.updated_at || report.created_at))}</p></div><div class="enterprise-actions">${button(tr('Modifica'),'data-ent-report-edit',n(report.id))}${button(report.pinned ? tr('Togli evidenza'):tr('Metti in evidenza'),'data-ent-report-pin',n(report.id))}${button(tr('Duplica'),'data-ent-report-duplicate',n(report.id))}${button(tr('Elimina'),'data-ent-report-delete',n(report.id),'danger-subtle')}</div></article>`).join('') || empty(tr('Non hai ancora salvato report.'))}</div>`;
  }
  async function showPortfolio(tab = 'overview',before = null,append = false) {
    if (!authorized(tr('Portfolio'))) return;
    const filters = {...memory.filters}, current = start('enterprise-portfolio'); memory.portfolioTab = tab;
    await showPanel(tr('Portfolio del workspace'),async () => {
      const [options,summary,insights,result] = await Promise.all([catalog(),api('/api/portfolio'),api('/api/portfolio/insights'),tab === 'cards' ? api(`/api/portfolio/cards?${query(filters,before)}`):tab === 'reports' ? api('/api/me/reports'):Promise.resolve(null)]);
      if (!current()) return ''; memory.catalog = options; memory.summary = summary; memory.insights = insights;
      let body = portfolioTabs(tab);
      if (tab === 'cards') {
        memory.cards = append ? [...memory.cards,...(result.items || [])]:(result.items || []); memory.cardNext = result.next_cursor;
        body += portfolioFiltersHTML(filters,summary,insights)+ui`<p aria-live="polite">${memory.cards.length} schede caricate${result.next_cursor ? tr(' · Altri risultati disponibili'):''}</p>`+portfolioCards(memory.cards)+(result.next_cursor ? button(tr('Carica altre schede'),'data-ent-cards-more',n(result.next_cursor)):'')+ui`<div id="enterprise-export-pages"></div>`;
      } else if (tab === 'reports') { memory.reports = result.reports || []; body += reportsHTML(memory.reports); }
      else if (tab === 'insights') body += ui`<p>Indicatori su tutte le bacheche accessibili. Le schede archiviate sono escluse.</p><p class="notice">Le tabelle mostrano fino a 100 persone, liste, dipendenze e traguardi. Usa la ricerca per esplorare le singole schede.</p>`+insightsHTML(insights);
      else body += stats(summary.summary,tr('Il lavoro in tutte le bacheche'))+(summary.boards_truncated ? ui`<p class="notice">Sono mostrate le prime 100 bacheche. I totali comprendono tutte le bacheche accessibili; usa la navigazione principale per aprire le altre.</p>`:'')+ui`<div class="enterprise-board-grid">${(summary.boards || []).map((board) => ui`<article class="enterprise-board"><h3>${e(board.name)}</h3><p>${n(board.open)} aperte · ${n(board.completed)} completate · ${n(board.overdue)} scadute</p><div class="enterprise-progress">${progress(board.completed,board.total)}</div><div class="enterprise-actions">${button(tr('Apri bacheca'),'data-ent-board',n(board.id))}${button(tr('Cerca schede qui'),'data-ent-board-cards',n(board.id))}</div></article>`).join('') || empty(tr('Crea la prima bacheca per iniziare il portfolio.'))}</div>`;
      return body+errorHTML;
    },'enterprise-portfolio');
  }
  function filterPreview(filters) {
    const names = {q:tr('Testo'),status:tr('Stato'),priority:tr('Priorità'),label:tr('Etichetta'),board_id:tr('Bacheca'),assignee_id:tr('Assegnatario'),from:tr('Scadenza dal'),to:tr('Scadenza al'),include_archived:tr('Schede archiviate')};
    return Object.entries(filters).map(([key,value]) => {
      let display = value;
      if (key === 'status') display = nameFrom('portfolio_statuses',value);
      if (key === 'priority') display = priorities[value] || value;
      if (key === 'label') display = labels[value] || value;
      if (key === 'board_id') display = memory.summary?.boards?.find((item) => n(item.id) === n(value))?.name || tr`Bacheca ${value}`;
      if (key === 'assignee_id') display = memory.summary?.users?.find((item) => n(item.id) === n(value))?.name || tr`Utente ${value}`;
      if (key === 'include_archived') display = value ? tr('Incluse'):tr('Escluse');
      return ui`<div><dt>${e(names[key] || tr('Filtro'))}</dt><dd>${e(display)}</dd></div>`;
    }).join('');
  }
  function showReportEditor(id = null) {
    const report = id ? memory.reports.find((item) => n(item.id) === n(id)):null;
    if (id && !report) return;
    memory.sequence++;
    const saved = draft('report',id || 'new'), filters = cleanFilters(saved.filters || memory.filters);
    panel(report ? tr('Modifica il report'):tr('Salva un report personale'),ui`<form id="enterprise-report-form" data-id="${n(id)}" data-version="${n(saved.version || report?.version)}" data-ent-draft="report" data-ent-draft-id="${n(id) || 'new'}" data-ent-filters="${e(JSON.stringify(filters))}"><label>Nome del report<input name="name" maxlength="100" required value="${e(saved.name ?? report?.name ?? '')}"></label><label class="inline-check"><input name="pinned" type="checkbox" ${(saved.pinned ?? report?.pinned) ? 'checked':''}>Metti in evidenza</label>${report ? ui`<label class="inline-check"><input name="replace_filters" type="checkbox" ${saved.replace_filters ? 'checked':''}>Sostituisci i filtri salvati con quelli della bozza qui sotto</label>`:''}<p class="helper-text">${report ? tr('I filtri originali restano attivi finché non scegli di sostituirli.'):tr('Vengono salvati questi filtri della bozza, anche se cambi ricerca prima di riaprirla.')}</p><dl class="enterprise-meta">${filterPreview(filters) || ui`<div><dt>Ambito</dt><dd>Tutte le schede accessibili</dd></div>`}</dl><div class="enterprise-actions"><button class="button primary" type="submit">Salva report</button>${report ? button(tr('Scarta bozza e ricarica'),'data-ent-draft-discard',n(id)):''}</div></form>${errorHTML}`,'enterprise-report-edit');
  }
  function formData(form) {
    const data = {};
    Array.from(form.elements || []).forEach((input) => {
      if (!input.name || input.type === 'submit' || input.type === 'button') return;
      if (input.name === 'reviewer_ids') { if (!data.reviewer_ids) data.reviewer_ids = []; if (input.checked) data.reviewer_ids.push(n(input.value)); }
      else data[input.name] = input.type === 'checkbox' ? !!input.checked:input.value;
    });
    if (form.dataset.version) data.version = n(form.dataset.version);
    return data;
  }
  function persistForm(form) {
    if (!form?.dataset?.entDraft) return;
    const data = formData(form); if (form.dataset.entDraft === 'report') data.filters = reportFilters(form);
    remember(namespace(`draft.${form.dataset.entDraft}`,form.dataset.entDraftId),JSON.stringify(data));
  }
  function forgetForm(form) { if (form.dataset.entDraft) forget(namespace(`draft.${form.dataset.entDraft}`,form.dataset.entDraftId)); }
  function reportFilters(form) { try { return cleanFilters(JSON.parse(form.dataset.entFilters)); } catch { return {...memory.filters}; } }
  function write(action,refresh,message) {
    const sequence = memory.sequence, user = owner();
    return perform(() => committed(action,async(result) => { if (sequence === memory.sequence && user === owner() && $('panel-dialog').open) await refresh?.(result); },message),'','panel-error');
  }
  function setFilters(filters) { memory.filters = cleanFilters(filters); remember(namespace('filters'),JSON.stringify(memory.filters)); }
  async function exportCSV(kind,before = null) {
    const filter = kind === 'reviews' ? parseStored(namespace('reviews',`${memory.reviews.boardId}.board.0`)):memory.filters;
    const path = kind === 'reviews' ? `/api/boards/${n(memory.reviews.boardId)}/review-export`:'/api/portfolio/export';
    await perform(async () => {
      const result = await api(`${path}?${query(filter,before)}`);
      downloadBlob(new Blob([result.csv],{type:'text/csv;charset=utf-8'}),result.filename || `${kind}.csv`);
      if (kind === 'portfolio' && $('enterprise-export-pages')) $('enterprise-export-pages').innerHTML = result.next_cursor ? ui`<p class="notice">Il CSV contiene una pagina di risultati. ${button(tr('Scarica la pagina CSV successiva'),'data-ent-export-before',n(result.next_cursor))}</p>`:empty(tr('Esportazione completata.'));
      toast(result.next_cursor ? tr('Pagina CSV scaricata. Sono disponibili altri risultati.'):tr('CSV scaricato.'));
    },'','panel-error');
  }
  async function navigate(boardId,cardId = null) {
    if (!closeEditors()) return;
    closeDialog('panel-dialog'); await selectBoard(n(boardId)); if (cardId && !state.loadError) await openCard(n(cardId));
  }
  document.addEventListener('input',(event) => persistForm(event.target.closest?.('[data-ent-draft]')));
  document.addEventListener('change',(event) => persistForm(event.target.closest?.('[data-ent-draft]')));
  document.addEventListener('click',async(event) => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    const data = target.dataset;
    if (data.entPortfolio !== undefined) { showPortfolio(data.entPortfolio); return; }
    if (data.entReviews !== undefined) { showReviews(data.entReviews); return; }
    if (data.entReview !== undefined) { showReview(n(data.entReview)); return; }
    if (data.entReviewCreate !== undefined) { showReviewCreate(n(data.entReviewCreate)); return; }
    if (data.entReviewMore !== undefined) { showReviews(memory.reviews.scope,n(data.entReviewMore),true); return; }
    if (data.entReviewReset !== undefined) { forget(namespace('reviews',memory.reviews.scope === 'mine' ? 'mine':`${memory.reviews.boardId}.${memory.reviews.scope}.${memory.reviews.cardId || 0}`)); showReviews(memory.reviews.scope); return; }
    if (data.entReviewEdit !== undefined) { showReviewEdit(n(data.entReviewEdit)); return; }
    if (data.entReviewersEdit !== undefined) { showReviewEdit(n(data.entReviewersEdit),true); return; }
    if (data.entReviewDuplicate !== undefined) { showDuplicate(n(data.entReviewDuplicate)); return; }
    if (data.entDraftDiscard !== undefined) {
      const form = target.closest('form'), id = n(data.entDraftDiscard), reviewersOnly = form?.dataset.entDraft === 'reviewers';
      if (!form?.dataset.entDraft || !confirm(tr('Scartare questa bozza e ricaricare la richiesta dal server?'))) return;
      if (form.dataset.entDraft === 'report') {
        const current = start('enterprise-report-edit');
        await perform(async () => {
          const result = await api(`/api/reports/${id}`); if (!current()) return;
          const report = result.report || result; memory.reports = memory.reports.filter((item) => n(item.id) !== id); memory.reports.push(report);
          forgetForm(form); showReportEditor(id);
        },'','panel-error');
        return;
      }
      forgetForm(form); await showReview(id);
      if (state.panel === 'enterprise-review' && memory.review?.id === id) showReviewEdit(id,reviewersOnly);
      return;
    }
    if (data.entHistory !== undefined) { showHistory(n(data.entHistory)); return; }
    if (data.entHistoryMore !== undefined) { showHistory(n(data.review),n(data.entHistoryMore),true); return; }
    if (data.entReviewCsv !== undefined) { exportCSV('reviews'); return; }
    if (data.entReviewAction !== undefined) {
      const item = memory.review, action = data.entReviewAction; if (!item || !['withdraw','cancel','reopen','delete','restore'].includes(action)) return;
      if (['delete','cancel','reopen'].includes(action) && !confirm(action === 'delete' ? tr('Spostare la richiesta nel cestino?'):action === 'reopen' ? tr('Riaprire la richiesta e azzerare i voti?'):tr('Annullare la richiesta?'))) return;
      const path = `/api/reviews/${n(item.id)}${action === 'delete' ? '':action === 'withdraw' ? '/vote':`/${action}`}`, method = ['delete','withdraw'].includes(action) ? 'DELETE':'POST';
      write(() => api(path,method,method === 'POST' ? {}:undefined,{version:item.version}),() => action === 'delete' ? showReviews(memory.reviews.scope || 'board'):showReview(item.id),tr('Revisione aggiornata.')); return;
    }
    if (data.entCard !== undefined) { const [boardId,cardId] = data.entCard.split(':').map(Number); navigate(boardId,cardId); return; }
    if (data.entBoard !== undefined) { navigate(n(data.entBoard)); return; }
    if (data.entBoardCards !== undefined) { setFilters({board_id:n(data.entBoardCards)}); showPortfolio('cards'); return; }
    if (data.entCardsMore !== undefined) { showPortfolio('cards',n(data.entCardsMore),true); return; }
    if (data.entPortfolioReset !== undefined) { setFilters({}); showPortfolio('cards'); return; }
    if (data.entPortfolioCsv !== undefined) { exportCSV('portfolio'); return; }
    if (data.entExportBefore !== undefined) { exportCSV('portfolio',n(data.entExportBefore)); return; }
    if (data.entReportNew !== undefined) { showReportEditor(); return; }
    if (data.entReportApply !== undefined) { const report = memory.reports.find((item) => n(item.id) === n(data.entReportApply)); if (report) { setFilters(report.filters); showPortfolio('cards'); } return; }
    if (data.entReportEdit !== undefined) { showReportEditor(n(data.entReportEdit)); return; }
    for (const action of ['pin','delete','duplicate']) {
      const id = data[`entReport${action[0].toUpperCase()+action.slice(1)}`]; if (id === undefined) continue;
      const report = memory.reports.find((item) => n(item.id) === n(id)); if (!report) return;
      if (action === 'delete' && !confirm(tr`Eliminare il report “${report.name}”?`)) return;
      const suffix = action === 'duplicate' ? tr(' (copia)'):'';
      write(() => api(`/api/reports/${n(id)}${action === 'duplicate' ? '/duplicate':''}`,action === 'duplicate' ? 'POST':action === 'delete' ? 'DELETE':'PATCH',action === 'duplicate' ? {name:Array.from(report.name).slice(0,100-Array.from(suffix).length).join('')+suffix}:action === 'pin' ? {pinned:!report.pinned}:undefined,{version:report.version}),() => showPortfolio('reports'),tr('Report aggiornato.')); return;
    }
    if (target.id === 'reviews-card') { if (state.cardEditor?.id) { saveDraft(); showReviews('card'); } else toast(tr('Salva la scheda prima di richiedere una revisione.'),true); }
    else if (target.id === 'reviews-board') showReviews('board');
    else if (target.id === 'reviews-nav') showReviews(state.board ? 'board':'mine');
    else if (target.id === 'portfolio-nav' || target.id === 'portfolio-board') showPortfolio();
  });
  document.addEventListener('submit',(event) => {
    const form = event.target; if (!form.id?.startsWith('enterprise-')) return; event.preventDefault();
    persistForm(form); const values = formData(form), version = n(form.dataset.version), id = n(form.dataset.id);
    if (form.id === 'enterprise-review-filter') {
      const filter = {status:values.status,reviewer_id:values.reviewer_id,requester_id:values.requester_id,overdue:values.overdue,include_deleted:values.include_deleted};
      remember(namespace('reviews',memory.reviews.scope === 'mine' ? 'mine':`${memory.reviews.boardId}.${memory.reviews.scope}.${memory.reviews.cardId || 0}`),JSON.stringify(filter)); showReviews(memory.reviews.scope);
    } else if (form.id === 'enterprise-portfolio-filter') { setFilters(values); showPortfolio('cards'); }
    else if (form.id === 'enterprise-review-create') {
      if (n(form.dataset.board) !== state.board?.id || n(form.dataset.card) !== state.cardEditor?.id) { toast(tr('Riapri le revisioni della scheda. La bozza è conservata.'),true); return; }
      const body = {title:values.title.trim(),description:values.description,due_date:values.due_date,policy:values.policy,reviewer_ids:values.reviewer_ids || []};
      write(async () => { const result = await api(`/api/cards/${n(form.dataset.card)}/reviews`,'POST',body); forgetForm(form); return result; },(result) => showReview(n((result.review || result).id)),tr('Richiesta di revisione inviata.'));
    } else if (form.id === 'enterprise-review-edit' || form.id === 'enterprise-reviewers-edit') {
      const reviewersOnly = form.id === 'enterprise-reviewers-edit', body = reviewersOnly ? {reviewer_ids:values.reviewer_ids || []}:{title:values.title.trim(),description:values.description,due_date:values.due_date,policy:values.policy};
      write(async () => { const result = await api(`/api/reviews/${id}${reviewersOnly ? '/reviewers':''}`,'PATCH',body,{version}); forgetForm(form); return result; },() => showReview(id),tr('Richiesta aggiornata.'));
    } else if (form.id === 'enterprise-review-vote') {
      write(async () => { const result = await api(`/api/reviews/${id}/vote`,'POST',{decision:values.decision,note:values.note.trim()},{version}); forgetForm(form); return result; },() => showReview(id),tr('Decisione registrata.'));
    } else if (form.id === 'enterprise-review-duplicate') {
      write(() => api(`/api/reviews/${id}/duplicate`,'POST',{card_id:n(values.card_id)},{version}),(result) => showReview(n((result.review || result).id)),tr('Richiesta duplicata.'));
    } else if (form.id === 'enterprise-report-form') {
      const report = memory.reports.find((item) => n(item.id) === id), body = {name:values.name.trim(),pinned:values.pinned};
      if (!id || values.replace_filters) body.filters = reportFilters(form); else if (!report) { toast(tr('Riapri il report prima di salvarlo. La bozza è conservata.'),true); return; }
      write(async () => { const result = await api(id ? `/api/reports/${id}`:'/api/me/reports',id ? 'PATCH':'POST',body,{version:id ? version:undefined}); forgetForm(form); return result; },() => showPortfolio('reports'),tr('Report salvato.'));
    }
  });
  return {showPortfolio,showReviews,showReview,showReviewCreate,reviewDetails,reviewRows,portfolioCards,insightsHTML,cleanFilters,query,formData,memory};
})();

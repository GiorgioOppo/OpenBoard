'use strict';

/* Sprint planning and authenticated intake. The API owns all workflow data and
 * catalog choices. Drafts are scoped to the signed-in account and retain their
 * original version until explicitly discarded after a conflict. */
const OpenBoardWorkflows = (() => {
  const memory = {owner:null,sequence:0,catalog:null,items:[],history:[],sprint:null,form:null,request:null,context:{},confirmation:null};
  const e = (value) => escapeHTML(value);
  const n = (value) => Number.isFinite(Number(value)) ? Number(value):0;
  const b = (title,key,value = '',style = 'secondary') => ui`<button type="button" class="button ${style}" data-wf-${key}="${e(value)}">${e(title)}</button>`;
  const empty = (text) => ui`<p class="workflow-empty">${e(text)}</p>`;
  const errors = ui`<section id="workflow-confirmation" class="workflow-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="workflow-confirm-title" aria-describedby="workflow-confirm-message" hidden><h3 id="workflow-confirm-title">Conferma operazione</h3><p id="workflow-confirm-message"></p><div class="workflow-actions"><button id="workflow-confirm-no" type="button" class="button secondary" data-wf-confirm="no">Annulla</button><button type="button" class="button danger-subtle" data-wf-confirm="yes">Conferma</button></div></section><p id="panel-error" class="form-error" role="alert"></p>`;
  const account = () => String(state.auth?.user?.id || 'signed-out');
  const key = (kind,id = '') => `workflows.${account()}.${kind}.${id}`;
  function saved(kind,id = '') { try { const data = JSON.parse(stored(key(kind,id))); return data && typeof data === 'object' && !Array.isArray(data) ? data:{}; } catch { return {}; } }
  function session() {
    if (memory.owner !== account()) { cancelConfirmation(); memory.owner=account(); memory.sequence++; memory.catalog=null; memory.items=[]; memory.history=[]; memory.sprint=null; memory.form=null; memory.request=null; memory.context={}; }
  }
  function cancelConfirmation() { memory.confirmation?.finish(false); }
  function confirmAction(message) {
    cancelConfirmation();
    const region=$('workflow-confirmation'),text=$('workflow-confirm-message'),previous=document.activeElement,user=account(),sequence=memory.sequence,panelSequence=state.panelSequence;
    if(!region || !text)return Promise.resolve(false);
    OpenBoardI18n.text(text,message);region.hidden=false;$('workflow-confirm-no')?.focus();
    return new Promise((resolve) => {
      memory.confirmation={finish(accepted) {
        if(memory.confirmation!==this)return;
        memory.confirmation=null;region.hidden=true;
        const valid=user===account() && sequence===memory.sequence && panelSequence===state.panelSequence && $('panel-dialog').open;
        if(previous?.isConnected)previous.focus();
        resolve(!!accepted && valid);
      }};
    });
  }
  function auth(title) { session(); if (state.auth?.user) return true; panel(title,empty(tr('Accedi con un account per usare Sprint e Richieste.')),'workflows-account'); return false; }
  async function catalog() {
    if (memory.catalog) return memory.catalog;
    const user=account(), data=await api('/api/catalog'), result={};
    for (const name of ['sprint_states','sprint_card_statuses','intake_field_types','intake_request_states']) {
      if (!Array.isArray(data[name]) || !data[name].length || data[name].some((item) => !item || typeof item.value !== 'string' || !/^[a-z_]{1,40}$/.test(item.value) || typeof item.label !== 'string')) throw new OpenBoardI18n.LocalizedError(tr('Catalogo Sprint/Richieste non disponibile. Aggiorna il server.'));
      result[name]=data[name].map((item) => ({value:item.value,label:tr(item.label)}));
    }
    if (user===account()) memory.catalog=result;
    return result;
  }
  function name(kind,value) { return memory.catalog?.[kind]?.find((item) => item.value===value)?.label || value || '—'; }
  function eventAction(event) {
    const labels={
      sprint_created:tr('Sprint creato'),sprint_edited:tr('Sprint modificato'),sprint_activated:tr('Sprint attivato'),
      sprint_closed:tr('Sprint chiuso'),sprint_reopened:tr('Sprint riaperto'),sprint_deleted:tr('Sprint nel cestino'),
      sprint_restored:tr('Sprint ripristinato'),sprint_cards_added:tr('Schede aggiunte allo Sprint'),sprint_cards_removed:tr('Schede rimosse dallo Sprint'),
      sprint_capacity_set:tr('Capacità aggiornata'),sprint_snapshot_captured:tr('Osservazione salvata'),sprint_snapshot_deleted:tr('Osservazione eliminata'),
      form_created:tr('Modulo creato'),form_edited:tr('Modulo modificato'),form_published:tr('Modulo pubblicato'),
      form_paused:tr('Modulo in pausa'),form_deleted:tr('Modulo nel cestino'),form_restored:tr('Modulo ripristinato'),
      field_created:tr('Campo creato'),field_edited:tr('Campo modificato'),field_deleted:tr('Campo nel cestino'),
      field_restored:tr('Campo ripristinato'),fields_reordered:tr('Ordine dei campi aggiornato'),target_column_removed:tr('Lista di destinazione rimossa'),
      request_submitted:tr('Richiesta inviata'),request_edited:tr('Richiesta modificata'),request_note_added:tr('Nota aggiunta'),
      request_state_changed:tr('Stato della richiesta aggiornato'),request_converted:tr('Richiesta convertita in scheda'),
      request_deleted:tr('Richiesta nel cestino'),request_restored:tr('Richiesta ripristinata')
    };
    return Object.hasOwn(labels,event.action) ? labels[event.action]:tr('Aggiornamento');
  }
  function eventDetails(event) {
    const note=String(event.note || event.details || '');
    if(['sprint_cards_added','sprint_cards_removed'].includes(event.action) && /^\d+ schede$/.test(note))return tr`${note.split(' ')[0]} schede`;
    if(event.action==='sprint_capacity_set' && /^\d+ minuti$/.test(note))return tr`${note.split(' ')[0]} minuti`;
    if(event.action==='request_state_changed') {
      const states={new:tr('Nuova'),in_review:tr('In valutazione'),accepted:tr('Accettata'),rejected:tr('Respinta')};
      if(Object.hasOwn(states,note))return states[note];
    }
    if(['sprint_snapshot_captured','sprint_snapshot_deleted'].includes(event.action) && note==='UTC corrente')return tr('UTC corrente');
    if(event.action==='target_column_removed' && note==='Colonna di destinazione rimossa definitivamente.')return tr('Colonna di destinazione rimossa definitivamente.');
    return note;
  }
  function options(items,selected='',blank=tr('Tutti')) { return (blank===null ? '':ui`<option value="">${e(blank)}</option>`)+(items || []).map((item) => ui`<option value="${e(item.value)}" ${String(item.value)===String(selected) ? 'selected':''}>${e(item.label)}</option>`).join(''); }
  function query(values={},before=null) {
    const params=new URLSearchParams();
    Object.entries(values).forEach(([name,value]) => { if (value!=='' && value!==undefined && value!==null && value!==false) params.set(name,value===true ? '1':String(value)); });
    if(n(before)>0) params.set('before',String(n(before))); params.set('limit','30'); return params.toString();
  }
  function current(kind,boardId=null) { const sequence=++memory.sequence,user=account(); return () => sequence===memory.sequence && user===account() && state.panel===kind && $('panel-dialog').open && (boardId===null || n(state.board?.id)===n(boardId)); }
  async function load(kind,title,render,boardId=null) {
    cancelConfirmation();
    if (!auth(title)) return;
    const valid=current(kind,boardId);
    await showPanel(title,async () => { const result=await render(valid); return valid() ? ui`<div class="workflow-panel">${result}${errors}</div>`:''; },kind);
  }
  function tabs(active) { return ui`<nav class="panel-tabs workflow-actions" aria-label="Sprint e Richieste">${b(tr('Sprint'),'sprints','',active==='sprints' ? 'primary':'secondary')}${b(tr('Backlog'),'backlog')}${b(tr('I miei task Sprint'),'my-tasks')}${b(tr('Moduli'),'forms','',active==='forms' ? 'primary':'secondary')}${b(tr('Richieste della bacheca'),'requests','board',active==='requests' ? 'primary':'secondary')}${b(tr('Le mie richieste'),'requests','mine',active==='mine' ? 'primary':'secondary')}</nav>`; }
  function list(items,render,message) { return ui`<div class="workflow-list">${items.map(render).join('') || empty(message)}</div>`; }
  function row(title,body,actions='',deleted=false) { return ui`<article class="workflow-row${deleted ? ' workflow-deleted':''}"><div><h3>${title}</h3>${body}</div><div class="workflow-actions">${actions}</div></article>`; }
  function table(title,heads,rows) { return ui`<section class="workflow-section"><h3>${e(title)}</h3><div class="table-scroll" tabindex="0" role="region" aria-label="${e(title)}"><table class="board-table"><caption>${e(title)}</caption><thead><tr>${heads.map((head) => ui`<th scope="col">${e(head)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => ui`<tr>${cells.map((cell,index) => ui`<${index ? 'td':'th scope="row"'}>${cell}</${index ? 'td':'th'}>`).join('')}</tr>`).join('') || ui`<tr><td colspan="${heads.length}">Nessun dato disponibile.</td></tr>`}</tbody></table></div></section>`; }
  function metrics(data,title,totalLabel=tr('Schede')) {
    const labels={total:totalLabel,completed:tr('Completate'),open:tr('Aperte'),estimate_minutes:tr('Stima (min)'),completed_estimate_minutes:tr('Stima completata (min)'),remaining_minutes:tr('Stima residua (min)'),logged_minutes:tr('Registrati (min)'),completion_percent:tr('Completamento (%)'),assigned_minutes:tr('Assegnati (min)'),unassigned_minutes:tr('Stime senza assegnatario (min)'),capacity_minutes:tr('Capacità (min)'),capacity_gap_minutes:tr('Capacità mancante (min)'),estimate_missing:tr('Schede senza stima'),new:tr('Nuove'),in_review:tr('In valutazione'),accepted:tr('Accettate'),rejected:tr('Rifiutate'),converted:tr('Convertite'),deleted:tr('Nel cestino')};
    return ui`<section class="workflow-section"><h3>${e(title)}</h3><div class="stat-grid">${Object.entries(data || {}).filter(([key,value]) => Object.hasOwn(labels,key) && typeof value==='number').map(([key,value]) => ui`<div><strong>${n(value)}</strong><span>${e(labels[key])}</span></div>`).join('')}</div></section>`;
  }
  function dataForm(id,body,{entity=0,version,kind='',draftId=entity,schema,submitLabel=tr('Salva')}={}) {
    return ui`<form id="workflow-${id}" class="workflow-form" data-id="${n(entity)}" data-owner="${e(account())}"${version===undefined ? '':` data-version="${n(version)}"`}${kind ? ` data-wf-draft="${e(kind)}" data-wf-draft-id="${e(draftId)}"`:''}${schema===undefined ? '':` data-schema="${e(schema)}"`}>${body}<div class="workflow-actions"><button type="submit" class="button primary">${e(submitLabel)}</button>${kind ? b(tr('Scarta bozza e ricarica'),'discard'):''}</div></form>`;
  }
  function draft(kind,id,source={}) {
    const data=saved(`draft.${kind}`,id);
    return {data:Object.keys(data).length ? data:source,version:Object.hasOwn(data,'version') ? n(data.version):source.version,stale:Object.hasOwn(data,'version') && n(data.version)!==n(source.version)};
  }
  function conflict(stale) { return stale ? ui`<p class="notice" role="status">La bozza riguarda una versione precedente. Scarta la bozza e rileggi i dati del server prima di salvare.</p>`:''; }
  function formValues(form) {
    const values=Object.create(null);
    for (const input of Array.from(form.elements || [])) {
      if (!input.name || input.type==='submit' || input.type==='button') continue;
      if (input.name==='card_ids') { if (!values.card_ids) values.card_ids=[]; if(input.checked) values.card_ids.push(n(input.value)); }
      else values[input.name]=input.type==='checkbox' ? !!input.checked:input.value;
    }
    if (form.dataset.version!==undefined) values.version=n(form.dataset.version);
    if (form.dataset.schema!==undefined) values.schema=form.dataset.schema;
    return values;
  }
  function persist(form) { if (form?.dataset?.wfDraft && authForm(form)) remember(key(`draft.${form.dataset.wfDraft}`,form.dataset.wfDraftId),JSON.stringify(formValues(form))); }
  function clearDraft(form) { if(form?.dataset?.wfDraft) forget(key(`draft.${form.dataset.wfDraft}`,form.dataset.wfDraftId)); }
  function authForm(form) { return !!state.auth?.user && (!form.dataset.owner || form.dataset.owner===account()); }
  function write(action,refresh,message=tr('Modifica salvata.'),form=null) {
    const user=account(),sequence=memory.sequence;
    return perform(() => committed(async () => { if(user!==account() || !state.auth?.user || (form && !authForm(form))) throw new OpenBoardI18n.LocalizedError(tr('L’account è cambiato. Riapri la vista prima di salvare.')); const result=await action(); if(user===account() && form) clearDraft(form); return result; },async(result) => { if(user===account() && sequence===memory.sequence && $('panel-dialog').open) await refresh?.(result); },message),'','panel-error');
  }
  function fieldsSprint(data={}) { return ui`<label>Nome Sprint<input name="name" required maxlength="120" value="${e(data.name ?? '')}"></label><label>Obiettivo<textarea name="goal" rows="3" maxlength="4000">${e(data.goal ?? '')}</textarea></label><div class="form-grid"><label>Inizio<input name="start_date" type="date" required value="${e(data.start_date ?? '')}"></label><label>Fine<input name="end_date" type="date" required value="${e(data.end_date ?? '')}"></label></div>`; }
  async function showSprints(before=null,append=false) {
    const boardId=state.board?.id; if(!boardId) {toast(tr('Apri una bacheca per vedere gli Sprint.'),true); return;}
    const filter=saved('sprint-filter',boardId);
    await load('workflows-sprints',tr('Sprint della bacheca'),async(valid) => {
      const [choices,result]=await Promise.all([catalog(),api(`/api/boards/${n(boardId)}/sprints?${query(filter,before)}`)]); if(!valid())return '';
      memory.catalog=choices; memory.context={type:'sprints',boardId}; memory.items=append ? [...memory.items,...(result.items || [])]:(result.items || []);
      return tabs('sprints')+(canManage() ? b(tr('Crea Sprint'),'sprint-new','','primary'):'')+ui`<form id="workflow-sprint-filter" data-owner="${e(account())}" class="workflow-filter"><div class="form-grid"><label>Cerca Sprint<input name="q" type="search" maxlength="200" value="${e(filter.q || '')}"></label><label>Stato<select name="state">${options(choices.sprint_states,filter.state)}</select></label></div><label class="inline-check"><input name="include_deleted" type="checkbox" ${filter.include_deleted ? 'checked':''}>Includi cestino</label><button class="button secondary" type="submit">Applica filtri</button></form>`+list(memory.items,(item) => row(b(item.name,'sprint',n(item.id),'text-button'),ui`<p>${e(name('sprint_states',item.state))} · ${e(OpenBoardI18n.isoDate(item.start_date))} → ${e(OpenBoardI18n.isoDate(item.end_date))}${item.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p><p>${e(item.goal || tr('Nessun obiettivo aggiunto.'))}</p>`,'',!!item.deleted_at),tr('Nessuno Sprint corrisponde ai filtri.'))+(result.next_cursor ? b(tr('Carica altri Sprint'),'sprints-more',n(result.next_cursor)):'');
    },boardId);
  }
  async function showSprintEditor(id=null) {
    const boardId=state.board?.id; if(!boardId || !canManage()) return;
    await load('workflows-sprint-edit',id ? tr('Modifica Sprint'):tr('Crea Sprint'),async(valid) => {
      const source=id ? await api(`/api/sprints/${n(id)}?include_deleted=1`):{}; if(!valid())return ''; if(id && !source.permissions?.manage) throw new OpenBoardI18n.LocalizedError(tr('Non puoi modificare questo Sprint.'));
      const info=draft('sprint',id || `new-${boardId}`,source); memory.sprint=id ? source:null; memory.context={type:'sprint-edit',boardId,id:n(id)};
      return b(tr('Torna agli Sprint'),'sprints')+conflict(info.stale)+dataForm('sprint-edit',fieldsSprint(info.data),{entity:id,version:id ? info.version:undefined,kind:'sprint',draftId:id || `new-${boardId}`});
    },boardId);
  }
  function sprintDetails(item) { return ui`<article class="workflow-detail"><p class="workflow-kicker">${e(name('sprint_states',item.state))}${item.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p><h3>${e(item.name)}</h3><p class="workflow-prose">${e(item.goal || tr('Nessun obiettivo aggiunto.'))}</p><dl class="workflow-meta"><div><dt>Inizio</dt><dd>${e(OpenBoardI18n.isoDate(item.start_date))}</dd></div><div><dt>Fine</dt><dd>${e(OpenBoardI18n.isoDate(item.end_date))}</dd></div><div><dt>Versione</dt><dd>${n(item.version)}</dd></div></dl></article>`; }
  async function showSprint(id) {
    await load('workflows-sprint',tr('Dettagli Sprint'),async(valid) => {
      const [choices,item]=await Promise.all([catalog(),api(`/api/sprints/${n(id)}?include_deleted=1`)]); const progress=item.deleted_at ? null:await api(`/api/sprints/${n(id)}/progress`); if(!valid())return '';
      memory.catalog=choices; memory.sprint=item; memory.context={type:'sprint',id:n(id),boardId:item.board_id};
      const manager=item.permissions?.manage,actions=item.deleted_at ? (manager ? b(tr('Ripristina Sprint'),'sprint-action','restore'):''):(manager ? (item.state!=='closed' ? b(tr('Modifica'),'sprint-edit',id):'')+(item.state==='planned' ? b(tr('Attiva Sprint'),'sprint-action','activate'):item.state==='active' ? b(tr('Chiudi Sprint'),'sprint-action','close'):b(tr('Riapri Sprint'),'sprint-action','reopen'))+b(tr('Sposta nel cestino'),'sprint-action','delete','danger-subtle'):'');
      return tabs('sprints')+sprintDetails(item)+(progress ? metrics(progress,tr('Avanzamento Sprint')):'')+ui`<div class="workflow-actions">${item.deleted_at ? '':b(tr('Schede Sprint'),'sprint-tab','cards')+b(tr('Capacità del team'),'sprint-tab','capacity')+b(tr('Previsione'),'sprint-tab','forecast')+b(tr('Burndown osservato'),'sprint-tab','snapshots')+b(tr('Esporta CSV'),'sprint-csv',id)}${b(tr('Cronologia'),'history',`sprint:${n(id)}`)}</div><div class="workflow-actions">${actions}</div>`;
    });
  }
  function cardRows(items,{selectable=false}={}) {
    return list(items,(card) => row(`${selectable ? ui`<label class="workflow-pick"><input name="card_ids" type="checkbox" value="${n(card.id)}"><span class="sr-only">Seleziona ${e(card.title)}</span></label>`:''}${b(card.title,'card',`${n(card.board_id || memory.sprint?.board_id || state.board?.id)}:${n(card.id)}`,'text-button')}`,ui`<p>${e(card.board_name || '')}${card.column_title ? ` / ${e(card.column_title)}`:''}${card.sprint_name ? ` · ${e(card.sprint_name)}`:''}</p><p>${card.completed ? tr('Completata'):tr('Aperta')} · ${n(card.estimate_minutes)} min stimati${card.blocked_reason ? ` · ${e(card.blocked_reason)}`:''}</p>`),tr('Nessuna scheda corrisponde ai filtri.'));
  }
  async function showCards(scope='backlog',before=null,append=false) {
    const sprint=memory.sprint,boardId=state.board?.id;
    if(scope!=='mine' && !boardId && !sprint) {toast(tr('Apri una bacheca.'),true); return;}
    const identity=scope==='sprint' ? n(sprint?.id):scope==='mine' ? 'mine':n(boardId),filter=saved('card-filter',`${scope}-${identity}`);
    const path=scope==='sprint' ? `/api/sprints/${identity}/cards`:scope==='mine' ? '/api/me/sprint-tasks':`/api/boards/${n(boardId)}/backlog`;
    await load('workflows-cards',scope==='sprint' ? tr('Schede dello Sprint'):scope==='mine' ? tr('I miei task negli Sprint attivi'):tr('Backlog della bacheca'),async(valid) => {
      const [choices,result,members,sprints]=await Promise.all([catalog(),api(`${path}?${query(filter,before)}`),scope==='mine' ? Promise.resolve({members:[]}):api(`/api/boards/${n(scope==='sprint' ? sprint.board_id:boardId)}/members`),scope==='backlog' && canWrite() ? api(`/api/boards/${n(boardId)}/sprints?limit=100`):Promise.resolve({items:[]})]); if(!valid())return '';
      memory.catalog=choices; memory.context={type:'cards',scope,identity,boardId}; memory.items=append ? [...memory.items,...(result.items || [])]:(result.items || []);
      const pick=scope==='backlog' ? canWrite():scope==='sprint' && sprint.permissions?.schedule && !sprint.deleted_at && sprint.state!=='closed';
      const users=(members.members || []).map((item) => ({value:n(item.user_id || item.id),label:item.name}));
      const filterHTML=ui`<form id="workflow-card-filter" data-owner="${e(account())}" class="workflow-filter"><div class="form-grid"><label>Cerca schede<input name="q" maxlength="200" type="search" value="${e(filter.q || '')}"></label><label>Stato<select name="status">${options(choices.sprint_card_statuses,filter.status || choices.sprint_card_statuses[0]?.value,null)}</select></label><label>Priorità<select name="priority">${options(Object.entries(priorities).map(([value,label]) => ({value,label})),filter.priority)}</select></label>${users.length ? ui`<label>Assegnatario<select name="assignee_id">${options(users,filter.assignee_id)}</select></label>`:''}</div><button class="button secondary" type="submit">Applica filtri</button></form>`;
      const bulk=pick ? ui`<form id="workflow-card-bulk" data-owner="${e(account())}" data-scope="${e(scope)}" class="workflow-form">${cardRows(memory.items,{selectable:true})}<div class="workflow-actions">${scope==='backlog' ? ui`<label>Sprint destinatario<select name="sprint_id" required>${options((sprints.items || []).filter((item) => item.state!=='closed' && !item.deleted_at).map((item) => ({value:n(item.id),label:item.name})),null,tr('Seleziona Sprint'))}</select></label><button type="submit" class="button primary">Assegna selezionate</button>`:ui`<button type="submit" class="button secondary">Rimuovi selezionate dallo Sprint</button>`}</div><p class="helper-text">Seleziona fino a 100 schede della pagina caricata. I filtri e i permessi vengono verificati dal server.</p>${sprints.next_cursor ? ui`<p class="notice">Sono mostrati i primi 100 Sprint. Apri il dettaglio desiderato per le altre assegnazioni.</p>`:''}</form>`:cardRows(memory.items);
      return tabs('sprints')+(scope==='sprint' ? b(tr('Torna allo Sprint'),'sprint',identity):'')+filterHTML+bulk+(result.next_cursor ? b(tr('Carica altre schede'),'cards-more',n(result.next_cursor)):'');
    },scope==='backlog' ? boardId:null);
  }
  async function showAssignment() {
    if(!state.cardEditor?.id || !state.board?.id) {toast(tr('Salva la scheda prima di assegnare uno Sprint.'),true); return;} saveDraft();
    const boardId=state.board.id,cardId=state.cardEditor.id;
    await load('workflows-assignment',tr('Sprint della scheda'),async(valid) => {
      const result=await api(`/api/boards/${n(boardId)}/sprints?limit=100`); if(!valid())return '';
      memory.context={type:'assignment',boardId,cardId};
      return ui`<p>La bozza della scheda resta nell’editor. L’assegnazione riguarda la scheda già salvata.</p>`+dataForm('assign',ui`<label>Sprint<select name="sprint_id" required>${options((result.items || []).filter((item) => !item.deleted_at && item.state!=='closed').map((item) => ({value:n(item.id),label:item.name})),null,tr('Seleziona Sprint'))}</select></label><label>Operazione<select name="operation"><option value="add">Assegna allo Sprint</option><option value="remove">Rimuovi dallo Sprint</option></select></label>`)+(result.next_cursor ? ui`<p class="notice">Sono mostrati i primi 100 Sprint.</p>`:'');
    },boardId);
  }
  async function showSprintTab(tab) {
    const id=n(memory.sprint?.id); if(!id)return; if(tab==='cards'){await showCards('sprint');return;}
    await load(`workflows-sprint-${tab}`,tab==='capacity' ? tr('Capacità del team'):tab==='forecast' ? tr('Previsione Sprint'):tr('Burndown osservato'),async(valid) => {
      const item=await api(`/api/sprints/${id}?include_deleted=1`);
      const result=await api(`/api/sprints/${id}/${tab==='capacity' ? 'capacity-report':tab}`); if(!valid())return ''; memory.sprint=item; memory.context={type:'sprint-tab',id,tab};
      let body=b(tr('Torna allo Sprint'),'sprint',id);
      if(tab==='capacity') body+=ui`<p>La capacità e tutte le stime sono espresse in minuti per l’intero Sprint. Le stime delle schede assegnate a più persone vengono ripartite dal server.</p>`+table(tr('Capacità e carico'),[tr('Persona'),tr('Capacità (min)'),tr('Assegnati (min)'),tr('Registrati (min)'),tr('Residui (min)'),tr('Modifica')],(result.items || []).map((person) => [e(person.name),n(person.capacity_minutes),n(person.assigned_minutes),n(person.logged_minutes),n(person.remaining_minutes),item.permissions?.manage && !item.deleted_at && item.state!=='closed' ? ui`<form id="workflow-capacity-${n(person.user_id)}" data-owner="${e(account())}" class="workflow-capacity" data-version="${n(item.version)}" data-user="${n(person.user_id)}"><label><span class="sr-only">Capacità in minuti di ${e(person.name)}</span><input name="minutes" type="number" required min="0" max="1000000" step="1" value="${n(person.capacity_minutes)}"></label><button class="button secondary" type="submit">Salva</button></form>`:'—']))+metrics(result.totals,tr('Totali capacità'));
      else if(tab==='forecast') body+=(result.capacity_configured===false ? ui`<p class="notice" role="status">Capacità non configurata. Inserisci i minuti disponibili del team prima di valutare il carico.</p>`:'')+metrics(result,tr('Previsione rispetto alla capacità'))+ui`<p class="workflow-prose">${e(result.description==='Confronto tra lavoro residuo stimato e capacità dichiarata; non è una previsione di data.' ? tr('Confronto tra lavoro residuo stimato e capacità dichiarata; non è una previsione di data.'):result.description || '')}</p><p class="helper-text">Minuti stimati e capacità dichiarata, senza proiezioni automatiche da dati storici. Le schede senza stima non contribuiscono al totale dei minuti.</p>`;
      else body+=ui`<p>Ogni riga è un’osservazione salvata nel giorno UTC indicato. Non vengono ricostruiti dati per i giorni senza osservazioni. Un nuovo salvataggio aggiorna l’osservazione di oggi.</p>`+(item.permissions?.manage && !item.deleted_at && item.state==='active' ? b(tr('Salva osservazione di oggi (UTC)'),'snapshot-add','','primary'):'')+table(tr('Osservazioni del lavoro residuo'),[tr('Giorno UTC'),tr('Schede'),tr('Completate'),tr('Stima residua (min)'),tr('Acquisizione'),tr('Azioni')],(result.items || []).map((snapshot) => [e(OpenBoardI18n.isoDate(snapshot.day)),n(snapshot.total),n(snapshot.completed),n(snapshot.remaining_minutes),e(formatDate(snapshot.captured_at)),item.permissions?.manage && !item.deleted_at ? b(tr('Elimina osservazione'),'snapshot-delete',snapshot.day,'danger-subtle'):'—']));
      return body;
    });
  }
  function fieldsForm(data,columns) { return ui`<label>Nome modulo<input name="name" required maxlength="200" value="${e(data.name ?? '')}"></label><label>Descrizione<textarea name="description" maxlength="4000" rows="3">${e(data.description ?? '')}</textarea></label><label>Lista delle schede convertite<select name="column_id" required>${options(columns.map((column) => ({value:n(column.id),label:column.title})),data.column_id,tr('Seleziona lista'))}</select></label>`; }
  async function showForms(before=null,append=false) {
    const boardId=state.board?.id;if(!boardId){toast(tr('Apri una bacheca per vedere i moduli.'),true);return;}
    const filter={...saved('form-filter',boardId)};if(!canManage())delete filter.include_deleted;
    await load('workflows-forms',tr('Moduli di richiesta'),async(valid) => {
      const [choices,result]=await Promise.all([catalog(),api(`/api/boards/${n(boardId)}/intake/forms?${query(filter,before)}`)]); if(!valid())return '';
      memory.catalog=choices; memory.context={type:'forms',boardId};memory.items=append ? [...memory.items,...(result.items || [])]:(result.items || []);
      return tabs('forms')+(canManage() ? b(tr('Crea modulo'),'form-new','','primary'):'')+ui`<form id="workflow-form-filter" data-owner="${e(account())}" class="workflow-filter">${canManage() ? ui`<label class="inline-check"><input name="include_deleted" type="checkbox" ${filter.include_deleted ? 'checked':''}>Includi cestino</label><button class="button secondary" type="submit">Applica</button>`:ui`<p class="helper-text">I moduli eliminati sono visibili solo agli amministratori.</p>`}</form>`+list(memory.items,(form) => row(b(form.name,'form',n(form.id),'text-button'),ui`<p>${form.published ? tr('Pubblicato'):tr('In pausa')}${form.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p><p>${e(form.description || '')}</p>`,'',!!form.deleted_at),tr('Nessun modulo disponibile.'))+(result.next_cursor ? b(tr('Carica altri moduli'),'forms-more',n(result.next_cursor)):'');
    },boardId);
  }
  async function showFormEditor(id=null) {
    const boardId=state.board?.id;if(!boardId || !canManage())return;
    await load('workflows-form-edit',id ? tr('Modifica modulo'):tr('Crea modulo'),async(valid) => {
      const [source,board]=await Promise.all([id ? api(`/api/intake/forms/${n(id)}?include_deleted=1`):Promise.resolve({}),api(`/api/boards/${n(boardId)}`)]);if(!valid())return '';if(id && !source.can_manage)throw new OpenBoardI18n.LocalizedError(tr('Non puoi modificare questo modulo.'));
      const info=draft('form',id || `new-${boardId}`,source);memory.form=id ? source:null;memory.context={type:'form-edit',boardId,id:n(id)};
      return b(tr('Torna ai moduli'),'forms')+conflict(info.stale)+dataForm('form-edit',fieldsForm(info.data,(board.board || board).columns || []),{entity:id,version:id ? info.version:undefined,kind:'form',draftId:id || `new-${boardId}`});
    },boardId);
  }
  function fieldRows(form) {
    const active=(form.fields || []).filter((field) => !field.deleted_at);
    return list(form.fields || [],(field) => row(`${e(field.name)}${field.required ? ui` <span class="planning-badge">Obbligatorio</span>`:''}`,ui`<p>${e(name('intake_field_types',field.type))} · ${e(field.key)}${field.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p>${field.type==='select' ? ui`<p>${e((field.options || []).join(' · '))}</p>`:''}`,form.can_manage && !form.deleted_at ? (field.deleted_at ? b(tr('Ripristina campo'),'field-action',`restore:${n(field.id)}:${n(field.version)}`):b(tr('Modifica campo'),'field-edit',n(field.id))+b(tr('Elimina campo'),'field-action',`delete:${n(field.id)}:${n(field.version)}`,'danger-subtle')+(active.indexOf(field)>0 ? b(tr('Sposta su'),'field-move',`${n(field.id)}:-1`):'')+(active.indexOf(field)<active.length-1 ? b(tr('Sposta giù'),'field-move',`${n(field.id)}:1`):'')):'',!!field.deleted_at),tr('Il modulo non ha ancora campi personalizzati.'));
  }
  async function showForm(id) {
    await load('workflows-form',tr('Dettagli modulo'),async(valid) => {
      const [choices,item]=await Promise.all([catalog(),api(`/api/intake/forms/${n(id)}${canManage() ? '?include_deleted=1':''}`)]);if(!valid())return '';memory.catalog=choices;memory.form=item;memory.context={type:'form',id:n(id),boardId:item.board_id};
      return tabs('forms')+ui`<article class="workflow-detail"><p class="workflow-kicker">${item.published ? tr('Pubblicato'):tr('In pausa')}${item.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p><h3>${e(item.name)}</h3><p class="workflow-prose">${e(item.description || '')}</p>${!item.column_id ? ui`<p class="notice">Lista rimossa: scegli una nuova destinazione nelle impostazioni del modulo.</p>`:''}</article>`+(!item.deleted_at && item.published ? b(tr('Compila richiesta'),'request-new',id,'primary'):'')+(item.can_manage ? ui`<div class="workflow-actions">${item.deleted_at ? b(tr('Ripristina modulo'),'form-action','restore'):b(tr('Modifica modulo'),'form-edit',id)+b(item.published ? tr('Metti in pausa'):tr('Pubblica modulo'),'form-action',item.published ? 'pause':'publish')+b(tr('Aggiungi campo'),'field-new')+b(tr('Sposta nel cestino'),'form-action','delete','danger-subtle')}</div>`:'')+fieldRows(item);
    });
  }
  async function showFieldEditor(id=null) {
    const form=memory.form;if(!form?.can_manage || form.deleted_at)return;
    const source=id ? (form.fields || []).find((item) => n(item.id)===n(id)):{version:form.version};if(!source)return;
    await load('workflows-field-edit',id ? tr('Modifica campo'):tr('Aggiungi campo'),async(valid) => {
      const choices=await catalog();if(!valid())return '';const info=draft('field',id || `new-${form.id}`,source),data=info.data;memory.context={type:'field-edit',id:n(id),formId:n(form.id)};
      return b(tr('Torna al modulo'),'form',form.id)+conflict(info.stale)+dataForm('field-edit',ui`<label>Chiave delle risposte<input name="key" required maxlength="40" pattern="[a-z][a-z0-9_]{0,39}" value="${e(data.key ?? '')}" ${id ? 'readonly':''}></label><label>Etichetta del campo<input name="name" required maxlength="200" value="${e(data.name ?? '')}"></label><label>Tipo<select name="type">${options(choices.intake_field_types,data.type || choices.intake_field_types[0]?.value,null)}</select></label><label class="inline-check"><input name="required" type="checkbox" ${data.required ? 'checked':''}>Obbligatorio</label><label>Opzioni per i campi a scelta (una per riga)<textarea name="options" rows="4" maxlength="4000">${e(Array.isArray(data.options) ? data.options.join('\n'):data.options ?? '')}</textarea></label><p class="helper-text">Massimo 20 campi attivi. I campi a scelta usano solo le opzioni definite qui. Le richieste precedenti mantengono il proprio schema originale.</p>`,{entity:id,version:id ? info.version:form.version,kind:'field',draftId:id || `new-${form.id}`});
    });
  }
  function schemaSignature(fields) { return JSON.stringify((fields || []).map(({key,type,required,options}) => ({key,type,required:!!required,options:options || []}))); }
  function answerFields(fields,answers={}) {
    return (fields || []).filter((field) => !field.deleted_at).map((field,index) => {
      const value=Object.hasOwn(answers,field.key) ? answers[field.key]:'',required=field.required && field.type!=='boolean' ? 'required':'',id=`workflow-answer-${index}`,attrs=`name="answer:${e(field.key)}" data-answer-key="${e(field.key)}" data-answer-type="${e(field.type)}" id="${id}"`;
      let input;
      if(field.type==='boolean') input=ui`<select ${attrs}${field.required ? ' required':''}>${options([{value:'true',label:tr('Sì')},{value:'false',label:tr('No')}],value===true ? 'true':value===false ? 'false':'',tr('Non specificato'))}</select>`;
      else if(field.type==='select') input=ui`<select ${attrs} ${required}>${options((field.options || []).map((option) => ({value:option,label:option})),value,tr('Seleziona'))}</select>`;
      else if(field.type==='text') input=ui`<textarea ${attrs} ${required} maxlength="10000" rows="3">${e(value)}</textarea>`;
      else input=ui`<input ${attrs} type="${field.type==='number' ? 'number':field.type==='date' ? 'date':'text'}" ${field.type==='number' ? 'step="any"':''} ${required} value="${e(value)}">`;
      return ui`<label for="${id}">${e(field.name)}${field.required ? ui` · ${tr('Obbligatorio')}`:''}${input}</label>`;
    }).join('');
  }
  function typedAnswers(form) {
    const answers=Object.create(null);
    for(const input of Array.from(form.elements || [])) {
      if(!input.dataset?.answerKey)continue;const value=input.value,type=input.dataset.answerType;
      if(value==='')continue;
      if(type==='boolean') {if(value!=='true' && value!=='false')throw new OpenBoardI18n.LocalizedError(tr('Seleziona Sì o No.'));answers[input.dataset.answerKey]=value==='true';}
      else if(type==='number') {if(!Number.isFinite(Number(value)))throw new OpenBoardI18n.LocalizedError(tr('Inserisci un numero valido.'));answers[input.dataset.answerKey]=Number(value);}
      else answers[input.dataset.answerKey]=value;
    }
    return answers;
  }
  function draftAnswers(values,fields) { return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('answer:')).map(([key,value]) => { const field=(fields || []).find((item) => item.key===key.slice(7)); return [key.slice(7),field?.type==='boolean' ? (value==='true' ? true:value==='false' ? false:value):value]; })); }
  async function showRequestEditor(id=null,formId=null) {
    await load('workflows-request-edit',id ? tr('Modifica la tua richiesta'):tr('Compila una richiesta'),async(valid) => {
      const source=id ? await api(`/api/intake/requests/${n(id)}?include_deleted=1`):await api(`/api/intake/forms/${n(formId)}`);if(!valid())return '';if(id && !source.can_edit)throw new OpenBoardI18n.LocalizedError(tr('Questa richiesta non è modificabile.'));
      const fields=id ? source.schema_snapshot || []:(source.fields || []).filter((field) => !field.deleted_at),identity=id || `new-${formId}`,info=draft('request',identity,id ? source:{version:source.version}),signature=schemaSignature(fields),staleSchema=!!info.data.schema && info.data.schema!==signature,answers=Object.keys(info.data).some((key) => key.startsWith('answer:')) ? draftAnswers(info.data,fields):source.answers || {};
      memory.request=id ? source:null;memory.form=id ? memory.form:source;memory.context={type:'request-edit',id:n(id),formId:n(id ? source.form_id:formId),schema:fields};
      return b(id ? tr('Torna alla richiesta'):tr('Torna al modulo'),id ? 'request':'form',id || formId)+conflict(info.stale)+(staleSchema ? ui`<p class="notice" role="alert">Il modulo è cambiato dalla bozza. La bozza precedente resta conservata: scartala per compilare i campi aggiornati.</p>`:'')+(source.form_changed ? ui`<p class="notice">Il modulo è cambiato: questa richiesta usa i campi e le opzioni originali.</p>`:'')+dataForm('request-edit',ui`<label>Titolo della richiesta<input name="title" required maxlength="300" value="${e(info.data.title ?? (id ? source.title:''))}"></label>${answerFields(fields,answers)}${staleSchema ? ui`<p class="form-error">Scarta la bozza prima di inviare.</p>`:''}`,{entity:id,version:id ? info.version:source.version,kind:'request',draftId:identity,schema:staleSchema ? info.data.schema:signature});
    });
  }
  function requestRows(items) { return list(items,(item) => row(b(item.title,'request',n(item.id),'text-button'),ui`<p>${e(name('intake_request_states',item.state))} · ${e(item.author || '')}${item.deleted_at ? ui` · ${tr('Nel cestino')}`:''}${item.converted_card_id ? ui` · ${tr('Convertita in scheda')}`:''}</p><p>${e(formatDate(item.created_at))}</p>`,'',!!item.deleted_at),tr('Nessuna richiesta corrisponde ai filtri.')); }
  async function showRequests(scope='board',before=null,append=false) {
    const boardId=state.board?.id;if(scope==='board' && !boardId){toast(tr('Apri una bacheca per vedere le richieste.'),true);return;}
    const identity=scope==='mine' ? 'mine':boardId,filter=saved('request-filter',identity),path=scope==='mine' ? '/api/me/intake/requests':`/api/boards/${n(boardId)}/intake/requests`;
    await load('workflows-requests',scope==='mine' ? tr('Le mie richieste'):tr('Richieste della bacheca'),async(valid) => {
      const [choices,result,stats]=await Promise.all([catalog(),api(`${path}?${query(filter,before)}`),scope==='board' && canWrite() ? api(`/api/boards/${n(boardId)}/intake/stats`):Promise.resolve(null)]);if(!valid())return '';memory.catalog=choices;memory.context={type:'requests',scope,boardId};memory.items=append ? [...memory.items,...(result.items || [])]:(result.items || []);
      return tabs(scope==='mine' ? 'mine':'requests')+ui`<form id="workflow-request-filter" data-owner="${e(account())}" class="workflow-filter"><div class="form-grid"><label>Cerca richieste<input name="q" type="search" maxlength="200" value="${e(filter.q || '')}"></label><label>Stato<select name="state">${options(choices.intake_request_states,filter.state)}</select></label></div><label class="inline-check"><input name="include_deleted" type="checkbox" ${filter.include_deleted ? 'checked':''}>Includi cestino</label><button class="button secondary" type="submit">Applica filtri</button></form>`+(stats ? metrics(stats,tr('Stato delle richieste'),tr('Richieste'))+b(tr('Esporta CSV'),'intake-csv',boardId):'')+requestRows(memory.items)+(result.next_cursor ? b(tr('Carica altre richieste'),'requests-more',n(result.next_cursor)):'');
    },scope==='board' ? boardId:null);
  }
  function requestDetails(item) {
    return ui`<article class="workflow-detail"><p class="workflow-kicker">${e(name('intake_request_states',item.state))}${item.deleted_at ? ui` · ${tr('Nel cestino')}`:''}</p><h3>${e(item.title)}</h3><p>${e(item.author || '')} · ${e(formatDate(item.created_at))}</p>${item.form_changed ? ui`<p class="notice">Il modulo attuale è cambiato. Le risposte qui sotto usano lo schema originale della richiesta.</p>`:''}<dl class="workflow-meta">${(item.schema_snapshot || []).map((field) => ui`<div><dt>${e(field.name)} <span class="helper-text">${e(name('intake_field_types',field.type))}</span></dt><dd class="workflow-prose">${Object.hasOwn(item.answers || {},field.key) ? e(typeof item.answers[field.key]==='boolean' ? (item.answers[field.key] ? tr('Sì'):tr('No')):item.answers[field.key]):tr('Non specificato')}</dd></div>`).join('')}</dl></article>`;
  }
  async function showRequest(id) {
    await load('workflows-request',tr('Dettagli richiesta'),async(valid) => {
      const [choices,item]=await Promise.all([catalog(),api(`/api/intake/requests/${n(id)}?include_deleted=1`)]);if(!valid())return '';memory.catalog=choices;memory.request=item;memory.context={type:'request',id:n(id),boardId:item.board_id};
      const note=draft('note',id,item),manager=item.can_triage;
      return tabs('requests')+requestDetails(item)+(item.converted_card_id && item.converted_card_available===false ? ui`<p class="notice">La scheda creata è stata rimossa.</p>`:'')+ui`<div class="workflow-actions">${b(tr('Cronologia richiesta'),'history',`request:${n(id)}`)}${item.converted_card_id && item.converted_card_available!==false ? b(tr('Apri scheda creata'),'card',`${n(item.board_id)}:${n(item.converted_card_id)}`):''}${item.deleted_at ? (item.can_edit || item.can_triage || n(item.author_id)===n(state.auth.user.id) ? b(tr('Ripristina richiesta'),'request-action','restore'):''):((item.can_edit ? b(tr('Modifica risposte'),'request-edit',id):'')+(item.can_edit || manager || n(item.author_id)===n(state.auth.user.id) ? b(tr('Sposta nel cestino'),'request-action','delete','danger-subtle'):''))}</div>`+(!item.deleted_at && manager && !item.converted_card_id ? dataForm('triage',ui`<label>Stato della richiesta<select name="state">${options(choices.intake_request_states,item.state,null)}</select></label>`,{entity:id,version:item.version,submitLabel:tr('Aggiorna stato')})+(item.state==='accepted' && !item.converted_card_id ? dataForm('convert',ui`<label>Descrizione della scheda (facoltativa)<textarea name="description" maxlength="10000" rows="3" placeholder="Lascia vuoto per usare le risposte originali"></textarea></label><p class="helper-text">Conferma per convertire la richiesta in una scheda. Puoi sintetizzare risposte molto lunghe; la richiesta originale resta disponibile.</p>`,{entity:id,version:item.version,submitLabel:tr('Converti in scheda')}):''):'')+ui`<section class="workflow-section"><h3>Discussione</h3>${list(item.notes || [],(note) => row(e(note.author || note.actor || ''),ui`<p class="workflow-prose">${e(note.body || '')}</p><p>${e(formatDate(note.created_at))}</p>`),tr('Nessuna nota.'))}</section>`+(!item.deleted_at && (manager || n(item.author_id)===n(state.auth.user.id)) ? conflict(note.stale)+dataForm('note',ui`<label>Aggiungi una nota<textarea name="body" required maxlength="2000" rows="3">${e(note.data.body || '')}</textarea></label>`,{entity:id,version:note.version,kind:'note',draftId:id,submitLabel:tr('Pubblica nota')}):'');
    });
  }
  async function showHistory(scope,id,before=null,append=false) {
    const path=scope==='sprint' ? `/api/sprints/${n(id)}/history`:`/api/intake/requests/${n(id)}/history`;
    await load('workflows-history',tr('Cronologia'),async(valid) => {
      const result=await api(`${path}?${query({},before)}`);if(!valid())return '';memory.context={type:'history',scope,id:n(id)};memory.history=append ? [...memory.history,...(result.items || [])]:(result.items || []);
      return b(tr('Torna al dettaglio'),scope==='sprint' ? 'sprint':'request',id)+ui`<ol class="workflow-history">${memory.history.map((event) => ui`<li><strong>${e(event.actor || event.author || '')}</strong><p>${e(eventAction(event))}</p><p class="workflow-prose">${e(eventDetails(event))}</p><time>${e(formatDate(event.created_at))}</time></li>`).join('') || ui`<li>Nessun evento registrato.</li>`}</ol>`+(result.next_cursor ? b(tr('Carica eventi precedenti'),'history-more',n(result.next_cursor)):'');
    });
  }
  async function exportCSV(scope,id) {
    const user=account();
    await perform(async () => {
      let csv,filename;
      if(scope==='sprint') {const result=await api(`/api/sprints/${n(id)}/export`);if(result.truncated || result.next_cursor)throw new OpenBoardI18n.LocalizedError(tr('Il CSV restituito è incompleto. Restringi l’esportazione.'));csv=result.csv;filename=result.filename;}
      else {
        const controller=new AbortController(),timeout=setTimeout(() => controller.abort(),15000);let response;try{response=await fetch(`/api/boards/${n(id)}/intake/export`,{headers:{Accept:'text/csv'},credentials:'same-origin',cache:'no-store',signal:controller.signal});}finally{clearTimeout(timeout);}
        if(!response.ok) {let message=tr('Esportazione non riuscita.');try{message=(await response.json()).error || message;}catch{}throw new Error(message);}
        if(!String(response.headers.get('Content-Type') || '').toLowerCase().includes('text/csv'))throw new OpenBoardI18n.LocalizedError(tr('Il server non ha restituito un CSV valido.'));
        csv=await response.text();filename=`openboard-richieste-${n(id)}.csv`;
      }
      if(user!==account())return;
      if(typeof csv!=='string')throw new OpenBoardI18n.LocalizedError(tr('Esportazione CSV non valida.'));
      const safeName=typeof filename==='string' && /^[A-Za-z0-9_.-]{1,120}\.csv$/.test(filename) ? filename:`openboard-${scope}-${n(id)}.csv`;
      downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),safeName);toast(tr('CSV completo scaricato (massimo 1000 righe).'));
    },'','panel-error');
  }
  async function navigate(value) {const [boardId,cardId]=value.split(':').map(Number);if(!closeEditors())return;memory.sequence++;closeDialog('panel-dialog');await selectBoard(boardId);if(cardId && !state.loadError)await openCard(cardId);}
  async function discard(form) {
    if(!form?.dataset.wfDraft || !await confirmAction(tr('Scartare questa bozza e ricaricare i dati del server?')))return;
    const context={...memory.context};clearDraft(form);
    if(context.type==='sprint-edit')await showSprintEditor(context.id || null);
    else if(context.type==='form-edit')await showFormEditor(context.id || null);
    else if(context.type==='field-edit') {await showForm(context.formId);if(memory.form?.id===context.formId)await showFieldEditor(context.id || null);}
    else if(context.type==='request-edit')await showRequestEditor(context.id || null,context.formId);
    else if(context.type==='request')await showRequest(context.id);
  }
  document.addEventListener('input',(event) => persist(event.target.closest?.('[data-wf-draft]')));
  document.addEventListener('change',(event) => persist(event.target.closest?.('[data-wf-draft]')));
  document.addEventListener('keydown',(event) => {
    if(memory.confirmation && event.key==='Escape') {event.preventDefault();event.stopPropagation();cancelConfirmation();}
  },true);
  $('panel-dialog')?.addEventListener?.('close',cancelConfirmation);
  document.addEventListener('click',async(event) => {
    const target=event.target.closest('button');if(!target || target.disabled)return;session();const data=target.dataset;
    if(data.wfConfirm!==undefined){memory.confirmation?.finish(data.wfConfirm==='yes');return;}
    cancelConfirmation();
    if(data.wfSprints!==undefined || target.id==='sprints-nav' || target.id==='sprints-board'){await showSprints();return;}
    if(data.wfForms!==undefined || target.id==='intake-nav' || target.id==='intake-board'){await showForms();return;}
    if(target.id==='sprint-card'){await showAssignment();return;}
    if(data.wfSprint!==undefined){await showSprint(n(data.wfSprint));return;}
    if(data.wfSprintNew!==undefined){await showSprintEditor();return;}
    if(data.wfSprintEdit!==undefined){await showSprintEditor(n(data.wfSprintEdit));return;}
    if(data.wfSprintsMore!==undefined){await showSprints(n(data.wfSprintsMore),true);return;}
    if(data.wfBacklog!==undefined){await showCards('backlog');return;}
    if(data.wfMyTasks!==undefined){await showCards('mine');return;}
    if(data.wfCardsMore!==undefined){await showCards(memory.context.scope,n(data.wfCardsMore),true);return;}
    if(data.wfSprintTab!==undefined){await showSprintTab(data.wfSprintTab);return;}
    if(data.wfSprintCsv!==undefined){await exportCSV('sprint',n(data.wfSprintCsv));return;}
    if(data.wfSprintAction!==undefined){const item=memory.sprint,action=data.wfSprintAction;if(!item?.permissions?.manage || !['activate','close','reopen','delete','restore'].includes(action))return;if(action==='delete' && !await confirmAction(tr('Spostare questo Sprint nel cestino?')))return;await write(() => api(`/api/sprints/${n(item.id)}${action==='delete' ? '':`/${action}`}`,action==='delete' ? 'DELETE':'POST',action==='delete' ? undefined:{},{version:item.version}),() => action==='delete' ? showSprints():showSprint(item.id));return;}
    if(data.wfSnapshotAdd!==undefined || data.wfSnapshotDelete!==undefined){const item=memory.sprint;if(!item?.permissions?.manage)return;const day=data.wfSnapshotDelete;if(day!==undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !await confirmAction(tr('Eliminare questa osservazione?'))))return;await write(() => api(`/api/sprints/${n(item.id)}/snapshots${day===undefined ? '':`/${day}`}`,day===undefined ? 'POST':'DELETE',day===undefined ? {}:undefined,{version:item.version}),() => showSprintTab('snapshots'));return;}
    if(data.wfForm!==undefined){await showForm(n(data.wfForm));return;}
    if(data.wfFormNew!==undefined){await showFormEditor();return;}
    if(data.wfFormEdit!==undefined){await showFormEditor(n(data.wfFormEdit));return;}
    if(data.wfFormsMore!==undefined){await showForms(n(data.wfFormsMore),true);return;}
    if(data.wfFormAction!==undefined){const item=memory.form,action=data.wfFormAction;if(!item?.can_manage || !['publish','pause','delete','restore'].includes(action))return;if(action==='delete' && !await confirmAction(tr('Spostare il modulo nel cestino?')))return;await write(() => api(`/api/intake/forms/${n(item.id)}${action==='delete' ? '':`/${action}`}`,action==='delete' ? 'DELETE':'POST',action==='delete' ? undefined:{},{version:item.version}),() => action==='delete' ? showForms():showForm(item.id));return;}
    if(data.wfFieldNew!==undefined){await showFieldEditor();return;}
    if(data.wfFieldEdit!==undefined){await showFieldEditor(n(data.wfFieldEdit));return;}
    if(data.wfFieldAction!==undefined){const [action,id,version]=data.wfFieldAction.split(':'),item=memory.form;if(!item?.can_manage || !['delete','restore'].includes(action))return;if(action==='delete' && !await confirmAction(tr('Eliminare il campo dalle nuove richieste?')))return;await write(() => api(`/api/intake/fields/${n(id)}${action==='restore' ? '/restore':''}`,action==='restore' ? 'POST':'DELETE',action==='restore' ? {}:undefined,{version:n(version)}),() => showForm(item.id));return;}
    if(data.wfFieldMove!==undefined){const [id,step]=data.wfFieldMove.split(':').map(Number),item=memory.form;if(!item?.can_manage)return;const ids=(item.fields || []).filter((field) => !field.deleted_at).map((field) => n(field.id)),index=ids.indexOf(id),next=index+step;if(index<0 || next<0 || next>=ids.length)return;[ids[index],ids[next]]=[ids[next],ids[index]];await write(() => api(`/api/intake/forms/${n(item.id)}/fields/reorder`,'POST',{field_ids:ids},{version:item.version}),() => showForm(item.id));return;}
    if(data.wfRequests!==undefined){await showRequests(data.wfRequests);return;}
    if(data.wfRequestsMore!==undefined){await showRequests(memory.context.scope,n(data.wfRequestsMore),true);return;}
    if(data.wfRequest!==undefined){await showRequest(n(data.wfRequest));return;}
    if(data.wfRequestNew!==undefined){await showRequestEditor(null,n(data.wfRequestNew));return;}
    if(data.wfRequestEdit!==undefined){await showRequestEditor(n(data.wfRequestEdit));return;}
    if(data.wfRequestAction!==undefined){const item=memory.request,action=data.wfRequestAction;if(!item || !['delete','restore','convert'].includes(action))return;if(['delete','convert'].includes(action) && !await confirmAction(action==='convert' ? tr('Creare una scheda da questa richiesta accettata?'):tr('Spostare la richiesta nel cestino?')))return;await write(() => api(`/api/intake/requests/${n(item.id)}${action==='delete' ? '':`/${action}`}`,action==='delete' ? 'DELETE':'POST',action==='delete' ? undefined:{},{version:item.version}),async(result) => {const cardId=n(result.converted_card_id || result.card_id || result.request?.converted_card_id);if(action==='convert' && cardId)await navigate(`${n(item.board_id)}:${cardId}`);else if(action==='delete')await showRequests('mine');else await showRequest(item.id);});return;}
    if(data.wfHistory!==undefined){const [scope,id]=data.wfHistory.split(':');await showHistory(scope,n(id));return;}
    if(data.wfHistoryMore!==undefined){await showHistory(memory.context.scope,memory.context.id,n(data.wfHistoryMore),true);return;}
    if(data.wfIntakeCsv!==undefined){await exportCSV('intake',n(data.wfIntakeCsv));return;}
    if(data.wfCard!==undefined){await navigate(data.wfCard);return;}
    if(data.wfDiscard!==undefined)await discard(target.closest('form'));
  });
  document.addEventListener('submit',async(event) => {
    const form=event.target;if(!form.id?.startsWith('workflow-'))return;event.preventDefault();session();if(!authForm(form)){toast(tr('L’account è cambiato. Riapri questa vista.'),true);return;}persist(form);
    const values=formValues(form),id=n(form.dataset.id),version=form.dataset.version===undefined ? undefined:n(form.dataset.version),context={...memory.context};
    if(form.id==='workflow-sprint-filter'){remember(key('sprint-filter',state.board.id),JSON.stringify({q:values.q,state:values.state,include_deleted:values.include_deleted}));await showSprints();return;}
    if(form.id==='workflow-form-filter'){remember(key('form-filter',state.board.id),JSON.stringify({include_deleted:values.include_deleted}));await showForms();return;}
    if(form.id==='workflow-card-filter'){remember(key('card-filter',`${context.scope}-${context.identity}`),JSON.stringify({q:values.q,status:values.status,priority:values.priority,assignee_id:values.assignee_id}));await showCards(context.scope);return;}
    if(form.id==='workflow-request-filter'){remember(key('request-filter',context.scope==='mine' ? 'mine':context.boardId),JSON.stringify({q:values.q,state:values.state,include_deleted:values.include_deleted}));await showRequests(context.scope);return;}
    if(form.id==='workflow-sprint-edit'){await write(() => api(id ? `/api/sprints/${id}`:`/api/boards/${n(context.boardId)}/sprints`,id ? 'PATCH':'POST',{name:values.name.trim(),goal:values.goal,start_date:values.start_date,end_date:values.end_date},{version}),(result) => showSprint(n(result.id || result.sprint?.id)),tr('Sprint salvato.'),form);return;}
    if(form.id==='workflow-card-bulk' || form.id==='workflow-assign'){
      const assignment=form.id==='workflow-assign',cardIds=assignment ? [context.cardId]:(values.card_ids || []),sprintId=assignment || context.scope==='backlog' ? n(values.sprint_id):n(memory.sprint?.id),remove=assignment ? values.operation==='remove':context.scope==='sprint';
      if(!cardIds.length || cardIds.length>100 || !sprintId){toast(tr('Scegli uno Sprint e da 1 a 100 schede.'),true);return;}
      if(assignment && (n(state.cardEditor?.id)!==n(context.cardId) || n(state.board?.id)!==n(context.boardId))){toast(tr('Riapri gli Sprint della scheda prima di salvare.'),true);return;}
      await write(async () => {const item=await api(`/api/sprints/${sprintId}`);if(assignment)return api(`/api/sprints/${sprintId}/cards${remove ? `/${n(cardIds[0])}`:''}`,remove ? 'DELETE':'POST',remove ? undefined:{card_id:n(cardIds[0])},{version:item.version});return api(`/api/sprints/${sprintId}/cards/bulk`,remove ? 'DELETE':'POST',{card_ids:cardIds},{version:item.version});},() => assignment ? showAssignment():showCards(context.scope),tr('Assegnazione Sprint aggiornata.'));return;
    }
    if(form.id.startsWith('workflow-capacity-')){const sprintId=n(memory.sprint?.id);await write(() => api(`/api/sprints/${sprintId}/capacity/${n(form.dataset.user)}`,'PATCH',{minutes:n(values.minutes)},{version}),() => showSprintTab('capacity'));return;}
    if(form.id==='workflow-form-edit'){await write(() => api(id ? `/api/intake/forms/${id}`:`/api/boards/${n(context.boardId)}/intake/forms`,id ? 'PATCH':'POST',{name:values.name.trim(),description:values.description,column_id:n(values.column_id)},{version}),(result) => showForm(n(result.id || result.form?.id)),tr('Modulo salvato.'),form);return;}
    if(form.id==='workflow-field-edit'){const body={name:values.name.trim(),type:values.type,required:values.required,options:values.type==='select' ? values.options.split('\n').map((item) => item.trim()).filter(Boolean):[]};if(!id)body.key=values.key;await write(() => api(id ? `/api/intake/fields/${id}`:`/api/intake/forms/${n(context.formId)}/fields`,id ? 'PATCH':'POST',body,{version}),() => showForm(context.formId),tr('Campo salvato.'),form);return;}
    if(form.id==='workflow-request-edit'){
      if(form.dataset.schema!==schemaSignature(context.schema)){toast(tr('Il modulo è cambiato. Scarta la bozza per compilare i campi aggiornati.'),true);return;}
      await write(() => api(id ? `/api/intake/requests/${id}`:`/api/intake/forms/${n(context.formId)}/requests`,id ? 'PATCH':'POST',{title:values.title.trim(),answers:typedAnswers(form)},{version}),(result) => showRequest(n(result.id || result.request?.id)),tr('Richiesta salvata.'),form);return;
    }
    if(form.id==='workflow-convert'){let cardId=0;const boardId=n(memory.request?.board_id);await write(async () => {const result=await api(`/api/intake/requests/${id}/convert`,'POST',values.description.trim() ? {description:values.description}:{},{version});cardId=n(result.converted_card_id || result.card_id || result.request?.converted_card_id);return result;},() => showRequest(id),tr('Richiesta convertita in scheda.'));if(cardId)await navigate(`${boardId}:${cardId}`);return;}
    if(form.id==='workflow-triage'){await write(() => api(`/api/intake/requests/${id}/state`,'POST',{state:values.state},{version}),() => showRequest(id));return;}
    if(form.id==='workflow-note'){await write(() => api(`/api/intake/requests/${id}/notes`,'POST',{body:values.body.trim()},{version}),() => showRequest(id),tr('Nota aggiunta.'),form);}
  });
  return {memory,showSprints,showSprint,showSprintEditor,showCards,showAssignment,showSprintTab,showForms,showForm,showFormEditor,showFieldEditor,showRequests,showRequest,showRequestEditor,showHistory,exportCSV,sprintDetails,requestDetails,answerFields,typedAnswers,formValues,schemaSignature,query,cardRows,requestRows};
})();

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../web/enterprise.js'),'utf8');
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const options = {
  review_statuses:[{value:'pending',label:'In attesa'},{value:'approved',label:'Approvata'},{value:'changes_requested',label:'Modifiche richieste'},{value:'cancelled',label:'Annullata'}],
  review_policies:[{value:'all',label:'Tutti i revisori'},{value:'any',label:'Almeno un revisore'}],
  review_decisions:[{value:'approved',label:'Approva'},{value:'changes_requested',label:'Richiedi modifiche'}],
  portfolio_statuses:[{value:'all',label:'Tutte'},{value:'open',label:'Aperte'},{value:'blocked',label:'Bloccate'}]
};
function review(id,title = `Review ${id}`) { return {id,title,card_id:8,board_id:7,version:3,requester_id:2,requester:'Alice',description:'Contesto',policy:'all',status:'pending',reviewers:[{user_id:1,name:'Revisore',eligible:true,decision:null}],can_manage:true,can_vote:true}; }
function deferred() { let resolve,reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }
const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); };
function runtime() {
  const listeners = new Map(), nodes = new Map(), storage = new Map(), requests = [], downloads = [];
  for (const id of ['panel-dialog','panel-body','panel-error','card-dialog','enterprise-export-pages']) nodes.set(id,{open:true,innerHTML:'',textContent:'',dataset:{}});
  const summary = {summary:{boards:1,total:1,open:1,completed:0},boards:[{id:7,name:'Bacheca',total:1,completed:0}],users:[{id:1,name:'Ada'}]};
  const insights = {activity:[],capacity:[],overdue_buckets:[],time:{estimate_minutes:60,total_minutes:45,variance_minutes:-15},bottlenecks:[],checklists:{done:1,total:2},dependency_blocks:[],milestones:[]};
  const context = {
    state:{auth:{enabled:true,user:{id:1,role:'member'}},board:{id:7},cardEditor:{id:8}},
    escapeHTML,URLSearchParams,Blob,priorities:{normal:'Normale'},labels:{design:'Design'},
    document:{addEventListener(name,fn){ if (!listeners.has(name)) listeners.set(name,[]); listeners.get(name).push(fn); }},
    $:(id) => nodes.get(id) || null,stored:(key) => storage.get(key) || '',remember:(key,value) => storage.set(key,value),forget:(key) => storage.delete(key),
    canWrite:() => true,saveDraft(){ context.savedCardDraft=true; },formatDate:(value) => value || '',closeEditors:() => true,
    closeDialog(){},selectBoard:async(id) => {context.selectedBoard=id;},openCard:async(id) => {context.selectedCard=id;},
    downloadBlob:(blob,name) => downloads.push({blob,name}),toast:(message) => {context.toastMessage=message;},confirm:() => true,
    api:async(path,method='GET',body,extra={}) => {
      const request = {path,method,body,extra}; requests.push(request);
      if (context.route) { const result=context.route(request); if (result !== undefined) return result; }
      if (path === '/api/catalog') return options;
      if (path === '/api/portfolio') return summary;
      if (path === '/api/portfolio/insights') return insights;
      if (path.startsWith('/api/portfolio/cards?')) return {items:[]};
      if (path === '/api/me/reports') return {reports:[]};
      if (path.endsWith('/members')) return {members:[{user_id:1,name:'Ada',username:'ada',role:'member',global_role:'member'},{user_id:2,name:'Bob',role:'member',global_role:'member'},{user_id:3,name:'Observer',role:'observer',global_role:'member'},{user_id:4,name:'Global observer',role:'member',global_role:'observer'}]};
      if (path.endsWith('/review-stats') || path.endsWith('/review-summary')) return {total:0,pending:0,approved:0};
      if (/\/reviews\?/.test(path)) return {items:[]};
      if (/^\/api\/reviews\/\d+\?include_deleted=1$/.test(path) && method === 'GET') return review(Number(path.split('?')[0].split('/').at(-1)));
      if (method !== 'GET') return {id:40,version:4};
      throw new Error(`Unhandled fake API request: ${method} ${path}`);
    }
  };
  context.panel = (title,body,kind) => {context.state.panel=kind; context.state.panelSequence=(context.state.panelSequence || 0)+1; nodes.get('panel-body').innerHTML=body;};
  context.showPanel = async(title,loader,kind) => {context.panel(title,'Loading',kind); const sequence=context.state.panelSequence; try { const body=await loader(); if (sequence===context.state.panelSequence) nodes.get('panel-body').innerHTML=body; } catch (error) { if(sequence===context.state.panelSequence) {context.lastError=error; nodes.get('panel-body').innerHTML=escapeHTML(error.message);} } };
  context.perform = async(action) => {try {return await action();} catch(error) {context.lastError=error; nodes.get('panel-error').textContent=error.message;} };
  context.committed = async(write,refresh) => {const result=await write(); if(refresh) await refresh(result); return result;};
  vm.createContext(context); vm.runInContext(source+'\nthis.enterprise=OpenBoardEnterprise;',context);
  async function emit(name,target) { for (const listener of listeners.get(name) || []) await listener({target,preventDefault(){}}); await tick(); }
  return {context,nodes,storage,requests,downloads,api:context.enterprise,emit,
    click:async(dataset,id='') => {const button={dataset,id,disabled:false,closest(){return this;}}; await emit('click',button);},
    submit:async(form) => emit('submit',form)};
}
function form(id,values,dataset={}) {
  const elements=Object.entries(values).flatMap(([name,value]) => name === 'reviewer_ids' ? value.map((id) => ({name,type:'checkbox',value:String(id),checked:true})):[{name,type:typeof value === 'boolean' ? 'checkbox':'text',value:typeof value === 'string' ? value:String(value),checked:typeof value === 'boolean' ? value:false}]);
  const result={id,dataset,elements}; result.closest=() => result; return result;
}
(async () => {
  const r=runtime(), bad='<img src=x onerror=attack()>"<script>alert(1)</script>';
  const details=r.api.reviewDetails({...review(5,bad),requester:bad,description:bad,due_date:bad,policy:bad,reviewers:[{user_id:2,name:bad,note:bad,decision:bad,eligible:false}]});
  assert(!details.includes('<img')); assert(!details.includes('<script>')); assert(details.includes('&lt;img')); assert(details.includes('Permesso revocato'));
  for (const html of [r.api.reviewRows([{id:1,title:bad,requester:bad,status:bad}]),r.api.portfolioCards([{id:1,board_id:7,title:bad,board_name:bad,column_title:bad,priority:bad,assignees:[{name:bad}]}]),r.api.insightsHTML({activity:[{date:bad,count:2}],capacity:[{name:bad,cards:3}],dependency_blocks:[{id:1,board_id:7,title:bad,board_name:bad}],milestones:[{title:bad,board_name:bad,due_date:bad}]})]) {assert(!html.includes('<img')); assert(!html.includes('<script>'));}
  assert(r.api.insightsHTML({checklists:{done:7,total:2}}).includes('value="2"'));
  const filters=r.api.cleanFilters({q:'a'.repeat(300),status:'blocked',board_id:'7',assignee_id:'bad',include_archived:true,before:90,unknown:bad});
  assert.equal(filters.q.length,200); assert.equal(filters.board_id,7); assert.equal(filters.include_archived,true); assert(!('before' in filters)); assert(!('unknown' in filters)); assert(!('assignee_id' in filters));
  assert.equal(new URLSearchParams(r.api.query({q:'a&b',include_archived:true},90)).get('q'),'a&b');
  assert.equal(new URLSearchParams(r.api.query({},90)).get('before'),'90');
  await r.api.showReviews('board');
  assert(r.nodes.get('panel-body').innerHTML.includes('<span>Revisioni</span>'));
  assert(!r.nodes.get('panel-body').innerHTML.includes('<span>Schede</span>'));

  // Actual asynchronous loaders: older filtered pages cannot replace a newer query
  // or contaminate its accumulated results when "load more" is used afterwards.
  await r.api.showPortfolio();
  const old=deferred(), newer=deferred();
  r.context.route=({path}) => path.startsWith('/api/portfolio/cards?') ? (path.includes('q=old') ? old.promise:newer.promise):undefined;
  r.api.memory.filters={q:'old'}; const p1=r.api.showPortfolio('cards');
  r.api.memory.filters={q:'new',board_id:7}; const p2=r.api.showPortfolio('cards');
  newer.resolve({items:[{id:20,title:'new result',board_id:7}],next_cursor:20}); await p2;
  old.resolve({items:[{id:10,title:'old result',board_id:7}],next_cursor:10}); await p1;
  assert.equal(r.api.memory.cards[0].id,20); assert(!r.nodes.get('panel-body').innerHTML.includes('old result'));
  r.context.route=({path}) => path.startsWith('/api/portfolio/cards?') ? {items:[{id:19,title:'second page',board_id:7}]}:undefined;
  await r.api.showPortfolio('cards',20,true);
  assert.deepEqual(Array.from(r.api.memory.cards,(card) => card.id),[20,19]);
  assert(r.requests.at(-1).path.includes('q=new')); assert(r.requests.at(-1).path.includes('board_id=7')); assert(r.requests.at(-1).path.includes('before=20'));
  await r.submit(form('enterprise-portfolio-filter',{q:'Persisted',board_id:'7',status:'blocked',assignee_id:'1',priority:'normal',label:'design',from:'2026-01-01',to:'2026-12-31',include_archived:true}));
  const savedFilters=JSON.parse(r.storage.get('enterprise.1.filters.')); assert.equal(savedFilters.q,'Persisted'); assert.equal(savedFilters.assignee_id,1); assert.equal(savedFilters.include_archived,true);

  const a=runtime(), first=deferred(), second=deferred();
  a.context.route=({path}) => path.startsWith('/api/boards/7/reviews?') ? first.promise:path.startsWith('/api/boards/9/reviews?') ? second.promise:undefined;
  const a1=a.api.showReviews('board'); a.context.state.board={id:9}; const a2=a.api.showReviews('board');
  second.resolve({items:[review(2,'new board')]}); await a2; first.resolve({items:[review(1,'old board')]}); await a1;
  assert.equal(a.api.memory.reviewItems[0].id,2); assert(!a.nodes.get('panel-body').innerHTML.includes('old board'));
  await a.submit(form('enterprise-review-filter',{status:'approved',reviewer_id:'2',requester_id:'1',overdue:true,include_deleted:true}));
  assert(JSON.parse(a.storage.get('enterprise.1.reviews.9.board.0')).overdue);
  assert(a.requests.some((request) => request.path.includes('status=approved') && request.path.includes('reviewer_id=2') && request.path.includes('overdue=1')));

  const d=runtime(), detail1=deferred(), detail2=deferred();
  d.context.route=({path}) => path === '/api/reviews/10?include_deleted=1' ? detail1.promise:path === '/api/reviews/11?include_deleted=1' ? detail2.promise:undefined;
  const d1=d.api.showReview(10), d2=d.api.showReview(11); detail2.resolve(review(11,'new detail')); await d2; detail1.resolve(review(10,'old detail')); await d1;
  assert.equal(d.api.memory.review.id,11); assert(!d.nodes.get('panel-body').innerHTML.includes('old detail'));
  const trash=runtime();
  trash.context.route=({path,method}) => path === '/api/reviews/90?include_deleted=1' && method === 'GET' ? {...review(90),deleted_at:'2026-10-16',can_vote:false}:undefined;
  await trash.api.showReview(90);
  assert(trash.nodes.get('panel-body').innerHTML.includes('data-ent-review-action="restore"'));
  assert(!trash.nodes.get('panel-body').innerHTML.includes('id="enterprise-review-vote"'));
  await trash.click({entReviewAction:'restore'});
  assert(trash.requests.some((request) => request.path === '/api/reviews/90/restore' && request.method === 'POST' && request.extra.version === 3));

  // Real form handlers retain review text after a failed authenticated request,
  // clear it only after acknowledgement, and send the optimistic version header.
  const c=runtime(); await c.api.showReviewCreate(8); assert(c.context.savedCardDraft);
  assert(!c.nodes.get('panel-body').innerHTML.includes('value="1" checked')); assert(!c.nodes.get('panel-body').innerHTML.includes('Observer')); assert(!c.nodes.get('panel-body').innerHTML.includes('Global observer'));
  const creation=form('enterprise-review-create',{title:'Richiesta',description:'Bozza da conservare',due_date:'2026-12-01',policy:'any',reviewer_ids:[2]},{card:'8',board:'7',entDraft:'review-new',entDraftId:'8'});
  c.context.route=({path,method}) => path === '/api/cards/8/reviews' && method === 'POST' ? Promise.reject(new Error('Connessione persa')):undefined;
  await c.submit(creation); assert.equal(JSON.parse(c.storage.get('enterprise.1.draft.review-new.8')).description,'Bozza da conservare'); assert.equal(c.context.lastError.message,'Connessione persa');
  c.context.route=({path,method}) => path === '/api/cards/8/reviews' && method === 'POST' ? review(12):undefined;
  await c.submit(creation); await tick(); assert(!c.storage.has('enterprise.1.draft.review-new.8')); assert.equal(c.api.memory.review.id,12);
  const vote=form('enterprise-review-vote',{decision:'changes_requested',note:'Aggiungi test'},{id:'12',version:'3',entDraft:'vote',entDraftId:'12'});
  await c.submit(vote); await tick();
  const voteRequest=c.requests.find((request) => request.path === '/api/reviews/12/vote'); assert.equal(voteRequest.extra.version,3); assert.equal(voteRequest.body.note,'Aggiungi test'); assert.equal(voteRequest.body.decision,'changes_requested');
  const edit=form('enterprise-review-edit',{title:'Mia modifica',description:'Contenuto locale',policy:'all',due_date:''},{id:'12',version:'3',entDraft:'review-edit',entDraftId:'12'});
  c.context.route=({path,method}) => path === '/api/reviews/12' && method === 'PATCH' ? Promise.reject(Object.assign(new Error('Versione cambiata'),{status:412})):undefined;
  await c.submit(edit); assert.equal(c.context.lastError.status,412); assert.equal(JSON.parse(c.storage.get('enterprise.1.draft.review-edit.12')).title,'Mia modifica'); assert.equal(c.nodes.get('panel-error').textContent,'Versione cambiata');
  c.context.route=({path}) => path === '/api/reviews/12?include_deleted=1' ? {...review(12),version:9,title:'Versione server aggiornata'}:undefined;
  const discardReview={dataset:{entDraftDiscard:'12'},disabled:false,closest:(selector) => selector === 'form' ? edit:discardReview};
  await c.emit('click',discardReview); assert(!c.storage.has('enterprise.1.draft.review-edit.12')); assert(c.nodes.get('panel-body').innerHTML.includes('data-version="9"'));

  const s=runtime(), reports=[{id:5,name:'Report team',filters:{status:'blocked'},pinned:false,version:7}];
  s.context.route=({path,method}) => path === '/api/me/reports' && method === 'GET' ? {reports}:undefined;
  await s.api.showPortfolio('reports'); await s.click({entReportPin:'5'});
  assert(s.requests.some((request) => request.path === '/api/reports/5' && request.method === 'PATCH' && request.body.pinned === true && request.extra.version === 7));
  await s.click({entReportDuplicate:'5'}); assert(s.requests.some((request) => request.path === '/api/reports/5/duplicate' && request.method === 'POST'));
  await s.click({entReportDelete:'5'}); assert(s.requests.some((request) => request.path === '/api/reports/5' && request.method === 'DELETE'));
  await s.click({entReportApply:'5'}); await tick(); assert.equal(s.api.memory.filters.status,'blocked');
  await s.api.showPortfolio('reports'); await s.click({entReportEdit:'5'});
  const reportEdit=form('enterprise-report-form',{name:'Nuovo nome',pinned:true,replace_filters:false},{id:'5',version:'7',entDraft:'report',entDraftId:'5'});
  await s.submit(reportEdit);
  const renamed=s.requests.find((request) => request.method === 'PATCH' && request.body?.name === 'Nuovo nome'); assert(renamed); assert(!Object.hasOwn(renamed.body,'filters'));
  const reportNew=form('enterprise-report-form',{name:'Da filtri',pinned:false},{id:'0',version:'0',entDraft:'report',entDraftId:'new'}); await s.submit(reportNew);
  assert(s.requests.some((request) => request.path === '/api/me/reports' && request.method === 'POST' && request.body.filters.status === 'blocked'));
  const reportSnapshot=form('enterprise-report-form',{name:'Bozza precedente',pinned:false},{id:'0',entDraft:'report',entDraftId:'new',entFilters:JSON.stringify({q:'Ricerca A',board_id:7})});
  s.api.memory.filters={q:'Ricerca B',status:'open'}; await s.submit(reportSnapshot);
  assert(s.requests.some((request) => request.method === 'POST' && request.body?.name === 'Bozza precedente' && request.body.filters.q === 'Ricerca A' && request.body.filters.board_id === 7));
  await s.api.showPortfolio('reports'); await s.click({entReportEdit:'5'});
  const conflictReport=form('enterprise-report-form',{name:'Nome locale',pinned:true,replace_filters:false},{id:'5',version:'7',entDraft:'report',entDraftId:'5',entFilters:JSON.stringify({q:'Conservata'})});
  s.context.route=({path,method}) => path === '/api/reports/5' && method === 'PATCH' ? Promise.reject(Object.assign(new Error('Conflitto report'),{status:412})):path === '/api/reports/5' && method === 'GET' ? {...reports[0],version:9,name:'Versione aggiornata'}:undefined;
  await s.submit(conflictReport); assert.equal(JSON.parse(s.storage.get('enterprise.1.draft.report.5')).name,'Nome locale');
  const discard={dataset:{entDraftDiscard:'5'},disabled:false,closest:(selector) => selector === 'form' ? conflictReport:discard};
  await s.emit('click',discard);
  assert(!s.storage.has('enterprise.1.draft.report.5')); assert(s.nodes.get('panel-body').innerHTML.includes('data-version="9"')); assert(s.nodes.get('panel-body').innerHTML.includes('Versione aggiornata'));

  const limits=runtime(); limits.context.route=({path}) => path === '/api/portfolio' ? {summary:{boards:120},boards:[],boards_truncated:true}:undefined;
  await limits.api.showPortfolio(); assert(limits.nodes.get('panel-body').innerHTML.includes('prime 100 bacheche'));
  await limits.api.showPortfolio('insights'); assert(limits.nodes.get('panel-body').innerHTML.includes('fino a 100 persone'));
  const preview=runtime(); await preview.api.showPortfolio('cards');
  const stateOptions=preview.nodes.get('panel-body').innerHTML.match(/name="status">([\s\S]*?)<\/select>/)[1];
  assert(!stateOptions.includes('value=""')); assert(stateOptions.includes('value="all" selected'));
  preview.api.memory.filters={q:'<img src=x>',status:'blocked',priority:'normal',label:'design',board_id:7,assignee_id:1,include_archived:true};
  await preview.click({entReportNew:''}); const reportPreview=preview.nodes.get('panel-body').innerHTML;
  assert(reportPreview.includes('<dt>Testo</dt>')); assert(!reportPreview.includes('<dt>q</dt>')); assert(reportPreview.includes('<dd>Bloccate</dd>')); assert(reportPreview.includes('<dd>Normale</dd>')); assert(reportPreview.includes('<dd>Bacheca</dd>')); assert(reportPreview.includes('<dd>Ada</dd>')); assert(!reportPreview.includes('<img'));

  // CSV follows authenticated API pagination instead of silently dropping the
  // results after the server's bounded page; board/card links keep editor guards.
  const x=runtime(); await x.api.showPortfolio('cards');
  x.api.memory.filters={q:'=formula',board_id:7};
  x.context.route=({path}) => path.startsWith('/api/portfolio/export?') ? {filename:'report.csv',csv:'"safe"',next_cursor:50}:undefined;
  await x.click({entPortfolioCsv:''}); assert.equal(x.downloads.length,1); assert(x.nodes.get('enterprise-export-pages').innerHTML.includes('data-ent-export-before="50"'));
  await x.click({entExportBefore:'50'}); assert(x.requests.at(-1).path.includes('before=50')); assert(x.requests.at(-1).path.includes('board_id=7'));
  x.context.closeEditors=() => false; await x.click({entCard:'7:8'}); assert.equal(x.context.selectedCard,undefined);
  x.context.closeEditors=() => true; await x.click({entCard:'7:8'}); assert.equal(x.context.selectedBoard,7); assert.equal(x.context.selectedCard,8);
  x.context.state.auth.user={id:2,role:'member'}; await x.api.showPortfolio('cards'); assert.equal(x.api.memory.filters.q,undefined); assert.equal(x.api.memory.owner,'2');
  x.context.state.auth.user=null; await x.api.showPortfolio(); assert(x.nodes.get('panel-body').innerHTML.includes('Accedi con un account'));
  console.log('Frontend 0.5: rendering sicuro, race, filtri, bozze, conflitti, revisioni, report personali, CSV e permessi verificati.');
})().catch((error) => {console.error(error); process.exitCode=1;});

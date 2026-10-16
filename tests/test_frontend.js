'use strict';
const assert = require('node:assert/strict');
const p = require('../web/productivity.js');
const hostile = p.markdown('<img src=x onerror=alert(1)>\n[click](javascript:alert)\n[safe](https://example.com?q="x")\n**bold**\n```\n<script>bad()</script>\n```');
assert(!hostile.includes('<img')); assert(!hostile.includes('<script>')); assert(!hostile.includes('href="javascript:')); assert(hostile.includes('rel="noopener noreferrer nofollow"')); assert(hostile.includes('<strong>bold</strong>'));
assert.equal(p.safeURL('https://me:secret@example.com'), '');
for (const formula of ['=SUM(1,2)',' +123','\t@SUM(A1)','-1','\rfoo']) assert(p.csvCell(formula).startsWith('"\''));
assert.equal(p.csvCell('a,"b"\nc'), '"a,""b""\nc"');
const board = {id:7,name:'Demo\r\nInjected:test',columns:[{title:'List',cards:[{id:8,title:'Caffè, lavoro; fase\\1\r\nInjected:value',description:'A\nB',due_date:'2026-12-31',start_date:'2026-12-30',completed:false},{id:9,title:'Undated'},{id:10,title:'Impossible',due_date:'2026-02-30'}]}]};
const ics = p.calendar(board,new Date('2026-10-15T12:00:00Z'));
assert(ics.includes('UID:board-7-card-8@openboard\r\n')); assert(ics.includes('DTSTART;VALUE=DATE:20261230')); assert(ics.includes('DTEND;VALUE=DATE:20270101')); assert(!ics.includes('\r\nInjected:')); assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1); assert(ics.includes('Caffè\\, lavoro\\; fase\\\\1\\nInjected:value'));
const long = p.foldLine('SUMMARY:'+ '🗂Caffè'.repeat(40)); assert(long.split('\r\n').every((line) => Buffer.byteLength(line,'utf8') <=75)); assert.equal(long.replace(/\r\n /g,''),'SUMMARY:'+ '🗂Caffè'.repeat(40));
assert(p.csv(board).startsWith('\uFEFF"ID"')); assert(p.csv(board).includes('"Undated"'));
assert(p.shouldDiscardDraft('owned','owned',false));
assert(!p.shouldDiscardDraft('unread other draft',undefined,false));
assert(!p.shouldDiscardDraft('other-tab','owned',false));
assert(!p.shouldDiscardDraft('owned','owned',true));
console.log('Frontend: Markdown, CSV e iCalendar verificati.');

// Typed fields preserve zero/false, distinguish clearing, and reject invalid dates/numbers.
assert.equal(p.fieldValue('number','0'),0); assert.equal(p.fieldValue('number','-1.25'),-1.25);
assert.equal(p.fieldValue('boolean','false'),false); assert.equal(p.fieldValue('boolean','true'),true);
for (const type of ['text','number','date','boolean','select']) assert.equal(p.fieldValue(type,''),null);
assert.equal(p.fieldValue('date','2028-02-29'),'2028-02-29');
assert.throws(() => p.fieldValue('date','2026-02-29')); assert.throws(() => p.fieldValue('number','Infinity')); assert.throws(() => p.fieldValue('number','1000000000001'));
assert.throws(() => p.fieldValue('boolean','yes'));
assert.equal(p.fieldText(false),'No'); assert.equal(p.fieldText(0),'0'); assert.equal(p.fieldText(null),'—');
assert(p.fieldMatches('Caffè e Design','CAFFÈ')); assert(p.fieldMatches(false,'no')); assert(!p.fieldMatches(null,''));
const logsCSV = p.worklogCSV([{id:1,date:'2026-10-16',author:'=SUM(A1)',board_name:'Team',card_title:'\"Scheda\"',minutes:30,note:'@IMPORTDATA(secret)'}]);
assert(logsCSV.includes('"\'=SUM(A1)"')); assert(logsCSV.includes('"\'@IMPORTDATA(secret)"')); assert(logsCSV.includes('"""Scheda"""'));
assert.equal(p.fieldCell('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
assert.equal(p.fieldCell(false),'No'); assert.equal(p.fieldCell(0),'0');
console.log('Frontend 0.4: campi tipizzati, filtri, CSV e struttura tabellare verificati.');

// Exercise the actual table renderer with hostile stored board data.
const vm = require('node:vm'), fs = require('node:fs');
const dynamicInputs = [{dataset:{customKey:'score',customType:'number'},value:'0'},{dataset:{customKey:'ready',customType:'boolean'},value:'false'}];
const context = {OpenBoardProductivity:p,productivity:p,state:{board:{name:'<script>board</script>',custom_fields:[{id:1,key:'score',name:'<img src=x>',type:'number',position:0}],milestones:[],columns:[{id:1,title:'<b>List</b>',cards:[{id:5,title:'<img onerror=attack()>',priority:'normal',custom_values:{score:0},total_minutes:17}]}]},cardEditor:{customValues:{retired:'preserved',score:2}}},
 document:{addEventListener(){},querySelectorAll(){return dynamicInputs;}},escapeHTML:(value) => String(value ?? '').replace(/[&<>"']/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),sorted:(cards) => cards,selectionCheckbox:()=>'',priorities:{normal:'Normale'}};
vm.createContext(Object.assign(context,require('./i18n-runtime.cjs'))); vm.runInContext(fs.readFileSync(require.resolve('../web/planning.js'),'utf8'),context);
const table = vm.runInContext('renderTable()',context);
assert(!table.includes('<img')); assert(!table.includes('<script>')); assert(table.includes('scope="row"')); assert(table.includes('scope="col"')); assert(table.includes('data-table-card="5"')); assert(table.includes('<td>0</td>'));
const values = vm.runInContext('readCustomValues()',context); assert.equal(values.score,0); assert.equal(values.ready,false); assert.equal(values.retired,'preserved');

const outgoing = p.planningPayload({custom_values:{active:0,retired:'keep'},milestone_key:'old'},[{key:'active'},{key:'retired',deleted_at:'now'}],[{key:'old',deleted_at:'now'}],'old');
assert.deepEqual(outgoing.custom_values,{active:0}); assert(!Object.hasOwn(outgoing,'milestone_key'));
assert.equal(p.planningPayload({custom_values:{active:null},milestone_key:''},[{key:'active'}],[],'old').milestone_key,'');
assert.equal(p.planningPayload({milestone_key:'new'},[],[{key:'new'}],'old').milestone_key,'new');

assert.equal(p.storageLabel('sqlite'),'SQLite');
assert.equal(p.storageLabel('postgresql+mongodb'),'PostgreSQL + MongoDB');
assert.equal(p.storageLabel(undefined),''); assert.equal(p.storageLabel('<script>'),'');

const catalogFixture = {labels:{design:'Design',sviluppo:'Sviluppo'},priorities:{low:'Bassa',normal:'Normale',high:'Alta',urgent:'Urgente'},covers:['','sage','peach'],custom_field_types:[{value:'text',label:'Testo'},{value:'number',label:'Numero'},{value:'date',label:'Data'},{value:'boolean',label:'Sì / No'},{value:'select',label:'Scelta'}]};
assert.deepEqual(p.catalog(catalogFixture).labels,catalogFixture.labels);
assert.equal(p.catalog(catalogFixture).fieldTypes.boolean,'Sì / No');
for (const catalog of [null,{}, {...catalogFixture,labels:{'bad" onclick="attack':'Unsafe'}}, {...catalogFixture,covers:['','bad/class']}, {...catalogFixture,custom_field_types:[{value:'script',label:'Unsafe'}]}, {...catalogFixture,priorities:{urgent:'Urgente'}}]) assert.throws(() => p.catalog(catalog));
assert.throws(() => p.catalog({...catalogFixture,labels:JSON.parse('{"__proto__":"unsafe"}')}));

const labelRenderer = fs.readFileSync(require.resolve('../web/app.js'),'utf8').match(/function labelBadges\(card\) \{[^\n]+/)[0];
const labelContext = {labels:{design:'<img src=x onerror=attack()>'},cardLabels:()=>['design'],escapeHTML:context.escapeHTML};
vm.createContext(Object.assign(labelContext,require('./i18n-runtime.cjs'))); vm.runInContext(labelRenderer,labelContext);
assert(!vm.runInContext('labelBadges({})',labelContext).includes('<img'));

// Run real asynchronous UI loaders against independently controlled HTTP replies.
(async () => {
  function uiRuntime() {
    const nodes = new Map(), listeners = new Map(), requests = [], storage = new Map();
    for (const id of ['panel-dialog','card-dialog','panel-body','worklog-deleted','worklogs-list','card-time-summary','bookmark-card']) nodes.set(id,{open:true,checked:false,innerHTML:'',textContent:'',dataset:{},setAttribute(name,value){this[name]=value;},insertAdjacentHTML(_,value){this.innerHTML+=value;}});
    const runtime = {state:{board:{id:7},cardSequence:4,cardEditor:{id:8},auth:{user:{id:1,role:'member'}}},productivity:p,URLSearchParams,Number,Promise,
      document:{addEventListener(name,fn){if (!listeners.has(name)) listeners.set(name,[]); listeners.get(name).push(fn);}},
      $:(id) => nodes.get(id) || null,escapeHTML:context.escapeHTML,canWrite:()=>true,canManage:()=>false,formatDate:(value) => value || '',activityLabel:(value) => value || '',icon:()=>'',updateBusy(){},
      stored:(key) => storage.get(key) || '',remember:(key,value) => storage.set(key,value),forget:(key) => storage.delete(key),refreshNotifications(){},loadComments:async()=>{},
      api:(path,method='GET',body) => new Promise((resolve,reject) => requests.push({path,method,body,resolve,reject})),
      async showPanel(title,loader,kind) { this.state.panel = kind; const generation = this.state.panelSequence = (this.state.panelSequence || 0)+1; const body = await loader(); if (generation === this.state.panelSequence) nodes.get('panel-body').innerHTML = body; },
      perform:async(action) => { try { return await action(); } catch(error) { runtime.lastError=error; } },committed:async(write,refresh) => {const result=await write(); if(refresh) await refresh(result); return result;}};
    // Global functions have no implicit receiver, as in the browser.
    runtime.showPanel = async(title,loader,kind) => { runtime.state.panel=kind; const generation=runtime.state.panelSequence=(runtime.state.panelSequence||0)+1; const body=await loader(); if(generation===runtime.state.panelSequence) nodes.get('panel-body').innerHTML=body; };
    vm.createContext(Object.assign(runtime,require('./i18n-runtime.cjs'))); vm.runInContext(fs.readFileSync(require.resolve('../web/planning.js'),'utf8'),runtime);
    return {runtime,nodes,requests,storage,listeners,call:(code) => vm.runInContext(code,runtime)};
  }
  const n = uiRuntime();
  n.runtime.state.notificationFilter={q:'old'}; const old=n.call('showFilteredNotifications()');
  n.runtime.state.notificationFilter={q:'new'}; const newer=n.call('showFilteredNotifications()');
  n.requests[1].resolve({items:[{id:20,title:'new first'}],next_cursor:20}); await newer;
  n.requests[0].resolve({items:[{id:10,title:'old result'}],next_cursor:10}); await old;
  const more=n.call('showFilteredNotifications(20,true)'); n.requests[2].resolve({items:[{id:19,title:'new second'}]}); await more;
  assert.deepEqual(Array.from(n.runtime.state.notificationsItems,(item)=>item.title),['new first','new second']);
  assert(!n.nodes.get('panel-body').innerHTML.includes('old result'));

  const w = uiRuntime(), first=w.call('loadWorklogs(8)');
  w.nodes.get('worklog-deleted').checked=true; const second=w.call('loadWorklogs(8)');
  w.requests[2].resolve({items:[{id:2,user_id:1,deleted_at:'now',date:'2026-10-16',minutes:30,note:''}]}); w.requests[3].resolve({total_minutes:30}); await second;
  w.requests[0].resolve({items:[{id:1,user_id:1,date:'2026-10-15',minutes:5,note:''}]}); w.requests[1].resolve({total_minutes:5}); await first;
  assert.equal(w.runtime.state.cardEditor.worklogs[0].id,2); assert(w.nodes.get('card-time-summary').textContent.includes('30 min totali'));

  const b=uiRuntime(), pending=b.call('loadBookmarkStatus(8,7,4)');
  assert.equal(b.runtime.state.cardEditor.bookmarkLoading,true);
  // Simulate an already acknowledged newer PATCH while the initial GET is delayed.
  b.runtime.state.cardEditor.bookmarkSequence++; b.runtime.state.cardEditor.bookmarkReady=true; b.runtime.state.cardEditor.bookmarkLoading=false; b.call('setBookmark(true)');
  b.requests[0].resolve({bookmarked:false}); await pending;
  assert.equal(b.nodes.get('bookmark-card').dataset.bookmarked,'true');
  const failed=uiRuntime(), status=failed.call('loadBookmarkStatus(8,7,4)'); failed.requests[0].reject(new Error('offline')); await status;
  assert.equal(failed.runtime.state.cardEditor.bookmarkReady,false); assert.equal(failed.nodes.get('bookmark-card').textContent,'Riprova stato segnalibro');

  const t=uiRuntime(); t.runtime.state.panel='thread'; t.runtime.state.threadId=3; t.runtime.state.threadCard=8;
  t.nodes.set('reply-body',{value:'Bozza **da conservare**'}); t.nodes.set('reply-form',{dataset:{parent:'3',card:'8'}});
  const thread=t.call('showThread(3)'); t.requests[0].resolve({parent:{id:3,card_id:8,body:'Parent',reactions:[]},replies:[]}); await thread;
  assert(t.nodes.get('panel-body').innerHTML.includes('Bozza **da conservare**'));
  const switching=t.call('showThread(4)'); t.requests[1].resolve({parent:{id:4,card_id:8,body:'Other',reactions:[]},replies:[]}); await switching;
  assert(!t.nodes.get('panel-body').innerHTML.includes('Bozza **da conservare**'));
  assert.equal(t.storage.get('reply.1.8.3'),'Bozza **da conservare**'); assert(!t.storage.has('reply.1.8.4'));
  t.runtime.state.threadId=3; t.nodes.get('reply-body').value='Reply awaiting server';
  const replyForm={id:'reply-form',dataset:{parent:'3',card:'8'}};
  const submit=() => {for(const listener of t.listeners.get('submit')) listener({target:replyForm,preventDefault(){}});};
  submit(); assert.equal(t.storage.get('reply.1.8.3'),'Reply awaiting server');
  t.requests[2].reject(new Error('network lost')); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.storage.get('reply.1.8.3'),'Reply awaiting server');
  submit(); t.requests[3].resolve({id:9}); await new Promise((resolve) => setImmediate(resolve));
  assert(!t.storage.has('reply.1.8.3')); assert.equal(t.nodes.get('reply-body').value,'');
  t.requests[4].resolve({parent:{id:3,card_id:8,body:'Parent'},replies:[{id:9,body:'Reply awaiting server'}]});
  await new Promise((resolve) => setImmediate(resolve)); assert(!t.storage.has('reply.1.8.3'));
  console.log('Frontend race tests: filtri, registro tempo, segnalibri e bozze risposta verificati.');
})().catch((error) => { console.error(error); process.exitCode=1; });

// Requests authorized in one session must never repopulate another account's
// view, including when a quiet refresh finishes after logout and a new login.
(async () => {
  const app = fs.readFileSync(require.resolve('../web/app.js'),'utf8');
  const take = (start,end) => app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
  const nodes = new Map(), requests = [], storage = new Map(), renders = [], errors = [], authHandlers = new Map();
  let authPrompts = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id,{open:false,value:'',innerHTML:'',hidden:false,closest(){return {open:true};},addEventListener(name,handler){authHandlers.set(`${id}:${name}`,handler);}});
    return nodes.get(id);
  };
  node('card-dialog').open = true;
  const session = (id,csrf = `csrf-${id}`) => ({enabled:true,csrf,user:{id,role:'admin'}});
  const context = {
    state:{auth:session(1),authGeneration:0,loadSequence:0,cardSequence:0,panelSequence:0,selectedCards:new Map(),
      board:{id:7,name:'Account A'},boards:[{id:7}],cardEditor:{id:31,version:4},view:'stats',loading:false,saving:false},
    Map,Number,JSON,Date,AbortController,setTimeout,clearTimeout,$:node,escapeHTML:(value)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),uuid:()=>`key-${requests.length}`,
    updateBusy(){},toast(message){errors.push(message);},clearFilters(){},route(){},refreshWatchState(){},
    renderSidebar(){},renderHeader(){},renderBoard(){renders.push({owner:context.state.auth?.user?.id,name:context.state.board?.name});},
    showLoadError(error){errors.push(error.message);},closeEditors:()=>true,closeDialog(id){node(id).open=false;},showAuth(){authPrompts++;},
    loadInitial:async()=>{},editorDirty:()=>true,readDraft:()=>null,pendingWorklog:()=>({}),
    cardData:()=>({title:'Account A unsaved secret',column_id:9}),
    stored:(key)=>storage.get(key)||'',remember:(key,value)=>storage.set(key,value),forget:(key)=>storage.delete(key),
    fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve:(value,status=200)=>resolve({ok:status<400,status,json:async()=>value}),reject}))
  };
  vm.createContext(Object.assign(context,require('./i18n-runtime.cjs')));
  vm.runInContext(take('class APIError','function toast('),context);
  vm.runInContext(take('async function perform(','function allCards('),context);
  vm.runInContext(take('function draftKey(','function readDraft('),context);
  vm.runInContext(take('async function selectBoard(','function showLoadError('),context);
  vm.runInContext(take('async function refreshBoards()','function clearFilters('),context);
  vm.runInContext(take('async function renderStats()','function renderBoard('),context);
  vm.runInContext(take('function stableRequest(','let searchTimer;'),context);
  vm.runInContext(take("$('auth-form').addEventListener('submit'","$('card-form').addEventListener('submit'"),context);
  const logout = take("    case 'logout':","  }\n});");
  vm.runInContext(`function logoutForTest(){switch('logout'){${logout}}}`,context);
  const tick = () => new Promise(resolve=>setImmediate(resolve));
  const call = code => vm.runInContext(code,context);
  const oldBoard = call('selectBoard(7,{quiet:true,navigate:false})');
  const oldBoards = call('refreshBoards()').then(()=>null,error=>error);
  const oldStats = call('renderStats()');
  const oldPost = call("api('/api/cards/31/comments','POST',{body:'Account A private comment'})").then(()=>null,error=>error);
  assert.equal(requests.length,4);
  assert.equal(requests[3].options.headers['X-CSRF-Token'],'csrf-1');
  call('logoutForTest()');
  assert.equal(requests[4].url,'/api/auth/logout');
  requests[4].resolve({}); await tick();
  assert.equal(requests[5].url,'/api/auth/session');
  requests[5].resolve({enabled:true,user:null,csrf:''}); await tick();
  assert.equal(context.state.auth.user,null);
  assert.equal(context.state.board,null);
  assert.equal(JSON.parse(storage.get('draft.1.7.31')).data.title,'Account A unsaved secret');
  node('auth-username').value='bob';node('auth-password').value='Disposable-test-password!';
  const login = authHandlers.get('auth-form:submit')({preventDefault(){}});
  assert.equal(requests[6].url,'/api/auth/login');
  requests[6].resolve(session(2)); await login;
  assert.equal(context.state.auth.user.id,2);
  requests[0].resolve({id:7,name:'PRIVATE_ACCOUNT_A',columns:[{id:9,cards:[{title:'Secret'}]}]});
  requests[1].resolve({boards:[{id:7,name:'PRIVATE_ACCOUNT_A'}]});
  requests[2].resolve({error:'PRIVATE_ACCOUNT_A_ERROR'},401);
  requests[3].reject(new TypeError('Lost response'));
  await Promise.all([oldBoard,oldStats]);
  assert.equal((await oldBoards).staleSession,true);assert.equal((await oldPost).staleSession,true);
  assert.equal(requests.length,7,'An obsolete POST must not retry with the new session cookie');
  assert.equal(context.state.board,null);assert.equal(context.state.boards.length,0);
  assert(!renders.some(render=>render.owner===2 && render.name==='PRIVATE_ACCOUNT_A'));
  assert(!errors.some(message=>message.includes('PRIVATE_ACCOUNT_A')));
  assert.equal(authPrompts,1,'An obsolete 401 must not reopen the sign-in dialog for account B');
  assert(!Array.from(storage.keys()).some(key=>key.startsWith('draft.2.')));
  assert(storage.has('draft.1.7.31'),'The original account recovery draft must remain available');

  // Renewing the same account's session also rejects late success and errors.
  const lateError = call('selectBoard(7,{quiet:true,navigate:false})');
  call("setSession({enabled:true,user:{id:2,role:'admin'},csrf:'renewed'},{renewed:true})");
  requests[7].reject(new Error('STALE_SESSION_ERROR')); await lateError;
  assert(!errors.some(message=>message.includes('STALE_SESSION_ERROR')));
  const lateSuccess = call('selectBoard(7,{quiet:true,navigate:false})');
  // The owner check remains protective even if a future caller forgets to
  // invalidate the generation before replacing an account object.
  context.state.auth=session(3);
  requests[8].resolve({id:7,name:'OLD_OWNER_DATA',columns:[]}); await lateSuccess;
  assert.equal(context.state.board,null);
  assert(!renders.some(render=>render.name==='OLD_OWNER_DATA'));
  console.log('Frontend session isolation: real logout/login handlers, late success/errors, POST retries and owner-scoped drafts verified.');
})().catch((error) => { console.error(error); process.exitCode=1; });

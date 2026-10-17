'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const p=require('../web/productivity.js'),{create}=require('../web/i18n.js');
const app=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const take=(start,end)=>{const from=app.indexOf(start);assert(from>=0,start);const to=end ? app.indexOf(end,from):app.length;assert(to>=from,end);return app.slice(from,to);};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function memory(entries=[]) {
 const map=new Map(entries);
 return {get length(){return map.size;},key:index=>[...map.keys()][index]??null,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key),map};
}
const now=Date.now(),raw=(title,updated_at=now)=>JSON.stringify({data:{title},updated_at});
const storage=memory([
 ['openboard.draft.1.7.31',raw('<img src=x onerror=attack()>')],['openboard.draft.1.7.new',raw('New',now-20)],
 ['openboard.draft.2.7.31',raw('OTHER_ACCOUNT_PRIVATE')],['openboard.draft.local.7.new',raw('Local only')],
 ['openboard.draft.10.7.new',raw('Prefix collision')],['openboard.draft.1.0.1',raw('Invalid board')],
 ['openboard.draft.1.9007199254740993.new',raw('Unsafe ID')],['openboard.draft.1.8.new',raw('Expired',now-30*86400000)],
 ['openboard.draft.1.9.new',raw('Future',now+120000)],['openboard.draft.1.7.22','{malformed'],['openboard.draft.1.7.23',JSON.stringify({data:[],updated_at:now})]
]);
const drafts=p.listCardDrafts(storage,'1',now);
assert.deepEqual(drafts.map(item=>item.cardId),[31,null]);assert.equal(p.listCardDrafts(storage,'local',now).length,1);
assert.deepEqual(p.listCardDrafts(storage,'signed-out',now),[]);
assert(!p.removeOwnedDraft(storage,drafts[0],'2'));assert(!p.removeOwnedDraft(storage,{key:'openboard.draft.1.settings',raw:'x'},'1'));
storage.setItem(drafts[0].key,raw('Updated by another tab',now+1));assert(!p.removeOwnedDraft(storage,drafts[0],'1'));
assert.equal(JSON.parse(storage.getItem(drafts[0].key)).data.title,'Updated by another tab');
assert(p.removeOwnedDraft(storage,drafts[1],'1'));assert(storage.getItem('openboard.draft.2.7.31'));
assert.deepEqual(p.listCardDrafts({get length(){throw new Error('blocked');}},'1'),[]);
assert.equal(p.initials('e\u0301mile 👩🏽‍💻 Tanaka','fr'),'E\u0301👩🏽‍💻');assert.equal(p.initials('🇯🇵 山田','ja'),'🇯🇵山');
assert.deepEqual(p.graphemes('A👩🏽‍💻e\u0301🇯🇵'),['A','👩🏽‍💻','e\u0301','🇯🇵']);
assert(p.composing({isComposing:true,key:'Enter'}));assert(p.composing({keyCode:229}));assert(!p.composing({key:'Enter'}));
const columns=[['11','12','13'],[],['21'],['31','32']];
assert.equal(p.navigateCards(columns,'13','ArrowRight'),'21');assert.equal(p.navigateCards(columns,'21','ArrowRight'),'31');
assert.equal(p.navigateCards(columns,'32','ArrowLeft'),'21');assert.equal(p.navigateCards(columns,'12','ArrowUp'),'11');
assert.equal(p.navigateCards(columns,'11','ArrowUp'),'11');assert.equal(p.navigateCards(columns,'12','End'),'13');
assert.equal(p.navigateCards(columns,'32','Home',true),'11');assert.equal(p.navigateCards(columns,'11','End',true),'32');
assert.equal(p.navigateCards(columns,'missing','ArrowDown'),null);
const leap=p.calendarPeriod('month','2028-02-18');assert.equal(leap.anchor,'2028-02-01');assert.equal(leap.days.length,42);assert(leap.days.includes('2028-02-29'));
assert.equal(new Date(leap.days[0]+'T12:00:00Z').getUTCDay(),1);
assert.deepEqual(p.calendarPeriod('week','2026-12-31').days,['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
assert.equal(p.calendarPeriod('month','2026-12-31',1).anchor,'2027-01-01');
assert.equal(p.calendarPeriod('month','0001-01-01',-1).anchor,'0001-01-01');
assert.equal(p.calendarPeriod('week','9999-12-31',1).anchor,'9999-12-27');
assert(p.calendarPeriod('month','9999-12-31').days.includes(null));
assert.equal(p.calendarPeriod('month','2026-04-01',Number.MAX_SAFE_INTEGER).anchor,'2026-04-01');
const messages=[],fallback=memory();let logouts=0;
const bridge=p.tabSessionBridge({storage:fallback,channel:{postMessage:value=>messages.push(value)},id:()=> 'event-1',onLogout:()=>logouts++});
bridge.publish();assert.deepEqual(messages,[{kind:'logout',nonce:'event-1'}]);assert.deepEqual(JSON.parse(fallback.getItem(bridge.key)),messages[0]);
assert(!bridge.receive(messages[0]));assert(bridge.receive('{"kind":"logout","nonce":"other"}'));assert(!bridge.receive({kind:'logout',nonce:'other'}));
for(const message of [{kind:'login',nonce:'x'},{kind:'logout',nonce:'x',user:{id:2}},'malformed','x'.repeat(1000),{kind:'logout',nonce:''},Object.assign(Object.create({kind:'logout',nonce:'inherited'}),{x:1,y:2})])assert(!bridge.receive(message));
assert.equal(logouts,1);
assert.doesNotThrow(()=>p.tabSessionBridge({storage:{setItem(){throw Error('blocked');}},channel:{postMessage(){throw Error('closed');}},onLogout(){}}).publish());
const i=create({catalog:{'Apri {0}':['Open {0}','Ouvrir {0}','Abrir {0}','{0} öffnen','打开{0}','{0}を開く'],'HTML':['<script>bad()</script>','a','b','c','d','e']},locale:'en',pseudo:true});
const user='Private Émile 👩🏽‍💻';assert.equal(i.t`Apri ${user}`,'⟦Ôpën '+user+' ···⟧');
assert(i.html`<button title="Apri ${escapeHTML(user)}">Apri ${escapeHTML(user)}</button>`.includes(user));
assert(!i.html`<p>HTML</p>`.includes('<script>'));assert(i.t('Apri {0}').includes('{0}'));
assert.equal(create({locale:'en',catalog:{Titolo:['Title']}}).t('Titolo'),'Title');

// A small DOM adapter exercises the real handlers, error relationships and
// account transitions without adding a browser dependency to the repository.
function runtime({withAPI=false}={}) {
 const nodes=new Map(),listeners=new Map(),windowListeners=new Map(),requests=[],posted=[],events=[],store=memory();let sequence=0;
 function element(id='') {
  const node={id,value:'',name:'',innerHTML:'',textContent:'',className:'',open:false,dataset:{},attributes:{},validity:{valid:true},willValidate:false,labels:[],
   setAttribute(name,value){this.attributes[name]=String(value);},getAttribute(name){return this.attributes[name]??null;},removeAttribute(name){delete this.attributes[name];},hasAttribute(name){return Object.hasOwn(this.attributes,name);},
   focus(){context.document.activeElement=this;},click(){events.push(['click',this.id]);},close(){this.open=false;},reset(){},
   insertAdjacentElement(_,other){nodes.set(other.id,other);},remove(){nodes.delete(this.id);if(this.form?.summary===this)this.form.summary=null;},
   closest(selector){if(selector==='button')return this.tagName==='BUTTON' ? this:null;if(selector==='[data-card-id]')return this.dataset.cardId ? this:null;return null;},
   matches(selector){return selector==='[data-card-id]' && !!this.dataset.cardId;},querySelector(){return null;},querySelectorAll(){return [];}
  };if(id)nodes.set(id,node);return node;
 }
 const node=id=>nodes.get(id) || element(id);
 const session=id=>({enabled:true,user:{id,role:'admin',name:'Alex',username:'alex'},csrf:'csrf-'+id});
 const context={state:{auth:session(1),authGeneration:0,loadSequence:0,cardSequence:0,panelSequence:0,selectedCards:new Map(),board:{id:7,columns:[{id:9,cards:[]}]},boards:[],saving:false},
  productivity:p,localStorage:store,Map,Set,Date,Number,JSON,Intl,URLSearchParams,Promise,AbortController,setTimeout,clearTimeout,escapeHTML,priorities:{normal:'Normale'},$:node,uuid:()=>`nonce-${++sequence}`,
  document:{activeElement:null,addEventListener(name,handler){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(handler);},querySelector(){return null;},createElement:()=>element()},
  window:{addEventListener:(name,handler)=>windowListeners.set(name,handler)},BroadcastChannel:class {postMessage(message){posted.push(message);}},
  formatDate:value=>value,todayISO:()=> '2026-10-17',allCards:()=>context.cards || [],matches:card=>card.title!=='Filtered',renderCard:card=>`<article data-card-id="${card.id}">${escapeHTML(card.title)}</article>`,renderCalendarAgenda:()=>'<div class="agenda-existing">Agenda</div>',
  closeEditors:()=>true,closeDialog:id=>{node(id).open=false;},saveDraft:()=>events.push(['save',context.state.auth.user?.id]),
  panel:(title,body,kind)=>{context.state.panel=kind;node('panel-dialog').open=true;node('panel-body').innerHTML=body;events.push(['panel',kind]);},
  canCreateBoard:()=>context.state.auth.user?.role!=='observer',canWrite:()=>context.state.auth.user?.role!=='observer' && !context.state.board?.readonly,
  showGlobalSearch:()=>events.push(['search']),showAccount:()=>events.push(['account']),showShortcuts:()=>events.push(['shortcuts']),openBoardEditor:()=>events.push(['new-board']),
  openCard:async id=>{events.push(['open-card',id]);context.state.cardEditor={id};node('card-dialog').open=true;return context.state.cardEditor;},
  selectBoard:async (id,options)=>{events.push(['select-board',id,options]);context.state.board={id,columns:[{id:9,cards:[]}]};},
  remember:(key,value)=>store.setItem('openboard.'+key,value),forget:key=>store.removeItem('openboard.'+key),stored:key=>store.getItem('openboard.'+key)||'',
  showAuth:()=>events.push(['auth']),toast:(message,error)=>events.push(['toast',message,error]),clearFilters(){},renderSidebar(){},renderHeader(){},renderBoard:()=>events.push(['render']),updateBusy(){},
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,reject,resolve:(value,status=200)=>resolve({ok:status<400,status,json:async()=>value})}))
 };
 vm.createContext(Object.assign(context,require('./i18n-runtime.cjs')));
 vm.runInContext(take('class APIError','function toast('),context);
 vm.runInContext(take('/* Personal browser tools.'),context);
 if(withAPI)vm.runInContext('let searchTimer;'+take('function showGlobalSearch()','function showMove()'),context);
 return {context,nodes,node,store,listeners,windowListeners,events,posted,requests,session,call:code=>vm.runInContext(code,context),emit:(type,event)=>{for(const handler of listeners.get(type)||[])handler(event);}};
}
(async()=>{
 const r=runtime();r.store.setItem('openboard.draft.1.7.31',raw('<img src=x onerror=attack()>'));r.store.setItem('openboard.draft.2.7.31',raw('OTHER_ACCOUNT_PRIVATE'));
 r.call('showDraftCenter()');assert(r.node('panel-body').innerHTML.includes('&lt;img'));assert(!r.node('panel-body').innerHTML.includes('<img'));assert(!r.node('panel-body').innerHTML.includes('OTHER_ACCOUNT_PRIVATE'));
 await r.call('resumeCardDraft(0)');assert.deepEqual(r.events.filter(item=>item[0]==='select-board' || item[0]==='open-card').map(item=>item.slice(0,2)),[['select-board',7],['open-card',31]]);
 assert.equal(r.events.find(item=>item[0]==='select-board')[2].quiet,true);assert(r.events.some(item=>item[0]==='click' && item[1]==='recover-draft'));
 r.events.length=0;r.context.state.auth=r.session(2);await r.call('resumeCardDraft(0)');assert.equal(r.events.length,0);
 const denied=runtime();denied.store.setItem('openboard.draft.1.7.new',raw('New'));denied.call('showDraftCenter()');denied.context.selectBoard=async()=>{throw Error('Permission denied');};
 await assert.rejects(denied.call('resumeCardDraft(0)'),/Permission denied/);assert(!denied.events.some(item=>item[0]==='open-card'));
 const switched=runtime();switched.store.setItem('openboard.draft.1.7.new',raw('New'));switched.call('showDraftCenter()');
 let resolveBoard;switched.context.selectBoard=()=>new Promise(resolve=>{resolveBoard=resolve;});const resume=switched.call('resumeCardDraft(0)');switched.context.state.auth=switched.session(2);resolveBoard();await resume;assert(!switched.events.some(item=>item[0]==='open-card'));
 // Even reopening the same card must not let an obsolete recovery request
 // overwrite the editor that the user has opened and begun typing into.
 const concurrent=runtime();concurrent.store.setItem('openboard.draft.1.7.31',raw('Recovery'));concurrent.call('showDraftCenter()');
 Object.assign(concurrent.context,{cardSnapshot:()=> 'saved',fillCard(){},readDraft:()=>null,icon:()=>'',route(){},loadProductivityCard(){},loadComments(){},openDialog:id=>{concurrent.node(id).open=true;}});
 concurrent.call(take('async function openCard(','function boardData()'));
 const recovery=concurrent.call('resumeCardDraft(0)');await new Promise(setImmediate);
 const manual=concurrent.call('openCard(31)');assert.equal(concurrent.requests.length,2);
 concurrent.requests[1].resolve({id:31,column_id:9,version:2});await manual;concurrent.node('card-title').value='Currently typing';
 concurrent.requests[0].resolve({id:31,column_id:9,version:1});await recovery;
 assert.equal(concurrent.node('card-title').value,'Currently typing');assert(!concurrent.events.some(item=>item[0]==='click' && item[1]==='recover-draft'));
 // Real session invalidation rejects an already pending success after a
 // cross-tab logout and a subsequent sign-in by another account.
 const tabs=runtime(),pending=tabs.call("api('/api/boards/7')").then(()=>null,error=>error);
 tabs.context.state.draftCenter={items:[{title:'Private'}]};tabs.context.state.globalSearch={cards:[{title:'Private'}]};
 tabs.windowListeners.get('storage')({key:'openboard.session-event',newValue:'{"kind":"logout","nonce":"other-tab"}'});
 assert.equal(tabs.context.state.auth.user,null);assert.equal(tabs.context.state.board,null);assert.equal(tabs.context.state.draftCenter,null);assert.equal(tabs.context.state.globalSearch,null);assert(tabs.events.some(item=>item[0]==='save' && item[1]===1));
 tabs.call('setSession({enabled:true,user:{id:2,role:"member"},csrf:"new"})');tabs.requests[0].resolve({name:'PRIVATE_OLD_OWNER'});assert.equal((await pending).staleSession,true);
 assert.equal(tabs.context.state.board,null);assert(!tabs.events.some(item=>item.includes('PRIVATE_OLD_OWNER')));
 const commands=runtime();commands.call('showCommandPalette()');assert(commands.node('command-results').innerHTML.includes('data-command="card"'));
 commands.context.state.auth.user.role='observer';assert(!commands.call('commandActions()').some(item=>['card','board'].includes(item.id)));
 commands.context.state.auth=commands.session(2);commands.emit('click',{target:{disabled:false,dataset:{command:'search'},closest(){return this;},hasAttribute(){return false;}}});assert(!commands.events.some(item=>item[0]==='search'));
 const calendar=runtime();calendar.context.state.calendarMode='month';calendar.context.state.calendarAnchor='2028-02-18';calendar.context.cards=[{id:1,due_date:'2028-02-29',title:'<img bad>'},{id:2,due_date:'2028-02-29',title:'Filtered'},{id:3,title:'No date'}];
 const month=calendar.call('renderCalendar()');assert.equal((month.match(/class="calendar-cell /g)||[]).length,42);assert(month.includes('2028-02-29'));assert(month.includes('&lt;img bad&gt;'));assert(!month.includes('Filtered'));assert(month.includes('No date'));
 calendar.context.state.calendarMode='week';calendar.context.state.calendarAnchor='2026-12-31';const week=calendar.call('renderCalendar()');assert.equal((week.match(/class="calendar-cell /g)||[]).length,7);assert(week.includes('2027-01-03'));
 calendar.context.state.calendarMode='agenda';assert(!calendar.call('renderCalendar()').includes('data-calendar-shift'));assert(calendar.call('renderCalendar()').includes('agenda-existing'));
 calendar.context.state.calendarMode='month';calendar.context.state.calendarAnchor=undefined;calendar.context.todayISO=()=> '2026-11-01';assert(calendar.call('renderCalendar()').includes('value="2026-11-01"'));
 const nextControl=calendar.node('next-period');calendar.node('board-canvas').querySelector=selector=>selector==='[data-calendar-shift="1"]' ? nextControl:null;
 calendar.emit('click',{target:{disabled:false,dataset:{calendarShift:'1'},closest(){return this;},hasAttribute(){return false;}}});assert.equal(calendar.context.state.calendarAnchor,'2026-12-01');assert.equal(calendar.context.document.activeElement,nextControl);
 const fields=runtime(),form={elements:[],summary:null,querySelector(){return this.summary;},prepend(element){element.form=this;this.summary=element;}};
 const input=fields.node('card-title');input.form=form;input.name='title';input.labels=[{textContent:'<img field>'}];input.validationMessage='Title <required>';input.willValidate=true;input.validity.valid=false;input.setAttribute('aria-describedby','existing-help');form.elements.push(input);
 fields.context.testInput=input;fields.context.testForm=form;fields.emit('invalid',{target:input});assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(input.getAttribute('aria-describedby'),'existing-help card-title-validation');assert.equal(fields.node('card-title-validation').textContent,'Title <required>');
 assert(form.summary.innerHTML.includes('&lt;img field&gt;'));assert(!form.summary.innerHTML.includes('<img'));assert.equal(form.summary.getAttribute('role'),'alert');
 fields.call('fieldError(testInput,"Again")');assert.equal(input.getAttribute('aria-describedby'),'existing-help card-title-validation');
 input.validity.valid=true;fields.emit('input',{target:input});assert.equal(input.getAttribute('aria-describedby'),'existing-help');assert.equal(input.getAttribute('aria-invalid'),null);assert.equal(form.summary,null);
 const untouched=fields.node('untouched');untouched.form=form;untouched.validity.valid=false;untouched.willValidate=true;untouched.validationMessage='Missing';form.elements.push(untouched);
 fields.emit('input',{target:input});assert.equal(form.summary,null,'Typing a valid field must not announce all errors before submission');
 fields.emit('invalid',{target:untouched});assert(form.summary);fields.emit('reset',{target:form});assert.equal(form.summary,null);assert.equal(untouched.getAttribute('aria-invalid'),null);
 const nav=runtime(),card=nav.node('card-12');card.dataset.cardId='12';const destination=nav.node('card-21');destination.dataset.cardId='21';
 nav.node('board-canvas').querySelectorAll=selector=>selector==='.column-cards' ? columns.map(ids=>({querySelectorAll:()=>ids.map(id=>({dataset:{cardId:id}}))})):[];
 nav.node('board-canvas').querySelector=selector=>selector==='[data-card-id="21"]' ? destination:null;
 let prevented=0;nav.emit('keydown',{target:card,key:'ArrowRight',preventDefault(){prevented++;}});assert.equal(nav.context.document.activeElement,destination);assert.equal(prevented,1);
 nav.context.document.activeElement=card;nav.emit('keydown',{target:card,key:'ArrowRight',isComposing:true,preventDefault(){throw Error('IME intercepted');}});assert.equal(nav.context.document.activeElement,card);
 nav.call(take("document.addEventListener('keydown',(event) => {\n  if (productivity.composing(event)) return;","document.querySelectorAll('dialog').forEach"));
 nav.emit('keydown',{target:card,key:'Enter',isComposing:true,preventDefault(){throw Error('IME intercepted');}});assert(!nav.events.some(item=>item[0]==='open-card'));
 const search=runtime({withAPI:true});search.call('showGlobalSearch()');search.node('global-query').value='work';
 const first=search.call('globalSearch("work")');assert.equal(search.requests[0].url,'/api/search?q=work&limit=30');search.requests[0].resolve({cards:[{id:40,board_id:7,title:'First',board_name:'B',column_title:'C'}],next_cursor:40});await first;
 assert(search.node('global-results').innerHTML.includes('global-more'));const more=search.call('globalSearch("work",true)');assert.equal(search.requests[1].url,'/api/search?q=work&limit=30&before=40');
 const duplicate=search.call('globalSearch("work",true)');await duplicate;assert.equal(search.requests.length,2,'Duplicate load-more clicks must not issue overlapping pages');
 search.requests[1].resolve({cards:[{id:40,title:'Duplicate'},{id:30,board_id:7,title:'<script>Page two</script>',board_name:'B',column_title:'C'}],next_cursor:null});await more;
 assert.equal(search.context.state.globalSearch.cards.length,2);assert(search.node('global-results').innerHTML.includes('First'));assert(search.node('global-results').innerHTML.includes('&lt;script&gt;Page two'));assert(!search.node('global-results').innerHTML.includes('<script>'));assert(!search.node('global-results').innerHTML.includes('global-more'));
 const firstResult=search.node('first-result');firstResult.dataset.searchCard='40';search.node('global-results').querySelector=selector=>selector==='[data-search-card="40"]' ? firstResult:null;firstResult.focus();search.call('renderGlobalSearch()');assert.equal(search.context.document.activeElement,firstResult);
 search.node('global-more').focus();search.node('global-results').querySelector=selector=>selector==='[data-search-card="30"]' ? firstResult:null;search.call('renderGlobalSearch(30)');assert.equal(search.context.document.activeElement,firstResult);
 const older=search.call('globalSearch("old")'),newer=search.call('globalSearch("new")');search.requests[3].resolve({cards:[{id:2,title:'Newest query',board_name:'B',column_title:'C'}]});await newer;search.requests[2].resolve({cards:[{id:3,title:'STALE_QUERY_PRIVATE'}]});await older;assert(!search.node('global-results').innerHTML.includes('STALE_QUERY_PRIVATE'));
 const stale=search.call('globalSearch("accountA")');search.call('setSession({enabled:true,user:{id:2,role:"member"},csrf:"new"})');search.requests[4].resolve({cards:[{id:1,title:'OLD_ACCOUNT_PRIVATE'}]});await stale;assert(!search.node('global-results').innerHTML.includes('OLD_ACCOUNT_PRIVATE'));assert.equal(search.context.state.globalSearch,null);
 console.log('Experience UI: scoped drafts and permissions, cross-tab session isolation, pagination races, calendar periods, command permissions, field errors, keyboard/IME, graphemes and pseudolocalization verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});

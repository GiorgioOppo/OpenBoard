'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test'),{create}=require('../web/i18n.js');
const importers=require('../web/importers.js');
const app=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const take=(start,end)=>{const from=app.indexOf(start),to=app.indexOf(end,from);assert(from>=0 && to>from,start);return app.slice(from,to);};
const registration=start=>{const from=app.indexOf(start),to=app.indexOf('\n});',from);assert(from>=0 && to>from,start);return app.slice(from,to+5);};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
const file=text=>{const bytes=new TextEncoder().encode(text);return {size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer};};
const nativeBoard=(name='Synthetic board')=>({format:'openboard',version:2,board:{name,description:'Synthetic description',columns:[{title:'List',cards:[{title:'Card'}]}],custom_fields:[],milestones:[]}});
const trelloBoard=(name='Synthetic Trello')=>({id:'board',name,lists:[{id:'list',name:'List'}],cards:[{id:'card',idList:'list',name:'Card',due:'2028-02-29T12:00:00Z'}]});
const catalog={};
for(const name of fs.readdirSync(path.join(__dirname,'../locales')).filter(name=>name.endsWith('.json')))
  Object.assign(catalog,JSON.parse(fs.readFileSync(path.join(__dirname,'../locales',name),'utf8')));

function runtime(locale='it') {
  const nodes=new Map(),listeners=new Map(),requests=[],events=[];
  let context,key=0;
  const dynamic=id=>['import-format','import-file','import-preview','csv-import-options','csv-import-name','csv-import-delimiter','csv-import-header','csv-import-mapping','prepare-csv-import','confirm-import'].includes(id)||id.startsWith('csv-map-');
  function removeChildren(id) {
    for(const [child,node] of [...nodes]) if(node.parent===id){removeChildren(child);nodes.delete(child);}
  }
  function parseHTML(parent,html) {
    removeChildren(parent);
    for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node=make(match[3],match[1]);node.parent=parent;
      for(const item of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        node.attributes[item[1]]=decode(item[2]??'');
        if(item[1].startsWith('data-'))node.dataset[item[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(item[2]??'');
      }
      node.value=node.attributes.value??'';node.checked=Object.hasOwn(node.attributes,'checked');node.hidden=Object.hasOwn(node.attributes,'hidden');
      if(match[1]==='select') {
        const contents=html.slice(match.index+match[0].length).split('</select>')[0];
        const options=[...contents.matchAll(/<option\b([^>]*)>/g)];
        const option=options.find(item=>/\bselected\b/.test(item[1]))||options[0];
        node.value=decode(option?.[1].match(/\bvalue="([^"]*)"/)?.[1]??'');
      }
    }
  }
  function make(id,tag='div') {
    let html='';
    const node={id,tag,attributes:{},dataset:{},open:false,disabled:false,checked:false,hidden:false,value:'',textContent:'',files:[],
      setAttribute(name,value){this.attributes[name]=String(value);},hasAttribute(name){return Object.hasOwn(this.attributes,name);},
      getAttribute(name){return this.attributes[name]??null;},addEventListener(){},focus(){},close(){this.open=false;},
      closest(selector){if(selector==='dialog')return nodes.get('panel-dialog');if(selector.includes('button')&&this.tag==='button')return this;return null;},
      get innerHTML(){return html;},set innerHTML(value){html=String(value);parseHTML(id,html);}};
    nodes.set(id,node);return node;
  }
  const node=id=>nodes.get(id)||(dynamic(id)?null:make(id,id.endsWith('-dialog')?'dialog':id==='import-board'?'button':'div'));
  for(const id of ['panel-dialog','panel-body','panel-heading','panel-error','card-dialog','board-dialog','column-dialog','move-dialog'])node(id);
  const i18n=create({locale,catalog});
  const session=(id=1,role='member')=>({enabled:true,user:{id,role},csrf:'csrf-'+id});
  context={state:{auth:session(),authGeneration:0,panelSequence:0,importSequence:0,loadSequence:0,cardSequence:0,
      loading:false,saving:false,board:{id:7,role:'observer',readonly:true,columns:[]},boards:[],selectedCards:new Map()},
    Map,Set,Number,Date,JSON,SyntaxError,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,
    OpenBoardImporters:importers,OpenBoardI18n:i18n,tr:i18n.t,ui:i18n.html,escapeHTML,$:node,uuid:()=> 'import-key-'+(++key),
    document:{body:make('document-body'),querySelectorAll(selector){
      if(selector.startsWith('dialog[open]'))return node('panel-dialog').open?[...nodes.values()].filter(value=>value.parent&&['input','select','button','textarea'].includes(value.tag)):[];
      if(selector==='[data-write]')return [...nodes.values()].filter(value=>value.hasAttribute('data-write'));
      if(selector==='[data-manage]')return [...nodes.values()].filter(value=>value.hasAttribute('data-manage'));
      return [];
    },addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);}},
    openDialog:id=>{node(id).open=true;},closeDialog:id=>{node(id).open=false;},saveReplyDraft(){},hydrateIcons(){},
    saveDraft(){},clearFilters(){},renderSidebar(){},renderHeader(){},renderBoard(){},canInspectStorage:()=>false,
    toast:message=>events.push(['toast',message]),refreshBoards:async()=>events.push(['refresh']),
    selectBoard:async id=>events.push(['select',id]),closeMenus(){},
    fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,reject,
      resolve:(value,status=200)=>resolve({ok:status<400,status,json:async()=>value})}))};
  vm.createContext(context);
  vm.runInContext(take('class APIError','function toast('),context);
  vm.runInContext(take('function canCreateBoard()','async function perform('),context);
  vm.runInContext(take('async function perform(','function allCards()'),context);
  vm.runInContext(take('function panel(','function showAuth('),context);
  vm.runInContext(take('function showImport()','function showGlobalSearch()'),context);
  vm.runInContext(registration("document.addEventListener('click',async (event) => {"),context);
  vm.runInContext(registration("document.addEventListener('input',(event) => {"),context);
  vm.runInContext(registration("document.addEventListener('change',(event) => {"),context);
  const emit=async(type,target)=>{await Promise.all((listeners.get(type)||[]).map(handler=>handler({target,preventDefault(){}})));await tick();};
  return {context,nodes,node,requests,events,session,call:code=>vm.runInContext(code,context),
    click:async id=>emit('click',node(id)),emit,
    async load(value){node('import-file').files=value?[value]:[];await emit('change',node('import-file'));},
    async format(value){node('import-format').value=value;await emit('change',node('import-format'));}};
}

test('Real delegated handlers keep OpenBoard v2 preview read-only until explicit confirmation',async()=>{
  const r=runtime();await r.click('import-board');
  assert.equal(r.context.state.panel,'import');assert(r.node('panel-body').innerHTML.includes('Trello JSON'));
  await r.load(file(JSON.stringify(nativeBoard('<img src=x onerror=attack()>'))));
  assert(r.node('import-preview').innerHTML.includes('&lt;img'));assert(!r.node('import-preview').innerHTML.includes('<img'));
  assert.equal(r.requests.length,0);assert(r.context.state.importKey);
  assert.equal(r.call('canWrite()'),false);assert.equal(r.node('confirm-import').disabled,false,'A member can create a board from a read-only current board');
  const savedKey=r.context.state.importKey,pending=r.click('confirm-import');
  assert.equal(r.requests.length,1);assert.equal(r.requests[0].url,'/api/import');
  assert.equal(r.requests[0].options.headers['X-CSRF-Token'],'csrf-1');
  assert.equal(r.requests[0].options.headers['Idempotency-Key'],savedKey);
  assert.equal(r.node('import-format').disabled,true);assert.equal(r.node('import-file').disabled,true);
  r.requests[0].resolve({id:31},201);await pending;
  assert.equal(r.node('panel-dialog').open,false);assert.equal(r.context.state.importSource,null);
  assert.deepEqual(r.events.filter(value=>value[0]==='select'),[['select',31]]);
});

test('CSV explicit mapping prepares warnings/counts, preserves literal formulas and sends no early mutations',async()=>{
  const r=runtime();r.call('showImport()');await r.format('csv');
  assert.equal(r.node('csv-import-options').hidden,false);assert.equal(r.node('import-file').accept,'.csv,text/csv');
  await r.load(file('Title,List,Description\r\n=2+2,Inbox,"First\r\nSecond"\r\n'));
  assert.equal(r.context.state.importData,null);assert.equal(r.node('confirm-import'),null);
  assert.equal(r.node('csv-map-title').value,'0');assert.equal(r.node('csv-map-list').value,'');
  r.node('csv-map-list').value='1';await r.emit('change',r.node('csv-map-list'));
  r.node('csv-map-description').value='2';await r.emit('change',r.node('csv-map-description'));
  r.node('csv-import-name').value='CSV board';await r.emit('input',r.node('csv-import-name'));
  await r.click('prepare-csv-import');
  assert.equal(r.requests.length,0);assert.equal(r.context.state.importData.board.name,'CSV board');
  assert.equal(r.context.state.importData.board.columns[0].title,'Inbox');
  assert.equal(r.context.state.importData.board.columns[0].cards[0].title,'=2+2');
  assert.equal(r.context.state.importData.board.columns[0].cards[0].description,'First\r\nSecond');
  assert(r.node('import-preview').innerHTML.includes('formule non vengono eseguite'));
  assert(r.node('import-preview').innerHTML.includes('1 schede'));
});

test('Every CSV config edit removes confirmation; unchanged preparation/retry preserves a stable key',async()=>{
  const r=runtime();r.call('showImport()');await r.format('csv');await r.load(file('title,list\nx,Inbox'));
  await r.click('prepare-csv-import');const first=r.context.state.importKey;
  await r.click('prepare-csv-import');assert.equal(r.context.state.importKey,first);
  r.node('csv-import-name').value='Changed name';await r.emit('input',r.node('csv-import-name'));
  assert.equal(r.context.state.importData,null);assert.equal(r.context.state.importKey,null);assert.equal(r.node('confirm-import'),null);
  await r.click('prepare-csv-import');const second=r.context.state.importKey;assert.notEqual(second,first);
  r.node('csv-map-list').value='1';await r.emit('change',r.node('csv-map-list'));assert.equal(r.node('confirm-import'),null);
  await r.click('prepare-csv-import');assert.notEqual(r.context.state.importKey,second);
  r.node('csv-import-header').checked=false;await r.emit('change',r.node('csv-import-header'));
  assert.equal(r.context.state.importData,null);assert.equal(r.node('csv-map-title').value,'0');
  r.node('csv-import-header').checked=true;await r.emit('change',r.node('csv-import-header'));
  r.node('csv-import-delimiter').value=';';await r.emit('change',r.node('csv-import-delimiter'));
  assert.equal(r.context.state.importKey,null);assert.equal(r.node('csv-map-list').value,'');
  await r.format('openboard');assert.equal(r.context.state.importSource,null);assert.equal(r.node('import-file').value,'');
  assert.equal(r.node('csv-import-options').hidden,true);assert.equal(r.requests.length,0);
});

test('CSV malformed rows/mappings and invalid file/JSON/UTF8 never enable confirmation',async()=>{
  const r=runtime();r.call('showImport()');
  await r.load(file('{invalid'));assert.equal(r.node('panel-error').textContent,'Il file non contiene JSON valido.');
  await r.load(file('null'));assert.equal(r.node('panel-error').textContent,'Serve un’esportazione OpenBoard in formato versione 2.');
  await r.load({size:2,arrayBuffer:async()=>Uint8Array.from([0xc3,0x28]).buffer});assert.equal(r.node('panel-error').textContent,'Il file non contiene testo UTF-8 valido.');
  let read=false;await r.load({size:2*1024*1024+1,arrayBuffer:async()=>{read=true;}});assert.equal(read,false);
  assert.equal(r.node('panel-error').textContent,'Il file supera il limite di 2 MB.');
  await r.load({size:0,arrayBuffer:async()=>new ArrayBuffer(2*1024*1024+1)});assert.equal(r.context.state.importData,null);
  await r.load({size:1,arrayBuffer:async()=>{throw new Error('PRIVATE_READER_ERROR');}});assert.equal(r.node('panel-error').textContent,'Impossibile leggere il file selezionato.');
  await r.format('csv');await r.load(file('title,other\nx,y'));
  r.node('csv-map-list').value='0';await r.emit('change',r.node('csv-map-list'));await r.click('prepare-csv-import');
  assert(r.node('panel-error').textContent.includes('Mappatura CSV'));assert.equal(r.node('confirm-import'),null);
  await r.load(file('title\n"unfinished'));assert(r.node('panel-error').textContent.includes('CSV non valido'));
  assert.equal(r.requests.length,0);
});

test('Trello conversion previews escaped names/warnings and rejects reversed dates before confirmation',async()=>{
  const r=runtime();r.call('showImport()');await r.format('trello');
  await r.load(file(JSON.stringify(trelloBoard('<script>synthetic</script>'))));
  assert(r.node('import-preview').innerHTML.includes('Commenti, attività'));assert(!r.node('import-preview').innerHTML.includes('<script>'));
  assert(r.context.state.importData.board.columns[0].cards[0].due_date==='2028-02-29');
  const oldKey=r.context.state.importKey;
  const invalid=trelloBoard();invalid.cards[0].start='2028-03-01T00:00:00Z';
  await r.load(file(JSON.stringify(invalid)));assert.equal(r.context.state.importData,null);assert.equal(r.node('confirm-import'),null);
  assert.equal(r.node('panel-error').textContent,'Data importata non valida.');
  await r.load(file(JSON.stringify(trelloBoard())));assert.notEqual(r.context.state.importKey,oldKey);
  assert.equal(r.requests.length,0);
});

test('A newer file, a reopened panel, closing or navigation invalidates late file reads and errors',async()=>{
  const r=runtime();r.call('showImport()');const old=deferred();await r.load({size:1,arrayBuffer:()=>old.promise});
  await r.load(file(JSON.stringify(nativeBoard('New file'))));const key=r.context.state.importKey;
  old.resolve(new TextEncoder().encode(JSON.stringify(nativeBoard('OLD_PRIVATE_FILE'))).buffer);await tick();
  assert.equal(r.context.state.importData.board.name,'New file');assert.equal(r.context.state.importKey,key);
  const reopened=deferred();await r.load({size:1,arrayBuffer:()=>reopened.promise});r.call('showImport()');
  reopened.reject(new Error('STALE_REOPEN_ERROR'));await tick();assert.equal(r.node('panel-error').textContent,'');assert.equal(r.context.state.importData,null);
  const away=deferred();await r.load({size:1,arrayBuffer:()=>away.promise});r.call('panel("Other","OTHER_PANEL","other")');
  away.resolve(new TextEncoder().encode(JSON.stringify(nativeBoard('OLD_NAVIGATION'))).buffer);await tick();
  assert.equal(r.node('panel-body').innerHTML,'OTHER_PANEL');assert.equal(r.context.state.importData,null);
  r.call('showImport()');const closed=deferred();await r.load({size:1,arrayBuffer:()=>closed.promise});r.node('panel-dialog').open=false;
  closed.resolve(new TextEncoder().encode(JSON.stringify(nativeBoard())).buffer);await tick();assert.equal(r.context.state.importData,null);
});

test('Account switch/logout clears decoded CSV sources and prevents late reads repopulating another account',async()=>{
  const r=runtime();r.call('showImport()');await r.format('csv');await r.load(file('title\nPRIVATE_OLD_ACCOUNT'));
  assert(r.context.state.importSource.text.includes('PRIVATE_OLD_ACCOUNT'));
  r.context.nextSession=r.session(2);r.call('setSession(nextSession)');
  assert.equal(r.context.state.importSource,null);assert.equal(r.context.state.importContext,null);assert.equal(r.context.state.importData,null);
  r.call('showImport()');const old=deferred();await r.load({size:1,arrayBuffer:()=>old.promise});
  r.call('setSession({enabled:true,user:null,csrf:""})');
  old.resolve(new TextEncoder().encode(JSON.stringify(nativeBoard('PRIVATE_LOGGED_OUT_FILE'))).buffer);await tick();
  assert.equal(r.context.state.importData,null);assert.equal(r.context.state.importSource,null);
  assert(!r.node('panel-body').innerHTML.includes('PRIVATE_LOGGED_OUT_FILE'));assert.equal(r.requests.length,0);
});

test('Observer/current-role and saving guards apply to real preparation and confirmation handlers',async()=>{
  const r=runtime();r.context.state.auth=r.session(1,'observer');await r.click('import-board');assert.equal(r.context.state.panel,undefined);
  r.context.state.auth=r.session();r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));
  r.context.state.auth.user.role='observer';await r.click('confirm-import');assert.equal(r.requests.length,0);
  r.call('updateBusy()');assert.equal(r.node('confirm-import').disabled,true);
  r.context.state.auth.user.role='member';r.context.state.saving=true;
  const source=r.context.state.importSource;await r.load(file(JSON.stringify(nativeBoard('Do not read'))));
  assert.equal(r.context.state.importSource,source);await r.click('confirm-import');assert.equal(r.requests.length,0);
});

test('HTTP failures and automatic POST retries reuse the same key and account context',async()=>{
  const r=runtime();r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));const key=r.context.state.importKey;
  let pending=r.click('confirm-import');r.requests[0].resolve({error:'Synthetic failure'},503);await pending;
  assert.equal(r.context.state.importKey,key);assert(r.context.state.importData);assert(r.node('panel-error').textContent);
  pending=r.click('confirm-import');assert.equal(r.requests[1].options.headers['Idempotency-Key'],key);
  r.requests[1].reject(new TypeError('Lost response'));await tick();assert.equal(r.requests.length,3);
  assert.equal(r.requests[2].options.headers['Idempotency-Key'],key);assert.equal(r.requests[2].options.body,r.requests[1].options.body);
  r.context.nextSession=r.session(2);r.call('setSession(nextSession)');r.call('panel("Other","SECOND_ACCOUNT","other")');
  r.requests[2].resolve({id:77},201);await pending;
  assert.equal(r.node('panel-body').innerHTML,'SECOND_ACCOUNT');assert(!r.events.some(value=>value[0]==='select'));
});

test('A delayed post-import refresh cannot override newer panel, same-board navigation, file or account intent',async()=>{
  const changes=[
    r=>r.call('panel("Other","OTHER_PANEL","other")'),
    r=>{r.context.state.loadSequence++;}, // even selecting the same board changes intent
    r=>{r.context.state.loading=true;},
    r=>{r.context.state.importSequence++;},
    r=>{r.context.nextSession=r.session(2);r.call('setSession(nextSession)');}
  ];
  for(const change of changes) {
    const r=runtime(),refresh=deferred();r.context.refreshBoards=()=>refresh.promise;
    r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));
    const pending=r.click('confirm-import');r.requests[0].resolve({id:31},201);await tick();
    assert.equal(r.node('panel-dialog').open,false);
    change(r);refresh.resolve();await pending;
    assert(!r.events.some(value=>value[0]==='select'));
  }
  const r=runtime(),refresh=deferred();r.context.refreshBoards=()=>refresh.promise;
  r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));
  const pending=r.click('confirm-import');r.requests[0].resolve({board:{id:31}},201);await tick();
  refresh.resolve();await pending;assert.deepEqual(r.events.filter(value=>value[0]==='select'),[['select',31]]);
});

test('Late import-write failure cannot replace another panel error in the same account',async()=>{
  const r=runtime();r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));
  const pending=r.click('confirm-import');
  r.call('panel("Other","OTHER_PANEL","other")');r.node('panel-error').textContent='Current panel message';
  r.requests[0].resolve({error:'STALE_IMPORT_WRITE_FAILURE'},503);await pending;
  assert.equal(r.node('panel-error').textContent,'Current panel message');
  assert.equal(r.node('panel-body').innerHTML,'OTHER_PANEL');
  assert(!r.events.some(value=>value[0]==='toast'&&value[1].includes('STALE_IMPORT_WRITE_FAILURE')));
});

test('Successful import replies only navigate to positive safe integer board IDs',async()=>{
  for(const id of [0,-1,1.5,'31',true,Number.MAX_SAFE_INTEGER+1,null]) {
    const r=runtime();r.call('showImport()');await r.load(file(JSON.stringify(nativeBoard())));
    const pending=r.click('confirm-import');r.requests[0].resolve({id},201);await pending;
    assert(!r.events.some(value=>value[0]==='select'));
  }
});

test('Warnings, CSV headers and user values are escaped, and UI copy works in all seven locales',async()=>{
  for(const language of ['it','en','fr','es','de','zh','ja']) {
    const r=runtime(language);r.call('showImport()');await r.format('trello');
    await r.load(file(JSON.stringify(trelloBoard('<img src=x onerror=attack()>'))));
    assert(r.node('import-preview').innerHTML.length>300);assert(!r.node('import-preview').innerHTML.includes('<img'));
    if(language==='en')assert(r.node('import-preview').innerHTML.includes('Conversion warnings'));
  }
  const r=runtime();r.call('showImport()');await r.format('csv');await r.load(file('"<img src=x onerror=attack()>",unused\nx,y'));
  assert(!r.node('csv-import-mapping').innerHTML.includes('<img'));assert(r.node('csv-import-mapping').innerHTML.includes('&lt;img'));
  r.context.OpenBoardImporters={...importers,parseCSV:(...args)=>({...importers.parseCSV(...args),warnings:['<img src=x onerror=warningAttack()>']})};
  await r.click('prepare-csv-import');assert(!r.node('import-preview').innerHTML.includes('<img'));assert(r.node('import-preview').innerHTML.includes('&lt;img'));
});

test('Every import UI source has six translations with matching placeholders',()=>{
  const {extractJavaScript}=require('../scripts/extract-i18n.cjs');
  for(const source of extractJavaScript(take('function showImport()','function showGlobalSearch()'))) {
    assert(Object.hasOwn(catalog,source),source);assert.equal(catalog[source].length,6);
    const placeholders=[...source.matchAll(/\{\w+\}/g)].map(item=>item[0]).sort();
    for(const translated of catalog[source])assert.deepEqual([...translated.matchAll(/\{\w+\}/g)].map(item=>item[0]).sort(),placeholders);
  }
});

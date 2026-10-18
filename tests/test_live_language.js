'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
const {create}=require('../web/i18n.js');

// A deliberately small DOM fixture executes the browser runtime and real app
// handlers. It models identity/ranges/forms, not browser layout or native IME.
const decode=text=>text.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g,value=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':'\u00a0'}[value]));
const escape=text=>String(text).replace(/[&<>"']/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]));
class Node {
  constructor(type,document,data=''){this.nodeType=type;this.ownerDocument=document;this.data=data;this.parentNode=null;this.childNodes=[];this.listeners=new Map();}
  get nextSibling(){if(!this.parentNode)return null;return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this)+1] || null;}
  get isConnected(){let node=this;while(node){if(node.nodeType===9)return true;node=node.parentNode;}return false;}
  appendChild(node){return this.insertBefore(node,null);}
  insertBefore(node,before){if(node.nodeType===11){for(const child of [...node.childNodes])this.insertBefore(child,before);return node;}node.remove();const index=before ? this.childNodes.indexOf(before):this.childNodes.length;assert(index>=0);this.childNodes.splice(index,0,node);node.parentNode=this;return node;}
  remove(){if(!this.parentNode)return;const parent=this.parentNode;parent.childNodes.splice(parent.childNodes.indexOf(this),1);this.parentNode=null;}
  get textContent(){if(this.nodeType===3)return this.data;if(this.nodeType===8)return '';return this.childNodes.map(node=>node.textContent).join('');}
  set textContent(value){if(this.nodeType===3){this.data=String(value);return;}for(const node of [...this.childNodes])node.remove();if(String(value))this.appendChild(this.ownerDocument.createTextNode(String(value)));}
  addEventListener(name,callback){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(callback);}
  dispatchEvent(event){event.target ||= this;for(const callback of this.listeners.get(event.type)||[])callback(event);return !event.defaultPrevented;}
  get innerHTML(){return this.childNodes.map(serialize).join('');}
  set innerHTML(value){for(const node of [...this.childNodes])node.remove();parse(this,String(value));}
}
class Element extends Node {
  constructor(name,document){super(1,document);this.tagName=name.toUpperCase();this.attributes=new Map();this.hidden=false;this.disabled=false;this.checked=false;this.open=false;this.selectionStart=0;this.selectionEnd=0;this.selectionDirection='none';}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name==='checked')this.checked=true;if(name==='open')this.open=true;}
  getAttribute(name){return this.attributes.get(name) ?? null;}
  hasAttribute(name){return this.attributes.has(name);}
  removeAttribute(name){this.attributes.delete(name);}
  get id(){return this.getAttribute('id') || '';}
  get dataset(){return Object.fromEntries([...this.attributes].filter(([name])=>name.startsWith('data-')).map(([name,value])=>[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));}
  get value(){if(this._value!==undefined)return this._value;if(this.tagName==='SELECT'){const options=this.querySelectorAll('option');return (options.find(node=>node.hasAttribute('selected'))||options[0])?.value || '';}if(this.tagName==='TEXTAREA')return this.textContent;return this.getAttribute('value') || '';}
  set value(value){this._value=String(value);}
  get defaultSelected(){return this.hasAttribute('selected');}
  set defaultSelected(value){if(value)this.setAttribute('selected','');else this.removeAttribute('selected');}
  reset(){for(const control of this.querySelectorAll('input,textarea,select')){control._value=undefined;control.checked=control.hasAttribute('checked');}}
  get type(){return this.getAttribute('type') || '';}
  get name(){return this.getAttribute('name') || '';}
  get isContentEditable(){return this.getAttribute('contenteditable')==='true';}
  focus(){this.ownerDocument.activeElement=this;}
  setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
  querySelectorAll(selector){const result=[];for(const node of this.childNodes){if(node.nodeType!==1)continue;if(matches(node,selector))result.push(node);result.push(...node.querySelectorAll(selector));}return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0] || null;}
  closest(selector){let node=this;while(node?.nodeType===1){if(matches(node,selector))return node;node=node.parentNode;}return null;}
  get classList(){const change=(name,add)=>{const names=new Set((this.getAttribute('class')||'').split(/\s+/).filter(Boolean));if(add)names.add(name);else names.delete(name);this.setAttribute('class',[...names].join(' '));};return {add:name=>change(name,true),remove:name=>change(name,false),toggle:(name,force)=>change(name,force)};}
  showModal(){this.open=true;}
}
function matches(element,selector){return selector.split(',').some(raw=>{let value=raw.trim();if(value.endsWith(':checked')){if(!element.checked)return false;value=value.slice(0,-8);}const id=value.match(/#([\w-]+)/);if(id && element.id!==id[1])return false;const tag=value.match(/^[a-z]+/i);if(tag && element.tagName!==tag[0].toUpperCase())return false;const attr=/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g;let match;while((match=attr.exec(value))){if(!element.hasAttribute(match[1]) || (match[2]!==undefined && element.getAttribute(match[1])!==match[2]))return false;}return true;});}
const voidTags=new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR']);
function parse(parent,html){const stack=[parent];for(const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g)){const token=match[0],current=stack.at(-1);if(token.startsWith('<!--'))current.appendChild(new Node(8,parent.ownerDocument,token.slice(4,-3)));else if(token.startsWith('</')){if(stack.length>1)stack.pop();}else if(token.startsWith('<!'))continue;else if(token.startsWith('<')){const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const element=new Element(tag,parent.ownerDocument);const attrs=token.slice(tag.length+1).replace(/\/?\s*>$/,'');for(const attribute of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g))element.setAttribute(attribute[1],decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));current.appendChild(element);if(!voidTags.has(element.tagName) && !token.endsWith('/>'))stack.push(element);}else current.appendChild(parent.ownerDocument.createTextNode(decode(token)));}}
function serialize(node){if(node.nodeType===3)return escape(node.data);if(node.nodeType===8)return '<!--'+node.data+'-->';return '<'+node.tagName.toLowerCase()+[...node.attributes].map(([name,value])=>' '+name+'="'+escape(value)+'"').join('')+'>'+node.innerHTML+(voidTags.has(node.tagName)?'':'</'+node.tagName.toLowerCase()+'>');}
class Document extends Node {
  constructor(html){super(9,null);this.ownerDocument=this;this.readyState='interactive';parse(this,html);this.documentElement=this.childNodes.find(node=>node.tagName==='HTML');this.activeElement=this.documentElement;this.title='OpenBoard';}
  createTextNode(text){return new Node(3,this,text);}
  createDocumentFragment(){return new Node(11,this);}
  querySelectorAll(selector){return this.documentElement.querySelectorAll(selector);}
  querySelector(selector){return this.querySelectorAll(selector)[0] || null;}
  getElementById(id){return this.querySelector('#'+id);}
  createTreeWalker(node,type){const items=[];const visit=current=>{for(const child of current.childNodes){if(type===128 && child.nodeType===8)items.push(child);visit(child);}};visit(node);let index=0;return {nextNode:()=>items[index++] || null};}
}
const app=read('web/app.js'),planning=read('web/planning.js');
function take(source,name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert(start>=0,name);const tail=source.slice(start),next=tail.slice(1).search(/\n(?:async )?function \w+\(/);return next<0 ? tail:tail.slice(0,next+1);}
function runtime({blocked=false,search='',stored='en',pseudo=false}={}) {
  const document=new Document(read('web/index.html')),storage=new Map([['openboard.language',stored]]),events=[],requests=[],updates=[];
  const context={console,URL,URLSearchParams,Intl,Date,Map,Set,Number,JSON,Error,RangeError,document,navigator:{languages:['en-US']},crypto:{randomUUID:()=> 'live-language-fixture'},
    localStorage:{getItem(key){if(blocked)throw Error('blocked');return storage.get(key)||null;},setItem(key,value){if(blocked)throw Error('blocked');storage.set(key,String(value));},removeItem:key=>storage.delete(key)},
    location:{href:'http://local.test/'+search+'#board/7/card/8',search:search+(pseudo ? (search ? '&':'?')+'pseudo=1':''),reload(){throw Error('Unexpected reload');},assign(){throw Error('Unexpected navigation');}},
    history:{state:{router:'original'},replaceState(state,title,url){assert.equal(state,context.history.state);updates.push(url);context.location.href=url;}},
    CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;this.defaultPrevented=false;}preventDefault(){this.defaultPrevented=true;}},
    state:{saving:false,view:'table',auth:{enabled:true,user:{id:1,role:'member',name:'Cestino'},csrf:'private-synthetic-token'},authGeneration:4,loadSequence:3,panelSequence:2,board:{id:7,columns:[]},cardEditor:{id:8,version:3,assigneeIds:[2],checklist:[{id:'1',text:'Cestino',done:false}],customValues:{note:'Cestino'},original:'unchanged'},tableEditor:{version:9,values:{title:'Cestino',priority:'normal',estimate_minutes:'12'},pending:true},panel:'enterprise-review-create'},
    api:async(...args)=>{requests.push(args);throw Error('No request expected');},canWrite:()=>true,canManage:()=>true,canCreateBoard:()=>true,
    openDialog:id=>{document.getElementById(id).open=true;},hydrateIcons(){},updateBusy(){},setTimeout:()=>1,clearTimeout(){},
    stored:(key,fallback='')=>storage.get('openboard.'+key)||fallback,remember:(key,value)=>storage.set('openboard.'+key,value),forget:key=>storage.delete('openboard.'+key),
    showDraftCenter(){},showGlobalSearch(){},showAccount(){},showShortcuts(){},openBoardEditor(){},setView(){},openCard(){},saveReplyDraft(){throw Error('Unexpected draft write');},
  };
  context.$=id=>document.getElementById(id);
  vm.createContext(context);vm.runInContext(read('web/locales.js'),context);context.OpenBoardLocales={...context.OpenBoardLocales,'Sposta {0} in {1}':['Move {0} to {1}','Déplacer {0} vers {1}','Mover {0} a {1}','Nach {1}: {0}','将{0}移动到{1}','{0}を{1}に移動']};vm.runInContext(read('web/i18n.js'),context);
  context.escapeHTML=value=>context.OpenBoardI18n.escape(value);
  vm.runInContext(read('web/productivity.js'),context);context.productivity=context.OpenBoardProductivity;
  vm.runInContext(['roleLabel','formatDate','toast','panel','cardData','cardSnapshot','editorDirty','draftKey','saveDraft','cardDraftVersionValid','readDraft','loadComments','commandActions'].map(name=>take(app,name)).join('\n'),context);
  vm.runInContext(['readCustomValues','pendingWorklog','renderComments','commentHTML'].map(name=>take(planning,name)).join('\n')+'\nconst reactionNames={};',context);
  const handler=app.match(/document\.addEventListener\('openboard:languagechanged',[\s\S]*?\n\}\);/)[0];vm.runInContext(handler,context);
  document.addEventListener('openboard:languagechanged',event=>events.push(event.detail.locale));
  const selectors=document.querySelectorAll('[data-language-selector]');
  function change(locale,index=0){selectors[index].value=locale;selectors[index].dispatchEvent(new context.CustomEvent('change'));}
  return {context,document,storage,events,requests,updates,selectors,change,$:context.$};
}

(async()=>{
  // Browser initialization translates authored static DOM without rebuilding it.
  const r=runtime(),{context:c,$}=r,i=c.OpenBoardI18n;
  assert.equal(typeof create({locale:'en'}).t('Cestino'),'string');
  assert.equal(i.locale,'en');assert(r.selectors.length>=7);assert.equal($('card-dialog').querySelector('[data-language-selector]').value,'en');
  const cardInput=$('card-title'),description=$('card-description'),cardDialog=$('card-dialog'),panel=$('panel-dialog');
  cardDialog.open=true;panel.open=true;c.state.saving=true;cardInput.value='Cestino';description.value='Cestino & Trash <script>user data</script>';
  for(const [id,value] of Object.entries({'card-column':'1','card-label':'design','card-assignee':'Alice','card-due-date':'2026-11-30','card-start-date':'2026-11-01','card-actual':'0','card-reference':'https://example.test','card-priority':'normal','card-estimate':'12','checklist-new':'unsaved task','comment-body':'unsaved Cestino','worklog-minutes':'15','worklog-note':'pending note','worklog-date':'2026-10-18'}))$(id).value=value;
  c.saveDraft();const draftKey='openboard.draft.1.7.8',beforeDraft=r.storage.get(draftKey),beforeCard=JSON.stringify(c.cardData()),beforeState=JSON.stringify(c.state),auth=c.state.auth,editor=c.state.cardEditor,table=c.state.tableEditor;
  vm.runInContext("panel(tr('Richiedi una revisione'),ui`<form id=\"review-draft\"><label>Nota per il richiedente<textarea id=\"review-note\">${escapeHTML('Cestino')}</textarea></label><select id=\"review-decision\"><option value=\"approved\" selected>${escapeHTML(tr('Approva'))}</option><option value=\"changes_requested\">${escapeHTML(tr('Richiedi modifiche'))}</option></select><button id=\"authored-button\" title=\"Apri ${escapeHTML('Cestino')}\">Cestino</button><span id=\"user-text\">${escapeHTML('Cestino')}</span><span id=\"server-label\">${escapeHTML(tr('Pianificato'))}</span><span id=\"date-label\">${escapeHTML(OpenBoardI18n.isoDate('2026-10-18'))}</span><span id=\"count-label\">${escapeHTML(OpenBoardI18n.count('{count} scheda','{count} schede',1234))}</span></form>`,'enterprise-review-create')",c);
  const review=$('review-note'),decision=$('review-decision'),button=$('authored-button'),date=$('date-label'),count=$('count-label');review.value='unsaved Cestino & <b>note</b>';decision.value='changes_requested';
  cardInput.focus();cardInput.setSelectionRange(1,5,'backward');
  const accountBinding=app.match(/^  OpenBoardI18n\.attribute\(\$\('account-menu'\),.*$/m)[0];vm.runInContext(accountBinding,c);vm.runInContext("OpenBoardI18n.text($('privacy-badge'),tr`Team · ${roleLabel('member')}`)",c);
  const sourceLabels=c.productivity.catalog({labels:{design:'Design'},priorities:{normal:'Normale'},covers:[''],custom_field_types:[['text','Testo'],['number','Numero'],['date','Data'],['boolean','Sì / No'],['select','Scelta']].map(([value,label])=>({value,label}))});
  const direct=c.document.createTextNode('');$('panel-body').appendChild(direct); // Unmarked future content is never scanned.
  for(const language of ['fr','es','de','zh-CN','ja','it','en']) {
    r.change(language,2);
    assert.equal(i.locale,language);assert.equal(r.document.documentElement.lang,language);assert(r.selectors.every(select=>select.value===language));
    assert.equal($('card-title'),cardInput);assert.equal($('card-description'),description);assert.equal($('review-note'),review);assert.equal($('review-decision'),decision);assert.equal($('authored-button'),button);
    assert.equal(cardInput.value,'Cestino');assert.equal(description.value,'Cestino & Trash <script>user data</script>');assert.equal(review.value,'unsaved Cestino & <b>note</b>');assert.equal(decision.value,'changes_requested');assert.equal($('user-text').textContent,'Cestino');
    assert.equal(r.document.activeElement,cardInput);assert.deepEqual([cardInput.selectionStart,cardInput.selectionEnd,cardInput.selectionDirection],[1,5,'backward']);
    assert.equal($('card-title-label').textContent,i.t('Titolo della scheda'));assert.equal(cardInput.getAttribute('placeholder'),i.t('A cosa lavoriamo?'));
    assert.equal(button.textContent,i.t('Cestino'));assert.equal(button.getAttribute('title'),i.t('Apri {0}',{0:'Cestino'}));assert.equal($('server-label').textContent,i.t('Pianificato'));assert.equal($('panel-heading').textContent,i.t('Richiedi una revisione'));
    assert.equal($('account-menu').getAttribute('aria-label'),String(i.message`Account e preferenze${': Cestino'}`));assert.equal($('privacy-badge').textContent,String(i.message`Team · ${i.message('Membro')}`));
    assert.equal(String(sourceLabels.priorities.normal),i.t('Normale'));assert.equal(date.textContent,String(i.isoDate('2026-10-18')));assert.equal(count.textContent,String(i.count('{count} scheda','{count} schede',1234)));
    assert.equal(c.state.auth,auth);assert.equal(c.state.cardEditor,editor);assert.equal(c.state.tableEditor,table);assert.equal(c.state.view,'table');assert.equal(c.state.panel,'enterprise-review-create');assert(cardDialog.open && panel.open);assert(c.state.saving);
    assert.equal(JSON.stringify(c.cardData()),beforeCard);assert.equal(r.storage.get(draftKey),beforeDraft);assert.equal(r.requests.length,0);
  }
  assert.equal(JSON.parse(beforeState).authGeneration,c.state.authGeneration);assert.equal(JSON.parse(beforeState).loadSequence,c.state.loadSequence);

  // Literal interpolation slots can change order without replacing their nodes.
  const nested=r.document.createDocumentFragment();parse(nested,vm.runInContext('ui`<div id="slot-order">Sposta ${ui`<input id="slot-first" value="private-one">`} in ${ui`<textarea id="slot-second">private-two</textarea>`}</div>`',c));$('panel-body').appendChild(nested);
  const first=$('slot-first'),second=$('slot-second');first.value='edited one';second.value='edited two';second.focus();second.setSelectionRange(2,6,'forward');r.change('de');
  assert.equal($('slot-first'),first);assert.equal($('slot-second'),second);assert.equal(first.value,'edited one');assert.equal(second.value,'edited two');assert.equal(r.document.activeElement,second);assert.deepEqual([second.selectionStart,second.selectionEnd],[2,6]);assert($('slot-order').innerHTML.indexOf('slot-second')<$('slot-order').innerHTML.indexOf('slot-first'));
  r.change('en');assert($('slot-order').innerHTML.indexOf('slot-first')<$('slot-order').innerHTML.indexOf('slot-second'));

  // Branded nested labels retain provenance, arbitrary data with the same text
  // does not. Unknown catalogue output cannot inject elements/attributes.
  // Catalogue is frozen in production, so use a separate live instance fixture.
  const malicious=create({locale:'en',live:true,catalog:{HTML:['<script>bad()</script>','" onfocus="bad()']}});
  const dangerous='<img src=x onerror=attack()> & <script>attack()</script>';assert.equal(i.markup(dangerous),escape(dangerous));assert.equal(c.productivity.fieldCell(dangerous),escape(dangerous));
  vm.runInContext(read('web/timeline.js'),c);const timelineModel=c.OpenBoardTimeline.model({columns:[{id:1,title:dangerous,cards:[{id:1,title:dangerous,start_date:'2026-10-01',due_date:'2026-10-18'},{id:2,title:dangerous}]}]},{anchor:'2026-10-18'});const timelineHTML=c.OpenBoardTimeline.render(timelineModel,{tr:c.tr,locale:i.locale});assert(!timelineHTML.includes('<img'));assert(!timelineHTML.includes('<script>'));assert(timelineHTML.includes('&lt;img'));
  const hostile=malicious.html`<input title="HTML"><p>${malicious.message('HTML')}</p>`;assert(!hostile.includes('<script>'));assert(!hostile.includes('title="" onfocus='));
  const opaque='<section>PRIVATE_UNRELATED_BODY</section>';const metadata=i.html`<button title="Apri ${'one'}">${opaque}</button>`;const attr=metadata.match(/data-ob-i18n-[^=]+="([^"]+)"/)[1];assert(!decodeURIComponent(attr).includes('PRIVATE_UNRELATED_BODY'));
  const error=new i.LocalizedError(c.tr('Scegli un nome per la lista.'));c.toast(error.localizedMessage);r.change('de');assert.equal($('toast-message').textContent,i.t('Scegli un nome per la lista.'));i.title(r.document,c.tr('OpenBoard · Il tuo lavoro, in ordine'));r.change('fr');assert.equal(r.document.title,i.t('OpenBoard · Il tuo lavoro, in ordine'));
  vm.runInContext(read('web/workflows.js')+'\nthis.workflows=OpenBoardWorkflows;',c);const requestMarkup=c.workflows.answerFields([{key:'private',name:'Cestino',type:'text',required:true},{key:'choice',name:'Cestino',type:'select',options:['Cestino','Trash']}],{private:'Cestino draft',choice:'Cestino'});const requestNode=r.document.createDocumentFragment();parse(requestNode,requestMarkup);$('panel-body').appendChild(requestNode);const requestInput=$('workflow-answer-0'),requestChoice=$('workflow-answer-1');requestInput.value='unsaved request Cestino';requestChoice.value='Cestino';r.change('ja');assert.equal($('workflow-answer-0'),requestInput);assert.equal(requestInput.value,'unsaved request Cestino');assert.equal(requestChoice.value,'Cestino');assert.equal(requestChoice.querySelectorAll('option').find(option=>option.value==='Cestino').textContent,'Cestino');assert.equal(requestInput.closest('label').textContent.split(' · ')[0],'Cestino');
  r.change('it');i.text(button,c.tr('Cestino'));i.text(button,'Cestino');i.attribute(button,'title','Cestino');r.change('en');assert.equal(button.textContent,'Cestino');assert.equal(button.getAttribute('title'),'Cestino');
  const unknown=r.document.createTextNode('Cestino');$('panel-body').appendChild(unknown);r.change('ja');assert.equal(unknown.data,'Cestino');

  // An actual queued comments read renders in the new language when it arrives;
  // switching itself does not add reads, writes or invalidate the editor.
  let resolve;c.api=(...args)=>{r.requests.push(args);return new Promise(done=>{resolve=done;});};
  const pending=c.loadComments(8);assert.equal(r.requests.length,1);r.change('fr');assert.equal(r.requests.length,1);resolve({comments:[]});await pending;assert.equal($('comments-list').textContent,i.t('Nessun commento con questi filtri.'));assert.equal($('comment-body').value,'unsaved Cestino');assert.equal(r.storage.get(draftKey),beforeDraft);

  const blocked=runtime({blocked:true,search:'?lang=fr&source=test'}),history=blocked.context.history.state;blocked.change('ja');assert.equal(blocked.context.OpenBoardI18n.locale,'ja');assert.equal(blocked.context.history.state,history);assert.equal(blocked.updates.length,1);const url=new URL(blocked.updates[0]);assert.equal(url.searchParams.get('lang'),'ja');assert.equal(url.searchParams.get('source'),'test');assert.equal(url.hash,'#board/7/card/8');
  const noOverride=runtime({blocked:true,search:'?source=test'});noOverride.change('de');assert.equal(noOverride.updates.length,0);assert.equal(noOverride.context.OpenBoardI18n.locale,'de');
  const pseudo=runtime({pseudo:true});assert.equal(pseudo.$('card-title-label').textContent,pseudo.context.OpenBoardI18n.t('Titolo della scheda'));pseudo.$('card-title').value='Cestino';pseudo.change('de');assert.equal(pseudo.$('card-title').value,'Cestino');assert(pseudo.$('card-title-label').textContent.startsWith('⟦'));
  const reset=runtime();reset.change('fr');reset.$('card-form').reset();reset.$('board-form').reset();reset.$('column-form').reset();assert(reset.selectors.every(select=>select.value==='fr'));reset.change('ja');reset.$('card-form').reset();assert(reset.selectors.every(select=>select.value==='ja'));
  const invalid=runtime();invalid.change('xx');assert.equal(invalid.context.OpenBoardI18n.locale,'en');assert(invalid.selectors.every(select=>select.value==='en'));
  console.log('Live language: actual browser initialization/change and app handlers, seven locales, mounted draft/control identity, selection, source provenance, slots, enums, formats, queued reads, blocked storage/history and no server mutations verified in a DOM VM fixture.');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {create,languages}=require('../web/i18n.js'),productivity=require('../web/productivity.js');
const app=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const take=(start,end)=>{const from=app.indexOf(start),to=end ? app.indexOf(end,from):app.length;assert(from>=0 && to>from,start);return app.slice(from,to);};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const catalogContext={};vm.runInNewContext(fs.readFileSync(require.resolve('../web/locales.js'),'utf8'),catalogContext);
const sample=()=>({storage_mode:'sqlite',attachments:{active:{files:2,bytes:1024},trashed:{files:3,bytes:2048},total:{files:5,bytes:3072},limits:{files:10,bytes:4096},remaining:{files:5,bytes:1024},over_limit:false},cache:{database_bytes:1048576,wal_bytes:0,shm_bytes:null,freelist_bytes:4096,filesystem_available_bytes:null,minimum_free_bytes:0,maximum_database_bytes:0,capacity_ok:true,measurement_available:false},history:{activity_rows:12,comments_rows:3,review_events_rows:4,sprint_events_rows:5,intake_events_rows:6,idempotency_rows:7,idempotency_request_bytes:256,idempotency_response_bytes:512},limitations:['logical_attachment_payload_only','external_physical_sizes_not_measured','mongodb_orphans_not_measured']});
function runtime(locale='it') {
 const nodes=new Map(),listeners=new Map(),requests=[],events=[];
 const session=(id=1,role='admin')=>({enabled:true,user:{id,role,name:'Alex',username:'alex'},csrf:'csrf-'+id});
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',value:'',open:false,disabled:false,attributes:{},dataset:{},setAttribute(name,value){this.attributes[name]=String(value);},getAttribute(name){return this.attributes[name]??null;},hasAttribute(name){return Object.hasOwn(this.attributes,name);},closest(){return this;},focus(){context.document.activeElement=this;},close(){this.open=false;}});return nodes.get(id);};
 const i18n=create({locale,catalog:catalogContext.OpenBoardLocales});
 const context={state:{auth:session(),authGeneration:0,panelSequence:0,loadSequence:0,cardSequence:0,board:{id:7},boards:[],selectedCards:new Map()},productivity,Intl,Number,Map,Set,Date,JSON,AbortController,setTimeout,clearTimeout,escapeHTML,$:node,uuid:()=> 'disposable-test-key',
  tr:i18n.t,ui:i18n.html,OpenBoardI18n:i18n,formatDate:()=> '12:34',roleLabel:role=>role,stored:()=>'',
  document:{activeElement:null,addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);}},
  openDialog:id=>{node(id).open=true;},closeDialog:id=>{node(id).open=false;},closeEditors:()=>true,hydrateIcons(){},updateBusy(){},saveReplyDraft(){},saveDraft(){},clearFilters(){},renderSidebar(){},renderHeader(){},renderBoard(){},showAuth(){events.push('auth');},
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,reject,resolve:(value,status=200)=>resolve({ok:status<400,status,json:async()=>value})}))
 };
 vm.createContext(context);vm.runInContext(take('class APIError','function toast('),context);
 vm.runInContext(take('function panel(','function showAuth('),context);
 vm.runInContext(take('/* Administrator-only capacity measurements.'),context);
 vm.runInContext(take('function showAccount()','async function showUsers()'),context);
 return {context,node,nodes,requests,events,session,call:code=>vm.runInContext(code,context),emit:(type,event)=>{for(const handler of listeners.get(type)||[])handler(event);}};
}
const tick=()=>new Promise(setImmediate);
(async()=>{
 const roles=runtime();roles.call('showAccount()');assert(roles.node('panel-body').innerHTML.includes('data-show-storage'));
 for(const role of ['member','observer']){roles.context.state.auth=roles.session(1,role);roles.call('showAccount()');assert(!roles.node('panel-body').innerHTML.includes('data-show-storage'));await roles.call('showStorageCapacity()');assert.equal(roles.requests.length,0);}
 roles.context.state.auth={enabled:true,user:null};assert.equal(roles.call('canInspectStorage()'),false);
 roles.context.state.auth=null;assert.equal(roles.call('canInspectStorage()'),false);
 roles.context.state.auth={enabled:false,user:null};roles.call('showAccount()');assert(roles.node('panel-body').innerHTML.includes('data-show-storage'));assert.equal(roles.call('canInspectStorage()'),true);
 const interaction=runtime(),button=interaction.node('open-capacity');button.setAttribute('data-show-storage','');interaction.emit('click',{target:button});assert.equal(interaction.requests.length,1);assert.equal(interaction.requests[0].url,'/api/admin/storage');assert.equal(interaction.requests[0].options.method,'GET');
 assert.equal(interaction.node('storage-refresh').disabled,true);interaction.requests[0].resolve(sample());await tick();assert.equal(interaction.node('storage-refresh').disabled,false);assert(interaction.node('storage-status').textContent.includes('12:34'));assert.equal(interaction.node('storage-content').getAttribute('aria-busy'),'false');
 const html=interaction.node('storage-content').innerHTML;assert(html.includes('scope="row"'));assert(html.includes('Allegati conservati'));assert(html.includes('Nel cestino o con antenati eliminati'));assert(html.includes('Non disponibile'));assert(html.includes('Illimitato'));assert(html.includes('title="0 '));assert(!html.includes('NaN'));assert(!html.includes('undefined'));assert(!html.includes('MongoDB orfani'));
 interaction.node('storage-refresh').focus();interaction.emit('click',{target:interaction.node('storage-refresh')});assert.equal(interaction.requests.length,2);interaction.requests[1].resolve(sample());await tick();assert.equal(interaction.context.document.activeElement,interaction.node('storage-refresh'),'Refresh retains the existing focused control');
 const zero=sample();zero.attachments={active:{files:0,bytes:0},trashed:{files:0,bytes:0},total:{files:0,bytes:0},limits:{files:0,bytes:0},remaining:{files:null,bytes:null},over_limit:false};
 interaction.context.payload=zero;const unlimited=interaction.call('renderStorageCapacity(payload)');assert.equal((unlimited.match(/Illimitato/g)||[]).length,5,'Two attachment limits, two remaining values and database maximum are unlimited');
 const exhausted=sample();exhausted.attachments.remaining={files:0,bytes:0};interaction.context.payload=exhausted;const exhaustedRow=interaction.call('renderStorageCapacity(payload)').match(/<tr><th scope="row">Residuo della quota<\/th>([\s\S]*?)<\/tr>/)[1];assert(exhaustedRow.includes('<td>0</td>'));assert(exhaustedRow.includes('title="0 '));assert(!exhaustedRow.includes('Illimitato'));assert(!exhaustedRow.includes('Non disponibile'));
 exhausted.attachments.remaining={files:null,bytes:null};const unavailableRow=interaction.call('renderStorageCapacity(payload)').match(/<tr><th scope="row">Residuo della quota<\/th>([\s\S]*?)<\/tr>/)[1];assert(unavailableRow.includes('Non disponibile'));assert(!unavailableRow.includes('Illimitato'));
 const external=sample();external.storage_mode='postgresql+mongodb';external.attachments.over_limit=true;external.cache.capacity_ok=false;external.cache.measurement_available=true;
 interaction.context.payload=external;const externalHTML=interaction.call('renderStorageCapacity(payload)');assert(externalHTML.includes('role="alert"'));assert(externalHTML.includes('MongoDB orfani'));assert(externalHTML.includes('cache SQLite locale'));assert(externalHTML.includes('cronologia, replay, indici, WAL, backup'));
 // Unknown/null measurements must never silently appear as zero or receive
 // raw server HTML; numbers use the selected locale and exact byte titles.
 interaction.context.payload={storage_mode:'<img src=x onerror=attack()>',attachments:{active:{files:-1,bytes:'<script>'}},cache:{},history:{},limitations:['<img>']};
 const malformed=interaction.call('renderStorageCapacity(payload)');assert(malformed.includes('Non disponibile'));assert(!malformed.includes('<img'));assert(!malformed.includes('<script>'));assert(!malformed.includes('NaN'));
 for(const language of languages){const translated=runtime(language.code);translated.context.payload=sample();const rendered=translated.call('renderStorageCapacity(payload)');assert(rendered.length>500);assert(!rendered.includes('undefined'));assert.equal(translated.call('storageCount(12345)'),new Intl.NumberFormat(language.code).format(12345));assert.equal(translated.call('storageBytes(0)'),new Intl.NumberFormat(language.code,{style:'unit',unit:'byte',unitDisplay:'short',maximumFractionDigits:0}).format(0));assert.equal(translated.call('storageBytes(1536)'),new Intl.NumberFormat(language.code,{maximumFractionDigits:2}).format(1.5)+' '+translated.context.tr('KiB'));}
 // A newer explicit refresh wins over an older success or failure.
 const races=runtime(),first=races.call('showStorageCapacity()'),second=races.call('refreshStorageCapacity()');races.requests[1].resolve({...sample(),storage_mode:'postgresql+mongodb'});await second;const newest=races.node('storage-content').innerHTML;races.requests[0].resolve(sample());await first;assert.equal(races.node('storage-content').innerHTML,newest);
 const failed=races.call('refreshStorageCapacity()'),succeeded=races.call('refreshStorageCapacity()');races.requests[3].resolve(sample());await succeeded;races.requests[2].reject(new Error('STALE_ERROR'));await failed;assert(!races.node('storage-error').textContent.includes('STALE_ERROR'));
 // Leaving, closing or reopening the panel invalidates the outstanding result.
 const away=races.call('refreshStorageCapacity()');races.call('panel("Other","OTHER_PANEL","other")');races.requests[4].resolve(external);await away;assert.equal(races.node('panel-body').innerHTML,'OTHER_PANEL');
 const reopenedOld=races.call('showStorageCapacity()'),reopenedNew=races.call('showStorageCapacity()');races.requests[6].resolve(sample());await reopenedNew;const reopenedBody=races.node('storage-content').innerHTML;races.requests[5].resolve(external);await reopenedOld;assert.equal(races.node('storage-content').innerHTML,reopenedBody);
 const closed=races.call('refreshStorageCapacity()');races.node('panel-dialog').open=false;races.requests[7].reject(new Error('CLOSED_PANEL_ERROR'));await closed;assert(!races.node('storage-error').textContent.includes('CLOSED_PANEL_ERROR'));
 // The actual API/session guard also prevents the old administrator's data
 // reaching a different account, including a late 401 that could reopen auth.
 const switched=runtime(),oldAccount=switched.call('showStorageCapacity()');switched.call('setSession({enabled:true,user:{id:2,role:"admin"},csrf:"second"})');switched.call('panel("Other","SECOND_ACCOUNT","other")');switched.requests[0].resolve({error:'PRIVATE_OLD_ACCOUNT'},401);await oldAccount;assert.equal(switched.node('panel-body').innerHTML,'SECOND_ACCOUNT');assert(!switched.events.includes('auth'));assert(!switched.node('storage-error').textContent.includes('PRIVATE_OLD_ACCOUNT'));
 const downgraded=runtime(),denied=downgraded.call('showStorageCapacity()');downgraded.context.state.auth.user.role='member';downgraded.requests[0].resolve(external);await denied;assert.equal(downgraded.node('storage-content').innerHTML,'');
 const revoked=runtime(),loaded=revoked.call('showStorageCapacity()');revoked.requests[0].resolve(sample());await loaded;assert(revoked.node('storage-content').innerHTML);
 const afterRevocation=revoked.call('refreshStorageCapacity()');revoked.call('setSession({enabled:true,user:{id:1,role:"member"},csrf:"csrf-1"})');assert.equal(revoked.node('panel-dialog').open,false);assert.equal(revoked.node('panel-body').innerHTML,'');assert.equal(revoked.context.state.panel,null);
 revoked.requests[1].resolve(external);await afterRevocation;assert.equal(revoked.node('panel-body').innerHTML,'');assert.equal(revoked.node('panel-dialog').open,false);
 // A current server-side ACL denial removes old measurements, while a
 // temporary failure remains visible and allows another explicit refresh.
 const temporary=runtime(),beforeFailure=temporary.call('showStorageCapacity()');temporary.requests[0].resolve(sample());await beforeFailure;const previousMeasurement=temporary.node('storage-content').innerHTML;
 const failedRefresh=temporary.call('refreshStorageCapacity()');temporary.requests[1].resolve({error:'Temporary failure'},503);await failedRefresh;assert.equal(temporary.node('storage-content').innerHTML,previousMeasurement);assert.equal(temporary.node('storage-status').textContent,'Misure non aggiornate.');assert(temporary.node('storage-error').textContent);assert.equal(temporary.node('storage-refresh').disabled,false);
 const errors=runtime(),initial=errors.call('showStorageCapacity()');errors.requests[0].resolve(sample());await initial;assert(errors.node('storage-content').innerHTML);
 const forbidden=errors.call('refreshStorageCapacity()');errors.requests[1].resolve({error:'Denied'},403);await forbidden;assert.equal(errors.node('storage-content').innerHTML,'');assert(errors.node('storage-error').textContent);assert.equal(errors.node('storage-refresh').disabled,false);
 const unavailable=errors.call('refreshStorageCapacity()');errors.requests[2].reject(new Error('<img error>'));await unavailable;assert.equal(errors.node('storage-error').textContent,'<img error>');assert.equal(errors.node('storage-content').innerHTML,'');assert.equal(errors.node('storage-refresh').disabled,false);
 console.log('Capacity UI: administrator/local access, explicit refresh, logical quotas, null/zero measurements, seven locales, panel/account races, revoked roles and error recovery verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});

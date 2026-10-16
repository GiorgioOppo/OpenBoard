'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {create,normalize,languages}=require('../web/i18n.js');
const sources={
  'Cestino':['Trash','Corbeille','Papelera','Papierkorb','回收站','ゴミ箱'],
  'Apri {0}':['Open {0}','Ouvrir {0}','Abrir {0}','{0} öffnen','打开{0}','{0}を開く'],
  'Sposta {0} in {1}':['Move {0} to {1}','Déplacer {0} vers {1}','Mover {0} a {1}','Nach {1}: {0}','将{0}移动到{1}','{0}を{1}に移動'],
  'HTML':['<script>bad()</script>','" onfocus="bad()','texto','Text','文本','テキスト']
};
assert.equal(normalize('zh-Hans-CN'),'zh-CN');assert.equal(normalize('EN_us'),'en');assert.equal(normalize('ja-JP'),'ja');assert.equal(normalize('__proto__'),null);assert.equal(normalize('xx'),null);
assert.equal(create({preferences:['xx','fr-CA','en-US']}).locale,'fr');assert.equal(create({preferences:['xx']}).locale,'en');assert.equal(create({locale:'de',preferences:['fr']}).locale,'de');
assert.equal(languages.length,7);
for(const language of languages) {
 const i=create({catalog:sources,locale:language.code});
 const value=i.t('Cestino');assert(value.length>0);
 assert.equal(i.t(' Cestino '),' '+value+' ');
 assert.equal(i.t('   '),'   ');
 const user='Cestino';const html=i.html`<button data-kind="cards" value="Cestino" title="Apri ${user}">Cestino</button><span>${user}</span>`;
 assert(html.includes('data-kind="cards"'));assert(html.includes('value="Cestino"'));assert(html.includes('<span>Cestino</span>'));assert(html.includes('>'+value+'</button>'));
 const phrase=i.t`Sposta ${'Board'} in ${'List'}`;assert(phrase.includes('Board'));assert(phrase.includes('List'));assert(!phrase.includes('{0}'));
 assert(!i.html`<p>HTML</p>`.includes('<script>'));assert(!i.html`<input title="HTML">`.includes('title="" onfocus='));
 assert(i.date(new Date('2026-10-16T12:00:00Z'),{year:'numeric',month:'long',day:'numeric'}).length>0);
 assert(i.number(1234.5).length>0);
}
assert.equal(create({catalog:sources,locale:'de'}).t`Sposta ${'Board'} in ${'List'}`,'Nach List: Board');
assert.equal(create({catalog:{Cestino:['Trash']},locale:'ja'}).t('Cestino'),'Trash');
assert.equal(create({locale:'ja'}).isoDate('2026-02-30'),'2026-02-30');
assert.equal(create({locale:'en'}).isoDate(''),'');
assert(create({locale:'ja'}).isoDate('2026-10-16').includes('年'));
function browserRuntime({stored=null,blocked=false,search='',preferences=['en-US']}={}) {
 const listeners={},selectors=[0,1].map(()=>({value:'',attributes:{},setAttribute(key,value){this.attributes[key]=value;},addEventListener(name,callback){this[name]=callback;}}));
 const status={textContent:''},markup={innerHTML:'<p>Cestino</p>',hasAttribute(){return false;}},storage=new Map(stored ? [['openboard.language',stored]]:[]);
 const context={URL,URLSearchParams,Intl,OpenBoardLocales:sources,navigator:{languages:preferences},state:{saving:false},openEditor:false,reloads:0,
  localStorage:{getItem:key=>storage.get(key)||null,setItem(key,value){if(blocked)throw new Error('blocked');storage.set(key,value);}},
  location:{search,href:'http://local.test/'+search+'#board/7',reload(){context.reloads++;},assign(value){context.assigned=value;}},
  CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;this.defaultPrevented=false;}preventDefault(){this.defaultPrevented=true;}},
  document:{readyState:'interactive',documentElement:{},querySelector(){return context.openEditor ? {}:null;},querySelectorAll(selector){return selector==='[data-i18n-static]' ? [markup]:selector==='[data-language-selector]' ? selectors:[status];},addEventListener(name,callback){listeners[name]=callback;},dispatchEvent(event){listeners[event.type]?.(event);return !event.defaultPrevented;}}
 };
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/i18n.js'),'utf8'),context);
 const guard=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').match(/document\.addEventListener\('openboard:languagechange',[\s\S]*?\n\}\);/)[0];
 vm.runInContext(guard,context);
 return {context,selectors,status,storage,markup,change(value){selectors[0].value=value;selectors[0].change();}};
}
const regular=browserRuntime();assert.equal(regular.markup.innerHTML,'<p>Trash</p>');regular.change('fr');assert.equal(regular.storage.get('openboard.language'),'fr');assert.equal(regular.context.reloads,1);
const guarded=browserRuntime();guarded.context.openEditor=true;guarded.change('fr');assert.equal(guarded.context.reloads,0);assert.equal(guarded.selectors[0].value,'en');assert(guarded.status.textContent.length>0);guarded.context.openEditor=false;guarded.context.state.saving=true;guarded.change('de');assert.equal(guarded.context.reloads,0);
const unavailable=browserRuntime({blocked:true,search:'?source=test'});unavailable.change('ja');assert.equal(new URL(unavailable.context.assigned).searchParams.get('lang'),'ja');assert.equal(new URL(unavailable.context.assigned).hash,'#board/7');assert.equal(new URL(unavailable.context.assigned).searchParams.get('source'),'test');
const explicit=browserRuntime({stored:'de',search:'?lang=fr&source=test'});assert.equal(explicit.context.OpenBoardI18n.locale,'fr');explicit.change('en');assert(!new URL(explicit.context.assigned).searchParams.has('lang'));assert.equal(new URL(explicit.context.assigned).searchParams.get('source'),'test');
const catalogContext={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/locales.js'),'utf8'),catalogContext);
const catalog=catalogContext.OpenBoardLocales;
assert(Object.keys(catalog).length>500);
for(const [source,translations] of Object.entries(catalog)) {
 assert.equal(translations.length,6,source);
 const placeholders=(source.match(/\{\w+\}/g)||[]).sort();
 for(const translated of translations){assert.equal(typeof translated,'string',source);assert(translated.trim(),source);assert.deepEqual((translated.match(/\{\w+\}/g)||[]).sort(),placeholders,source);}
}
for(const locale of ['en','fr','es','de','zh-CN','ja','it']) {
 const i=create({catalog,locale});
 for(const label of ['Accedi','Aggiungi scheda','Titolo della richiesta','Crea Sprint','Richieste','Lingua'])assert(i.t(label).trim());
 for(const status of [400,401,403,404,409,412,413,429,503])assert(!i.error('<script>untrusted server error</script>',status).includes('<script>'));
}
const english=create({catalog,locale:'en'}),german=create({catalog,locale:'de'});
assert.equal(english.count('{count} scheda','{count} schede',1),'1 card');
assert.equal(english.count('{count} scheda','{count} schede',2),'2 cards');
assert(english.count('{count} scheda','{count} schede',1000).includes('1,000'));
assert(german.count('{count} scheda','{count} schede',1000).includes('1.000'));
console.log(`Internationalization: ${Object.keys(catalog).length} messages, seven locales, safe HTML, placeholders and locale formats verified.`);

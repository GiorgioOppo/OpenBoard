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
// Browser initialization and live switching run against DOM nodes and actual
// app handlers in test_live_language.js.
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

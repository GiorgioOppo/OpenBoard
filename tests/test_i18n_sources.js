'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync,spawnSync}=require('node:child_process');
const {extractJavaScript,extractHTML,extractCErrorSources,extractFile,extractSources}=require('../scripts/extract-i18n.cjs');
const root=path.resolve(__dirname,'..');
const same=(actual,expected)=>assert.deepEqual(actual,[...new Set(expected)].sort());

// Calls, escaped strings and nested templates are inspected without evaluating
// interpolation expressions or accidentally treating stored text as UI copy.
const fixture=[
  "tr('Prima'); tr /* comment */ (\"Seconda\");",
  "tr('L\\'apostrofo'); tr(\"Una \\\"citazione\\\"\");",
  "tr('\\u0043aff\\u00e8\\x21'); tr('\\u{1F44D}');",
  "tr('A\\\nB'); tr`Un\\`apice`; tr`Prezzo \\${valore}`;",
  "tr('Con parametri', {name:'not a source'}); tr('not static' + variable);",
  "api.t('Metodo t'); api.translate('Metodo translate'); api.error('Metodo error');",
  "api.other('IGNORE_METHOD'); api.tr('IGNORE_MEMBER'); api['t']('IGNORE_COMPUTED');",
  "const text=\"tr('IGNORE_STRING') ui`<b>IGNORE_HTML</b>`\";",
  "// tr('IGNORE_COMMENT') ui`<b>IGNORE_COMMENT_HTML</b>`",
  "/* tr('IGNORE_BLOCK') */ tr('Dopo commento');",
  "const plain=`tr('IGNORE_QUASI') ${tr('Dentro espressione')}`;",
  'ui`<section title="Apri ${name}"><h2>Panoramica</h2>${ui`<span>Dentro ${tr`Nido ${value}`}</span>`}</section>`;',
  "tr`Valore ${ {a:1,b:`x${tr('Chiamata annidata')}`}.a } ${ /}/.test(text) ? tr('Ramo') : '' }`;",
  "tr`Commento ${ /* } tr('IGNORE_INTERPOLATION_COMMENT') */ tr('Commento interno') }`;",
  "const pattern=/tr\\('IGNORE_REGEX'\\)|ui`<p>IGNORE_REGEX_HTML<\\/p>`/gi;",
  "const characters=/[/\\]\\\"']/g; tr('Dopo classe regex');",
  "if (test(foo())) /tr('IGNORE_CONTROL_REGEX')/.test(text);",
  "function f() {} /tr('IGNORE_FUNCTION_REGEX')/.test(text);",
  "class Example {} /tr('IGNORE_CLASS_REGEX')/.test(text);",
  "const fn=function() {} / tr('Divisione funzione');",
  "const arrow=()=>{} / tr('Divisione freccia');",
  "const amount=1 / tr('Divisione'); const ratio=n / /tr('IGNORE_SECOND_REGEX')/.test(text);",
  "const increment=n++ / tr('Divisione incremento');",
  "tr`Regex ${ /\\}/.test(text) ? tr('Vera') : tr('Falsa') }`;"
].join('\n');
same(extractJavaScript(fixture),[
  'Prima','Seconda',"L'apostrofo",'Una "citazione"','Caffè!','👍','AB','Un`apice','Prezzo ${valore}',
  'Con parametri','Metodo t','Metodo translate','Metodo error','Dopo commento','Dentro espressione',
  'Apri {0}','Panoramica','Dentro {0}','Nido {0}','Valore {0} {1}','Chiamata annidata','Ramo',
  'Commento {0}','Commento interno','Dopo classe regex','Divisione funzione','Divisione freccia',
  'Divisione','Divisione incremento','Regex {0}','Vera','Falsa'
]);
same(extractJavaScript([
  "OpenBoardI18n.count('{count} scheda', /* plural */ '{count} schede', value, {nested:tr('Parametro annidato'),data:{count:2}});",
  "OpenBoardI18n . count ('{count} lista', '{count} liste', compute(1,2));",
  "OpenBoardI18n?.count('{count} elemento', '{count} elementi', 0);",
  "array.count('IGNORE_ARRAY_SINGLE','IGNORE_ARRAY_PLURAL',2);",
  "other.OpenBoardI18n.count('IGNORE_NESTED_SINGLE','IGNORE_NESTED_PLURAL',2);",
  "count('IGNORE_GLOBAL_SINGLE','IGNORE_GLOBAL_PLURAL',2);",
  "const text=\"OpenBoardI18n.count('IGNORE_STRING_SINGLE','IGNORE_STRING_PLURAL',2)\";"
].join('\n')),['{count} scheda','{count} schede','{count} lista','{count} liste','{count} elemento','{count} elementi','Parametro annidato']);
for(const malformed of ['tr("unfinished)', 'ui`unfinished', 'tr`unfinished ${ 1', '/* unfinished', 'const x=/unfinished']) {
  assert.throws(()=>extractJavaScript(malformed),SyntaxError,malformed);
}

const html='<button title="Apri &#39;scheda&#39;" aria-label="Apri scheda">  Cestino  </button><input placeholder="Cerca…" value="DO_NOT_TRANSLATE"><span>\uE0000\uE001</span>';
same(extractHTML(html),["Apri 'scheda'",'Apri scheda','Cestino','Cerca…']);
const cFixture=[
  'error_response(404, "Scheda " /* adjacent C literals */ "non trovata.");',
  'error_response(flag ? 400 : 503, flag ? "Prima." : "Seconda.");',
  'auth_error(status, "Caff\\xc3\\xa8, \\"note\\".");',
  'error_response(nested(a,b), "Messaggio annidato.");',
  'error_response(400, "("); error_response(400, ","); error_response(400, ")");',
  'const char *text="error_response(400, \\"IGNORE_C_STRING\\")";',
  '// error_response(400, "IGNORE_C_COMMENT");',
  '/* auth_error(400, "IGNORE_C_BLOCK"); */',
  "const char quote='\\\"'; auth_error(400, \"Dopo carattere.\");",
  'error_response(400, "Riga\\nseconda"); auth_error(400, "\\u65e5\\u672c");',
  'error_response(400, message); other_function(400,"IGNORE_C_FUNCTION");'
].join('\n');
same(extractCErrorSources(cFixture),['Scheda non trovata.','Prima.','Seconda.','Caffè, "note".','Messaggio annidato.','(',',',')','Dopo carattere.','Riga seconda','日本']);

// The real catalogue is a committed generated asset; coverage checks operate
// on repository sources and built-ins only, so CI needs neither npm nor Babel.
const catalogContext={};
vm.runInNewContext(fs.readFileSync(path.join(root,'web/locales.js'),'utf8'),catalogContext);
const catalog=catalogContext.OpenBoardLocales;
assert(catalog && typeof catalog==='object','Generated locale bundle is missing');
const web=path.join(root,'web'),src=path.join(root,'src');
const webFiles=fs.readdirSync(web).filter(name=>name.endsWith('.js') || name==='index.html').map(name=>path.join(web,name));
const cFiles=fs.readdirSync(src).filter(name=>name.endsWith('.c')).map(name=>path.join(src,name));
const uiSources=extractSources(webFiles),errorSources=extractSources(cFiles);
assert(uiSources.length>=1000,`Unexpectedly few UI sources: ${uiSources.length}`);
assert(errorSources.length>=316,`Unexpectedly few C error sources: ${errorSources.length}`);
const missingUI=uiSources.filter(source=>!Object.hasOwn(catalog,source));
const missingErrors=errorSources.filter(source=>!Object.hasOwn(catalog,source));
assert.deepEqual(missingUI,[],`Untranslated UI sources: ${JSON.stringify(missingUI)}`);
assert.deepEqual(missingErrors,[],`Untranslated API errors: ${JSON.stringify(missingErrors)}`);

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openboard-i18n-source-'));
try {
  const jsFile=path.join(directory,'fixture space 日本.js'),htmlFile=path.join(directory,'fixture.html'),cFile=path.join(directory,'fixture.c');
  fs.writeFileSync(jsFile,"tr('Prima'); ui`<b>Cestino</b>`;");fs.writeFileSync(htmlFile,'<p>Seconda</p>');fs.writeFileSync(cFile,'auth_error(400,"Errore.");');
  same(extractFile(jsFile),['Prima','Cestino']);same(extractFile(htmlFile),['Seconda']);same(extractFile(cFile),['Errore.']);
  const expected=['Cestino','Errore.','Prima','Seconda'];same(extractSources([jsFile,htmlFile,cFile,jsFile]),expected);
  const script=path.join(root,'scripts/extract-i18n.cjs');
  const output=execFileSync(process.execPath,[script,jsFile,htmlFile,cFile],{encoding:'utf8'});
  same(JSON.parse(output),expected);
  assert.equal(output,execFileSync(process.execPath,[script,cFile,htmlFile,jsFile],{encoding:'utf8'}),'CLI output must be deterministic');
  assert(execFileSync(process.execPath,[script,'--help'],{encoding:'utf8'}).startsWith('Usage:'));
  const failure=spawnSync(process.execPath,[script,path.join(directory,'missing.js')],{encoding:'utf8'});
  assert.equal(failure.status,1);assert(failure.stderr.startsWith('i18n extraction failed:'));
} finally {fs.rmSync(directory,{recursive:true,force:true});}
console.log(`i18n sources: lexer fixtures, ${uiSources.length} UI sources and ${errorSources.length} API errors covered without dependencies.`);

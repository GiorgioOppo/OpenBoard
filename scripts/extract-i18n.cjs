#!/usr/bin/env node
'use strict';

/* Dependency-free source coverage for the buildless UI. This is a lexer, not a
 * JavaScript evaluator: it follows nested template expressions and skips quoted
 * strings, comments and regular expressions without executing application code.
 * It recognizes global tr(), tr`` and ui``, and literal .t/.translate/.error
 * calls, plus the two literal sources of OpenBoardI18n.count(). Dynamic
 * messages deliberately have no extractable static source. */
const fs = require('node:fs');
const path = require('node:path');
const {create,keyOf} = require('../web/i18n.js');
const engine = create({locale:'it'});
const identifierStart = (char) => !!char && /[A-Za-z_$]/.test(char);
const identifierPart = (char) => !!char && /[A-Za-z0-9_$]/.test(char);
const regexKeywords = new Set(['return','throw','case','delete','void','typeof','instanceof','in','of','yield','await','else','do','new']);
const controlKeywords = new Set(['if','while','for','with','switch','catch']);

function skipTrivia(source,start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index++; continue; }
    if (source.startsWith('//',index)) { const end=source.indexOf('\n',index+2); index=end<0 ? source.length:end+1; continue; }
    if (source.startsWith('/*',index)) { const end=source.indexOf('*/',index+2); if(end<0)throw new SyntaxError('Unterminated block comment'); index=end+2; continue; }
    break;
  }
  return index;
}
function escapedCharacter(source,start,cString=false) {
  const char=source[start];
  if (char === undefined) throw new SyntaxError('Unterminated escape sequence');
  if (char==='\n') return {value:'',end:start+1};
  if (char==='\r') return {value:'',end:start+(source[start+1]==='\n' ? 2:1)};
  const simple={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',a:'\x07'};
  if (Object.hasOwn(simple,char) && (cString || char!=='a')) return {value:simple[char],end:start+1};
  if (char==='x' || char==='u' || cString && char==='U') {
    let digits,end;
    if(char==='u' && !cString && source[start+1]==='{') {
      end=source.indexOf('}',start+2); if(end<0)throw new SyntaxError('Unterminated Unicode escape');
      digits=source.slice(start+2,end); end++;
    } else if(char==='x' && cString) {
      digits=source.slice(start+1).match(/^[\da-f]+/i)?.[0] || '';end=start+1+digits.length;
    } else {
      const length=char==='x' ? 2:char==='U' ? 8:4;
      digits=source.slice(start+1,start+1+length);end=start+1+length;
      if(digits.length!==length)throw new SyntaxError('Incomplete character escape');
    }
    if(!/^[\da-f]+$/i.test(digits))throw new SyntaxError('Invalid character escape');
    const number=parseInt(digits,16);if(number>0x10ffff)throw new SyntaxError('Unicode escape out of range');
    return {value:String.fromCodePoint(number),end,...(cString && char==='x' ? {byte:number & 255}:{})};
  }
  if(/[0-7]/.test(char)) {
    const digits=source.slice(start).match(/^[0-7]{1,3}/)[0];
    const number=parseInt(digits,8);return {value:String.fromCharCode(number),end:start+digits.length,...(cString ? {byte:number & 255}:{})};
  }
  return {value:char,end:start+1};
}
function quotedString(source,start,cString=false) {
  const quote=source[start];let index=start+1,value='';const bytes=[];
  while(index<source.length) {
    const char=source[index++];
    if(char===quote)return {value:bytes.length ? Buffer.concat([...bytes,Buffer.from(value)]).toString('utf8'):value,end:index};
    if(char==='\\') {const escape=escapedCharacter(source,index,cString);if(escape.byte!==undefined){bytes.push(Buffer.from(value),Buffer.from([escape.byte]));value='';}else value+=escape.value;index=escape.end;}
    else value+=char;
  }
  throw new SyntaxError('Unterminated quoted string');
}
function regularExpression(source,start) {
  let index=start+1,inClass=false;
  while(index<source.length) {
    const char=source[index++];
    if(char==='\\') {index++;continue;}
    if(char==='[')inClass=true;
    else if(char===']')inClass=false;
    else if(char==='/' && !inClass) {while(identifierPart(source[index]))index++;return index;}
    else if(char==='\n' || char==='\r')throw new SyntaxError('Unterminated regular expression');
  }
  throw new SyntaxError('Unterminated regular expression');
}
function extractJavaScript(source) {
  const sources=new Set();
  const add=(value)=>{const key=keyOf(value);if(key)sources.add(key);};
  function literalCall(start,argumentsToRead=1) {
    let index=skipTrivia(source,start);
    if(source[index]!=='(')return;
    for(let argument=0;argument<argumentsToRead;argument++) {
      index=skipTrivia(source,index+1);
      if(!['"',"'"].includes(source[index]))return;
      const literal=quotedString(source,index),after=skipTrivia(source,literal.end);
      // A concatenation or other expression is not a static source argument.
      if(source[after]!==')' && source[after]!==',')return;
      add(literal.value);
      if(source[after]===')')return;
      index=after;
    }
  }
  function template(start,tag) {
    let index=start+1,part='',parts=[],count=0;
    while(index<source.length) {
      const char=source[index++];
      if(char==='\\') {const escape=escapedCharacter(source,index);part+=escape.value;index=escape.end;continue;}
      if(char==='`') {
        parts.push(part);
        if(tag==='tr')add(parts.map((text,i)=>text+(i<count ? `{${i}}`:'')).join(''));
        if(tag==='ui')for(const text of engine.extractHTML(parts.map((text,i)=>text+(i<count ? `\uE000${i}\uE001`:'')).join('')))add(text);
        return index;
      }
      if(char==='$' && source[index]==='{') {
        parts.push(part);part='';count++;index=scan(index+1,true);continue;
      }
      // JavaScript normalizes literal CR and CRLF inside template strings.
      if(char==='\r') {part+='\n';if(source[index]==='\n')index++;}
      else part+=char;
    }
    throw new SyntaxError('Unterminated template literal');
  }
  function scan(start,interpolation=false) {
    let index=start,canRegex=true,last=null,pendingFunction=null,pendingClass=null;
    const parentheses=[],braces=[];
    while(index<source.length) {
      index=skipTrivia(source,index);if(index>=source.length)break;
      const char=source[index];
      if(char==='}' && interpolation && !braces.length)return index+1;
      if(char==='"' || char==="'") {const literal=quotedString(source,index);index=literal.end;last={type:'literal'};canRegex=false;continue;}
      if(char==='`') {index=template(index,last?.type==='identifier' && !last.member ? last.value:null);last={type:'template'};canRegex=false;continue;}
      if(char==='/' && canRegex) {index=regularExpression(source,index);last={type:'regex'};canRegex=false;continue;}
      if(identifierStart(char)) {
        const begin=index++;while(identifierPart(source[index]))index++;
        const value=source.slice(begin,index),member=last?.value==='.' || last?.value==='?.';
        if(value==='tr' && !member || member && ['t','translate','error'].includes(value))literalCall(index);
        if(value==='count' && member && last.owner==='OpenBoardI18n')literalCall(index,2);
        if(value==='function' && !member)pendingFunction={declaration:!last || [';','}','export','default','async'].includes(last.value)};
        if(value==='class' && !member)pendingClass={declaration:!last || [';','}','export','default'].includes(last.value)};
        last={type:'identifier',value,member};canRegex=regexKeywords.has(value);continue;
      }
      if(/\d/.test(char) || char==='.' && /\d/.test(source[index+1] || '')) {
        const number=source.slice(index).match(/^(?:0[xob][\da-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?[\d_]+)?n?)/i);
        index+=number?.[0].length || 1;last={type:'number'};canRegex=false;continue;
      }
      const operator=['===','!==','>>>','**=','=>','?.','++','--','==','!=','<=','>=','&&','||','??','+=','-=','*=','/=','%=','**','<<','>>'].find(value=>source.startsWith(value,index)) || char;
      index+=operator.length;
      let functionBody=null;
      if(operator==='(') {parentheses.push({control:last?.type==='identifier' && controlKeywords.has(last.value),fn:pendingFunction});pendingFunction=null;canRegex=true;}
      else if(operator===')') {const frame=parentheses.pop();canRegex=!!frame?.control;functionBody=frame?.fn;}
      else if(operator==='{') {
        // An object follows an expression-opening operator; a statement block
        // follows a control parenthesis, arrow, keyword or another statement.
        const block=!last || last.value==='=>' || last.value===')' && canRegex || last.value===';' || last.value==='}' || last.type==='identifier' && ['else','try','finally','do'].includes(last.value);
        braces.push(last?.functionBody ? last.functionBody.declaration:pendingClass ? pendingClass.declaration:last?.value==='=>' ? false:block);pendingClass=null;canRegex=true;
      } else if(operator==='}')canRegex=braces.pop() ?? true;
      else if(operator===']' || operator==='++' || operator==='--' || operator==='.' || operator==='?.')canRegex=false;
      else canRegex=true;
      const owner=['.','?.'].includes(operator) && last?.type==='identifier' && !last.member ? last.value:null;
      last={type:'operator',value:operator,...(owner ? {owner}:{}),...(functionBody ? {functionBody}:{})};
    }
    if(interpolation)throw new SyntaxError('Unterminated template expression');
    return index;
  }
  scan(0);return [...sources].sort();
}
function extractHTML(source) {return engine.extractHTML(source).sort();}
function cTokens(source) {
  const tokens=[];let index=0;
  while(index<source.length) {
    index=skipTrivia(source,index);if(index>=source.length)break;
    const char=source[index];
    if(char==='"' || char==="'") {const literal=quotedString(source,index,true);tokens.push({kind:char==='"' ? 'string':'character',value:literal.value});index=literal.end;continue;}
    if(identifierStart(char)) {const begin=index++;while(identifierPart(source[index]))index++;tokens.push({kind:'identifier',value:source.slice(begin,index)});continue;}
    tokens.push({kind:'punctuation',value:char});index++;
  }
  return tokens;
}
function extractCErrorSources(source) {
  const tokens=cTokens(source),sources=new Set();
  for(let index=0;index<tokens.length-1;index++) {
    if(tokens[index].kind!=='identifier' || !['error_response','auth_error'].includes(tokens[index].value) || tokens[index+1].value!=='(')continue;
    let depth=1,argument=0;
    for(let cursor=index+2;cursor<tokens.length && depth;cursor++) {
      const token=tokens[cursor];
      if(token.kind==='punctuation' && token.value==='(')depth++;
      else if(token.kind==='punctuation' && token.value===')')depth--;
      else if(token.kind==='punctuation' && token.value===',' && depth===1)argument++;
      else if(argument===1 && token.kind==='string') {
        let message=token.value;
        while(tokens[cursor+1]?.kind==='string')message+=tokens[++cursor].value;
        const key=keyOf(message);if(key)sources.add(key);
      }
    }
  }
  return [...sources].sort();
}
function extractFile(filename) {
  const source=fs.readFileSync(filename,'utf8');
  if(filename.endsWith('.html'))return extractHTML(source);
  if(filename.endsWith('.c') || filename.endsWith('.h'))return extractCErrorSources(source);
  return extractJavaScript(source);
}
function extractSources(filenames) {return [...new Set(filenames.flatMap(extractFile))].sort();}
module.exports={extractJavaScript,extractHTML,extractCErrorSources,extractFile,extractSources};
if(require.main===module) {
  try {
    let filenames=process.argv.slice(2);
    if(filenames.includes('--help')) {process.stdout.write('Usage: node scripts/extract-i18n.cjs [web/*.js web/index.html src/*.c]\nPrints static translation sources as JSON. Defaults to web JavaScript and index.html.\n');}
    else {
      if(!filenames.length) {const web=path.join(__dirname,'../web');filenames=fs.readdirSync(web).filter(name=>name.endsWith('.js') || name==='index.html').map(name=>path.join(web,name));}
      process.stdout.write(JSON.stringify(extractSources(filenames),null,2)+'\n');
    }
  } catch(error) {process.stderr.write(`i18n extraction failed: ${error.message}\n`);process.exitCode=1;}
}

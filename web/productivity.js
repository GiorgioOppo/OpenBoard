/* Pure formatting helpers shared by the buildless UI and its tests. */
(function (root) {
  'use strict';
  const tr = (source) => (root.OpenBoardI18n?.message || root.OpenBoardI18n?.t)?.(source) || source;
  const locale = () => root.OpenBoardI18n?.locale || 'it';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeURL(value) { try { const url = new URL(String(value)); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
  function inline(text) {
    // Escape every unrecognized character, so HTML and Markdown attributes never become markup.
    const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
    let result = '', cursor = 0, match;
    while ((match = pattern.exec(text))) {
      result += escape(text.slice(cursor, match.index));
      if (match[1] !== undefined) result += `<code>${escape(match[1])}</code>`;
      else if (match[2] !== undefined) { const href = safeURL(match[3]); result += href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer nofollow">${escape(match[2])}</a>` : escape(match[0]); }
      else if (match[4] !== undefined) result += `<strong>${escape(match[4])}</strong>`;
      else result += `<em>${escape(match[5])}</em>`;
      cursor = pattern.lastIndex;
    }
    return result + escape(text.slice(cursor));
  }
  function markdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g,'\n').split('\n');
    let output = '', code = false, codeLines = [], list = false;
    const closeList = () => { if (list) { output += '</ul>'; list = false; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) { closeList(); if (code) { output += `<pre><code>${escape(codeLines.join('\n'))}</code></pre>`; codeLines = []; } code = !code; continue; }
      if (code) { codeLines.push(line); continue; }
      if (/^\s*[-*]\s+/.test(line)) { if (!list) { output += '<ul>'; list = true; } output += `<li>${inline(line.replace(/^\s*[-*]\s+/,''))}</li>`; continue; }
      closeList();
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) output += `<h${heading[1].length+2}>${inline(heading[2])}</h${heading[1].length+2}>`;
      else if (/^>\s?/.test(line)) output += `<blockquote>${inline(line.replace(/^>\s?/,''))}</blockquote>`;
      else if (line.trim()) output += `<p>${inline(line)}</p>`;
    }
    closeList(); if (code) output += `<pre><code>${escape(codeLines.join('\n'))}</code></pre>`;
    return output || (root.ui ? root.ui`<p class="helper-text">Nessuna descrizione.</p>`:`<p class="helper-text">${escape(tr('Nessuna descrizione.'))}</p>`);
  }
  function csvCell(value) { let text = String(value ?? ''); if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'"+text; return '"'+text.replace(/"/g,'""')+'"'; }
  function csv(board) {
    const rows = [['ID',tr('Titolo'),tr('Lista'),tr('Descrizione'),tr('Responsabili'),tr('Etichette'),tr('Priorità'),tr('Inizio'),tr('Scadenza'),tr('Completata'),tr('Archiviata'),tr('Blocco'),tr('Stima minuti'),tr('Minuti effettivi'),tr('Riferimento')]];
    for (const column of board.columns || []) for (const card of column.cards || []) rows.push([card.id,card.title,column.title,card.description,(card.assignees || []).map((u) => u.name).join(', ') || card.assignee,(card.labels || []).join(', '),card.priority,card.start_date,card.due_date,card.completed ? tr('Sì'):tr('No'),card.archived ? tr('Sì'):tr('No'),card.blocked_reason,card.estimate_minutes,card.actual_minutes,card.reference_url]);
    return '\uFEFF'+rows.map((row) => row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  }
  function icsText(value) { return String(value ?? '').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,'); }
  function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false; const date = new Date(value+'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value; }
  function dateText(value) { return root.OpenBoardI18n?.isoDate?.(value) ?? String(value ?? ''); }
  function foldLine(line) { let out = '', part = '', bytes = 0; const encoder = new TextEncoder(); for (const char of line) { const size = encoder.encode(char).length; if (bytes+size > 75) { out += part+'\r\n'; part = ' '; bytes = 1; } part += char; bytes += size; } return out+part; }
  function calendar(board, now = new Date()) {
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//OpenBoard//IT','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:'+icsText(board.name)];
    const stamp = now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    for (const column of board.columns || []) for (const card of column.cards || []) {
      if (!validDate(card.due_date) || card.archived) continue;
      const start = validDate(card.start_date) && card.start_date <= card.due_date ? card.start_date : card.due_date;
      const end = new Date(card.due_date+'T00:00:00Z'); end.setUTCDate(end.getUTCDate()+1);
      lines.push('BEGIN:VEVENT',`UID:board-${Number(board.id)}-card-${Number(card.id)}@openboard`,`DTSTAMP:${stamp}`,`DTSTART;VALUE=DATE:${start.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${end.toISOString().slice(0,10).replace(/-/g,'')}`,'SUMMARY:'+icsText(card.title),'DESCRIPTION:'+icsText(card.description),'STATUS:'+(card.completed ? 'CONFIRMED':'TENTATIVE'),'END:VEVENT');
    }
    lines.push('END:VCALENDAR'); return lines.map(foldLine).join('\r\n')+'\r\n';
  }
  function shouldDiscardDraft(current, owned, ambiguous) { return !!owned && current === owned && !ambiguous; }
  function fieldValue(type, value) {
    if (value === '' || value === null || value === undefined) return null;
    if (type === 'number') { const number = Number(value); if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new (root.OpenBoardI18n?.LocalizedError || Error)(tr('Inserisci un numero finito.')); return number; }
    if (type === 'boolean') { if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; throw new (root.OpenBoardI18n?.LocalizedError || Error)(tr('Scegli Sì o No.')); }
    if (type === 'date' && !validDate(value)) throw new (root.OpenBoardI18n?.LocalizedError || Error)(tr('Inserisci una data valida.'));
    return String(value);
  }
  function fieldText(value) { return value === true ? tr('Sì') : value === false ? tr('No') : value === null || value === undefined ? '—' : String(value); }
  function planningPayload(data, fields, milestones, originalMilestone = '') {
    const keys = new Set((fields || []).filter((field) => !field.deleted_at).map((field) => field.key));
    const result = {...data,custom_values:Object.fromEntries(Object.entries(data.custom_values || {}).filter(([key]) => keys.has(key)))};
    if (result.milestone_key && result.milestone_key === originalMilestone && !(milestones || []).some((item) => !item.deleted_at && item.key === result.milestone_key)) delete result.milestone_key;
    return result;
  }
  function fieldCell(value) { const text=fieldText(value);return root.OpenBoardI18n?.markup ? root.OpenBoardI18n.markup(text):escape(text); }
  function fieldMatches(value, query) { return value !== null && value !== undefined && fieldText(value).toLocaleLowerCase(locale()).includes(String(query).trim().toLocaleLowerCase(locale())); }
  // Exact typed semantics shared with the field-search API. Text matching is
  // case-sensitive. Missing/null values are unset; explicit null equality
  // retains the legacy API behavior.
  function fieldMatchesAdvanced(value, field, condition) {
    if (!field || field.deleted_at || !['text','number','date','boolean','select'].includes(field.type) || !condition || typeof condition !== 'object' || Array.isArray(condition) || Object.keys(condition).some(key => !['key','op','value'].includes(key))) return false;
    const {op, value: target} = condition, supported = ['eq','ne','contains','gt','gte','lt','lte','is_set','is_unset'];
    if (!supported.includes(op)) return false;
    const present = value !== null && value !== undefined, hasTarget = Object.hasOwn(condition,'value');
    if (op === 'is_set' || op === 'is_unset') return !hasTarget && (op === 'is_set' ? present : !present);
    if (!hasTarget || target === undefined) return false;
    const equality = op === 'eq' || op === 'ne';
    const textValid = item => typeof item === 'string' && !item.includes('\0') && [...item].length <= 2000 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item);
    const typed = item => field.type === 'number' ? typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12 : field.type === 'boolean' ? typeof item === 'boolean' : field.type === 'date' ? typeof item === 'string' && validDate(item) && item >= '0001-01-01' : field.type === 'select' ? typeof item === 'string' && Array.isArray(field.options) && field.options.includes(item) : field.type === 'text' && textValid(item);
    if (target === null) return equality && (op === 'eq' ? value === null : present && typed(value));
    if (op === 'contains') return ['text','select'].includes(field.type) && textValid(target) && typeof value === 'string' && value.includes(target);
    if (!typed(target)) return false;
    if (op === 'eq') return present && typed(value) && value === target;
    if (op === 'ne') return present && typed(value) && value !== target;
    if (!['number','date'].includes(field.type) || !present || !typed(value)) return false;
    if (op === 'gt') return value > target;
    if (op === 'gte') return value >= target;
    if (op === 'lt') return value < target;
    return value <= target;
  }
  function worklogCSV(rows) {
    return '\uFEFF'+[['ID',tr('Giorno'),tr('Autore'),tr('Bacheca'),tr('Scheda'),tr('Minuti'),tr('Nota')],...rows.map((row) => [row.id,row.date,row.author,row.board_name,row.card_title,row.minutes,row.note])].map((row) => row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  }
  function catalog(value) {
    const failure = () => { throw new (root.OpenBoardI18n?.LocalizedError || Error)(tr('Catalogo del server non valido.')); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) failure();
    function names(map) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) failure();
      const entries = Object.entries(map);
      if (!entries.length || entries.length > 50 || entries.some(([key,name]) => !/^[a-z][a-z0-9_]{0,39}$/.test(key) || ['constructor','prototype'].includes(key) || typeof name !== 'string' || !name.trim() || name.length > 100)) failure();
      return Object.fromEntries(entries.map(([key,name]) => [key,tr(name)]));
    }
    const labels = names(value.labels), priorities = names(value.priorities);
    if (!Object.hasOwn(priorities,'normal')) failure();
    if (!Array.isArray(value.covers) || !value.covers.includes('') || value.covers.length > 20 || value.covers.some((key) => typeof key !== 'string' || (key && !/^[a-z][a-z0-9_]{0,39}$/.test(key))) || new Set(value.covers).size !== value.covers.length) failure();
    const supported = ['text','number','date','boolean','select'];
    if (!Array.isArray(value.custom_field_types) || value.custom_field_types.length !== supported.length || value.custom_field_types.some((item) => !item || !supported.includes(item.value) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100) || new Set(value.custom_field_types.map((item) => item.value)).size !== supported.length) failure();
    return {labels,priorities,covers:[...value.covers],fieldTypes:Object.fromEntries(value.custom_field_types.map((item) => [item.value,tr(item.label)]))};
  }
  function storageLabel(value) { return value === 'sqlite' ? 'SQLite' : value === 'postgresql+mongodb' ? 'PostgreSQL + MongoDB' : ''; }
  function graphemes(value, language = locale()) {
    const text = String(value ?? '');
    return typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(language,{granularity:'grapheme'}).segment(text)].map(item=>item.segment) : Array.from(text);
  }
  function initials(value, language = locale()) {
    return String(value ?? '').trim().split(/\s+/u).slice(0,2).map(part=>graphemes(part,language)[0] || '').join('').toLocaleUpperCase(language);
  }
  function composing(event) { return !!event?.isComposing || event?.keyCode === 229; }
  function navigateCards(columns, current, key, control = false) {
    const grid = columns.map(items=>items.filter(Boolean)).filter(items=>items.length);
    const x = grid.findIndex(items=>items.includes(current));
    if (x < 0) return null;
    const y = grid[x].indexOf(current);
    if (key==='Home') return control ? grid[0][0] : grid[x][0];
    if (key==='End') return control ? grid.at(-1).at(-1) : grid[x].at(-1);
    if (key==='ArrowUp') return grid[x][Math.max(0,y-1)];
    if (key==='ArrowDown') return grid[x][Math.min(grid[x].length-1,y+1)];
    const next = key==='ArrowLeft' ? Math.max(0,x-1) : key==='ArrowRight' ? Math.min(grid.length-1,x+1) : -1;
    return next < 0 ? null : grid[next][Math.min(y,grid[next].length-1)];
  }
  function listCardDrafts(storage, owner, now = Date.now()) {
    if (!/^(?:local|[1-9]\d*)$/.test(String(owner))) return [];
    const prefix = `openboard.draft.${owner}.`, items = [];
    try {
      for (let index=0;index<storage.length;index++) {
        const key=storage.key(index);
        if (typeof key!=='string' || !key.startsWith(prefix)) continue;
        const ids=key.slice(prefix.length).match(/^([1-9]\d*)\.(new|[1-9]\d*)$/);
        if (!ids) continue;
        const raw=storage.getItem(key);
        if (!raw || raw.length>2*1024*1024) continue;
        let draft; try { draft=JSON.parse(raw); } catch { continue; }
        if (!draft || typeof draft.data!=='object' || !draft.data || Array.isArray(draft.data) || typeof draft.data.title!=='string' || !Number.isFinite(draft.updated_at) || draft.updated_at>now+60000 || now-draft.updated_at>=30*86400000) continue;
        const boardId=Number(ids[1]),cardId=ids[2]==='new' ? null:Number(ids[2]);
        if (!Number.isSafeInteger(boardId) || (cardId!==null && !Number.isSafeInteger(cardId))) continue;
        items.push({key,raw,boardId,cardId,title:draft.data.title,updatedAt:draft.updated_at});
      }
    } catch { return []; }
    return items.sort((a,b)=>b.updatedAt-a.updatedAt || a.key.localeCompare(b.key));
  }
  function removeOwnedDraft(storage, item, owner) {
    const prefix=`openboard.draft.${owner}.`;
    if (!/^(?:local|[1-9]\d*)$/.test(String(owner)) || typeof item?.key!=='string' || !item.key.startsWith(prefix) || !/^([1-9]\d*)\.(new|[1-9]\d*)$/.test(item.key.slice(prefix.length)) || typeof item.raw!=='string') return false;
    try { if (storage.getItem(item.key)!==item.raw) return false; storage.removeItem(item.key); return true; } catch { return false; }
  }
  function calendarPeriod(mode, anchor, shift = 0) {
    const chosen=validDate(anchor) && anchor>='0001-01-01' ? anchor:new Date().toISOString().slice(0,10);
    const date=new Date(chosen+'T12:00:00Z');
    shift=Number.isSafeInteger(shift) ? shift:0;
    if (mode==='month') { date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth()+shift); }
    else date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7)+shift*7);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear()<1 || date.getUTCFullYear()>9999) return calendarPeriod(mode,chosen,0);
    const focus=date.toISOString().slice(0,10), start=new Date(date);
    if (mode==='month') start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
    const days=Array.from({length:mode==='month' ? 42:7},(_,index)=>{
      const day=new Date(start);day.setUTCDate(day.getUTCDate()+index);
      return day.getUTCFullYear()<1 || day.getUTCFullYear()>9999 ? null:day.toISOString().slice(0,10);
    });
    return {anchor:focus,days};
  }
  function tabSessionBridge({storage,channel,onLogout,id = () => globalThis.crypto?.randomUUID?.() || String(Math.random())}) {
    const key='openboard.session-event', seen=new Set();
    function receive(value) {
      let message=value;
      if (typeof message==='string') { if(message.length>200)return false;try { message=JSON.parse(message); } catch { return false; } }
      if (!message || typeof message!=='object' || Array.isArray(message) || Object.keys(message).length!==2 || !Object.hasOwn(message,'kind') || !Object.hasOwn(message,'nonce') || message.kind!=='logout' || typeof message.nonce!=='string' || !message.nonce || message.nonce.length>100 || seen.has(message.nonce)) return false;
      seen.add(message.nonce);if(seen.size>100)seen.delete(seen.values().next().value);
      onLogout(); return true;
    }
    function publish() {
      const message={kind:'logout',nonce:id()};seen.add(message.nonce);
      if(seen.size>100)seen.delete(seen.values().next().value);
      try { channel?.postMessage(message); } catch { /* Storage is the fallback. */ }
      try { storage?.setItem(key,JSON.stringify(message)); } catch { /* Cross-tab support is optional. */ }
    }
    return {key,publish,receive};
  }
  const helpers = {safeURL,markdown,csvCell,csv,icsText,calendar,foldLine,dateText,validDate,shouldDiscardDraft,fieldValue,fieldText,planningPayload,fieldCell,fieldMatches,fieldMatchesAdvanced,worklogCSV,storageLabel,catalog,graphemes,initials,composing,navigateCards,listCardDrafts,removeOwnedDraft,calendarPeriod,tabSessionBridge};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  root.OpenBoardProductivity = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);

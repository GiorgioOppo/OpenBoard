/* Pure formatting helpers shared by the buildless UI and its tests. */
(function (root) {
  'use strict';
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
    return output || '<p class="helper-text">Nessuna descrizione.</p>';
  }
  function csvCell(value) { let text = String(value ?? ''); if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'"+text; return '"'+text.replace(/"/g,'""')+'"'; }
  function csv(board) {
    const rows = [['ID','Titolo','Lista','Descrizione','Responsabili','Etichette','Priorità','Inizio','Scadenza','Completata','Archiviata','Blocco','Stima minuti','Minuti effettivi','Riferimento']];
    for (const column of board.columns || []) for (const card of column.cards || []) rows.push([card.id,card.title,column.title,card.description,(card.assignees || []).map((u) => u.name).join(', ') || card.assignee,(card.labels || []).join(', '),card.priority,card.start_date,card.due_date,card.completed ? 'Sì':'No',card.archived ? 'Sì':'No',card.blocked_reason,card.estimate_minutes,card.actual_minutes,card.reference_url]);
    return '\uFEFF'+rows.map((row) => row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  }
  function icsText(value) { return String(value ?? '').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,'); }
  function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false; const date = new Date(value+'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value; }
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
  const helpers = {safeURL,markdown,csvCell,csv,icsText,calendar,foldLine,shouldDiscardDraft};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  root.OpenBoardProductivity = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);

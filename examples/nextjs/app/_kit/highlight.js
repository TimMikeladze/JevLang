// Minimal JS colouring: comments, strings, keywords, jevlang builders.
const TOKEN = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")|\b(const|export|import|from|true|false)\b|\b(definePolicy|choice|noul|score|gate|rule|all|any|compare|fact|assign|escalate|page|hold)\b(?=\()/g;
export function colour(line) {
  const out = [];
  let last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const kind = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'f';
    out.push(<span key={m.index} className={`tok-${kind}`}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  out.push(line.slice(last));
  return out;
}


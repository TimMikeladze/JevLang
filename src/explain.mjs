// One decision in prose: what it decided, which clause, and what it read.
export function explainDecision(d) {
  const head = `${d.action}${d.target ? ` ${d.target}` : ''}${d.reason ? `  // ${d.reason}` : ''}`;
  const where = d.rule ? `\n  ${d.rule}${d.clause === null || d.clause === undefined ? '' : ` ${d.clause}`}${d.source ? `, ${d.source}` : ''}` : '';
  const because = d.readings?.length
    ? `\n  because\n${d.readings.map(r => `    ${r.question} = ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`
      + `${r.confidence === null || r.confidence === undefined ? '' : `   confidence ${r.confidence}`}`
      + `${r.detail ? `   (${r.detail})` : ''}`).join('\n')}`
    : '';
  return `${head}${where}${because}`;
}

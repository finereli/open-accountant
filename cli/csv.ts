// Minimal RFC 4180 CSV parser: quoted fields, embedded commas/quotes/newlines,
// CRLF, and a UTF-8 BOM (many bank exports carry one). No dependencies.

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += c
        i++
      }
    } else if (c === '"') {
      inQuotes = true
      i++
    } else if (c === ',') {
      row.push(field)
      field = ''
      i++
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      i++
    } else {
      field += c
      i++
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

// "1,234.56" / "-950" / "0.00" -> integer cents, decimally exact (no float
// rounding on the parse path - this is a ledger).
export function parseMoneyCents(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, '')
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,10}))?$/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const whole = parseInt(m[2], 10)
  const fracRaw = (m[3] ?? '').padEnd(2, '0')
  // Round half-up past 2 decimals (Wise exchange legs can carry more).
  let cents = whole * 100 + parseInt(fracRaw.slice(0, 2) || '0', 10)
  if (fracRaw.length > 2 && parseInt(fracRaw[2], 10) >= 5) cents += 1
  return sign * cents
}

// csv-reader-fast: a fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV
// reader for "Read broken CSV files faster, 21 November 2026"). run(input)
// returns exactly {columns, rows, errors} as csv-reader 1.0.0 does for every
// input: the same broken-row policy, the same error records, the same line and
// row numbers. It is a single left-to-right pass that jumps between
// delimiters with indexOf/slice/split instead of reading one character at a
// time, so plain fields cost a few native scans instead of a JS loop per
// character, and whole clean records cost one split.
//
// Policy (mirrors csv-reader 1.0.0):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it read
//     as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with empty strings (short_row, with fields: its field count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a record's short_row
//     or long_row when it ends: line the 1-based line its record starts on,
//     counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Record context for error records, set at each record's start.
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, how many characters the
  // unquoted read kept (the quote_junk check reads it).
  let fVal = '';
  let fEnd = END;
  let fAdd = 0;

  // Drops stray CRs from `chunk` (each one an error), except a trailing CR
  // when it belongs to a CRLF break, and returns what is kept.
  function stripCR(chunk, allowTrailing) {
    const r = chunk.indexOf('\r');
    if (r === -1) return chunk;
    let v = '';
    let s = 0;
    for (;;) {
      const i = chunk.indexOf('\r', s);
      if (i === -1) {
        v += chunk.slice(s);
        break;
      }
      v += chunk.slice(s, i);
      if (!(allowTrailing && i === chunk.length - 1)) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      s = i + 1;
    }
    return v;
  }

  // Reads unquoted characters onto `value` up to the next comma, line break or
  // end of the text. Sets fVal, fEnd and fAdd (added counts the characters kept).
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const iC = text.indexOf(',', pos);
      if (iC !== -1) {
        const chunk = text.slice(pos, iC);
        const nl = chunk.indexOf('\n');
        if (nl === -1) {
          // Ends at the comma; every CR in the chunk is stray.
          pos = iC + 1;
          const kept = stripCR(chunk, false);
          fVal = value + kept;
          fEnd = COMMA;
          fAdd = added + kept.length;
          return;
        }
        // A line break inside the chunk ends the field first.
        pos = pos + nl + 1;
        line += 1;
        const kept = stripCR(chunk.slice(0, nl), true);
        fVal = value + kept;
        fEnd = BREAK;
        fAdd = added + kept.length;
        return;
      }
      const iL = text.indexOf('\n', pos);
      if (iL === -1) {
        // To the end of the text; every CR here is stray.
        const kept = stripCR(text.slice(pos), false);
        pos = n;
        fVal = value + kept;
        fEnd = END;
        fAdd = added + kept.length;
        return;
      }
      const kept = stripCR(text.slice(pos, iL), true);
      pos = iL + 1;
      line += 1;
      fVal = value + kept;
      fEnd = BREAK;
      fAdd = added + kept.length;
      return;
    }
    fVal = value;
    fEnd = END;
    fAdd = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal, fEnd, fAdd.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      // The chunk [pos, q) holds no quote; it may hold CRs and LFs.
      const chunk = text.slice(pos, q);
      if (chunk.indexOf('\r') === -1) {
        // Each LF inside quotes is one more line.
        let p = chunk.indexOf('\n');
        while (p !== -1) {
          line += 1;
          p = chunk.indexOf('\n', p + 1);
        }
        value += chunk;
      } else {
        // CRLF and a lone CR inside quotes each read as one LF.
        let v = '';
        let seg = 0;
        for (let i = 0; i < chunk.length; i++) {
          const cc = chunk.charCodeAt(i);
          if (cc === 13) {
            v += chunk.slice(seg, i);
            v += '\n';
            line += 1;
            if (chunk.charCodeAt(i + 1) === 10) i += 1;
            seg = i + 1;
          } else if (cc === 10) {
            line += 1;
          }
        }
        v += chunk.slice(seg);
        value += v;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      if (pos >= n) {
        fVal = value;
        fEnd = END;
        fAdd = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fVal = value;
        fEnd = COMMA;
        fAdd = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fVal = value;
        fEnd = BREAK;
        fAdd = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fVal = value;
        fEnd = BREAK;
        fAdd = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fAdd > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record whose line holds no quote and no stray CR is its
    // comma-split, nothing else. A trailing CR before the LF is the CRLF
    // break. Any quote or stray CR takes the general reader below.
    let fields = null;
    let quoted = false;
    const iL = text.indexOf('\n', pos);
    if (iL !== -1) {
      let lt = text.slice(pos, iL);
      if (lt.indexOf('"') === -1) {
        if (lt.length > 0 && lt.charCodeAt(lt.length - 1) === 13) lt = lt.slice(0, -1);
        if (lt.indexOf('\r') === -1) {
          if (lt.length === 0) {
            pos = iL + 1;
            line += 1;
            continue;
          }
          fields = lt.split(',');
          pos = iL + 1;
          line += 1;
        }
      }
    } else {
      const lt = text.slice(pos);
      if (lt.indexOf('"') === -1 && lt.indexOf('\r') === -1) {
        fields = lt.split(',');
        pos = n;
      }
    }

    if (fields === null) {
      fields = [];
      for (;;) {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          readQuoted();
        } else {
          quoted = false;
          readUnquoted('');
        }
        fields.push(fVal);
        if (fEnd !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

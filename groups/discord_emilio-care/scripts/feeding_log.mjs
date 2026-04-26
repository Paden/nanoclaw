// groups/discord_emilio-care/scripts/feeding_log.mjs
// Feedings tab helpers — pure functions for testability + thin Sheets API wrappers.

const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';
const TAB = 'Feedings';

export function validateAmount(input) {
  const n = typeof input === 'number' ? input : parseFloat(String(input ?? ''));
  if (!Number.isFinite(n)) throw new Error(`amount must be a number (got "${input}")`);
  if (n <= 0) throw new Error(`amount must be > 0 (got ${n})`);
  if (n > 20) throw new Error(`amount must be ≤ 20 oz (got ${n})`);
  return n;
}

// Pure: takes the full sheet rows (header + data) and returns today's feedings
// newest-first, each annotated with its 1-based sheet row number.
export function computeRecentFeedings(rows, todayDateStr, limit = 5) {
  if (!rows || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ts = r[0] || '';
    if (!ts.startsWith(todayDateStr)) continue;
    out.push({
      timestamp: ts,
      amount: r[1] || '',
      source: r[2] || '',
      sheetRow: i + 1, // header is row 1
    });
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit);
}

export async function appendFeeding(token, { timestamp, amount, source }) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[timestamp, amount, source]] }),
    },
  );
  if (!r.ok) throw new Error(`appendFeeding ${r.status}: ${await r.text()}`);
}

export async function updateFeedingAmount(token, { sheetRow, amount }) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!B${sheetRow}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[amount]] }),
    },
  );
  if (!r.ok) throw new Error(`updateFeedingAmount ${r.status}: ${await r.text()}`);
}

export async function readFeedings(token) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A:C')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (j.error) throw new Error(`readFeedings ${j.error.message}`);
  return j.values || [];
}

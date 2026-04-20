/**
 * Sheets MCP Server for NanoClaw
 * Wraps sheets.mjs so the agent can read/append/update Google Sheets
 * without inline `node -e "import { readRange } ..."` shell-outs.
 * Reuses calendar-mcp's OAuth client (scopes include both calendar + sheets).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Runtime-resolved absolute path inside the container. The agent-runner
// build copies this file into dist/, and /workspace/global is bind-mounted
// at runtime to the host's groups/global dir (see src/container-runner.ts).
// @ts-expect-error — untyped .mjs import
import { readRange, appendRows, updateRange } from '/workspace/global/scripts/lib/sheets.mjs';

function log(msg: string): void {
  console.error(`[SHEETS] ${msg}`);
}

const server = new McpServer({ name: 'google-sheets', version: '1.0.0' });

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_BYTES = 50_000;

type Row = (string | number | boolean | null)[];

export function paginateRows(
  allRows: Row[],
  offset: number,
  limit: number,
): {
  rows: Row[];
  totalRows: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset?: number;
} {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const totalRows = allRows.length;
  let slice = allRows.slice(safeOffset, safeOffset + safeLimit);
  // Hard byte cap: shrink slice until JSON fits under MAX_BYTES. Large rows
  // can still blow the limit even with small counts, so trim by one.
  while (slice.length > 1 && JSON.stringify(slice).length > MAX_BYTES) {
    slice = slice.slice(0, slice.length - 1);
  }
  const returned = slice.length;
  const truncated = safeOffset + returned < totalRows;
  const result: {
    rows: Row[];
    totalRows: number;
    offset: number;
    limit: number;
    truncated: boolean;
    nextOffset?: number;
  } = {
    rows: slice,
    totalRows,
    offset: safeOffset,
    limit: safeLimit,
    truncated,
  };
  if (truncated) result.nextOffset = safeOffset + returned;
  return result;
}

server.tool(
  'read_range',
  `Read a range from a Google Sheet with pagination. Returns { rows, totalRows, offset, limit, truncated, nextOffset? }. Default limit is ${DEFAULT_LIMIT} rows; max ${MAX_LIMIT}. Response is hard-capped at ~${Math.round(MAX_BYTES / 1000)}KB. For large tabs, narrow the A1 range (e.g. "Feedings!A500:C600") or paginate via offset/limit. Example range: "Sheet1!A2:D100".`,
  {
    sheet_id: z.string().describe('The spreadsheet ID from the URL'),
    range: z.string().describe('A1 notation range, e.g. "Tab!A:Z"'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Row offset into the returned range (0-based). Default 0.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Max rows to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
      ),
  },
  async ({ sheet_id, range, offset, limit }) => {
    const off = offset ?? 0;
    const lim = limit ?? DEFAULT_LIMIT;
    log(`read_range ${sheet_id} ${range} offset=${off} limit=${lim}`);
    try {
      const rows = (await readRange(sheet_id, range)) as Row[];
      const paged = paginateRows(rows, off, lim);
      return { content: [{ type: 'text', text: JSON.stringify(paged) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `ERROR: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'append_rows',
  'Append rows to a Google Sheet. Values is a 2D array of rows. Range should be like "Sheet1!A:D".',
  {
    sheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))),
  },
  async ({ sheet_id, range, values }) => {
    log(`append_rows ${sheet_id} ${range} (${values.length} rows)`);
    try {
      const res = await appendRows(sheet_id, range, values);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'update_range',
  'Overwrite a range in a Google Sheet with the given values (2D array).',
  {
    sheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))),
  },
  async ({ sheet_id, range, values }) => {
    log(`update_range ${sheet_id} ${range}`);
    try {
      const res = await updateRange(sheet_id, range, values);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('Sheets MCP server ready');

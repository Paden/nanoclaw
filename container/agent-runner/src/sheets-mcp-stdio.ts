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

server.tool(
  'read_range',
  'Read a range from a Google Sheet. Returns rows as a 2D array. Example range: "Sheet1!A2:D100".',
  {
    sheet_id: z.string().describe('The spreadsheet ID from the URL'),
    range: z.string().describe('A1 notation range, e.g. "Tab!A:Z"'),
  },
  async ({ sheet_id, range }) => {
    log(`read_range ${sheet_id} ${range}`);
    try {
      const rows = await readRange(sheet_id, range);
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
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

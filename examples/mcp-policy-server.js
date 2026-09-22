#!/usr/bin/env node
// A policy as an MCP server over stdio: `node examples/mcp-policy-server.js`.
// Nothing but protocol goes to stdout.
import { policyMcpServer, serveStdio, mcpTool, mcpTextResult, mcpInputRequired, makeMcpServer } from '../src/mcp.js';
import { policy as ticket } from './ticket-router.js';

const base = policyMcpServer(ticket);
// One more tool, so a client can exercise a tool that needs a person.
const asking = mcpTool({
  name: 'which-room',
  description: 'Ask which room, then answer',
  inputSchema: { type: 'object', properties: { hint: { type: 'string', 'x-mcp-header': 'Hint' } }, required: [] },
  run: async (args, call) => {
    if (call.inputResponses) return mcpTextResult(`room: ${JSON.stringify(call.inputResponses.room)}`);
    if (call.elicit) {
      const answer = await call.elicit('Which room?', { type: 'object' });
      return mcpTextResult(`room: ${JSON.stringify(answer?.content ?? null)}`);
    }
    return mcpInputRequired({ room: { method: 'elicitation/create', params: { message: 'Which room?' } } }, { state: 'asked' });
  },
});
const failing = mcpTool({
  name: 'always-fails', description: 'Fails', inputSchema: { type: 'object' },
  run: async () => { throw new Error('the door is jammed'); },
});
await serveStdio(makeMcpServer({
  name: base.info.name, version: base.info.version, title: base.info.title,
  instructions: base.instructions, tools: [...base.tools, asking, failing], resources: base.resources,
}));

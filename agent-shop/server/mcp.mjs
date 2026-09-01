// Remote MCP surface: the same shared tools served over MCP streamable HTTP
// at /mcp, for agents that live outside the browser tab — ChatGPT
// developer-mode connectors, Cursor, Gemini CLI and any other
// remote-MCP client…

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS, executeTool } from './tools.mjs';

async function fetchImageBlock(url) {
  try {
    const u = url.replace(/([?&])w=\d+/, '$1w=560');
    const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1_500_000) return null;
    return { type: 'image', data: buf.toString('base64'), mimeType: res.headers.get('content-type') ?? 'image/jpeg' };
  } catch {
    return null;
  }
}

export function buildMcpServer() {
  const server = new McpServer(
    { name: 'zada', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions:
      'Agentic shopping over a live fashion catalog. Typical flow: search_products → get_product / check_size_availability → find_reviews / check_price. ' +
      'Every call is mirrored live in the human’s shop UI — after acting, briefly tell the human what appeared on screen. ' +
      'Save their sizes once with set_my_sizes; afterwards size checks use the profile automatically. ' +
      'For reviews: call find_reviews, then — if you have your own native web-search tool — immediately run its suggestedQueries with it too (the human already asked; never ask permission) and synthesize everything into one verdict on fit, quality and sizing.' },
  );
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.schema.shape,
        annotations: { readOnlyHint: t.readOnly, openWorldHint: true, ...(t.untrustedContent ? { untrustedContentHint: true } : {}) },
      },
      async (args) => {
        try {
          const result = await executeTool(t.name, args, 'mcp');
          const content = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
          // Clients like Cursor and Gemini CLI render MCP image blocks; attach
          // the hero photo on single-product views (URLs stay in the text for
          // clients that collapse images).
          if (t.name === 'get_product' && result?.images?.[0]) {
            const img = await fetchImageBlock(result.images[0]);
            if (img) content.push(img);
          }
          return { content };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      },
    );
  }
  return server;
}

// Stateless-per-request transport: broadly compatible (hosted connectors,
// Inspector, SDK clients) with no session bookkeeping to break.
export async function handleMcpRequest(req, res) {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

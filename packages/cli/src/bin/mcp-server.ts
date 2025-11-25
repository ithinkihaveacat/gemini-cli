/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  Config,
  type ConfigParameters,
  DEFAULT_GEMINI_MODEL,
} from '@google/gemini-cli-core';
import type { AnyDeclarativeTool } from '@google/gemini-cli-core';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

// Helper to convert JSON Schema to Zod Schema recursively
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
    if (!schema) return z.any();

    if (schema.type === 'string') {
        let s = z.string();
        if (schema.description) s = s.describe(schema.description);
        return s;
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        let n = z.number();
        if (schema.description) n = n.describe(schema.description);
        return n;
    }
    if (schema.type === 'boolean') {
        let b = z.boolean();
        if (schema.description) b = b.describe(schema.description);
        return b;
    }
    if (schema.type === 'array') {
        const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
        let a = z.array(itemSchema);
        if (schema.description) a = a.describe(schema.description);
        return a;
    }
    if (schema.type === 'object') {
        const shape: Record<string, z.ZodTypeAny> = {};
        if (schema.properties) {
            for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
                let propSchema = jsonSchemaToZod(prop);
                if (!schema.required || !schema.required.includes(key)) {
                    propSchema = propSchema.optional();
                }
                shape[key] = propSchema;
            }
        }
        // If additionalProperties is true or missing, we might want passthrough,
        // but Zod object is strict by default or strips unknown.
        // For MCP tools, we usually define all props.
        let o = z.object(shape);
        if (schema.description) o = o.describe(schema.description);
        return o;
    }

    // Fallback
    return z.any();
}

// Generic adapter to register a DeclarativeTool with McpServer
function registerMcpTool(server: McpServer, tool: AnyDeclarativeTool) {
  const schema = tool.schema.parametersJsonSchema as any;

  // Convert the top-level properties to a map of Zod schemas.
  // The MCP SDK `registerTool` method expects the `inputSchema` to be a plain object
  // where keys are property names and values are Zod schemas (the "shape").
  // It does NOT expect a `z.object()` instance for `inputSchema`.
  const zodShape: Record<string, z.ZodTypeAny> = {};

  if (schema && schema.type === 'object' && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
        let propZod = jsonSchemaToZod(prop);
        if (!schema.required || !schema.required.includes(key)) {
            propZod = propZod.optional();
        }
        zodShape[key] = propZod;
    }
  }

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: zodShape,
    },
    async (params, { signal }) => {
      try {
        const result = await tool.buildAndExecute(params as any, signal);

        let textContent = '';
        if (typeof result.llmContent === 'string') {
          textContent = result.llmContent;
        } else if (Array.isArray(result.llmContent)) {
            textContent = result.llmContent.map((part: any) => {
                if ('text' in part) return part.text;
                return JSON.stringify(part);
            }).join('\n');
        } else {
             textContent = JSON.stringify(result.llmContent);
        }

        return {
          content: [
            { type: 'text', text: textContent }
          ]
        };
      } catch (error: any) {
        return {
            content: [
                { type: 'text', text: `Error: ${error.message}` }
            ],
            isError: true
        };
      }
    }
  );
}

async function main() {
  const server = new McpServer({
    name: 'gemini-core-tools',
    version: '1.0.0',
  });

  const configParams: ConfigParameters = {
    sessionId: randomUUID(),
    targetDir: process.cwd(),
    cwd: process.cwd(),
    debugMode: false,
    model: process.env['GEMINI_MODEL'] || DEFAULT_GEMINI_MODEL,
    codebaseInvestigatorSettings: {
        enabled: true,
    },
  };

  const config = new Config(configParams);

  await config.initialize();

  const toolRegistry = config.getToolRegistry();
  const tools = toolRegistry.getAllTools();

  const requestedTools = new Set([
    'codebase_investigator',
    'Edit', 'edit',
    'FindFiles', 'glob',
    'GoogleSearch', 'web_search',
    'ReadFile', 'read_file',
    'ReadFolder', 'ls',
    'SearchText', 'grep', 'ripgrep',
    'Shell', 'run_shell_command',
    'WebFetch', 'web_fetch',
    'WriteFile', 'write_file',
    'WriteTodos', 'write_todos',
  ]);

  const shouldRegister = (tool: AnyDeclarativeTool) => {
    // Check internal name
    if (requestedTools.has(tool.name)) return true;

    // Check aliases (redundant but safe)
    if (tool.name === 'edit' && requestedTools.has('Edit')) return true;
    if (tool.name === 'glob' && requestedTools.has('FindFiles')) return true;
    if (tool.name === 'web_search' && requestedTools.has('GoogleSearch')) return true;
    if (tool.name === 'read_file' && requestedTools.has('ReadFile')) return true;
    if (tool.name === 'ls' && requestedTools.has('ReadFolder')) return true;
    if ((tool.name === 'grep' || tool.name === 'ripgrep') && requestedTools.has('SearchText')) return true;
    if (tool.name === 'run_shell_command' && requestedTools.has('Shell')) return true;
    if (tool.name === 'web_fetch' && requestedTools.has('WebFetch')) return true;
    if (tool.name === 'write_file' && requestedTools.has('WriteFile')) return true;
    if (tool.name === 'write_todos' && requestedTools.has('WriteTodos')) return true;

    return false;
  };

  for (const tool of tools) {
      if (shouldRegister(tool)) {
          registerMcpTool(server, tool);
      }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

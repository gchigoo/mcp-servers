#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

const server = new Server(
  {
    name: "example-servers/postgres",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    'Please provide at least one database URL (or id=url pair) as a command-line argument',
  );
  process.exit(1);
}

type DatabaseConfig = {
  id: string;
  url: string;
  pool: pg.Pool;
  resourceBaseUrl: URL;
};

function parseDatabaseArgs(rawArgs: string[]): Array<{ id: string; url: string }> {
  const hasMultiple = rawArgs.length > 1;

  const parsed = rawArgs.map((arg, index) => {
    const separatorIndex = arg.indexOf("=");

    if (separatorIndex === -1) {
      if (hasMultiple) {
        throw new Error(
          "When providing multiple databases, use id=postgres://... for each argument",
        );
      }

      return { id: "default", url: arg };
    }

    const id = arg.slice(0, separatorIndex).trim();
    const url = arg.slice(separatorIndex + 1).trim();

    if (!id) {
      throw new Error(`Database id is missing in argument #${index + 1}`);
    }

    if (!url) {
      throw new Error(`Database URL is missing for id "${id}"`);
    }

    return { id, url };
  });

  const seenIds = new Set<string>();
  for (const { id } of parsed) {
    if (seenIds.has(id)) {
      throw new Error(`Duplicate database id "${id}"`);
    }
    seenIds.add(id);
  }

  return parsed;
}

function createResourceBaseUrl(databaseUrl: string, databaseIdInPath?: string) {
  const base = new URL(databaseUrl);
  base.protocol = "postgres:";
  base.password = "";

  if (databaseIdInPath) {
    base.pathname = `/${databaseIdInPath}/`;
  } else if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }

  return base;
}

const databaseArgs = parseDatabaseArgs(args);
const hasMultipleDatabases = databaseArgs.length > 1;

const databases: DatabaseConfig[] = databaseArgs.map(({ id, url }) => ({
  id,
  url,
  pool: new pg.Pool({ connectionString: url }),
  resourceBaseUrl: createResourceBaseUrl(url, hasMultipleDatabases ? id : undefined),
}));

const databaseMap = new Map<string, DatabaseConfig>(
  databases.map((database) => [database.id, database]),
);

const SCHEMA_PATH = "schema";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resourceLists = await Promise.all(
    databases.map(async (database) => {
      const client = await database.pool.connect();
      try {
        const result = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        );
        return result.rows.map((row: { table_name: string }) => ({
          uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, database.resourceBaseUrl)
            .href,
          mimeType: "application/json",
          name: hasMultipleDatabases
            ? `[${database.id}] "${row.table_name}" database schema`
            : `"${row.table_name}" database schema`,
        }));
      } finally {
        client.release();
      }
    }),
  );

  return {
    resources: resourceLists.flat(),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request: { params: { uri: string } }) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.replace(/^\/+/, "").split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();
  const databaseId = hasMultipleDatabases ? pathComponents.pop() : databases[0].id;

  if (!schema || !tableName || schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const database = databaseId ? databaseMap.get(databaseId) : databases[0];
  if (!database) {
    throw new Error(
      `Unknown database "${databaseId}". Available databases: ${Array.from(databaseMap.keys()).join(", ")}`,
    );
  }

  const client = await database.pool.connect();
  try {
    const result = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [tableName],
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
            databaseId: {
              type: "string",
              description:
                "Database id to run the query against (required when multiple databases are configured)",
            },
          },
          required: ["sql"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: { sql?: string; databaseId?: string } } }) => {
  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;
    const databaseId = request.params.arguments?.databaseId as string | undefined;

    if (!sql) {
      throw new Error("The 'sql' argument is required.");
    }

    const resolveDatabase = () => {
      if (databaseId) {
        const database = databaseMap.get(databaseId);
        if (!database) {
          throw new Error(
            `Unknown databaseId "${databaseId}". Available databases: ${Array.from(databaseMap.keys()).join(", ")}`,
          );
        }
        return database;
      }

      if (databases.length === 1) {
        return databases[0];
      }

      throw new Error(
        `Multiple databases are configured (${Array.from(databaseMap.keys()).join(", ")}). Please specify databaseId.`,
      );
    };

    const targetDatabase = resolveDatabase();

    const client = await targetDatabase.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      throw error;
    } finally {
      client
        .query("ROLLBACK")
        .catch((error: unknown) =>
          console.warn("Could not roll back transaction:", error),
        );

      client.release();
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

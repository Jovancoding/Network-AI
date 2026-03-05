# MCP Networking Roadmap

**Model Context Protocol Implementation Plan for Network-AI**

This document outlines the roadmap for implementing MCP (Model Context Protocol) networking in the Swarm Orchestrator, enabling cross-machine agent communication with enterprise-grade security.

---

## 🎯 Vision

Transform the AuthGuardian permission system into an **MCP Server** that allows agents running on different host machines to request permission grants over secure transports (SSE or WebSockets), while maintaining the local-first, privacy-focused architecture.

```
┌─────────────────────┐         ┌─────────────────────┐
│   Machine A         │         │   Machine B         │
│  ┌───────────────┐  │   MCP   │  ┌───────────────┐  │
│  │ Orchestrator  │◄─┼────────►│  │ Data Analyst  │  │
│  │   Agent       │  │  (SSE)  │  │    Agent      │  │
│  └───────────────┘  │         │  └───────────────┘  │
│         │           │         │         │           │
│         ▼           │         │         │           │
│  ┌───────────────┐  │         │         │           │
│  │ AuthGuardian  │  │         │         │           │
│  │  MCP Server   │◄─┼─────────┼─────────┘           │
│  └───────────────┘  │  Grant  │                     │
│         │           │ Request │                     │
│         ▼           │         │                     │
│  ┌───────────────┐  │         │                     │
│  │ Local Policy  │  │         │                     │
│  │   Engine      │  │         │                     │
│  └───────────────┘  │         │                     │
└─────────────────────┘         └─────────────────────┘
```

---

## 📋 Implementation Phases

### Phase 1: MCP Server Foundation (Weeks 1-2)
**Status:** ✅ Done — `lib/mcp-bridge.ts`

#### 1.1 AuthGuardian MCP Server
Create `lib/mcp-server.ts`:

```typescript
// MCP Server Types
interface MCPCapabilities {
  tools: MCPTool[];
  resources: MCPResource[];
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

// AuthGuardian as MCP Server
class AuthGuardianMCPServer {
  private authGuardian: AuthGuardian;
  
  getCapabilities(): MCPCapabilities {
    return {
      tools: [
        {
          name: "request_permission",
          description: "Request access grant for a resource",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              resource_type: { type: "string", enum: ["SAP_API", "FINANCIAL_API", "EXTERNAL_SERVICE", "DATA_EXPORT"] },
              justification: { type: "string" },
              scope: { type: "string" }
            },
            required: ["agent_id", "resource_type", "justification"]
          }
        },
        {
          name: "validate_token",
          description: "Validate an existing permission token",
          inputSchema: {
            type: "object",
            properties: {
              token: { type: "string" },
              agent_id: { type: "string" },
              resource_type: { type: "string" }
            },
            required: ["token", "agent_id", "resource_type"]
          }
        },
        {
          name: "revoke_token",
          description: "Revoke a permission token",
          inputSchema: {
            type: "object",
            properties: {
              token: { type: "string" }
            },
            required: ["token"]
          }
        }
      ],
      resources: [
        {
          uri: "grants://active",
          name: "Active Grants",
          description: "List of currently active permission grants"
        },
        {
          uri: "grants://audit",
          name: "Audit Log",
          description: "Permission request/grant audit trail"
        }
      ]
    };
  }
}
```

#### 1.2 Files Shipped
- [x] `lib/mcp-bridge.ts` — `McpBlackboardBridge` (server), `McpBridgeClient`, `McpBridgeRouter`, `McpInProcessTransport`, full JSON-RPC 2.0
- [x] `lib/mcp-blackboard-tools.ts` — MCP tool definitions for all blackboard operations
- [x] `lib/mcp-tools-extended.ts` — Budget, token, and audit tools over MCP

---

### Phase 2: Transport Layer (Weeks 3-4)
**Status:** ✅ Done — `lib/mcp-transport-sse.ts`

#### 2.1 SSE Transport (Server-Sent Events)
Primary transport for browser-compatible clients:

```typescript
// SSE Transport Implementation
class SSETransport {
  private server: http.Server;
  private connections: Map<string, Response> = new Map();
  
  constructor(private mcpServer: AuthGuardianMCPServer, port: number = 3001) {
    this.server = http.createServer(this.handleRequest.bind(this));
  }
  
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Endpoint: GET /sse - Establish SSE connection
    // Endpoint: POST /mcp/tools/{toolName} - Invoke tool
    // Endpoint: GET /mcp/resources/{uri} - Read resource
  }
  
  broadcast(event: string, data: unknown): void {
    for (const conn of this.connections.values()) {
      conn.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}
```

#### 2.2 WebSocket Transport
For bidirectional real-time communication:

```typescript
// WebSocket Transport Implementation
class WebSocketTransport {
  private wss: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  
  constructor(private mcpServer: AuthGuardianMCPServer, port: number = 3002) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', this.handleConnection.bind(this));
  }
  
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Authenticate client
    // Register for events
    // Handle tool invocations
  }
}
```

#### 2.3 Security Requirements
- [ ] TLS/mTLS for encrypted transport
- [ ] API key authentication for clients
- [ ] Rate limiting per client
- [ ] IP allowlist (optional)
- [ ] Audit logging of all remote requests

---

### Phase 3: Cross-Machine Agent Discovery (Weeks 5-6)
**Status:** ✅ Done — `McpBridgeRouter` + `lib/mcp-tools-control.ts` (`agent_list`, `agent_spawn`)

#### 3.1 Agent Registry
Track agents across machines:

```typescript
interface RemoteAgent {
  agent_id: string;
  machine_id: string;
  capabilities: string[];
  trust_level: number;
  last_seen: Date;
  endpoint: string;  // MCP endpoint URL
}

class AgentRegistry {
  private agents: Map<string, RemoteAgent> = new Map();
  
  register(agent: RemoteAgent): void;
  discover(capability: string): RemoteAgent[];
  heartbeat(agent_id: string): void;
}
```

#### 3.2 Discovery Protocol
Options for agent discovery:

| Method | Pros | Cons | Best For |
|--------|------|------|----------|
| Static Config | Simple, secure | Manual updates | Small deployments |
| mDNS/DNS-SD | Auto-discovery | Network limited | LAN environments |
| Central Registry | Scalable | Single point of failure | Cloud deployments |
| Gossip Protocol | Decentralized | Complexity | Large P2P networks |

**Recommended:** Start with **Static Config**, add **Central Registry** later.

---

### Phase 4: Distributed Blackboard (Weeks 7-8)
**Status:** ✅ Done — `lib/blackboard-backend-crdt.ts` + `lib/consistency.ts` + `lib/crdt.ts`

#### 4.1 CRDT-Based Synchronization
For eventual consistency across machines:

```typescript
// Conflict-free Replicated Data Type for Blackboard
interface CRDTBlackboardEntry {
  key: string;
  value: unknown;
  vector_clock: Record<string, number>;
  tombstone: boolean;  // For deletions
}

class DistributedBlackboard {
  private local: LockedBlackboard;
  private peers: Map<string, MCPClient> = new Map();
  
  // Merge remote changes using vector clocks
  merge(remote: CRDTBlackboardEntry[]): void;
  
  // Sync local changes to peers
  sync(): Promise<void>;
}
```

#### 4.2 Consistency Levels
Support configurable consistency:

| Level | Behavior | Use Case |
|-------|----------|----------|
| `eventual` | Async replication | Non-critical state |
| `session` | Read-your-writes | User-facing data |
| `strong` | Synchronous quorum | Financial data |

---

### Phase 5: Budget Federation (Weeks 9-10)
**Status:** ✅ Done — `lib/federated-budget.ts`

#### 5.1 Federated Budget Tracking
Track token spending across machines:

```typescript
interface FederatedBudget {
  task_id: string;
  global_budget: number;
  machine_allocations: Map<string, number>;
  spent_by_machine: Map<string, number>;
}

class FederatedBudgetManager {
  // Request budget allocation from orchestrator
  requestAllocation(task_id: string, tokens: number): Promise<boolean>;
  
  // Report spending back to orchestrator
  reportSpending(task_id: string, tokens: number): Promise<void>;
  
  // Orchestrator: Rebalance allocations
  rebalance(task_id: string): void;
}
```

---

## 🔐 Security Architecture

### Authentication Flow

```
┌──────────┐                    ┌──────────────┐
│  Remote  │                    │ AuthGuardian │
│  Agent   │                    │  MCP Server  │
└────┬─────┘                    └──────┬───────┘
     │                                 │
     │  1. Connect (API Key + TLS)     │
     │────────────────────────────────►│
     │                                 │
     │  2. Challenge (Nonce)           │
     │◄────────────────────────────────│
     │                                 │
     │  3. Response (Signed Nonce)     │
     │────────────────────────────────►│
     │                                 │
     │  4. Session Token               │
     │◄────────────────────────────────│
     │                                 │
     │  5. Request Permission          │
     │────────────────────────────────►│
     │                                 │
     │  6. Grant (if approved)         │
     │◄────────────────────────────────│
     │                                 │
```

### Trust Boundaries

| Zone | Trust Level | Access |
|------|-------------|--------|
| Local Machine | High (0.9) | Full API access |
| Trusted Network | Medium (0.7) | Limited scope |
| External | Low (0.5) | Read-only, audited |

---

## 📁 File Structure (Proposed)

```
lib/
├── mcp/
│   ├── server.ts           # MCP Server implementation
│   ├── client.ts           # MCP Client for connecting to other servers
│   ├── types.ts            # Protocol type definitions
│   ├── transport/
│   │   ├── sse.ts          # Server-Sent Events transport
│   │   ├── websocket.ts    # WebSocket transport
│   │   └── stdio.ts        # Standard I/O transport (local)
│   ├── security/
│   │   ├── auth.ts         # Authentication handlers
│   │   ├── tls.ts          # TLS configuration
│   │   └── rate-limit.ts   # Rate limiting
│   └── discovery/
│       ├── registry.ts     # Agent registry
│       └── static.ts       # Static configuration
scripts/
├── mcp_server.py           # Python MCP server (alternative)
└── mcp_client.py           # Python MCP client
```

---

## 🚀 Quick Start

Usage:

```bash
# Start MCP Server (Machine A - Orchestrator)
npx ts-node lib/mcp/server.ts --port 3001 --mode sse

# Connect Agent (Machine B)
python scripts/mcp_client.py connect --server https://machine-a:3001

# Request Permission from Remote Machine
python scripts/mcp_client.py request-permission \
  --agent data_analyst \
  --resource SAP_API \
  --justification "Q4 analysis task"
```

---

## 📊 Milestones

| Milestone | Shipped in | Status | Key files |
|-----------|------------|--------|-----------|
| Phase 1: MCP Server Foundation | v4.x | ✅ Done | `lib/mcp-bridge.ts` — `McpBlackboardBridge`, `McpBridgeClient`, `McpBridgeRouter`, `McpInProcessTransport`, full JSON-RPC 2.0 |
| Phase 2: SSE/WS Transport | v4.x | ✅ Done | `lib/mcp-transport-sse.ts` — `McpSseServer` (HTTP + SSE, port 3001), `McpCombinedBridge`, `McpSseTransport` |
| Phase 3: Agent Discovery | v4.x | ✅ Done | `McpBridgeRouter` (multi-board routing), `lib/mcp-tools-control.ts` (`agent_list`, `agent_spawn` over MCP) |
| Phase 4: Distributed Blackboard | v4.x | ✅ Done | `lib/blackboard-backend-crdt.ts` (vector clocks, tombstones, bidirectional sync), `lib/consistency.ts` (`eventual`/`session`/`strong`), `lib/crdt.ts` |
| Phase 5: Budget Federation | v4.x | ✅ Done | `lib/federated-budget.ts` — global ceiling, per-agent spend tracking, blackboard persistence |
| Phase 6: Extended MCP Tools | v4.x | ✅ Done | `lib/mcp-tools-extended.ts` (budget/token/audit tools), `lib/mcp-tools-control.ts` (config/agent/FSM tools) |
| **Production Ready** | **v4.0.17** | ✅ **Shipped** | All phases complete — 139 adapter tests, 79 standalone tests pass |

---

## 🔗 References

- [Model Context Protocol Spec](https://modelcontextprotocol.io)
- [OpenClaw MCP Integration](https://docs.openclaw.ai/mcp)
- [SSE Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [WebSocket Protocol RFC 6455](https://tools.ietf.org/html/rfc6455)

---

## 🤝 Contributing

This roadmap is open for community input. Key areas needing design decisions:

1. **Transport Priority:** SSE vs WebSocket as primary?
2. **Discovery Method:** Static config vs auto-discovery?
3. **Consistency Model:** Eventual vs strong for blackboard?
4. **Budget Federation:** Central orchestrator vs peer-to-peer?

Open an issue or PR to discuss!

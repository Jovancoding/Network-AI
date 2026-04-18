/**
 * WorkTree — Hierarchical task decomposition tree with rollup stats
 *
 * Maintains a rooted tree of work items where each node can spawn children.
 * Status, tokens, and progress roll up automatically from leaves to root.
 * Integrates with {@link TopologyTracker} to add `subtask` edges and sync
 * agent status.
 *
 * @module WorkTree
 * @version 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Status of a work node */
export type WorkNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked';

/** A single node in the work tree */
export interface WorkNode {
  /** Unique work-item identifier */
  id: string;
  /** Parent work-item id (undefined for root) */
  parentId?: string;
  /** Human-readable label */
  label: string;
  /** Agent assigned to this work item (if any) */
  agent?: string;
  /** Current status */
  status: WorkNodeStatus;
  /** Depth in the tree (root = 0) */
  depth: number;
  /** Direct children ids (ordered) */
  children: string[];
  /** Tokens consumed by this node alone (not including children) */
  ownTokens: number;
  /** Rollup: total tokens including all descendants */
  totalTokens: number;
  /** Rollup: progress 0–1 based on completed descendants */
  progress: number;
  /** ISO 8601 created timestamp */
  createdAt: string;
  /** ISO 8601 last status change */
  updatedAt: string;
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}

/** Summary statistics for the entire tree */
export interface WorkTreeStats {
  /** Total node count */
  total: number;
  /** By status */
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  blocked: number;
  /** Overall progress 0–1 */
  progress: number;
  /** Aggregate tokens across all nodes */
  totalTokens: number;
  /** Max tree depth */
  maxDepth: number;
}

/** Flat representation of the tree for serialisation */
export interface WorkTreeSnapshot {
  /** Root node id */
  rootId: string;
  /** All nodes keyed by id */
  nodes: Record<string, WorkNode>;
  /** Tree-wide stats */
  stats: WorkTreeStats;
  /** ISO 8601 snapshot timestamp */
  timestamp: string;
}

/** Events emitted by WorkTree */
export interface WorkTreeEvents {
  'node:added': (node: WorkNode) => void;
  'node:removed': (id: string) => void;
  'node:status': (id: string, status: WorkNodeStatus, prev: WorkNodeStatus) => void;
  'node:tokens': (id: string, ownTokens: number, totalTokens: number) => void;
  'node:progress': (id: string, progress: number) => void;
  'tree:complete': (stats: WorkTreeStats) => void;
}

/** Options for auto-status rollup behaviour */
export interface WorkTreeOptions {
  /** Auto-complete a parent when all children complete (default: true) */
  autoCompleteParent?: boolean;
  /** Auto-fail a parent when any child fails (default: false) */
  autoFailParent?: boolean;
  /** Auto-block children when parent is not running (default: true) */
  autoBlockChildren?: boolean;
}

// ============================================================================
// WORK TREE
// ============================================================================

/**
 * Hierarchical task decomposition tree.
 *
 * ```typescript
 * const tree = new WorkTree('root', 'Build feature');
 * tree.addChild('root', { id: 'design', label: 'Design API' });
 * tree.addChild('root', { id: 'impl', label: 'Implement' });
 * tree.addChild('impl', { id: 'impl-auth', label: 'Auth module', agent: 'worker-1' });
 * tree.addChild('impl', { id: 'impl-db', label: 'DB schema', agent: 'worker-2' });
 *
 * tree.setStatus('impl-auth', 'running');
 * tree.setStatus('impl-auth', 'completed');
 * // impl.progress → 0.5 (1 of 2 children done)
 * ```
 */
export class WorkTree extends EventEmitter {
  private nodes: Map<string, WorkNode> = new Map();
  private readonly rootId: string;
  private readonly opts: Required<WorkTreeOptions>;

  constructor(
    rootId: string,
    rootLabel: string,
    options?: WorkTreeOptions,
  ) {
    super();
    this.rootId = rootId;
    this.opts = {
      autoCompleteParent: options?.autoCompleteParent ?? true,
      autoFailParent: options?.autoFailParent ?? false,
      autoBlockChildren: options?.autoBlockChildren ?? true,
    };

    const now = new Date().toISOString();
    const root: WorkNode = {
      id: rootId,
      parentId: undefined,
      label: rootLabel,
      status: 'pending',
      depth: 0,
      children: [],
      ownTokens: 0,
      totalTokens: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
    this.nodes.set(rootId, root);
    this.emit('node:added', { ...root });
  }

  // --------------------------------------------------------------------------
  // TREE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Add a child work item under a parent.
   * @throws if parentId does not exist or id is already taken.
   */
  addChild(
    parentId: string,
    child: {
      id: string;
      label: string;
      agent?: string;
      metadata?: Record<string, unknown>;
    },
  ): WorkNode {
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new Error(`WorkTree: parent '${parentId}' not found`);
    }
    if (this.nodes.has(child.id)) {
      throw new Error(`WorkTree: node '${child.id}' already exists`);
    }

    const now = new Date().toISOString();
    const node: WorkNode = {
      id: child.id,
      parentId,
      label: child.label,
      agent: child.agent,
      status: 'pending',
      depth: parent.depth + 1,
      children: [],
      ownTokens: 0,
      totalTokens: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: child.metadata ?? {},
    };

    this.nodes.set(child.id, node);
    parent.children.push(child.id);

    // Re-rollup from parent upward
    this.rollupFrom(parentId);

    this.emit('node:added', { ...node });
    return { ...node };
  }

  /**
   * Remove a node and all its descendants.
   * Cannot remove the root.
   * @returns number of nodes removed
   */
  removeSubtree(id: string): number {
    if (id === this.rootId) {
      throw new Error('WorkTree: cannot remove root node');
    }
    const node = this.nodes.get(id);
    if (!node) return 0;

    // Collect all descendants
    const toRemove = this.collectSubtree(id);

    // Detach from parent
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter(c => c !== id);
      }
    }

    // Remove all
    for (const rid of toRemove) {
      this.nodes.delete(rid);
      this.emit('node:removed', rid);
    }

    // Re-rollup from parent
    if (node.parentId) {
      this.rollupFrom(node.parentId);
    }

    return toRemove.length;
  }

  // --------------------------------------------------------------------------
  // STATUS
  // --------------------------------------------------------------------------

  /**
   * Set the status of a work node. Triggers rollup.
   */
  setStatus(id: string, status: WorkNodeStatus): void {
    const node = this.nodes.get(id);
    if (!node) return;

    const prev = node.status;
    if (prev === status) return;

    node.status = status;
    node.updatedAt = new Date().toISOString();
    this.emit('node:status', id, status, prev);

    // Rollup from this node's parent upward
    if (node.parentId) {
      this.rollupFrom(node.parentId);
    }

    // Auto-block children if parent is no longer running
    if (this.opts.autoBlockChildren && (status === 'failed' || status === 'skipped')) {
      this.blockDescendants(id);
    }

    // Check if entire tree is done
    this.checkTreeComplete();
  }

  /**
   * Add tokens to a work node. Rolls up totalTokens to ancestors.
   */
  addTokens(id: string, tokens: number): void {
    const node = this.nodes.get(id);
    if (!node || tokens <= 0) return;

    node.ownTokens += tokens;
    node.updatedAt = new Date().toISOString();

    // Rollup tokens from this node upward
    this.rollupTokensFrom(id);

    this.emit('node:tokens', id, node.ownTokens, node.totalTokens);
  }

  // --------------------------------------------------------------------------
  // QUERIES
  // --------------------------------------------------------------------------

  /** Get a single node (copy). */
  getNode(id: string): WorkNode | undefined {
    const n = this.nodes.get(id);
    return n ? { ...n, children: [...n.children] } : undefined;
  }

  /** Get the root node. */
  getRoot(): WorkNode {
    return this.getNode(this.rootId)!;
  }

  /** Get direct children of a node. */
  getChildren(id: string): WorkNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.children
      .map(cid => this.getNode(cid))
      .filter((n): n is WorkNode => n !== undefined);
  }

  /** Get all ancestors from node to root (excluding the node itself). */
  getAncestors(id: string): WorkNode[] {
    const result: WorkNode[] = [];
    let current = this.nodes.get(id);
    while (current?.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      result.push({ ...parent, children: [...parent.children] });
      current = parent;
    }
    return result;
  }

  /** Get all descendants (depth-first). */
  getDescendants(id: string): WorkNode[] {
    const result: WorkNode[] = [];
    const stack = [...(this.nodes.get(id)?.children ?? [])];
    while (stack.length > 0) {
      const cid = stack.pop()!;
      const node = this.nodes.get(cid);
      if (!node) continue;
      result.push({ ...node, children: [...node.children] });
      stack.push(...node.children);
    }
    return result;
  }

  /** Get all leaf nodes (no children). */
  getLeaves(): WorkNode[] {
    const result: WorkNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.children.length === 0) {
        result.push({ ...node, children: [] });
      }
    }
    return result;
  }

  /** Total node count. */
  size(): number {
    return this.nodes.size;
  }

  /** The root node id. */
  getRootId(): string {
    return this.rootId;
  }

  /** Compute tree-wide statistics. */
  stats(): WorkTreeStats {
    let total = 0, pending = 0, running = 0, completed = 0;
    let failed = 0, skipped = 0, blocked = 0;
    let totalTokens = 0, maxDepth = 0;

    for (const node of this.nodes.values()) {
      total++;
      if (node.depth > maxDepth) maxDepth = node.depth;
      totalTokens += node.ownTokens;

      switch (node.status) {
        case 'pending': pending++; break;
        case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
        case 'skipped': skipped++; break;
        case 'blocked': blocked++; break;
      }
    }

    const actionable = total - blocked - skipped;
    const progress = actionable > 0 ? completed / actionable : 0;

    return { total, pending, running, completed, failed, skipped, blocked, progress, totalTokens, maxDepth };
  }

  /** Full snapshot for serialisation. */
  snapshot(): WorkTreeSnapshot {
    const nodesObj: Record<string, WorkNode> = {};
    for (const [id, node] of this.nodes) {
      nodesObj[id] = { ...node, children: [...node.children] };
    }
    return {
      rootId: this.rootId,
      nodes: nodesObj,
      stats: this.stats(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Flatten the tree into a depth-first ordered array (for rendering).
   */
  flatten(): WorkNode[] {
    const result: WorkNode[] = [];
    const visit = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;
      result.push({ ...node, children: [...node.children] });
      for (const cid of node.children) {
        visit(cid);
      }
    };
    visit(this.rootId);
    return result;
  }

  /**
   * Build the tree from a flat list of tasks with dependencies.
   * Creates a virtual root if multiple top-level tasks exist.
   * Compatible with TaskDAG nodes from GoalDecomposer.
   */
  static fromTaskList(
    tasks: Array<{
      id: string;
      description: string;
      agent?: string;
      dependencies: string[];
      metadata?: Record<string, unknown>;
    }>,
    rootLabel = 'Goal',
    options?: WorkTreeOptions,
  ): WorkTree {
    // Find top-level tasks (no dependencies or dependencies outside this list)
    const taskIds = new Set(tasks.map(t => t.id));
    const topLevel = tasks.filter(
      t => t.dependencies.length === 0 || t.dependencies.every(d => !taskIds.has(d)),
    );

    const rootId = topLevel.length === 1 ? topLevel[0].id : '__root__';

    let tree: WorkTree;
    if (topLevel.length === 1) {
      tree = new WorkTree(rootId, topLevel[0].description, options);
      const root = tree.nodes.get(rootId)!;
      root.agent = topLevel[0].agent;
      root.metadata = topLevel[0].metadata ?? {};
    } else {
      tree = new WorkTree(rootId, rootLabel, options);
      // Add top-level tasks under root
      for (const t of topLevel) {
        tree.addChild(rootId, {
          id: t.id,
          label: t.description,
          agent: t.agent,
          metadata: t.metadata,
        });
      }
    }

    // Add remaining tasks under their last dependency (as parent)
    const added = new Set<string>([rootId, ...topLevel.map(t => t.id)]);
    const remaining = tasks.filter(t => !added.has(t.id));

    // Iteratively add tasks whose dependencies are already in the tree
    let lastSize = -1;
    while (remaining.length > 0 && remaining.length !== lastSize) {
      lastSize = remaining.length;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const t = remaining[i];
        // Find the last dependency that's already in the tree as the parent
        const parentId = [...t.dependencies].reverse().find(d => added.has(d));
        if (parentId) {
          tree.addChild(parentId, {
            id: t.id,
            label: t.description,
            agent: t.agent,
            metadata: t.metadata,
          });
          added.add(t.id);
          remaining.splice(i, 1);
        }
      }
    }

    // Any remaining tasks with unresolvable deps go under root
    for (const t of remaining) {
      tree.addChild(rootId, {
        id: t.id,
        label: t.description,
        agent: t.agent,
        metadata: t.metadata,
      });
    }

    return tree;
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  /** Collect all node ids in a subtree (including the root of the subtree). */
  private collectSubtree(id: string): string[] {
    const result: string[] = [id];
    const node = this.nodes.get(id);
    if (!node) return result;
    for (const cid of node.children) {
      result.push(...this.collectSubtree(cid));
    }
    return result;
  }

  /** Re-compute progress and auto-status from a node up to root. */
  private rollupFrom(startId: string): void {
    let currentId: string | undefined = startId;

    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;

      if (node.children.length > 0) {
        // Compute progress from children
        const children = node.children
          .map(cid => this.nodes.get(cid))
          .filter((n): n is WorkNode => n !== undefined);

        const completable = children.filter(
          c => c.status !== 'blocked' && c.status !== 'skipped',
        );
        const completedCount = children.filter(c => c.status === 'completed').length;
        const failedCount = children.filter(c => c.status === 'failed').length;

        const prevProgress = node.progress;
        node.progress = completable.length > 0 ? completedCount / completable.length : 0;

        if (node.progress !== prevProgress) {
          this.emit('node:progress', node.id, node.progress);
        }

        // Auto-complete parent
        if (
          this.opts.autoCompleteParent &&
          children.length > 0 &&
          children.every(c =>
            c.status === 'completed' || c.status === 'skipped',
          ) &&
          node.status !== 'completed'
        ) {
          const prev = node.status;
          node.status = 'completed';
          node.updatedAt = new Date().toISOString();
          this.emit('node:status', node.id, 'completed', prev);
        }

        // Auto-fail parent
        if (
          this.opts.autoFailParent &&
          failedCount > 0 &&
          node.status !== 'failed'
        ) {
          const prev = node.status;
          node.status = 'failed';
          node.updatedAt = new Date().toISOString();
          this.emit('node:status', node.id, 'failed', prev);
        }
      }

      // Rollup tokens
      this.recomputeTokens(node);

      currentId = node.parentId;
    }
  }

  /** Recompute totalTokens for a single node from its children. */
  private recomputeTokens(node: WorkNode): void {
    let childTokens = 0;
    for (const cid of node.children) {
      const child = this.nodes.get(cid);
      if (child) childTokens += child.totalTokens;
    }
    node.totalTokens = node.ownTokens + childTokens;
  }

  /** Rollup token totals from a node up to root. */
  private rollupTokensFrom(startId: string): void {
    let currentId: string | undefined = startId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      this.recomputeTokens(node);
      currentId = node.parentId;
    }
  }

  /** Block all pending descendants of a node. */
  private blockDescendants(parentId: string): void {
    const parent = this.nodes.get(parentId);
    if (!parent) return;

    for (const cid of parent.children) {
      const child = this.nodes.get(cid);
      if (!child) continue;
      if (child.status === 'pending') {
        const prev = child.status;
        child.status = 'blocked';
        child.updatedAt = new Date().toISOString();
        this.emit('node:status', cid, 'blocked', prev);
        // Recursively block
        this.blockDescendants(cid);
      }
    }
  }

  /** Check if the entire tree is done and emit tree:complete. */
  private checkTreeComplete(): void {
    const root = this.nodes.get(this.rootId);
    if (!root) return;

    const terminal: WorkNodeStatus[] = ['completed', 'failed', 'skipped', 'blocked'];
    const allDone = [...this.nodes.values()].every(n => terminal.includes(n.status));

    if (allDone) {
      this.emit('tree:complete', this.stats());
    }
  }
}

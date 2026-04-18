/**
 * Barnes-Hut QuadTree — Spatial indexing for O(n log n) force simulation
 *
 * Used by the topology dashboard to replace the naive O(n²) all-pairs
 * repulsion with Barnes-Hut approximation. Also provides viewport queries
 * for culling off-screen nodes.
 *
 * @module QuadTree
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** A 2D point with an identifier */
export interface QTPoint {
  id: string;
  x: number;
  y: number;
}

/** Axis-aligned bounding box */
export interface QTBounds {
  x: number;      // center x
  y: number;      // center y
  halfW: number;  // half width
  halfH: number;  // half height
}

/** Statistics about a QuadTree region (for Barnes-Hut) */
export interface QTMass {
  /** Total number of points in this region */
  count: number;
  /** Center of mass x */
  cx: number;
  /** Center of mass y */
  cy: number;
}

// ============================================================================
// QUADTREE NODE
// ============================================================================

const QT_CAPACITY = 8; // Points per leaf before subdividing

/**
 * A QuadTree for 2D spatial indexing with Barnes-Hut mass summaries.
 *
 * Usage:
 * ```typescript
 * const qt = new QuadTree({ x: 500, y: 400, halfW: 500, halfH: 400 });
 * qt.insert({ id: 'a', x: 100, y: 200 });
 * qt.insert({ id: 'b', x: 300, y: 150 });
 *
 * // Barnes-Hut force query (theta = 0.5)
 * qt.forceOnPoint(100, 200, 0.5, (cx, cy, mass, dx, dy, distSq) => {
 *   // Apply repulsion force from (cx, cy) with given mass
 * });
 *
 * // Viewport query
 * const visible = qt.queryRange({ x: 250, y: 250, halfW: 250, halfH: 250 });
 * ```
 */
export class QuadTree {
  private bounds: QTBounds;
  private points: QTPoint[] = [];
  private divided = false;
  private nw: QuadTree | null = null;
  private ne: QuadTree | null = null;
  private sw: QuadTree | null = null;
  private se: QuadTree | null = null;
  private mass: QTMass = { count: 0, cx: 0, cy: 0 };

  constructor(bounds: QTBounds) {
    this.bounds = bounds;
  }

  // --------------------------------------------------------------------------
  // INSERTION
  // --------------------------------------------------------------------------

  /**
   * Insert a point into the tree.
   * @returns true if inserted, false if out of bounds
   */
  insert(point: QTPoint): boolean {
    if (!this.containsPoint(point.x, point.y)) return false;

    // Update mass center incrementally
    const prev = this.mass.count;
    this.mass.cx = (this.mass.cx * prev + point.x) / (prev + 1);
    this.mass.cy = (this.mass.cy * prev + point.y) / (prev + 1);
    this.mass.count = prev + 1;

    if (!this.divided && this.points.length < QT_CAPACITY) {
      this.points.push(point);
      return true;
    }

    if (!this.divided) {
      this.subdivide();
    }

    if (this.nw!.insert(point)) return true;
    if (this.ne!.insert(point)) return true;
    if (this.sw!.insert(point)) return true;
    if (this.se!.insert(point)) return true;

    // Shouldn't happen if containsPoint passed, but safety fallback
    return false;
  }

  /**
   * Build the tree from an array of points (faster than individual inserts).
   */
  static build(points: QTPoint[], bounds: QTBounds): QuadTree {
    const tree = new QuadTree(bounds);
    for (const p of points) {
      tree.insert(p);
    }
    return tree;
  }

  // --------------------------------------------------------------------------
  // QUERIES
  // --------------------------------------------------------------------------

  /**
   * Find all points within a rectangular viewport.
   */
  queryRange(range: QTBounds): QTPoint[] {
    const found: QTPoint[] = [];
    this.queryRangeInto(range, found);
    return found;
  }

  private queryRangeInto(range: QTBounds, found: QTPoint[]): void {
    if (!this.intersects(range)) return;

    for (const p of this.points) {
      if (
        p.x >= range.x - range.halfW &&
        p.x <= range.x + range.halfW &&
        p.y >= range.y - range.halfH &&
        p.y <= range.y + range.halfH
      ) {
        found.push(p);
      }
    }

    if (this.divided) {
      this.nw!.queryRangeInto(range, found);
      this.ne!.queryRangeInto(range, found);
      this.sw!.queryRangeInto(range, found);
      this.se!.queryRangeInto(range, found);
    }
  }

  // --------------------------------------------------------------------------
  // BARNES-HUT FORCE TRAVERSAL
  // --------------------------------------------------------------------------

  /**
   * Traverse the tree with Barnes-Hut approximation for a single point.
   *
   * For each region, if the region is "far enough" (width/distance < theta),
   * treat it as a point mass at the center of mass. Otherwise recurse.
   *
   * @param px - Query point x
   * @param py - Query point y
   * @param theta - Opening angle threshold (0.5 is common, higher = faster but less accurate)
   * @param callback - Called for each mass interaction: (cx, cy, mass, dx, dy, distSq)
   */
  forceOnPoint(
    px: number,
    py: number,
    theta: number,
    callback: (cx: number, cy: number, mass: number, dx: number, dy: number, distSq: number) => void,
  ): void {
    if (this.mass.count === 0) return;

    const dx = this.mass.cx - px;
    const dy = this.mass.cy - py;
    const distSq = dx * dx + dy * dy;

    // If this is a leaf with points, interact directly
    if (!this.divided) {
      if (distSq > 0.01) {
        callback(this.mass.cx, this.mass.cy, this.mass.count, dx, dy, distSq);
      }
      return;
    }

    // Barnes-Hut criterion: region width / distance < theta → approximate
    const regionWidth = this.bounds.halfW * 2;
    if (regionWidth * regionWidth < theta * theta * distSq) {
      callback(this.mass.cx, this.mass.cy, this.mass.count, dx, dy, distSq);
      return;
    }

    // Recurse into children
    this.nw!.forceOnPoint(px, py, theta, callback);
    this.ne!.forceOnPoint(px, py, theta, callback);
    this.sw!.forceOnPoint(px, py, theta, callback);
    this.se!.forceOnPoint(px, py, theta, callback);
  }

  // --------------------------------------------------------------------------
  // ACCESSORS
  // --------------------------------------------------------------------------

  /** Total point count in this subtree */
  get count(): number {
    return this.mass.count;
  }

  /** The mass summary of this subtree */
  getMass(): QTMass {
    return { ...this.mass };
  }

  /** The bounds of this node */
  getBounds(): QTBounds {
    return { ...this.bounds };
  }

  /** Whether this node has been subdivided */
  get isSubdivided(): boolean {
    return this.divided;
  }

  // --------------------------------------------------------------------------
  // CLUSTERING SUPPORT
  // --------------------------------------------------------------------------

  /**
   * Get cluster summaries at a given depth or size threshold.
   * Returns groups of points that share a QuadTree cell below the given size.
   *
   * @param maxCellSize - Maximum cell width to stop recursing (in world units)
   * @returns Array of clusters, each with center, count, and contained point ids
   */
  getClusters(maxCellSize: number): Array<{ cx: number; cy: number; count: number; ids: string[] }> {
    const clusters: Array<{ cx: number; cy: number; count: number; ids: string[] }> = [];
    this.collectClusters(maxCellSize, clusters);
    return clusters;
  }

  private collectClusters(
    maxCellSize: number,
    out: Array<{ cx: number; cy: number; count: number; ids: string[] }>,
  ): void {
    if (this.mass.count === 0) return;

    const cellSize = this.bounds.halfW * 2;

    // If this cell is small enough OR is a leaf, emit as cluster
    if (cellSize <= maxCellSize || !this.divided) {
      const ids = this.collectAllIds();
      if (ids.length > 0) {
        out.push({
          cx: this.mass.cx,
          cy: this.mass.cy,
          count: this.mass.count,
          ids,
        });
      }
      return;
    }

    this.nw!.collectClusters(maxCellSize, out);
    this.ne!.collectClusters(maxCellSize, out);
    this.sw!.collectClusters(maxCellSize, out);
    this.se!.collectClusters(maxCellSize, out);
  }

  private collectAllIds(): string[] {
    const ids: string[] = [];
    for (const p of this.points) ids.push(p.id);
    if (this.divided) {
      ids.push(...this.nw!.collectAllIds());
      ids.push(...this.ne!.collectAllIds());
      ids.push(...this.sw!.collectAllIds());
      ids.push(...this.se!.collectAllIds());
    }
    return ids;
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  private subdivide(): void {
    const { x, y, halfW, halfH } = this.bounds;
    const qW = halfW / 2;
    const qH = halfH / 2;

    this.nw = new QuadTree({ x: x - qW, y: y - qH, halfW: qW, halfH: qH });
    this.ne = new QuadTree({ x: x + qW, y: y - qH, halfW: qW, halfH: qH });
    this.sw = new QuadTree({ x: x - qW, y: y + qH, halfW: qW, halfH: qH });
    this.se = new QuadTree({ x: x + qW, y: y + qH, halfW: qW, halfH: qH });

    // Re-insert existing points into children
    for (const p of this.points) {
      this.nw.insert(p) || this.ne.insert(p) || this.sw.insert(p) || this.se.insert(p);
    }
    this.points = [];
    this.divided = true;
  }

  private containsPoint(x: number, y: number): boolean {
    return (
      x >= this.bounds.x - this.bounds.halfW &&
      x <= this.bounds.x + this.bounds.halfW &&
      y >= this.bounds.y - this.bounds.halfH &&
      y <= this.bounds.y + this.bounds.halfH
    );
  }

  private intersects(range: QTBounds): boolean {
    return !(
      range.x - range.halfW > this.bounds.x + this.bounds.halfW ||
      range.x + range.halfW < this.bounds.x - this.bounds.halfW ||
      range.y - range.halfH > this.bounds.y + this.bounds.halfH ||
      range.y + range.halfH < this.bounds.y - this.bounds.halfH
    );
  }
}

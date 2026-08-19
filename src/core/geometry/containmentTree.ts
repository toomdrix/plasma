import { Path2DLoop, Point2D, Segment, ArcSegment } from '../../types/cam';

export class ContainmentTree {
  /**
   * Builds the containment hierarchy for closed loops, assigns nesting depth,
   * classifies as OUTER_PERIMETER vs INNER_HOLE, and enforces cut winding order:
   * - Outer perimeters (Depth 0, 2...): Clockwise (CW)
   * - Inner holes/cutouts (Depth 1, 3...): Counter-Clockwise (CCW)
   */
  public buildHierarchy(loops: Path2DLoop[]): Path2DLoop[] {
    if (loops.length === 0) return [];

    // Sort loops by area descending so outer boundaries are processed before inner holes
    const sorted = [...loops].sort((a, b) => b.area - a.area);
    const n = sorted.length;

    // containsMatrix[i][j] is true if loop i contains loop j
    const containsMatrix: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        // Bounding box quick rejection test
        if (this.boundsContain(sorted[i].bounds, sorted[j].bounds)) {
          // Accurate point-in-polygon containment test using sample points from loop j
          if (this.isLoopInsideLoop(sorted[j], sorted[i])) {
            containsMatrix[i][j] = true;
          }
        }
      }
    }

    // Direct parent detection: loop i is the direct parent of loop j if i contains j
    // and there is no intermediate k such that i contains k and k contains j
    const processedLoops: Path2DLoop[] = sorted.map((loop) => ({
      ...loop,
      parentId: null,
      childrenIds: [],
      nestingDepth: 0,
    }));

    for (let j = 0; j < n; j++) {
      let directParentIdx = -1;
      let minParentArea = Infinity;

      for (let i = 0; i < n; i++) {
        if (containsMatrix[i][j]) {
          if (sorted[i].area < minParentArea) {
            minParentArea = sorted[i].area;
            directParentIdx = i;
          }
        }
      }

      if (directParentIdx !== -1) {
        processedLoops[j].parentId = processedLoops[directParentIdx].id;
        processedLoops[directParentIdx].childrenIds.push(processedLoops[j].id);
      }
    }

    // Assign nesting depths
    for (let i = 0; i < n; i++) {
      let depth = 0;
      let currParentId = processedLoops[i].parentId;
      while (currParentId !== null) {
        depth++;
        const parent = processedLoops.find((l) => l.id === currParentId);
        currParentId = parent ? parent.parentId : null;
      }
      processedLoops[i].nestingDepth = depth;
    }

    // Classify and enforce winding order
    for (let i = 0; i < n; i++) {
      const loop = processedLoops[i];
      const isEvenDepth = loop.nestingDepth % 2 === 0;

      if (isEvenDepth) {
        // Outer profile -> Cut direction CW
        loop.classification = 'OUTER_PERIMETER';
        if (loop.windingOrder !== 'CW') {
          this.reverseLoop(loop);
        }
      } else {
        // Inner cutout / hole -> Cut direction CCW
        loop.classification = 'INNER_HOLE';
        if (loop.windingOrder !== 'CCW') {
          this.reverseLoop(loop);
        }
      }
    }

    return processedLoops;
  }

  private isLoopInsideLoop(inner: Path2DLoop, outer: Path2DLoop): boolean {
    // Test multiple sample points from inner loop against outer loop
    const testPoints: Point2D[] = [];

    if (inner.isCircularHole && inner.holeCenter) {
      testPoints.push(inner.holeCenter);
    }

    for (const seg of inner.segments) {
      testPoints.push(seg.start);
      if (seg.type === 'arc') {
        const arc = seg as ArcSegment;
        const midAngle = (arc.startAngle + arc.endAngle) / 2;
        testPoints.push({
          x: arc.center.x + arc.radius * Math.cos(midAngle),
          y: arc.center.y + arc.radius * Math.sin(midAngle),
        });
      }
    }

    let insideCount = 0;
    for (const pt of testPoints) {
      if (this.isPointInLoop(pt, outer)) {
        insideCount++;
      }
    }

    // Majority of points must be inside
    return insideCount > testPoints.length / 2;
  }

  public isPointInLoop(point: Point2D, loop: Path2DLoop): boolean {
    // Ray-Casting algorithm against polygon approximation of loop segments
    let inside = false;
    const px = point.x;
    const py = point.y;

    const polyPoints: Point2D[] = [];
    for (const seg of loop.segments) {
      polyPoints.push(seg.start);
      if (seg.type === 'arc') {
        // Discretize arc with intermediate samples
        const arc = seg as ArcSegment;
        let sweep = arc.clockwise
          ? (arc.startAngle - arc.endAngle + 2 * Math.PI) % (2 * Math.PI)
          : (arc.endAngle - arc.startAngle + 2 * Math.PI) % (2 * Math.PI);
        if (sweep === 0) sweep = 2 * Math.PI;

        const numSamples = Math.max(4, Math.ceil(sweep / (Math.PI / 8)));
        for (let s = 1; s < numSamples; s++) {
          const t = s / numSamples;
          const ang = arc.clockwise ? arc.startAngle - t * sweep : arc.startAngle + t * sweep;
          polyPoints.push({
            x: arc.center.x + arc.radius * Math.cos(ang),
            y: arc.center.y + arc.radius * Math.sin(ang),
          });
        }
      }
    }

    const n = polyPoints.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polyPoints[i].x;
      const yi = polyPoints[i].y;
      const xj = polyPoints[j].x;
      const yj = polyPoints[j].y;

      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }

    return inside;
  }

  private boundsContain(outer: { minX: number; minY: number; maxX: number; maxY: number }, inner: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
    return outer.minX <= inner.minX + 1e-4 &&
           outer.minY <= inner.minY + 1e-4 &&
           outer.maxX >= inner.maxX - 1e-4 &&
           outer.maxY >= inner.maxY - 1e-4;
  }

  private reverseLoop(loop: Path2DLoop) {
    const reversedSegs: Segment[] = [];
    for (let i = loop.segments.length - 1; i >= 0; i--) {
      const seg = loop.segments[i];
      if (seg.type === 'line') {
        reversedSegs.push({
          type: 'line',
          start: { ...seg.end },
          end: { ...seg.start },
        });
      } else {
        const arc = seg as ArcSegment;
        reversedSegs.push({
          type: 'arc',
          start: { ...arc.end },
          end: { ...arc.start },
          center: { ...arc.center },
          radius: arc.radius,
          startAngle: arc.endAngle,
          endAngle: arc.startAngle,
          clockwise: !arc.clockwise,
        });
      }
    }

    loop.segments = reversedSegs;
    loop.signedArea = -loop.signedArea;
    loop.windingOrder = loop.windingOrder === 'CW' ? 'CCW' : 'CW';
  }
}

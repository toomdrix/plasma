import { Segment, ArcSegment, Point2D, Path2DLoop, BoundingBox } from '../../types/cam';

export interface StitchResult {
  loops: Path2DLoop[];
  openPaths: Path2DLoop[];
  warnings: string[];
}

export class LoopStitcher {
  private tolerance: number;

  constructor(tolerance: number = 0.05) {
    this.tolerance = tolerance;
  }

  public stitch(segments: Segment[]): StitchResult {
    const warnings: string[] = [];
    const remaining = [...segments];
    const rawLoops: Segment[][] = [];
    const openLoops: Segment[][] = [];

    while (remaining.length > 0) {
      const currentLoop: Segment[] = [remaining.shift()!];
      let closed = false;

      while (true) {
        const loopStart = currentLoop[0].start;
        const loopEnd = currentLoop[currentLoop.length - 1].end;

        // Check if loop is already closed
        if (this.distance(loopStart, loopEnd) <= this.tolerance) {
          // Snap exact end to start
          currentLoop[currentLoop.length - 1].end = { ...loopStart };
          closed = true;
          break;
        }

        // Look for matching segment connected to loopEnd
        let matchIdx = -1;
        let reverseMatch = false;
        let attachToFront = false;

        for (let i = 0; i < remaining.length; i++) {
          const seg = remaining[i];

          // 1. Connect to loopEnd (normal)
          if (this.distance(loopEnd, seg.start) <= this.tolerance) {
            matchIdx = i;
            reverseMatch = false;
            attachToFront = false;
            break;
          }
          // 2. Connect to loopEnd (reversed)
          if (this.distance(loopEnd, seg.end) <= this.tolerance) {
            matchIdx = i;
            reverseMatch = true;
            attachToFront = false;
            break;
          }
          // 3. Connect to loopStart (prepend reversed)
          if (this.distance(loopStart, seg.start) <= this.tolerance) {
            matchIdx = i;
            reverseMatch = true;
            attachToFront = true;
            break;
          }
          // 4. Connect to loopStart (prepend normal)
          if (this.distance(loopStart, seg.end) <= this.tolerance) {
            matchIdx = i;
            reverseMatch = false;
            attachToFront = true;
            break;
          }
        }

        if (matchIdx !== -1) {
          let seg = remaining.splice(matchIdx, 1)[0];
          if (reverseMatch) {
            seg = this.reverseSegment(seg);
          }

          if (attachToFront) {
            // Snapping
            seg.end = { ...currentLoop[0].start };
            currentLoop.unshift(seg);
          } else {
            // Snapping
            seg.start = { ...currentLoop[currentLoop.length - 1].end };
            currentLoop.push(seg);
          }
        } else {
          // No contiguous segment found within tolerance
          break;
        }
      }

      if (closed || this.distance(currentLoop[0].start, currentLoop[currentLoop.length - 1].end) <= this.tolerance) {
        currentLoop[currentLoop.length - 1].end = { ...currentLoop[0].start };
        rawLoops.push(currentLoop);
      } else {
        openLoops.push(currentLoop);
        warnings.push(`Unclosed contour detected with ${currentLoop.length} segments.`);
      }
    }

    const closedLoops = rawLoops.map((segs, idx) => this.buildPathLoop(`loop-${idx}`, segs, true));
    const openPathLoops = openLoops.map((segs, idx) => this.buildPathLoop(`open-${idx}`, segs, false));

    return {
      loops: closedLoops,
      openPaths: openPathLoops,
      warnings,
    };
  }

  private reverseSegment(seg: Segment): Segment {
    if (seg.type === 'line') {
      return {
        type: 'line',
        start: { ...seg.end },
        end: { ...seg.start },
      };
    } else {
      const arc = seg as ArcSegment;
      return {
        type: 'arc',
        start: { ...arc.end },
        end: { ...arc.start },
        center: { ...arc.center },
        radius: arc.radius,
        startAngle: arc.endAngle,
        endAngle: arc.startAngle,
        clockwise: !arc.clockwise,
      };
    }
  }

  private buildPathLoop(id: string, segments: Segment[], isClosed: boolean): Path2DLoop {
    const bounds = this.calculateLoopBounds(segments);
    const { area, signedArea } = this.calculateLoopArea(segments);
    const circularHoleInfo = this.detectCircularHole(segments);

    return {
      id,
      segments,
      isClosed,
      classification: 'OUTER_PERIMETER', // Will be refined in containment tree
      windingOrder: signedArea >= 0 ? 'CCW' : 'CW',
      nestingDepth: 0,
      parentId: null,
      childrenIds: [],
      bounds,
      area,
      signedArea,
      isCircularHole: circularHoleInfo.isCircular,
      holeRadius: circularHoleInfo.radius,
      holeCenter: circularHoleInfo.center,
    };
  }

  private detectCircularHole(segments: Segment[]): { isCircular: boolean; radius?: number; center?: Point2D } {
    if (segments.length === 0) return { isCircular: false };

    // Check if loop consists solely of 1 or 2 or 4 arcs sharing the exact same center and radius
    const allArcs = segments.every((s) => s.type === 'arc');
    if (!allArcs) return { isCircular: false };

    const firstArc = segments[0] as ArcSegment;
    const center = firstArc.center;
    const radius = firstArc.radius;

    for (const seg of segments) {
      const arc = seg as ArcSegment;
      if (this.distance(center, arc.center) > this.tolerance || Math.abs(radius - arc.radius) > this.tolerance) {
        return { isCircular: false };
      }
    }

    return {
      isCircular: true,
      radius,
      center,
    };
  }

  private calculateLoopArea(segments: Segment[]): { area: number; signedArea: number } {
    // Green's Theorem for polygon + circular arc segments:
    // Signed Area = 1/2 * sum(x_i * y_{i+1} - x_{i+1} * y_i) + sum(arc_sagitta_areas)
    let chordSignedArea = 0;
    let arcAreaAdjustment = 0;

    for (const seg of segments) {
      const p1 = seg.start;
      const p2 = seg.end;
      chordSignedArea += p1.x * p2.y - p2.x * p1.y;

      if (seg.type === 'arc') {
        const arc = seg as ArcSegment;
        let sweep = arc.clockwise
          ? (arc.startAngle - arc.endAngle + 2 * Math.PI) % (2 * Math.PI)
          : (arc.endAngle - arc.startAngle + 2 * Math.PI) % (2 * Math.PI);
        if (sweep === 0) sweep = 2 * Math.PI;

        // Circular segment area = 1/2 * r^2 * (sweep - sin(sweep))
        const segmentArea = 0.5 * arc.radius * arc.radius * (sweep - Math.sin(sweep));
        // Add or subtract depending on winding
        const sign = arc.clockwise ? -1 : 1;
        arcAreaAdjustment += sign * segmentArea;
      }
    }

    const totalSignedArea = 0.5 * chordSignedArea + arcAreaAdjustment;
    return {
      signedArea: totalSignedArea,
      area: Math.abs(totalSignedArea),
    };
  }

  private calculateLoopBounds(segments: Segment[]): BoundingBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const seg of segments) {
      minX = Math.min(minX, seg.start.x, seg.end.x);
      minY = Math.min(minY, seg.start.y, seg.end.y);
      maxX = Math.max(maxX, seg.start.x, seg.end.x);
      maxY = Math.max(maxY, seg.start.y, seg.end.y);

      if (seg.type === 'arc') {
        const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
        for (const angle of angles) {
          if (this.isAngleOnArc(angle, seg)) {
            const exX = seg.center.x + seg.radius * Math.cos(angle);
            const exY = seg.center.y + seg.radius * Math.sin(angle);
            minX = Math.min(minX, exX);
            minY = Math.min(minY, exY);
            maxX = Math.max(maxX, exX);
            maxY = Math.max(maxY, exY);
          }
        }
      }
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  private isAngleOnArc(angle: number, arc: ArcSegment): boolean {
    const s = arc.startAngle;
    const e = arc.endAngle;
    const a = (angle + 2 * Math.PI) % (2 * Math.PI);

    if (arc.clockwise) {
      return s >= e ? a <= s && a >= e : a <= s || a >= e;
    } else {
      return s <= e ? a >= s && a <= e : a >= s || a <= e;
    }
  }

  private distance(p1: Point2D, p2: Point2D): number {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }
}

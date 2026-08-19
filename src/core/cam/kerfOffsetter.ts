import ClipperLib from 'clipper-lib';
import { Path2DLoop, Segment, ArcSegment, Point2D, CAMParameters } from '../../types/cam';

const SCALE = 100000; // 1mm = 100,000 Clipper integer units (0.01 micron precision)

export interface OffsetLoopResult {
  loopId: string;
  originalLoop: Path2DLoop;
  offsetSegments: Segment[];
  isCircularHole: boolean;
  holeRadius?: number;
  holeCenter?: Point2D;
  success: boolean;
  warning?: string;
}

export class KerfOffsetter {
  /**
   * Computes the kerf-compensated toolpath centerlines for all loops:
   * - Outer perimeters: offset OUTWARD by +kerf/2 (Clockwise cut direction)
   * - Inner holes/cutouts: offset INWARD by -kerf/2 (Counter-Clockwise cut direction)
   */
  public offsetLoops(loops: Path2DLoop[], params: CAMParameters): OffsetLoopResult[] {
    const results: OffsetLoopResult[] = [];
    const halfKerf = (params.kerfWidth || 0) / 2;

    for (const loop of loops) {
      if (loop.classification === 'OPEN_CONTOUR' || !loop.isClosed) {
        // Open contour: No kerf offset applied
        results.push({
          loopId: loop.id,
          originalLoop: loop,
          offsetSegments: [...loop.segments],
          isCircularHole: false,
          success: true,
          warning: 'Open contour: kerf offset bypassed.',
        });
        continue;
      }

      if (halfKerf <= 1e-4) {
        // Kerf is 0 -> toolpath equals CAD geometry
        results.push({
          loopId: loop.id,
          originalLoop: loop,
          offsetSegments: [...loop.segments],
          isCircularHole: Boolean(loop.isCircularHole),
          holeRadius: loop.holeRadius,
          holeCenter: loop.holeCenter,
          success: true,
        });
        continue;
      }

      // Exact analytical circular hole
      if (loop.isCircularHole && loop.holeCenter && loop.holeRadius !== undefined) {
        const offsetCircle = this.offsetCircularHole(loop, halfKerf);
        results.push(offsetCircle);
        continue;
      }

      // General polygon / arc loop offset via robust ClipperLib
      const offsetGeneral = this.offsetGeneralLoop(loop, halfKerf);
      results.push(offsetGeneral);
    }

    return results;
  }

  private offsetCircularHole(loop: Path2DLoop, halfKerf: number): OffsetLoopResult {
    const center = loop.holeCenter!;
    const isInner = loop.classification === 'INNER_HOLE';
    const delta = isInner ? -halfKerf : halfKerf;
    const newRadius = loop.holeRadius! + delta;

    if (newRadius <= 0.05) {
      return {
        loopId: loop.id,
        originalLoop: loop,
        offsetSegments: [],
        isCircularHole: true,
        holeRadius: loop.holeRadius,
        holeCenter: center,
        success: false,
        warning: `Hole diameter (${(loop.holeRadius! * 2).toFixed(2)}mm) is smaller than kerf width.`,
      };
    }

    // Generate circular toolpath with 2 half-circle arcs
    // Plasma cut direction: CCW for inner holes, CW for outer circles
    const clockwise = !isInner;
    const pRight: Point2D = { x: center.x + newRadius, y: center.y };
    const pLeft: Point2D = { x: center.x - newRadius, y: center.y };

    const offsetSegments: Segment[] = clockwise
      ? [
          {
            type: 'arc',
            start: pRight,
            end: pLeft,
            center,
            radius: newRadius,
            startAngle: 0,
            endAngle: Math.PI,
            clockwise: true,
          },
          {
            type: 'arc',
            start: pLeft,
            end: pRight,
            center,
            radius: newRadius,
            startAngle: Math.PI,
            endAngle: 0,
            clockwise: true,
          },
        ]
      : [
          {
            type: 'arc',
            start: pRight,
            end: pLeft,
            center,
            radius: newRadius,
            startAngle: 0,
            endAngle: Math.PI,
            clockwise: false,
          },
          {
            type: 'arc',
            start: pLeft,
            end: pRight,
            center,
            radius: newRadius,
            startAngle: Math.PI,
            endAngle: 2 * Math.PI,
            clockwise: false,
          },
        ];

    return {
      loopId: loop.id,
      originalLoop: loop,
      offsetSegments,
      isCircularHole: true,
      holeRadius: newRadius,
      holeCenter: center,
      success: true,
    };
  }

  private offsetGeneralLoop(loop: Path2DLoop, halfKerf: number): OffsetLoopResult {
    const isInner = loop.classification === 'INNER_HOLE';

    // Discretize loop into polygon vertices
    const polyPoints = this.discretizeLoop(loop, 0.005);
    if (polyPoints.length < 3) {
      return {
        loopId: loop.id,
        originalLoop: loop,
        offsetSegments: [...loop.segments],
        isCircularHole: false,
        success: false,
        warning: 'Degenerate loop with fewer than 3 vertices.',
      };
    }

    // Convert to ClipperLib format
    const path: { X: number; Y: number }[] = polyPoints.map((pt) => ({
      X: Math.round(pt.x * SCALE),
      Y: Math.round(pt.y * SCALE),
    }));

    // In ClipperLib:
    // Clipper.Orientation(path) === true means positive orientation (CCW in Cartesian)
    // For ClipperOffset:
    // If input is positive (CCW), positive delta inflates (expands outwards), negative delta deflates (shrinks inwards).
    const isPositive = ClipperLib.Clipper.Orientation(path);
    if (!isPositive) {
      path.reverse();
    }

    // Outer perimeters: +halfKerf (outward expansion)
    // Inner holes: -halfKerf (inward shrink)
    const deltaMm = isInner ? -halfKerf : halfKerf;
    const deltaUnits = Math.round(deltaMm * SCALE);

    // Miter join with miterLimit = 2.0 preserves sharp 90-degree corners perfectly
    const co = new ClipperLib.ClipperOffset(2.0, 0.25);
    co.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);

    const solution: { X: number; Y: number }[][] = new ClipperLib.Paths();
    co.Execute(solution, deltaUnits);

    if (!solution || solution.length === 0 || solution[0].length < 3) {
      return {
        loopId: loop.id,
        originalLoop: loop,
        offsetSegments: [],
        isCircularHole: false,
        success: false,
        warning: 'Kerf offset collapsed the geometry completely.',
      };
    }

    // Pick the largest solution contour if multiple were returned
    let bestSol = solution[0];
    let maxArea = Math.abs(ClipperLib.Clipper.Area(bestSol));
    for (let i = 1; i < solution.length; i++) {
      const a = Math.abs(ClipperLib.Clipper.Area(solution[i]));
      if (a > maxArea) {
        maxArea = a;
        bestSol = solution[i];
      }
    }

    // Enforce required plasma cut orientation:
    // Outer perimeters: Clockwise (CW -> Clipper Orientation = false)
    // Inner cutouts: Counter-Clockwise (CCW -> Clipper Orientation = true)
    const wantsPositive = isInner; // CCW for inner holes, CW for outer perimeters
    const currentOrientation = ClipperLib.Clipper.Orientation(bestSol);
    if (currentOrientation !== wantsPositive) {
      bestSol.reverse();
    }

    // Convert offset polygon vertices to clean LineSegments
    const offsetSegments: Segment[] = [];
    const numPts = bestSol.length;
    for (let i = 0; i < numPts; i++) {
      const p1: Point2D = {
        x: Number(bestSol[i].X) / SCALE,
        y: Number(bestSol[i].Y) / SCALE,
      };
      const p2: Point2D = {
        x: Number(bestSol[(i + 1) % numPts].X) / SCALE,
        y: Number(bestSol[(i + 1) % numPts].Y) / SCALE,
      };

      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 1e-4) {
        offsetSegments.push({
          type: 'line',
          start: p1,
          end: p2,
        });
      }
    }

    return {
      loopId: loop.id,
      originalLoop: loop,
      offsetSegments,
      isCircularHole: false,
      success: true,
    };
  }

  private discretizeLoop(loop: Path2DLoop, maxChordError: number = 0.005): Point2D[] {
    const points: Point2D[] = [];

    for (const seg of loop.segments) {
      if (seg.type === 'line') {
        points.push(seg.start);
      } else {
        const arc = seg as ArcSegment;
        let sweep = arc.clockwise
          ? (arc.startAngle - arc.endAngle + 2 * Math.PI) % (2 * Math.PI)
          : (arc.endAngle - arc.startAngle + 2 * Math.PI) % (2 * Math.PI);
        if (sweep === 0) sweep = 2 * Math.PI;

        const numSteps = Math.max(
          8,
          Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - maxChordError / Math.max(arc.radius, 0.1)))))
        );

        for (let s = 0; s < numSteps; s++) {
          const t = s / numSteps;
          const ang = arc.clockwise ? arc.startAngle - t * sweep : arc.startAngle + t * sweep;
          points.push({
            x: arc.center.x + arc.radius * Math.cos(ang),
            y: arc.center.y + arc.radius * Math.sin(ang),
          });
        }
      }
    }

    return points;
  }
}

import DxfParser from 'dxf-parser';
import { Point2D, Segment, LineSegment, ArcSegment, BoundingBox } from '../../types/cam';

export interface RawParsedEntities {
  segments: Segment[];
  bounds: BoundingBox;
  units: string;
  warnings: string[];
}

export class DXFReader {
  private parser: DxfParser;

  constructor() {
    this.parser = new DxfParser();
  }

  public parse(dxfContent: string): RawParsedEntities {
    const warnings: string[] = [];
    let dxf: any;

    try {
      dxf = this.parser.parseSync(dxfContent);
    } catch (err: any) {
      throw new Error(`DXF Parsing failed: ${err.message || err}`);
    }

    if (!dxf || !dxf.entities || dxf.entities.length === 0) {
      return {
        segments: [],
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
        units: 'mm',
        warnings: ['No geometric entities found in DXF file.'],
      };
    }

    const segments: Segment[] = [];
    const units = dxf.header?.$INSUNITS ? this.decodeUnits(dxf.header.$INSUNITS) : 'mm';

    for (const entity of dxf.entities) {
      try {
        switch (entity.type) {
          case 'LINE':
            this.parseLine(entity, segments);
            break;
          case 'ARC':
            this.parseArc(entity, segments);
            break;
          case 'CIRCLE':
            this.parseCircle(entity, segments);
            break;
          case 'LWPOLYLINE':
          case 'POLYLINE':
            this.parsePolyline(entity, segments);
            break;
          case 'SPLINE':
            this.parseSpline(entity, segments);
            break;
          default:
            // Non-supported entity types (e.g. TEXT, DIMENSION, MTEXT, 3DFACE)
            break;
        }
      } catch (err: any) {
        warnings.push(`Failed to parse entity ${entity.type}: ${err.message}`);
      }
    }

    const bounds = this.calculateBounds(segments);

    return {
      segments,
      bounds,
      units,
      warnings,
    };
  }

  private decodeUnits(insunits: number): string {
    switch (insunits) {
      case 1:
        return 'in';
      case 4:
        return 'mm';
      case 5:
        return 'cm';
      case 6:
        return 'm';
      default:
        return 'mm';
    }
  }

  private parseLine(entity: any, output: Segment[]) {
    const p1: Point2D = entity.vertices?.[0]
      ? { x: entity.vertices[0].x, y: entity.vertices[0].y }
      : { x: entity.start.x, y: entity.start.y };
    const p2: Point2D = entity.vertices?.[1]
      ? { x: entity.vertices[1].x, y: entity.vertices[1].y }
      : { x: entity.end.x, y: entity.end.y };

    if (this.distance(p1, p2) > 1e-6) {
      output.push({
        type: 'line',
        start: p1,
        end: p2,
      });
    }
  }

  private parseArc(entity: any, output: Segment[]) {
    const center: Point2D = { x: entity.center.x, y: entity.center.y };
    const radius = Number(entity.radius);
    if (radius <= 1e-6) return;

    // dxf-parser typically outputs angles in radians (or degrees in older versions)
    // In DXF format, angles are standard 0 to 360 degrees counter-clockwise from positive X-axis
    let startAngle = Number(entity.startAngle);
    let endAngle = Number(entity.endAngle);

    // If angles appear to be degrees (e.g. > 2*PI), convert to radians
    if (Math.abs(startAngle) > 2 * Math.PI || Math.abs(endAngle) > 2 * Math.PI) {
      startAngle = (startAngle * Math.PI) / 180;
      endAngle = (endAngle * Math.PI) / 180;
    }

    // Ensure angle normalization in [0, 2*PI)
    startAngle = (startAngle + 2 * Math.PI) % (2 * Math.PI);
    endAngle = (endAngle + 2 * Math.PI) % (2 * Math.PI);

    const start: Point2D = {
      x: center.x + radius * Math.cos(startAngle),
      y: center.y + radius * Math.sin(startAngle),
    };
    const end: Point2D = {
      x: center.x + radius * Math.cos(endAngle),
      y: center.y + radius * Math.sin(endAngle),
    };

    output.push({
      type: 'arc',
      start,
      end,
      center,
      radius,
      startAngle,
      endAngle,
      clockwise: false, // Standard DXF arcs are CCW
    });
  }

  private parseCircle(entity: any, output: Segment[]) {
    const center: Point2D = { x: entity.center.x, y: entity.center.y };
    const radius = Number(entity.radius);
    if (radius <= 1e-6) return;

    // Split circle into two 180-degree arcs (from 0 to PI and PI to 2*PI) for robust stitching
    const pRight: Point2D = { x: center.x + radius, y: center.y };
    const pLeft: Point2D = { x: center.x - radius, y: center.y };

    output.push({
      type: 'arc',
      start: pRight,
      end: pLeft,
      center,
      radius,
      startAngle: 0,
      endAngle: Math.PI,
      clockwise: false,
    });

    output.push({
      type: 'arc',
      start: pLeft,
      end: pRight,
      center,
      radius,
      startAngle: Math.PI,
      endAngle: 2 * Math.PI,
      clockwise: false,
    });
  }

  private parsePolyline(entity: any, output: Segment[]) {
    const vertices = entity.vertices || [];
    if (vertices.length < 2) return;

    const isClosed = Boolean(entity.shape || entity.closed);
    const count = isClosed ? vertices.length : vertices.length - 1;

    for (let i = 0; i < count; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % vertices.length];
      const p1: Point2D = { x: v1.x, y: v1.y };
      const p2: Point2D = { x: v2.x, y: v2.y };
      const bulge = v1.bulge || 0;

      if (this.distance(p1, p2) < 1e-6) continue;

      if (Math.abs(bulge) < 1e-6) {
        output.push({
          type: 'line',
          start: p1,
          end: p2,
        });
      } else {
        // Convert bulge to arc
        const arc = this.bulgeToArc(p1, p2, bulge);
        if (arc) output.push(arc);
      }
    }
  }

  private bulgeToArc(p1: Point2D, p2: Point2D, bulge: number): ArcSegment | null {
    // Bulge b = tan(theta / 4)
    // theta is the included angle of the arc in radians.
    // If b > 0: CCW, if b < 0: CW
    const theta = 4 * Math.atan(Math.abs(bulge));
    const chordDist = this.distance(p1, p2);
    if (chordDist < 1e-6) return null;

    const radius = chordDist / (2 * Math.sin(theta / 2));
    const sagitta = (chordDist / 2) * Math.abs(bulge);
    const midChord: Point2D = {
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    };

    // Vector from p1 to p2
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    // Normal vector perpendicular to chord
    // Sign depends on bulge sign
    const sign = bulge > 0 ? 1 : -1;
    const normX = (-dy / chordDist) * sign;
    const normY = (dx / chordDist) * sign;

    // Distance from midpoint of chord to center of arc: d = radius - sagitta (or computed by pythagoras)
    const d = radius * Math.cos(theta / 2);
    // If theta > PI, center is on the other side of chord
    const centerDir = theta <= Math.PI ? -1 : 1;

    const center: Point2D = {
      x: midChord.x + centerDir * d * normX,
      y: midChord.y + centerDir * d * normY,
    };

    let startAngle = Math.atan2(p1.y - center.y, p1.x - center.x);
    let endAngle = Math.atan2(p2.y - center.y, p2.x - center.x);

    startAngle = (startAngle + 2 * Math.PI) % (2 * Math.PI);
    endAngle = (endAngle + 2 * Math.PI) % (2 * Math.PI);

    return {
      type: 'arc',
      start: p1,
      end: p2,
      center,
      radius,
      startAngle,
      endAngle,
      clockwise: bulge < 0,
    };
  }

  private parseSpline(entity: any, output: Segment[]) {
    // DXF SPLINE discretization using control points / fit points
    const points: Point2D[] = (entity.controlPoints || entity.fitPoints || []).map((pt: any) => ({
      x: pt.x,
      y: pt.y,
    }));

    if (points.length < 2) return;

    if (points.length === 2) {
      output.push({ type: 'line', start: points[0], end: points[1] });
      return;
    }

    // Adaptive chordal cubic B-Spline interpolation
    const samples = Math.max(16, points.length * 8);
    let prevPt = this.evaluateSpline(points, 0);

    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const curPt = this.evaluateSpline(points, t);
      if (this.distance(prevPt, curPt) > 1e-4) {
        output.push({
          type: 'line',
          start: prevPt,
          end: curPt,
        });
        prevPt = curPt;
      }
    }
  }

  private evaluateSpline(points: Point2D[], t: number): Point2D {
    // Centripetal Catmull-Rom or de Casteljau interpolation across piecewise segments
    const n = points.length - 1;
    if (n === 1) {
      return {
        x: points[0].x + (points[1].x - points[0].x) * t,
        y: points[0].y + (points[1].y - points[0].y) * t,
      };
    }

    // Generalized Bézier curve evaluation (de Casteljau)
    let temp = points.map((p) => ({ ...p }));
    for (let k = 1; k <= n; k++) {
      for (let i = 0; i <= n - k; i++) {
        temp[i] = {
          x: (1 - t) * temp[i].x + t * temp[i + 1].x,
          y: (1 - t) * temp[i].y + t * temp[i + 1].y,
        };
      }
    }
    return temp[0];
  }

  private distance(p1: Point2D, p2: Point2D): number {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  private calculateBounds(segments: Segment[]): BoundingBox {
    if (segments.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }

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
        // Sample arc extremas along 0, 90, 180, 270 degrees if covered
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
}

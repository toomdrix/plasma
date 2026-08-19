import {
  ToolpathOperation,
  Segment,
  ArcSegment,
  Point2D,
  BoundingBox,
  CAMParameters,
  DatumOrigin,
} from '../../types/cam';

export class GRBLPostProcessor {
  /**
   * Generates GRBL v1.1 / NIST RS274NGC V3 compliant plasma G-code (.nc)
   * with standalone modal initialization headers, clean comment separation,
   * incremental I/J arc centers rounded strictly to 0.001mm precision,
   * floating-point dwell commands, and clean M5/M2 program termination.
   */
  public generate(
    operations: ToolpathOperation[],
    bounds: BoundingBox,
    params: CAMParameters
  ): {
    gcode: string;
    originShift: Point2D;
    totalCutLength: number;
    totalRapidLength: number;
    pierceCount: number;
    estimatedTimeSec: number;
  } {
    const originShift = this.computeOriginShift(bounds, params.datumOrigin, params.customOriginOffset);
    const lines: string[] = [];

    // Informational header comments (standalone lines)
    lines.push('( MicroPlasma CAM - GRBL Plasma Post-Processor )');
    lines.push(`( Material: ${params.materialPreset || 'Custom'} )`);
    lines.push(`( Feed: ${params.cutFeedRate} mm/min, Pierce Delay: ${this.fmtDwell(params.pierceDelay)}s, Kerf: ${params.kerfWidth} mm )`);
    lines.push(`( Datum: ${params.datumOrigin} )`);

    // Modal Initialization Header (G91.1 before G90 ensures buggy senders do not get stuck in G91)
    lines.push('G21');
    lines.push('G91.1');
    lines.push('G90');
    lines.push('G94');
    lines.push('G17');
    lines.push('');

    let totalCutLength = 0;
    let totalRapidLength = 0;
    let pierceCount = 0;
    let totalCutTimeMin = 0;
    let totalRapidTimeMin = 0;
    const RAPID_SPEED_MM_MIN = 6000;

    let currentPos: Point2D = { x: 0, y: 0 };

    for (let opIdx = 0; opIdx < operations.length; opIdx++) {
      const op = operations[opIdx];
      const opName =
        op.classification === 'INNER_HOLE'
          ? `Operation ${opIdx + 1}: Internal Cutout (${op.isCircularHole ? 'Hole' : 'Contour'})`
          : `Operation ${opIdx + 1}: Outer Perimeter`;

      lines.push(`( --- ${opName} --- )`);

      // 1. Rapid move to Pierce Point
      const pierceX = op.piercePoint.x + originShift.x;
      const pierceY = op.piercePoint.y + originShift.y;
      const rapidDist = Math.hypot(pierceX - currentPos.x, pierceY - currentPos.y);
      totalRapidLength += rapidDist;
      totalRapidTimeMin += rapidDist / RAPID_SPEED_MM_MIN;

      lines.push(`G0 X${this.fmt(pierceX)} Y${this.fmt(pierceY)}`);
      currentPos = { x: pierceX, y: pierceY };

      // 2. Torch ON & Dwell (clean lines without inline comments)
      lines.push('M3 S1000');
      if (params.pierceDelay > 0) {
        lines.push(`G4 P${this.fmtDwell(params.pierceDelay)}`);
      }
      pierceCount++;

      // 3. Lead-In Motion
      const opFeed = op.feedRate || params.cutFeedRate;
      if (op.leadIn.segments.length > 0) {
        lines.push(`( Lead-in @ F${opFeed} )`);
        for (const seg of op.leadIn.segments) {
          const segDist = this.emitSegmentGCode(seg, originShift, opFeed, lines, true);
          totalCutLength += segDist;
          totalCutTimeMin += segDist / opFeed;
          currentPos = { x: seg.end.x + originShift.x, y: seg.end.y + originShift.y };
        }
      }

      // 4. Main Cut Contour
      lines.push(`( Main Cut Contour @ F${opFeed} )`);
      for (const seg of op.cutPath) {
        const segDist = this.emitSegmentGCode(seg, originShift, opFeed, lines, false);
        totalCutLength += segDist;
        totalCutTimeMin += segDist / opFeed;
        currentPos = { x: seg.end.x + originShift.x, y: seg.end.y + originShift.y };
      }

      // 5. Overburn / Torch OFF handling
      if (op.overburn && op.overburn.segments.length > 0) {
        lines.push('M5');
        lines.push('( Overburn coasting through cut line )');
        for (const seg of op.overburn.segments) {
          const segDist = this.emitSegmentGCode(seg, originShift, opFeed, lines, false);
          totalCutLength += segDist;
          totalCutTimeMin += segDist / opFeed;
          currentPos = { x: seg.end.x + originShift.x, y: seg.end.y + originShift.y };
        }
      } else {
        // Torch OFF directly at end of cut
        lines.push('M5');
      }

      // 6. Lead-out if applicable
      if (op.leadOut && op.leadOut.segments.length > 0) {
        lines.push('( Lead-out )');
        for (const seg of op.leadOut.segments) {
          const segDist = this.emitSegmentGCode(seg, originShift, opFeed, lines, false);
          totalCutLength += segDist;
          totalCutTimeMin += segDist / opFeed;
          currentPos = { x: seg.end.x + originShift.x, y: seg.end.y + originShift.y };
        }
      }

      lines.push('');
    }

    // Program Termination Footer
    lines.push('( --- Footer --- )');
    const returnDist = Math.hypot(0 - currentPos.x, 0 - currentPos.y);
    totalRapidLength += returnDist;
    totalRapidTimeMin += returnDist / RAPID_SPEED_MM_MIN;

    lines.push('G0 X0 Y0');
    lines.push('M5');
    lines.push('M2');

    const estimatedTimeSec = Math.round(
      totalCutTimeMin * 60 + totalRapidTimeMin * 60 + pierceCount * (params.pierceDelay + 0.5)
    );

    // Verify all lines respect max 128 chars
    const gcode = lines.join('\n');
    for (const line of lines) {
      if (line.length > 128) {
        console.warn(`G-code line exceeds 128 chars (${line.length} chars): ${line}`);
      }
    }

    return {
      gcode,
      originShift,
      totalCutLength: Math.round(totalCutLength * 10) / 10,
      totalRapidLength: Math.round(totalRapidLength * 10) / 10,
      pierceCount,
      estimatedTimeSec,
    };
  }

  private emitSegmentGCode(
    seg: Segment,
    originShift: Point2D,
    feedRate: number,
    lines: string[],
    includeFeed: boolean
  ): number {
    const endX = seg.end.x + originShift.x;
    const endY = seg.end.y + originShift.y;
    const feedStr = includeFeed ? ` F${feedRate}` : '';

    if (seg.type === 'line') {
      const dist = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
      lines.push(`G1 X${this.fmt(endX)} Y${this.fmt(endY)}${feedStr}`);
      return dist;
    } else {
      const arc = seg as ArcSegment;
      const startX = arc.start.x + originShift.x;
      const startY = arc.start.y + originShift.y;
      const centerX = arc.center.x + originShift.x;
      const centerY = arc.center.y + originShift.y;

      // Incremental relative vector offsets from start vertex to center
      const iVal = centerX - startX;
      const jVal = centerY - startY;

      const gCodeCmd = arc.clockwise ? 'G2' : 'G3';
      lines.push(
        `${gCodeCmd} X${this.fmt(endX)} Y${this.fmt(endY)} I${this.fmt(iVal)} J${this.fmt(jVal)}${feedStr}`
      );

      let sweep = arc.clockwise
        ? (arc.startAngle - arc.endAngle + 2 * Math.PI) % (2 * Math.PI)
        : (arc.endAngle - arc.startAngle + 2 * Math.PI) % (2 * Math.PI);
      if (sweep === 0) sweep = 2 * Math.PI;

      return arc.radius * sweep;
    }
  }

  public computeOriginShift(
    bounds: BoundingBox,
    datum: DatumOrigin,
    customOffset?: Point2D
  ): Point2D {
    if (datum === 'CAD_ORIGIN') {
      return customOffset ? { x: -customOffset.x, y: -customOffset.y } : { x: 0, y: 0 };
    }

    const { minX, minY, maxX, maxY } = bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    switch (datum) {
      case 'BOTTOM_LEFT':
        return { x: -minX, y: -minY };
      case 'BOTTOM_CENTER':
        return { x: -midX, y: -minY };
      case 'BOTTOM_RIGHT':
        return { x: -maxX, y: -minY };
      case 'MIDDLE_LEFT':
        return { x: -minX, y: -midY };
      case 'CENTER':
        return { x: -midX, y: -midY };
      case 'MIDDLE_RIGHT':
        return { x: -maxX, y: -midY };
      case 'TOP_LEFT':
        return { x: -minX, y: -maxY };
      case 'TOP_CENTER':
        return { x: -midX, y: -maxY };
      case 'TOP_RIGHT':
        return { x: -maxX, y: -maxY };
      default:
        return { x: -minX, y: -minY };
    }
  }

  private fmt(val: number): string {
    // Strictly round to 3 decimal places (0.001mm) and strip negative zero
    const rounded = Math.round(val * 1000) / 1000;
    if (Math.abs(rounded) < 1e-5) return '0';
    return rounded.toFixed(3).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

  private fmtDwell(seconds: number): string {
    const rounded = Math.round(seconds * 1000) / 1000;
    if (Math.abs(rounded) < 1e-5) return '0';
    return rounded.toFixed(3).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }
}

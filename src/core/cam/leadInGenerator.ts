import {
  Point2D,
  Vector2D,
  Segment,
  ArcSegment,
  LeadInMotion,
  LeadOutMotion,
  CAMParameters,
  LoopClassification,
} from '../../types/cam';
import { OffsetLoopResult } from './kerfOffsetter';

export class LeadInGenerator {
  /**
   * Generates lead-in and lead-out motions for a toolpath loop:
   * - Outer profiles: Tangential arc starting in scrap outside part
   * - Standard inner cutouts: Tangential arc starting in scrap slug inside hole
   * - Small bolt holes (< 2 * leadInRadius): Center-point pierce + linear lead-in
   */
  public generate(
    offsetResult: OffsetLoopResult,
    params: CAMParameters,
    nodeIndexOverride?: number
  ): {
    leadIn: LeadInMotion;
    leadOut?: LeadOutMotion;
    reorderedSegments: Segment[];
    piercePoint: Point2D;
  } {
    const segments = offsetResult.offsetSegments;
    if (segments.length === 0) {
      const pZero: Point2D = { x: 0, y: 0 };
      return {
        leadIn: { piercePoint: pZero, entryPoint: pZero, segments: [] },
        reorderedSegments: [],
        piercePoint: pZero,
      };
    }

    const classification = offsetResult.originalLoop.classification;
    const isCircularHole = offsetResult.isCircularHole;
    const holeRadius = offsetResult.holeRadius;
    const holeCenter = offsetResult.holeCenter;

    // Determine start node / entry segment
    const startNode = (nodeIndexOverride !== undefined && nodeIndexOverride < segments.length)
      ? nodeIndexOverride
      : (offsetResult.originalLoop.leadInNodeIndex || 0);

    // Reorder segments so startNode is first
    const reorderedSegments = [
      ...segments.slice(startNode),
      ...segments.slice(0, startNode),
    ];

    const entryPoint = { ...reorderedSegments[0].start };
    const tangent = this.getSegmentTangentAtStart(reorderedSegments[0]);

    // Check for small bolt hole center-point pierce
    const effectiveLeadRadius = params.leadInRadius || 3.5;
    const holeDiameter = isCircularHole && holeRadius ? holeRadius * 2 : 0;

    if (
      classification === 'INNER_HOLE' &&
      isCircularHole &&
      holeCenter &&
      (params.leadInType === 'center_pierce' || holeDiameter < effectiveLeadRadius * 2.5)
    ) {
      // Center-point pierce
      const piercePoint: Point2D = { ...holeCenter };
      const leadInSegment: Segment = {
        type: 'line',
        start: piercePoint,
        end: entryPoint,
      };

      const leadIn: LeadInMotion = {
        piercePoint,
        entryPoint,
        segments: [leadInSegment],
      };

      return {
        leadIn,
        reorderedSegments,
        piercePoint,
      };
    }

    // Standard Tangential Arc or Linear Lead-In
    if (params.leadInType === 'line') {
      const leadIn = this.generateLinearLeadIn(entryPoint, tangent, params, classification);
      const leadOut = isCircularHole ? undefined : this.generateLeadOut(reorderedSegments, params, classification);
      return {
        leadIn,
        leadOut,
        reorderedSegments,
        piercePoint: leadIn.piercePoint,
      };
    } else {
      // Tangential Arc Lead-In (Default & Standard for Plasma)
      const leadIn = this.generateArcLeadIn(entryPoint, tangent, params, classification);
      const leadOut = isCircularHole ? undefined : this.generateLeadOut(reorderedSegments, params, classification);
      return {
        leadIn,
        leadOut,
        reorderedSegments,
        piercePoint: leadIn.piercePoint,
      };
    }
  }

  private generateArcLeadIn(
    entryPoint: Point2D,
    tangent: Vector2D,
    params: CAMParameters,
    classification: LoopClassification
  ): LeadInMotion {
    const R = Math.max(1.0, params.leadInRadius || 3.5);
    const sweepDeg = Math.max(30, Math.min(120, params.leadInSweepAngle || 90));
    const sweepRad = (sweepDeg * Math.PI) / 180;

    // Unit normal vector pointing to the LEFT into scrap material
    // Forward cut vector T = (Tx, Ty), Left Normal N = (-Ty, Tx)
    const normX = -tangent.y;
    const normY = tangent.x;

    // Arc center is placed at distance R in scrap direction
    const arcCenter: Point2D = {
      x: entryPoint.x + R * normX,
      y: entryPoint.y + R * normY,
    };

    // Vector from arcCenter to entryPoint
    const angleToEntry = Math.atan2(entryPoint.y - arcCenter.y, entryPoint.x - arcCenter.x);

    // An arc with center on the left turning into forward direction T travels CCW (G3)
    // Starting angle is angleToEntry - sweepRad
    const angleToPierce = angleToEntry - sweepRad;

    const piercePoint: Point2D = {
      x: arcCenter.x + R * Math.cos(angleToPierce),
      y: arcCenter.y + R * Math.sin(angleToPierce),
    };

    const startAngleNorm = (angleToPierce % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const endAngleNorm = (angleToEntry % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);

    const arcSegment: ArcSegment = {
      type: 'arc',
      start: piercePoint,
      end: entryPoint,
      center: arcCenter,
      radius: R,
      startAngle: startAngleNorm,
      endAngle: endAngleNorm,
      clockwise: false, // CCW arc blends with tangent T
    };

    const segments: Segment[] = [];
    // Optional straight lead-in extension
    if (params.leadInStraightLength && params.leadInStraightLength > 0) {
      const straightDirX = -Math.sin(angleToPierce);
      const straightDirY = Math.cos(angleToPierce);
      const straightPierce: Point2D = {
        x: piercePoint.x - params.leadInStraightLength * straightDirX,
        y: piercePoint.y - params.leadInStraightLength * straightDirY,
      };
      segments.push({
        type: 'line',
        start: straightPierce,
        end: piercePoint,
      });
      return {
        piercePoint: straightPierce,
        entryPoint,
        segments: [...segments, arcSegment],
      };
    }

    return {
      piercePoint,
      entryPoint,
      segments: [arcSegment],
    };
  }

  private generateLinearLeadIn(
    entryPoint: Point2D,
    tangent: Vector2D,
    params: CAMParameters,
    classification: LoopClassification
  ): LeadInMotion {
    const len = Math.max(1.0, params.leadInRadius || 3.5);
    // 45 degree angle into scrap
    const normX = -tangent.y;
    const normY = tangent.x;
    const dirX = (-tangent.x + normX) / Math.SQRT2;
    const dirY = (-tangent.y + normY) / Math.SQRT2;

    const piercePoint: Point2D = {
      x: entryPoint.x + len * dirX,
      y: entryPoint.y + len * dirY,
    };

    return {
      piercePoint,
      entryPoint,
      segments: [
        {
          type: 'line',
          start: piercePoint,
          end: entryPoint,
        },
      ],
    };
  }

  private generateLeadOut(
    segments: Segment[],
    params: CAMParameters,
    classification: LoopClassification
  ): LeadOutMotion | undefined {
    if (!params.leadOutLength || params.leadOutLength <= 0) return undefined;

    const lastSeg = segments[segments.length - 1];
    const exitPoint = { ...lastSeg.end };
    const tangent = this.getSegmentTangentAtEnd(lastSeg);

    // Tangent normal into scrap
    const normX = -tangent.y;
    const normY = tangent.x;
    const dirX = (tangent.x + normX) / Math.SQRT2;
    const dirY = (tangent.y + normY) / Math.SQRT2;

    const endPoint: Point2D = {
      x: exitPoint.x + params.leadOutLength * dirX,
      y: exitPoint.y + params.leadOutLength * dirY,
    };

    return {
      exitPoint,
      segments: [
        {
          type: 'line',
          start: exitPoint,
          end: endPoint,
        },
      ],
    };
  }

  private getSegmentTangentAtStart(seg: Segment): Vector2D {
    if (seg.type === 'line') {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    } else {
      const arc = seg as ArcSegment;
      const radX = (arc.start.x - arc.center.x) / arc.radius;
      const radY = (arc.start.y - arc.center.y) / arc.radius;
      return arc.clockwise ? { x: radY, y: -radX } : { x: -radY, y: radX };
    }
  }

  private getSegmentTangentAtEnd(seg: Segment): Vector2D {
    if (seg.type === 'line') {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    } else {
      const arc = seg as ArcSegment;
      const radX = (arc.end.x - arc.center.x) / arc.radius;
      const radY = (arc.end.y - arc.center.y) / arc.radius;
      return arc.clockwise ? { x: radY, y: -radX } : { x: -radY, y: radX };
    }
  }
}

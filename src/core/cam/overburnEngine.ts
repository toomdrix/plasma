import {
  Segment,
  ArcSegment,
  Point2D,
  OverburnMotion,
  CAMParameters,
} from '../../types/cam';

export class OverburnEngine {
  /**
   * Applies plasma-specific hole overrun and feed rate scaling.
   * For circular holes, computes overrun segment past 360° mark and scales feed rate if D < 30mm.
   */
  public process(
    segments: Segment[],
    isCircularHole: boolean,
    holeRadius: number | undefined,
    params: CAMParameters
  ): {
    feedRate: number;
    overburn?: OverburnMotion;
    isSmallHole: boolean;
  } {
    const baseFeed = params.cutFeedRate || 3000;
    const holeThreshold = params.smallHoleThreshold || 30.0;
    const feedScale = (params.smallHoleFeedScale || 60) / 100;
    const overburnDist = Math.max(0, params.overburnDistance || 3.0);

    let feedRate = baseFeed;
    let isSmallHole = false;

    if (isCircularHole && holeRadius !== undefined) {
      const diameter = holeRadius * 2;

      // Feed reduction for small holes
      if (diameter < holeThreshold) {
        feedRate = Math.round(baseFeed * feedScale);
        isSmallHole = true;
      }

      // Overburn calculation
      if (overburnDist > 0 && segments.length > 0) {
        const torchOffPoint = { ...segments[segments.length - 1].end };
        const overburnSegments = this.generateOverburnPath(segments, overburnDist);

        return {
          feedRate,
          isSmallHole,
          overburn: {
            torchOffPoint,
            segments: overburnSegments,
          },
        };
      }
    }

    return {
      feedRate,
      isSmallHole,
    };
  }

  private generateOverburnPath(segments: Segment[], distance: number): Segment[] {
    const overburnSegs: Segment[] = [];
    let remainingDist = distance;

    // Follow path from the beginning for 'distance' mm
    for (const seg of segments) {
      if (remainingDist <= 1e-4) break;

      if (seg.type === 'line') {
        const segLen = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
        if (segLen <= remainingDist) {
          overburnSegs.push({ ...seg });
          remainingDist -= segLen;
        } else {
          const t = remainingDist / segLen;
          overburnSegs.push({
            type: 'line',
            start: { ...seg.start },
            end: {
              x: seg.start.x + t * (seg.end.x - seg.start.x),
              y: seg.start.y + t * (seg.end.y - seg.start.y),
            },
          });
          remainingDist = 0;
        }
      } else {
        const arc = seg as ArcSegment;
        const arcLength = arc.radius * this.getArcSweep(arc);

        if (arcLength <= remainingDist) {
          overburnSegs.push({ ...arc });
          remainingDist -= arcLength;
        } else {
          // Truncate arc to remaining distance
          const subSweep = remainingDist / arc.radius;
          const subEndAngle = arc.clockwise
            ? arc.startAngle - subSweep
            : arc.startAngle + subSweep;

          const normEndAngle = (subEndAngle + 2 * Math.PI) % (2 * Math.PI);
          const endPt: Point2D = {
            x: arc.center.x + arc.radius * Math.cos(normEndAngle),
            y: arc.center.y + arc.radius * Math.sin(normEndAngle),
          };

          overburnSegs.push({
            type: 'arc',
            start: { ...arc.start },
            end: endPt,
            center: { ...arc.center },
            radius: arc.radius,
            startAngle: arc.startAngle,
            endAngle: normEndAngle,
            clockwise: arc.clockwise,
          });

          remainingDist = 0;
        }
      }
    }

    return overburnSegs;
  }

  private getArcSweep(arc: ArcSegment): number {
    let sweep = arc.clockwise
      ? (arc.startAngle - arc.endAngle + 2 * Math.PI) % (2 * Math.PI)
      : (arc.endAngle - arc.startAngle + 2 * Math.PI) % (2 * Math.PI);
    return sweep === 0 ? 2 * Math.PI : sweep;
  }
}

import {
  CAMParameters,
  ProcessedCAMPlan,
  Path2DLoop,
  ToolpathOperation,
  BoundingBox,
  Point2D,
} from '../../types/cam';
import { DXFReader } from '../dxf/dxfReader';
import { LoopStitcher } from '../geometry/loopStitcher';
import { ContainmentTree } from '../geometry/containmentTree';
import { KerfOffsetter } from './kerfOffsetter';
import { LeadInGenerator } from './leadInGenerator';
import { OverburnEngine } from './overburnEngine';
import { CutOrderOptimizer } from './cutOrderOptimizer';
import { GRBLPostProcessor } from '../gcode/grblPostProcessor';

export class CAMEngine {
  private dxfReader: DXFReader;
  private loopStitcher: LoopStitcher;
  private containmentTree: ContainmentTree;
  private kerfOffsetter: KerfOffsetter;
  private leadInGenerator: LeadInGenerator;
  private overburnEngine: OverburnEngine;
  private cutOrderOptimizer: CutOrderOptimizer;
  private postProcessor: GRBLPostProcessor;

  constructor() {
    this.dxfReader = new DXFReader();
    this.loopStitcher = new LoopStitcher(0.05);
    this.containmentTree = new ContainmentTree();
    this.kerfOffsetter = new KerfOffsetter();
    this.leadInGenerator = new LeadInGenerator();
    this.overburnEngine = new OverburnEngine();
    this.cutOrderOptimizer = new CutOrderOptimizer();
    this.postProcessor = new GRBLPostProcessor();
  }

  /**
   * Complete end-to-end processing pipeline from DXF string to G-code and interactive toolpaths
   */
  public processDXF(dxfContent: string, params: CAMParameters): ProcessedCAMPlan {
    const warnings: string[] = [];

    // 1. Parse DXF raw entities
    const rawData = this.dxfReader.parse(dxfContent);
    if (rawData.warnings.length > 0) {
      warnings.push(...rawData.warnings);
    }

    if (rawData.segments.length === 0) {
      return this.emptyPlan(warnings);
    }

    // 2. Stitch segments into closed loops & open contours
    const stitchResult = this.loopStitcher.stitch(rawData.segments);
    if (stitchResult.warnings.length > 0) {
      warnings.push(...stitchResult.warnings);
    }

    if (stitchResult.loops.length === 0 && stitchResult.openPaths.length === 0) {
      return this.emptyPlan(warnings);
    }

    // 3. Build containment tree & assign CW outer / CCW inner winding order
    const classifiedLoops = this.containmentTree.buildHierarchy(stitchResult.loops);

    // Combine closed loops and open contours
    const allLoops = [...classifiedLoops, ...stitchResult.openPaths];

    // 4. Compute toolpath operations from classified loops
    return this.generateCAMPlanFromLoops(allLoops, rawData.bounds, params, warnings);
  }

  /**
   * Recomputes toolpaths and G-code when parameters or node selections change without reparsing DXF
   */
  public generateCAMPlanFromLoops(
    loops: Path2DLoop[],
    bounds: BoundingBox,
    params: CAMParameters,
    existingWarnings: string[] = []
  ): ProcessedCAMPlan {
    const warnings = [...existingWarnings];

    // 1. Kerf Offsetting
    const offsetResults = this.kerfOffsetter.offsetLoops(loops, params);

    // 2. Generate Toolpath Operations (Lead-ins, Overburns, Feeds)
    const rawOperations: ToolpathOperation[] = [];

    for (const offsetRes of offsetResults) {
      if (!offsetRes.success || offsetRes.offsetSegments.length === 0) {
        if (offsetRes.warning) warnings.push(offsetRes.warning);
        continue;
      }

      // Lead-in generation
      const { leadIn, leadOut, reorderedSegments, piercePoint } =
        this.leadInGenerator.generate(offsetRes, params);

      // Overburn & Small hole feed reduction
      const { feedRate, overburn } = this.overburnEngine.process(
        reorderedSegments,
        offsetRes.isCircularHole,
        offsetRes.holeRadius,
        params
      );

      const effectiveLeadOut = (overburn && overburn.segments.length > 0) ? undefined : leadOut;

      const opStartPoint = leadIn.segments.length > 0 ? leadIn.segments[0].start : piercePoint;
      const opEndPoint = effectiveLeadOut && effectiveLeadOut.segments.length > 0
        ? effectiveLeadOut.segments[effectiveLeadOut.segments.length - 1].end
        : overburn && overburn.segments.length > 0
        ? overburn.segments[overburn.segments.length - 1].end
        : reorderedSegments[reorderedSegments.length - 1].end;

      const op: ToolpathOperation = {
        id: `op-${offsetRes.loopId}`,
        loopId: offsetRes.loopId,
        classification: offsetRes.originalLoop.classification,
        isCircularHole: offsetRes.isCircularHole,
        holeDiameter: offsetRes.holeRadius ? offsetRes.holeRadius * 2 : undefined,
        feedRate,
        piercePoint,
        leadIn,
        cutPath: reorderedSegments,
        overburn,
        leadOut: effectiveLeadOut,
        startPoint: opStartPoint,
        endPoint: opEndPoint,
      };

      rawOperations.push(op);
    }

    // 3. Cut Ordering & Rapid Optimization (Internal cutouts first, outer last)
    const { orderedOperations, rapidTravels } = this.cutOrderOptimizer.optimize(rawOperations);

    // 4. GRBL G-code Post-Processing
    const gcodeResult = this.postProcessor.generate(orderedOperations, bounds, params);

    return {
      originalLoops: loops,
      toolpaths: orderedOperations,
      rapidTravels,
      bounds,
      originShift: gcodeResult.originShift,
      totalCutLength: gcodeResult.totalCutLength,
      totalRapidLength: gcodeResult.totalRapidLength,
      pierceCount: gcodeResult.pierceCount,
      estimatedTimeSec: gcodeResult.estimatedTimeSec,
      warnings,
      gcode: gcodeResult.gcode,
    };
  }

  private emptyPlan(warnings: string[]): ProcessedCAMPlan {
    const emptyBounds: BoundingBox = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    return {
      originalLoops: [],
      toolpaths: [],
      rapidTravels: [],
      bounds: emptyBounds,
      originShift: { x: 0, y: 0 },
      totalCutLength: 0,
      totalRapidLength: 0,
      pierceCount: 0,
      estimatedTimeSec: 0,
      warnings,
      gcode: '',
    };
  }
}

import { describe, it, expect } from 'vitest';
import { DXFReader } from '../src/core/dxf/dxfReader';
import { LoopStitcher } from '../src/core/geometry/loopStitcher';
import { ContainmentTree } from '../src/core/geometry/containmentTree';
import { KerfOffsetter } from '../src/core/cam/kerfOffsetter';
import { LeadInGenerator } from '../src/core/cam/leadInGenerator';
import { OverburnEngine } from '../src/core/cam/overburnEngine';
import { CAMEngine } from '../src/core/cam/camEngine';
import { DEFAULT_CAM_PARAMETERS } from '../src/core/cam/presets';
import { SQUARE_WITH_CIRCLE_DXF, BULGE_SLOT_DXF } from './fixtures/sampleDxf';

describe('DXFReader & Geometry Parsing', () => {
  it('should parse 4 lines and 1 circle into segments with correct bounds', () => {
    const reader = new DXFReader();
    const result = reader.parse(SQUARE_WITH_CIRCLE_DXF);

    expect(result.segments.length).toBe(6); // 4 lines + 2 circle arcs
    expect(result.bounds.minX).toBeCloseTo(0, 1);
    expect(result.bounds.minY).toBeCloseTo(0, 1);
    expect(result.bounds.maxX).toBeCloseTo(100, 1);
    expect(result.bounds.maxY).toBeCloseTo(100, 1);
  });

  it('should parse LWPOLYLINE with arc bulges into lines and arcs', () => {
    const reader = new DXFReader();
    const result = reader.parse(BULGE_SLOT_DXF);

    expect(result.segments.length).toBe(4);
    const arcSegs = result.segments.filter((s) => s.type === 'arc');
    const lineSegs = result.segments.filter((s) => s.type === 'line');
    expect(arcSegs.length).toBe(2);
    expect(lineSegs.length).toBe(2);
  });
});

describe('LoopStitcher & ContainmentTree', () => {
  it('should stitch 4 lines and circle into 2 closed loops with correct containment', () => {
    const reader = new DXFReader();
    const stitcher = new LoopStitcher(0.05);
    const containment = new ContainmentTree();

    const raw = reader.parse(SQUARE_WITH_CIRCLE_DXF);
    const stitchRes = stitcher.stitch(raw.segments);

    expect(stitchRes.loops.length).toBe(2);
    expect(stitchRes.openPaths.length).toBe(0);

    const classified = containment.buildHierarchy(stitchRes.loops);
    expect(classified.length).toBe(2);

    const outer = classified.find((l) => l.classification === 'OUTER_PERIMETER');
    const inner = classified.find((l) => l.classification === 'INNER_HOLE');

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();

    // Outermost loop must be CW, Inner hole must be CCW for plasma squarer edge
    expect(outer?.windingOrder).toBe('CW');
    expect(inner?.windingOrder).toBe('CCW');
    expect(outer?.nestingDepth).toBe(0);
    expect(inner?.nestingDepth).toBe(1);
    expect(inner?.isCircularHole).toBe(true);
    expect(inner?.holeRadius).toBeCloseTo(10, 1);
  });
});

describe('KerfOffsetter & LeadInGenerator', () => {
  it('should offset outer loop outward and inner hole inward', () => {
    const cam = new CAMEngine();
    const params = {
      ...DEFAULT_CAM_PARAMETERS,
      kerfWidth: 1.2, // halfKerf = 0.6mm
    };

    const plan = cam.processDXF(SQUARE_WITH_CIRCLE_DXF, params);

    expect(plan.toolpaths.length).toBe(2);

    // Hole cut must be internal hole with smaller radius
    const holeOp = plan.toolpaths.find((op) => op.classification === 'INNER_HOLE')!;
    const outerOp = plan.toolpaths.find((op) => op.classification === 'OUTER_PERIMETER')!;

    expect(holeOp).toBeDefined();
    expect(outerOp).toBeDefined();

    // Internal hole radius should be 10mm - 0.6mm = 9.4mm
    expect(holeOp.holeDiameter).toBeCloseTo(18.8, 1);

    // Internal hole must be ordered first (index 0)
    expect(plan.toolpaths[0].id).toBe(holeOp.id);

    // Verify outer perimeter has exactly 4 perpendicular parallel segments
    expect(outerOp.cutPath.length).toBe(4);
    for (const seg of outerOp.cutPath) {
      expect(seg.type).toBe('line');
      const isHorizontal = Math.abs(seg.start.y - seg.end.y) < 1e-4;
      const isVertical = Math.abs(seg.start.x - seg.end.x) < 1e-4;
      expect(isHorizontal || isVertical).toBe(true);
    }
  });

  it('should apply small hole feed reduction for holes < 30mm', () => {
    const overburn = new OverburnEngine();
    const params = {
      ...DEFAULT_CAM_PARAMETERS,
      cutFeedRate: 3000,
      smallHoleThreshold: 30,
      smallHoleFeedScale: 60,
      overburnDistance: 3.0,
    };

    const result = overburn.process(
      [],
      true,
      10, // 20mm diameter < 30mm
      params
    );

    expect(result.isSmallHole).toBe(true);
    expect(result.feedRate).toBe(1800); // 60% of 3000
  });
});

describe('G-Code Generation & Output Formatting', () => {
  it('should generate valid GRBL G-code strictly conforming to GRBL v1.1 / NIST RS274NGC', () => {
    const cam = new CAMEngine();
    const params = {
      ...DEFAULT_CAM_PARAMETERS,
      datumOrigin: 'BOTTOM_LEFT' as const,
      pierceDelay: 0.5,
    };

    const plan = cam.processDXF(SQUARE_WITH_CIRCLE_DXF, params);
    const lines = plan.gcode.split('\n');

    // 1. Modal Initialization Header
    const gcodeOnly = lines.filter((l) => l.trim() && !l.startsWith('('));
    expect(gcodeOnly[0]).toBe('G21');
    expect(gcodeOnly[1]).toBe('G91.1');
    expect(gcodeOnly[2]).toBe('G90');
    expect(gcodeOnly[3]).toBe('G94');
    expect(gcodeOnly[4]).toBe('G17');

    // 2. Clean Comment Stripping: No executable line should contain '(' or ')'
    for (const line of gcodeOnly) {
      expect(line).not.toContain('(');
      expect(line).not.toContain(')');
    }

    // 3. Dwell formatting: G4 P0.5 on its own line
    expect(gcodeOnly).toContain('G4 P0.5');

    // 4. Clean Program Termination: Must end with M5 and M2
    const lastCmds = gcodeOnly.slice(-2);
    expect(lastCmds[0]).toBe('M5');
    expect(lastCmds[1]).toBe('M2');

    // 5. Line length constraint: No line must exceed 128 characters
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(128);
    }

    // 6. Arc precision: check arc moves (G2/G3) have I and J relative offsets
    const arcLines = gcodeOnly.filter((l) => /^G[23]\s/.test(l));
    expect(arcLines.length).toBeGreaterThan(0);
    for (const arc of arcLines) {
      expect(arc).toMatch(/I-?\d+(\.\d+)?/);
      expect(arc).toMatch(/J-?\d+(\.\d+)?/);
    }

    expect(plan.pierceCount).toBe(2);
    expect(plan.totalCutLength).toBeGreaterThan(400);
  });
});

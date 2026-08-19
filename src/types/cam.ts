export interface Point2D {
  x: number;
  y: number;
}

export interface Vector2D {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export type SegmentType = 'line' | 'arc';

export interface LineSegment {
  type: 'line';
  start: Point2D;
  end: Point2D;
}

export interface ArcSegment {
  type: 'arc';
  start: Point2D;
  end: Point2D;
  center: Point2D;
  radius: number;
  startAngle: number; // in radians
  endAngle: number;   // in radians
  clockwise: boolean;
}

export type Segment = LineSegment | ArcSegment;

export type LoopClassification = 'OUTER_PERIMETER' | 'INNER_HOLE' | 'OPEN_CONTOUR';
export type WindingOrder = 'CW' | 'CCW';

export interface Path2DLoop {
  id: string;
  segments: Segment[];
  isClosed: boolean;
  classification: LoopClassification;
  windingOrder: WindingOrder;
  nestingDepth: number; // 0 = outermost part, 1 = hole in part, 2 = island in hole, etc.
  parentId: string | null;
  childrenIds: string[];
  bounds: BoundingBox;
  area: number; // unsigned area in mm²
  signedArea: number;
  isCircularHole?: boolean;
  holeRadius?: number;
  holeCenter?: Point2D;
  leadInNodeIndex?: number; // Custom start node index along segments
  flipOffsetDirection?: boolean;
}

export type LeadInType = 'arc' | 'line' | 'center_pierce';

export interface CAMParameters {
  // Machine & Material
  materialPreset: string;
  cutFeedRate: number;       // mm/min
  pierceDelay: number;       // seconds (G4 P...)
  kerfWidth: number;         // mm

  // Lead-in & Lead-out
  leadInType: LeadInType;
  leadInRadius: number;      // mm (3-5mm)
  leadInSweepAngle: number;  // degrees (60-90)
  leadInStraightLength: number; // mm (optional lead-in straight leg)
  leadOutLength: number;     // mm (1-2mm)

  // Plasma Hole Specifics
  overburnDistance: number;  // mm (2.5-4.0mm)
  smallHoleThreshold: number;// mm (cut diameter < 30mm)
  smallHoleFeedScale: number;// percentage (e.g. 60%)

  // Datum Origin & Export Options
  datumOrigin: DatumOrigin;
  customOriginOffset?: Point2D;
  includeComments?: boolean;
}

export type DatumOrigin =
  | 'BOTTOM_LEFT'
  | 'BOTTOM_CENTER'
  | 'BOTTOM_RIGHT'
  | 'MIDDLE_LEFT'
  | 'CENTER'
  | 'MIDDLE_RIGHT'
  | 'TOP_LEFT'
  | 'TOP_CENTER'
  | 'TOP_RIGHT'
  | 'CAD_ORIGIN';

export interface PiercePoint {
  x: number;
  y: number;
  type: 'arc_lead_in' | 'center_pierce' | 'linear_lead_in';
}

export interface LeadInMotion {
  piercePoint: Point2D;
  entryPoint: Point2D;
  segments: Segment[];
}

export interface LeadOutMotion {
  exitPoint: Point2D;
  segments: Segment[];
}

export interface OverburnMotion {
  torchOffPoint: Point2D;
  segments: Segment[];
}

export interface ToolpathOperation {
  id: string;
  loopId: string;
  classification: LoopClassification;
  isCircularHole: boolean;
  holeDiameter?: number;
  feedRate: number; // Adjusted for small holes if applicable
  piercePoint: Point2D;
  leadIn: LeadInMotion;
  cutPath: Segment[];
  overburn?: OverburnMotion;
  leadOut?: LeadOutMotion;
  startPoint: Point2D;
  endPoint: Point2D;
}

export interface RapidTravel {
  from: Point2D;
  to: Point2D;
}

export interface ProcessedCAMPlan {
  originalLoops: Path2DLoop[];
  toolpaths: ToolpathOperation[];
  rapidTravels: RapidTravel[];
  bounds: BoundingBox;
  originShift: Point2D;
  totalCutLength: number;    // mm
  totalRapidLength: number;  // mm
  pierceCount: number;
  estimatedTimeSec: number;
  warnings: string[];
  gcode: string;
}

export interface MaterialPreset {
  id: string;
  name: string;
  thickness: string;
  feedRate: number;
  pierceDelay: number;
  kerfWidth: number;
  leadInRadius: number;
  overburnDistance: number;
  smallHoleFeedScale: number;
}

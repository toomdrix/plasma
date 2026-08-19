import {
  ProcessedCAMPlan,
  Point2D,
  Segment,
  ArcSegment,
  ToolpathOperation,
  RapidTravel,
  BoundingBox,
  Path2DLoop,
} from '../../types/cam';

export class Viewport2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private plan: ProcessedCAMPlan | null = null;

  // Viewport Transform (World to Screen)
  private scale: number = 1.0;
  private offsetX: number = 0;
  private offsetY: number = 0;

  // Dragging & Interaction State
  private isDragging: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private initialPinchDist: number = 0;
  private initialPinchScale: number = 1.0;

  // Selection & Hover
  private hoveredLoopId: string | null = null;
  private selectedLoopId: string | null = null;

  // Callback for loop click / start node cycling
  private onLoopClickCallback?: (loopId: string) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.initEventListeners();
    this.resize();
  }

  public setOnLoopClick(cb: (loopId: string) => void) {
    this.onLoopClickCallback = cb;
  }

  public setPlan(plan: ProcessedCAMPlan) {
    const isFirstLoad = !this.plan || this.plan.originalLoops.length === 0;
    this.plan = plan;
    if (isFirstLoad && plan.originalLoops.length > 0) {
      this.zoomToFit();
    } else {
      this.render();
    }
  }

  public resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.render();
  }

  public zoomToFit() {
    if (!this.plan || this.plan.originalLoops.length === 0) {
      this.render();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;
    const padding = 60; // pixels padding

    const b = this.plan.bounds;
    const partWidth = Math.max(b.width, 10);
    const partHeight = Math.max(b.height, 10);

    const scaleX = (width - padding * 2) / partWidth;
    const scaleY = (height - padding * 2) / partHeight;
    this.scale = Math.min(scaleX, scaleY);

    const partCenterX = (b.minX + b.maxX) / 2;
    const partCenterY = (b.minY + b.maxY) / 2;

    // In standard CAM coordinates, Y is UP. Canvas Y is DOWN.
    // Screen X = offsetX + worldX * scale
    // Screen Y = offsetY - worldY * scale
    this.offsetX = width / 2 - partCenterX * this.scale;
    this.offsetY = height / 2 + partCenterY * this.scale;

    this.render();
  }

  public render() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    this.ctx.save();
    this.ctx.scale(dpr, dpr);

    // 1. Background
    this.ctx.fillStyle = '#0f172a'; // Deep slate dark background
    this.ctx.fillRect(0, 0, width, height);

    // 2. Grid lines & Coordinate axes
    this.drawGrid(width, height);

    if (!this.plan || this.plan.originalLoops.length === 0) {
      this.drawEmptyState(width, height);
      this.ctx.restore();
      return;
    }

    // 3. Draw CAD Raw Geometry (Dark Slate / Grey)
    this.drawCADGeometry();

    // 4. Draw Rapid Travels (Dashed Yellow)
    this.drawRapidTravels(this.plan.rapidTravels);

    // 5. Draw Toolpaths (Lead-ins, Cut Paths, Overburn, Lead-out)
    this.drawToolpaths(this.plan.toolpaths);

    // 6. Draw Pierce Points (Vibrant Red with Halo)
    this.drawPiercePoints(this.plan.toolpaths);

    // 7. Draw Machine Origin (0,0) Crosshairs with Datum Anchor Indicator
    this.drawOriginIndicator();

    this.ctx.restore();
  }

  private drawGrid(width: number, height: number) {
    const stepMm = this.getGridStep(this.scale);
    const stepPixels = stepMm * this.scale;

    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = '#1e293b'; // subtle grid

    const startX = this.offsetX % stepPixels;
    const startY = this.offsetY % stepPixels;

    this.ctx.beginPath();
    for (let x = startX; x < width; x += stepPixels) {
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
    }
    for (let y = startY; y < height; y += stepPixels) {
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
    }
    this.ctx.stroke();
  }

  private getGridStep(scale: number): number {
    const minPixelSpacing = 40;
    const unitSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const step of unitSteps) {
      if (step * scale >= minPixelSpacing) return step;
    }
    return 100;
  }

  private drawCADGeometry() {
    if (!this.plan) return;

    this.ctx.lineWidth = 1.5;
    for (const loop of this.plan.originalLoops) {
      const isHovered = loop.id === this.hoveredLoopId;
      const isSelected = loop.id === this.selectedLoopId;

      this.ctx.strokeStyle = isSelected
        ? '#38bdf8'
        : isHovered
        ? '#94a3b8'
        : '#475569';

      this.ctx.beginPath();
      for (const seg of loop.segments) {
        this.renderSegment(seg);
      }
      this.ctx.stroke();
    }
  }

  private drawRapidTravels(rapids: RapidTravel[]) {
    this.ctx.save();
    this.ctx.setLineDash([5, 5]);
    this.ctx.strokeStyle = '#eab308'; // Dashed Amber/Yellow
    this.ctx.lineWidth = 1.2;

    this.ctx.beginPath();
    for (const r of rapids) {
      const p1 = this.worldToScreen(r.from);
      const p2 = this.worldToScreen(r.to);
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawToolpaths(operations: ToolpathOperation[]) {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      // 1. Lead-in (Vibrant Green)
      this.ctx.strokeStyle = '#10b981';
      this.ctx.lineWidth = 2.0;
      this.ctx.beginPath();
      for (const seg of op.leadIn.segments) {
        this.renderSegment(seg);
      }
      this.ctx.stroke();

      // 2. Main Kerf Cut Path (Plasma Cyan/Blue)
      this.ctx.strokeStyle = '#06b6d4';
      this.ctx.lineWidth = 2.5;
      this.ctx.beginPath();
      for (const seg of op.cutPath) {
        this.renderSegment(seg);
      }
      this.ctx.stroke();

      // 3. Overburn Segment (Amber)
      if (op.overburn && op.overburn.segments.length > 0) {
        this.ctx.strokeStyle = '#f59e0b';
        this.ctx.lineWidth = 3.0;
        this.ctx.beginPath();
        for (const seg of op.overburn.segments) {
          this.renderSegment(seg);
        }
        this.ctx.stroke();
      }

      // 4. Lead-out (Purple/Violet)
      if (op.leadOut && op.leadOut.segments.length > 0) {
        this.ctx.strokeStyle = '#a855f7';
        this.ctx.lineWidth = 2.0;
        this.ctx.beginPath();
        for (const seg of op.leadOut.segments) {
          this.renderSegment(seg);
        }
        this.ctx.stroke();
      }

      // 5. Sequence Number Tag at Pierce
      this.drawSequenceNumber(op, i + 1);
    }
  }

  private drawPiercePoints(operations: ToolpathOperation[]) {
    for (const op of operations) {
      const pt = this.worldToScreen(op.piercePoint);

      // Red Glow Halo
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      this.ctx.fill();

      // Pierce Center Dot
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      this.ctx.fillStyle = '#ef4444';
      this.ctx.fill();
    }
  }

  private drawSequenceNumber(op: ToolpathOperation, seq: number) {
    const pt = this.worldToScreen(op.piercePoint);

    this.ctx.save();
    this.ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    // Badge pill
    const tagY = pt.y - 12;
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    this.ctx.beginPath();
    this.ctx.roundRect(pt.x - 9, tagY - 7, 18, 14, 4);
    this.ctx.fill();

    this.ctx.strokeStyle = op.classification === 'INNER_HOLE' ? '#38bdf8' : '#fb923c';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    this.ctx.fillStyle = '#f8fafc';
    this.ctx.fillText(`${seq}`, pt.x, tagY);
    this.ctx.restore();
  }

  private drawOriginIndicator() {
    if (!this.plan) return;

    // Shifted Origin is at world coord -originShift
    const originWorld: Point2D = {
      x: -this.plan.originShift.x,
      y: -this.plan.originShift.y,
    };
    const pt = this.worldToScreen(originWorld);

    this.ctx.save();
    // Crosshairs
    this.ctx.strokeStyle = '#ef4444';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(pt.x - 14, pt.y);
    this.ctx.lineTo(pt.x + 14, pt.y);
    this.ctx.moveTo(pt.x, pt.y - 14);
    this.ctx.lineTo(pt.x, pt.y + 14);
    this.ctx.stroke();

    // Origin Circle
    this.ctx.beginPath();
    this.ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    this.ctx.strokeStyle = '#ef4444';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    this.ctx.fillStyle = '#ef4444';
    this.ctx.font = 'bold 10px monospace';
    this.ctx.fillText('(0,0)', pt.x + 12, pt.y - 4);
    this.ctx.restore();
  }

  private renderSegment(seg: Segment) {
    if (seg.type === 'line') {
      const p1 = this.worldToScreen(seg.start);
      const p2 = this.worldToScreen(seg.end);
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
    } else {
      const arc = seg as ArcSegment;
      const c = this.worldToScreen(arc.center);
      const r = arc.radius * this.scale;

      // Flip angles for screen coordinates where Y is inverted
      const sAngle = -arc.startAngle;
      const eAngle = -arc.endAngle;
      const anticlockwise = !arc.clockwise;

      this.ctx.arc(c.x, c.y, r, sAngle, eAngle, anticlockwise);
    }
  }

  private drawEmptyState(width: number, height: number) {
    this.ctx.save();
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '15px Inter, system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText('Drop a DXF file here or click "Upload DXF"', width / 2, height / 2);
    this.ctx.restore();
  }

  // World to Screen & Screen to World Coordinates
  public worldToScreen(p: Point2D): Point2D {
    return {
      x: this.offsetX + p.x * this.scale,
      y: this.offsetY - p.y * this.scale, // Y inverted for standard Cartesian CAM
    };
  }

  public screenToWorld(p: Point2D): Point2D {
    return {
      x: (p.x - this.offsetX) / this.scale,
      y: (this.offsetY - p.y) / this.scale,
    };
  }

  private initEventListeners() {
    // Mouse Pan & Zoom
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.offsetX += dx;
        this.offsetY += dy;
        this.render();
      } else {
        this.handleHover(e.clientX, e.clientY);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const newScale = Math.max(0.01, Math.min(100, this.scale * zoomFactor));

      // Zoom towards mouse pointer
      this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
      this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
      this.scale = newScale;

      this.render();
    }, { passive: false });

    // Touch Pinch & Pan Gestures for Mobile
    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.dragStartX = e.touches[0].clientX;
        this.dragStartY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        this.initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this.initialPinchScale = this.scale;
      }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.dragStartX;
        const dy = e.touches[0].clientY - this.dragStartY;
        this.dragStartX = e.touches[0].clientX;
        this.dragStartY = e.touches[0].clientY;
        this.offsetX += dx;
        this.offsetY += dy;
        this.render();
      } else if (e.touches.length === 2) {
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (this.initialPinchDist > 0) {
          const ratio = currentDist / this.initialPinchDist;
          this.scale = Math.max(0.01, Math.min(100, this.initialPinchScale * ratio));
          this.render();
        }
      }
    }, { passive: true });

    this.canvas.addEventListener('touchend', () => {
      this.isDragging = false;
      this.initialPinchDist = 0;
    });

    // Tap/Click to cycle lead-in start node
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldPos = this.screenToWorld({ x: mouseX, y: mouseY });

      if (this.plan && this.onLoopClickCallback) {
        for (const loop of this.plan.originalLoops) {
          if (this.isPointNearLoop(worldPos, loop, 10 / this.scale)) {
            this.selectedLoopId = loop.id;
            this.onLoopClickCallback(loop.id);
            this.render();
            break;
          }
        }
      }
    });

    window.addEventListener('resize', () => this.resize());
  }

  private handleHover(clientX: number, clientY: number) {
    if (!this.plan) return;
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;
    const worldPos = this.screenToWorld({ x: mouseX, y: mouseY });

    let foundId: string | null = null;
    for (const loop of this.plan.originalLoops) {
      if (this.isPointNearLoop(worldPos, loop, 8 / this.scale)) {
        foundId = loop.id;
        break;
      }
    }

    if (foundId !== this.hoveredLoopId) {
      this.hoveredLoopId = foundId;
      this.render();
    }
  }

  private isPointNearLoop(pt: Point2D, loop: Path2DLoop, threshold: number): boolean {
    for (const seg of loop.segments) {
      if (seg.type === 'line') {
        if (this.distToLineSegment(pt, seg.start, seg.end) <= threshold) return true;
      } else {
        const arc = seg as ArcSegment;
        const distToCenter = Math.hypot(pt.x - arc.center.x, pt.y - arc.center.y);
        if (Math.abs(distToCenter - arc.radius) <= threshold) return true;
      }
    }
    return false;
  }

  private distToLineSegment(p: Point2D, v: Point2D, w: Point2D): number {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  }
}

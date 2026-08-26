import { Viewport2D } from './ui/canvas/Viewport2D';
import { CAMEngine } from './core/cam/camEngine';
import { MATERIAL_PRESETS, DEFAULT_CAM_PARAMETERS } from './core/cam/presets';
import { SAMPLE_PARTS } from './ui/components/SampleParts';
import { GCodeModal } from './ui/components/GCodeModal';
import { CAMParameters, ProcessedCAMPlan, DatumOrigin, LeadInType, PositioningMode } from './types/cam';

class MicroPlasmaApp {
  private camEngine: CAMEngine;
  private viewport: Viewport2D;
  private gcodeModal: GCodeModal;

  private currentDxfContent: string = '';
  private currentFilename: string = 'sample-flange.dxf';
  private currentPlan: ProcessedCAMPlan | null = null;
  private params: CAMParameters = { ...DEFAULT_CAM_PARAMETERS };

  // DOM Elements
  private presetSelect!: HTMLSelectElement;
  private sampleSelect!: HTMLSelectElement;
  private fileInput!: HTMLInputElement;
  private btnUploadDxf!: HTMLElement;
  private btnExportGCode!: HTMLElement;
  private btnToggleSidebar!: HTMLElement;
  private btnZoomFit!: HTMLElement;
  private sidebarPanel!: HTMLElement;
  private dropZone!: HTMLElement;
  private warningsContainer!: HTMLElement;

  // Param Inputs
  private inputFeedRate!: HTMLInputElement;
  private inputPierceDelay!: HTMLInputElement;
  private inputKerfWidth!: HTMLInputElement;
  private inputLeadInRadius!: HTMLInputElement;
  private inputLeadInAngle!: HTMLInputElement;
  private inputLeadOutLength!: HTMLInputElement;
  private inputOverburn!: HTMLInputElement;
  private inputSmallHoleThreshold!: HTMLInputElement;
  private inputSmallHoleSpeedScale!: HTMLInputElement;
  private cadOriginToggle!: HTMLInputElement;
  private disableLaserModeToggle!: HTMLInputElement;
  private includeCommentsToggle!: HTMLInputElement;
  private leadInTypePills!: NodeListOf<HTMLElement>;
  private positioningModePills!: NodeListOf<HTMLElement>;
  private originNodes!: NodeListOf<HTMLElement>;
  private currentDatumLabel!: HTMLElement;

  // Stat Elements
  private statCutLength!: HTMLElement;
  private statRapidLength!: HTMLElement;
  private statPierceCount!: HTMLElement;
  private statEstTime!: HTMLElement;

  constructor() {
    this.camEngine = new CAMEngine();
    const canvas = document.getElementById('camViewport') as HTMLCanvasElement;
    this.viewport = new Viewport2D(canvas);
    this.gcodeModal = new GCodeModal();

    this.bindDOMElements();
    this.initPresetDropdown();
    this.initEventHandlers();
    this.syncInputsFromParams();

    // Setup loop click callback to cycle start node
    this.viewport.setOnLoopClick((loopId: string) => {
      this.cycleLoopStartNode(loopId);
    });

    // Load default sample part
    this.loadSamplePart('flange-bracket');
  }

  private bindDOMElements() {
    this.presetSelect = document.getElementById('presetSelect') as HTMLSelectElement;
    this.sampleSelect = document.getElementById('sampleSelect') as HTMLSelectElement;
    this.fileInput = document.getElementById('dxfFileInput') as HTMLInputElement;
    this.btnUploadDxf = document.getElementById('btnUploadDxf')!;
    this.btnExportGCode = document.getElementById('btnExportGCode')!;
    this.btnToggleSidebar = document.getElementById('btnToggleSidebar')!;
    this.btnZoomFit = document.getElementById('btnZoomFit')!;
    this.sidebarPanel = document.getElementById('sidebarPanel')!;
    this.dropZone = document.getElementById('dropZone')!;
    this.warningsContainer = document.getElementById('warningsContainer')!;

    this.inputFeedRate = document.getElementById('paramFeedRate') as HTMLInputElement;
    this.inputPierceDelay = document.getElementById('paramPierceDelay') as HTMLInputElement;
    this.inputKerfWidth = document.getElementById('paramKerfWidth') as HTMLInputElement;
    this.inputLeadInRadius = document.getElementById('paramLeadInRadius') as HTMLInputElement;
    this.inputLeadInAngle = document.getElementById('paramLeadInAngle') as HTMLInputElement;
    this.inputLeadOutLength = document.getElementById('paramLeadOutLength') as HTMLInputElement;
    this.inputOverburn = document.getElementById('paramOverburn') as HTMLInputElement;
    this.inputSmallHoleThreshold = document.getElementById('paramSmallHoleThreshold') as HTMLInputElement;
    this.inputSmallHoleSpeedScale = document.getElementById('paramSmallHoleSpeedScale') as HTMLInputElement;
    this.cadOriginToggle = document.getElementById('cadOriginToggle') as HTMLInputElement;
    this.disableLaserModeToggle = document.getElementById('disableLaserModeToggle') as HTMLInputElement;
    this.includeCommentsToggle = document.getElementById('includeCommentsToggle') as HTMLInputElement;
    this.leadInTypePills = document.querySelectorAll('#leadInTypeGroup .radio-pill');
    this.positioningModePills = document.querySelectorAll('#positioningModeGroup .radio-pill');
    this.originNodes = document.querySelectorAll('#originGrid .origin-node');
    this.currentDatumLabel = document.getElementById('currentDatumLabel')!;

    this.statCutLength = document.getElementById('statCutLength')!;
    this.statRapidLength = document.getElementById('statRapidLength')!;
    this.statPierceCount = document.getElementById('statPierceCount')!;
    this.statEstTime = document.getElementById('statEstTime')!;
  }

  private initPresetDropdown() {
    this.presetSelect.innerHTML = MATERIAL_PRESETS.map(
      (p) => `<option value="${p.id}">${p.name} (${p.thickness})</option>`
    ).join('');
    this.presetSelect.value = this.params.materialPreset;
  }

  private initEventHandlers() {
    // Preset changed
    this.presetSelect.addEventListener('change', () => {
      const presetId = this.presetSelect.value;
      const found = MATERIAL_PRESETS.find((p) => p.id === presetId);
      if (found) {
        this.params.materialPreset = found.id;
        this.params.cutFeedRate = found.feedRate;
        this.params.pierceDelay = found.pierceDelay;
        this.params.kerfWidth = found.kerfWidth;
        this.params.leadInRadius = found.leadInRadius;
        this.params.overburnDistance = found.overburnDistance;
        this.params.smallHoleFeedScale = found.smallHoleFeedScale;
        this.syncInputsFromParams();
        this.reprocessCAM();
      }
    });

    // Sample part changed
    this.sampleSelect.addEventListener('change', () => {
      const sampleId = this.sampleSelect.value;
      if (sampleId) {
        this.loadSamplePart(sampleId);
      }
    });

    // File Upload
    this.btnUploadDxf.addEventListener('click', () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener('change', (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files[0]) {
        const file = target.files[0];
        this.readDxfFile(file);
      }
    });

    // Drag and Drop
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.style.boxShadow = 'inset 0 0 0 2px var(--accent-plasma)';
    });

    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.style.boxShadow = 'none';
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.style.boxShadow = 'none';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        this.readDxfFile(e.dataTransfer.files[0]);
      }
    });

    // Zoom Fit Button
    this.btnZoomFit.addEventListener('click', () => {
      this.viewport.zoomToFit();
    });

    // Toggle Sidebar (Mobile)
    this.btnToggleSidebar.addEventListener('click', () => {
      this.sidebarPanel.classList.toggle('collapsed');
    });

    // Collapsible Sidebar Sections (Accordion)
    document.querySelectorAll('.panel-section .panel-header').forEach((header) => {
      header.addEventListener('click', () => {
        const section = header.closest('.panel-section');
        if (section) {
          section.classList.toggle('collapsed');
        }
      });
    });

    // Export G-Code Button
    this.btnExportGCode.addEventListener('click', () => {
      if (this.currentPlan && this.currentPlan.gcode) {
        this.gcodeModal.show(this.currentPlan.gcode, this.currentFilename);
      }
    });

    // Parameter Input Listeners
    const bindNumInput = (input: HTMLInputElement, key: keyof CAMParameters) => {
      input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        if (!isNaN(val)) {
          (this.params as any)[key] = val;
          this.reprocessCAM();
        }
      });
    };

    bindNumInput(this.inputFeedRate, 'cutFeedRate');
    bindNumInput(this.inputPierceDelay, 'pierceDelay');
    bindNumInput(this.inputKerfWidth, 'kerfWidth');
    bindNumInput(this.inputLeadInRadius, 'leadInRadius');
    bindNumInput(this.inputLeadInAngle, 'leadInSweepAngle');
    bindNumInput(this.inputLeadOutLength, 'leadOutLength');
    bindNumInput(this.inputOverburn, 'overburnDistance');
    bindNumInput(this.inputSmallHoleThreshold, 'smallHoleThreshold');
    bindNumInput(this.inputSmallHoleSpeedScale, 'smallHoleFeedScale');

    // Lead-In Type Pills
    this.leadInTypePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        this.leadInTypePills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.params.leadInType = pill.dataset.value as LeadInType;
        this.reprocessCAM();
      });
    });

    // Positioning Mode Pills (G91 Relative / G90 Absolute)
    this.positioningModePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        this.positioningModePills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.params.positioningMode = pill.dataset.value as PositioningMode;
        this.reprocessCAM();
      });
    });

    // 9-Point Origin Selector Grid
    this.originNodes.forEach((node) => {
      node.addEventListener('click', () => {
        if (this.cadOriginToggle.checked) {
          this.cadOriginToggle.checked = false;
        }
        this.originNodes.forEach((n) => n.classList.remove('active'));
        node.classList.add('active');
        this.params.datumOrigin = node.dataset.datum as DatumOrigin;
        this.updateDatumLabel();
        this.reprocessCAM();
      });
    });

    // CAD Origin Toggle
    this.cadOriginToggle.addEventListener('change', () => {
      if (this.cadOriginToggle.checked) {
        this.originNodes.forEach((n) => n.classList.remove('active'));
        this.params.datumOrigin = 'CAD_ORIGIN';
      } else {
        const firstNode = this.originNodes[6]; // BOTTOM_LEFT
        firstNode.classList.add('active');
        this.params.datumOrigin = firstNode.dataset.datum as DatumOrigin;
      }
      this.updateDatumLabel();
      this.reprocessCAM();
    });

    // Disable Laser Mode Toggle
    if (this.disableLaserModeToggle) {
      this.disableLaserModeToggle.addEventListener('change', () => {
        this.params.disableLaserMode = this.disableLaserModeToggle.checked;
        this.reprocessCAM();
      });
    }

    // Include Comments Toggle
    if (this.includeCommentsToggle) {
      this.includeCommentsToggle.addEventListener('change', () => {
        this.params.includeComments = this.includeCommentsToggle.checked;
        this.reprocessCAM();
      });
    }
  }

  private updateDatumLabel() {
    const formatted = this.params.datumOrigin
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('-');
    this.currentDatumLabel.textContent = formatted;
  }

  private syncInputsFromParams() {
    this.inputFeedRate.value = String(this.params.cutFeedRate);
    this.inputPierceDelay.value = String(this.params.pierceDelay);
    this.inputKerfWidth.value = String(this.params.kerfWidth);
    this.inputLeadInRadius.value = String(this.params.leadInRadius);
    this.inputLeadInAngle.value = String(this.params.leadInSweepAngle);
    this.inputLeadOutLength.value = String(this.params.leadOutLength);
    this.inputOverburn.value = String(this.params.overburnDistance);
    this.inputSmallHoleThreshold.value = String(this.params.smallHoleThreshold);
    this.inputSmallHoleSpeedScale.value = String(this.params.smallHoleFeedScale);
    if (this.disableLaserModeToggle) {
      this.disableLaserModeToggle.checked = this.params.disableLaserMode !== false;
    }
    if (this.includeCommentsToggle) {
      this.includeCommentsToggle.checked = Boolean(this.params.includeComments);
    }

    this.leadInTypePills.forEach((pill) => {
      if (pill.dataset.value === this.params.leadInType) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });

    this.positioningModePills.forEach((pill) => {
      const isMatch = (this.params.positioningMode || 'relative') === pill.dataset.value;
      if (isMatch) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });

    this.updateDatumLabel();
  }

  private readDxfFile(file: File) {
    this.currentFilename = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        this.currentDxfContent = content;
        this.processNewDXF();
      }
    };
    reader.readAsText(file);
  }

  private loadSamplePart(sampleId: string) {
    const sample = SAMPLE_PARTS.find((p) => p.id === sampleId);
    if (sample) {
      this.currentFilename = `${sample.id}.dxf`;
      this.currentDxfContent = sample.dxfContent;
      this.processNewDXF();
    }
  }

  private processNewDXF() {
    if (!this.currentDxfContent) return;

    try {
      this.currentPlan = this.camEngine.processDXF(this.currentDxfContent, this.params);
      this.viewport.setPlan(this.currentPlan);
      this.updateStatsAndWarnings();
    } catch (err: any) {
      alert(`Error processing DXF: ${err.message}`);
    }
  }

  private reprocessCAM() {
    if (!this.currentPlan || this.currentPlan.originalLoops.length === 0) {
      this.processNewDXF();
      return;
    }

    // Recompute CAM plan with updated parameters without re-parsing DXF
    this.currentPlan = this.camEngine.generateCAMPlanFromLoops(
      this.currentPlan.originalLoops,
      this.currentPlan.bounds,
      this.params,
      this.currentPlan.warnings
    );
    this.viewport.setPlan(this.currentPlan);
    this.updateStatsAndWarnings();
  }

  private cycleLoopStartNode(loopId: string) {
    if (!this.currentPlan) return;
    const loop = this.currentPlan.originalLoops.find((l) => l.id === loopId);
    if (loop && loop.segments.length > 1) {
      const curIndex = loop.leadInNodeIndex || 0;
      loop.leadInNodeIndex = (curIndex + 1) % loop.segments.length;
      this.reprocessCAM();
    }
  }

  private updateStatsAndWarnings() {
    if (!this.currentPlan) return;

    this.statCutLength.textContent = `${this.currentPlan.totalCutLength.toFixed(1)} mm`;
    this.statRapidLength.textContent = `${this.currentPlan.totalRapidLength.toFixed(1)} mm`;
    this.statPierceCount.textContent = `${this.currentPlan.pierceCount}`;

    const mins = Math.floor(this.currentPlan.estimatedTimeSec / 60);
    const secs = this.currentPlan.estimatedTimeSec % 60;
    this.statEstTime.textContent = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Warnings
    if (this.currentPlan.warnings.length > 0) {
      this.warningsContainer.style.display = 'flex';
      this.warningsContainer.innerHTML = `⚠️ ${this.currentPlan.warnings.join('<br>⚠️ ')}`;
    } else {
      this.warningsContainer.style.display = 'none';
      this.warningsContainer.innerHTML = '';
    }
  }
}

// Initialize application on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  new MicroPlasmaApp();
});

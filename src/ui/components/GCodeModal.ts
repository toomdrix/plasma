export class GCodeModal {
  private backdropEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private downloadBtn: HTMLElement;
  private copyBtn: HTMLElement;
  private closeBtn: HTMLElement;
  private currentGCode: string = '';
  private currentFilename: string = 'part.nc';

  constructor() {
    this.backdropEl = document.getElementById('gcodeModal')!;
    this.textareaEl = document.getElementById('gcodeContent') as HTMLTextAreaElement;
    this.downloadBtn = document.getElementById('btnDownloadModal')!;
    this.copyBtn = document.getElementById('btnCopyGCode')!;
    this.closeBtn = document.getElementById('btnCloseModal')!;

    this.initEvents();
  }

  public show(gcode: string, filename: string = 'part.nc') {
    this.currentGCode = gcode;
    this.currentFilename = filename.endsWith('.nc') ? filename : `${filename.replace(/\.[^/.]+$/, '')}.nc`;
    this.textareaEl.value = gcode;
    this.backdropEl.classList.add('open');
  }

  public hide() {
    this.backdropEl.classList.remove('open');
  }

  private initEvents() {
    this.closeBtn.addEventListener('click', () => this.hide());
    this.backdropEl.addEventListener('click', (e) => {
      if (e.target === this.backdropEl) this.hide();
    });

    this.copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.currentGCode);
        const originalText = this.copyBtn.innerHTML;
        this.copyBtn.innerHTML = '<span>✓ Copied!</span>';
        setTimeout(() => {
          this.copyBtn.innerHTML = originalText;
        }, 1500);
      } catch {
        this.textareaEl.select();
        document.execCommand('copy');
      }
    });

    this.downloadBtn.addEventListener('click', () => {
      this.downloadFile();
    });
  }

  public downloadFile() {
    if (!this.currentGCode) return;
    const blob = new Blob([this.currentGCode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.currentFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

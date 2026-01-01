import { formatNumber } from "../utils.js";

export class statsUI {
  constructor(rootElement) {
    this.root = rootElement;
  }

  displayStats(stats) {
    requestAnimationFrame(() => {
      const statsDiv = this.root?.querySelector(".zap-stats");
      if (!statsDiv) {
        console.warn('[statsUI] Stats container not found');
        return;
      }

      try {
        let html;
        if (!stats) {
          html = this.createZeroStats();
        } else if (stats.skeleton) {
          html = this.#createSkeletonStats();
        } else if (stats.error || stats.timeout) {
          html = this.createZeroStats();
        } else {
          html = this.createNormalStats(stats);
        }

        statsDiv.innerHTML = html;
      } catch (error) {
        console.error('[statsUI] Error displaying stats:', error);
        statsDiv.innerHTML = this.createZeroStats();
      }
    });
  }

  #createSkeletonStats() {
    return `
      <div class="stats-item">Total zaps</div>
      <div class="stats-item"><span class="number skeleton">...</span></div>
      <div class="stats-item">zaps</div>
      <div class="stats-item">Total amount</div>
      <div class="stats-item"><span class="number skeleton">...</span></div>
      <div class="stats-item">sats</div>
      <div class="stats-item">Max zap</div>
      <div class="stats-item"><span class="number skeleton">...</span></div>
      <div class="stats-item">sats</div>
    `;
  }

  createZeroStats() {
    return `
      <div class="stats-item">Total zaps</div>
      <div class="stats-item"><span class="number text-muted">0</span></div>
      <div class="stats-item">zaps</div>
      <div class="stats-item">Total amount</div>
      <div class="stats-item"><span class="number text-muted">0</span></div>
      <div class="stats-item">sats</div>
      <div class="stats-item">Max zap</div>
      <div class="stats-item"><span class="number text-muted">0</span></div>
      <div class="stats-item">sats</div>
    `;
  }

  createNormalStats(stats) {
    return `
      <div class="stats-item">Total zaps</div>
      <div class="stats-item"><span class="number">${formatNumber(
        stats.count
      )}</span></div>
      <div class="stats-item">zaps</div>
      <div class="stats-item">Total amount</div>
      <div class="stats-item"><span class="number">${formatNumber(
        Math.floor(stats.msats / 1000)
      )}</span></div>
      <div class="stats-item">sats</div>
      <div class="stats-item">Max zap</div>
      <div class="stats-item"><span class="number">${formatNumber(
        Math.floor(stats.maxMsats / 1000)
      )}</span></div>
      <div class="stats-item">sats</div>
    `;
  }
}

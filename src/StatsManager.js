export class StatsManager {
  // Stats were removed by design:
  // - no external APIs
  // - no totals displayed
  // Keep a minimal class here only for backward compatibility in case
  // older code still imports/instantiates it.
  async initializeStats(_identifier, _viewId, _showSkeleton = false) {
    return null;
  }

  getCurrentStats(_viewId) {
    return null;
  }

  async handleZapEvent(_event, _viewId, _identifier) {
    return;
  }
}

export const statsManager = new StatsManager();

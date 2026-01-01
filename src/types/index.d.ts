declare module 'nostr-zap' {
  export interface ViewerConfigType {
    relayUrls: string[];
    pubkey?: string;
    noteId?: string;
    colorMode?: boolean;
  }

  export class ViewerConfig {
    static fromButton(button: HTMLButtonElement): ViewerConfigType | null;
  }

  export interface ProfilePool {
    fetchProfiles(pubkeys: string[]): Promise<void>;
  }

  export interface EventPool {
    connectToRelays(urls: string[]): Promise<void>;
  }

  export interface SubscriptionManager {
    setViewConfig(viewId: string, config: ViewerConfigType): void;
    setupInfiniteScroll(viewId: string): void;
    initializeSubscriptions(config: ViewerConfigType, viewId: string): Promise<void>;
  }

  export interface CacheManager {
    getZapEvents(viewId: string): any[];
    processCachedData(viewId: string, config: ViewerConfigType): Promise<{
      hasEnoughCachedEvents: boolean;
    }>;
  }

  export const profilePool: ProfilePool;
  export const eventPool: EventPool;
  export const APP_CONFIG: any;
  export const cacheManager: CacheManager;
  export const subscriptionManager: SubscriptionManager;

  export function initialize(options?: Record<string, any>): void;
  export function nostrZapView(options?: Record<string, any>): void;

  // --- merged nostr-zap API (formerly a separate package) ---
  export interface NostrZapApi {
    init(params: {
      npub: string;
      noteId?: string;
      naddr?: string;
      relays?: string;
      cachedAmountDialog?: any;
      buttonColor?: string;
      anon?: boolean;
    }): Promise<any>;
    initTarget(targetEl: HTMLElement): void;
    initTargets(selector?: string): void;
    injectCSS(): void;
    autoInitializeZapButtons(): void;
    canUseNip07(): boolean;
  }

  export const nostrZap: NostrZapApi;
  export const zapInit: NostrZapApi["init"];
  export const zapInitTarget: NostrZapApi["initTarget"];
  export const zapInitTargets: NostrZapApi["initTargets"];
  export const zapInjectCSS: NostrZapApi["injectCSS"];
  export const autoInitializeZapButtons: NostrZapApi["autoInitializeZapButtons"];
  export const canUseNip07: NostrZapApi["canUseNip07"];
}

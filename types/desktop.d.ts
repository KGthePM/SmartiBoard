export {};

export type DesktopUpdateState = {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'disabled';
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  error?: string;
};

type DesktopBridge = {
  getInfo(): Promise<{
    version: string;
    update: DesktopUpdateState;
    releasesUrl: string;
  } | null>;
  checkForUpdates(): Promise<DesktopUpdateState | null>;
  downloadUpdate(): Promise<DesktopUpdateState | null>;
  restartAndInstall(): Promise<boolean>;
  setCloseHandler(handler: () => Promise<{ ok: boolean; error?: string }>): void;
  clearCloseHandler(): void;
  setCloseCancelledHandler(handler: () => void): void;
  clearCloseCancelledHandler(): void;
  onUpdateState(handler: (state: DesktopUpdateState) => void): () => void;
};

declare global {
  interface Window {
    smartiDesktop?: DesktopBridge;
  }
}

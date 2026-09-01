'use client';

import { useEffect, useState } from 'react';
import type { DesktopUpdateState } from '@/types/desktop';

export function DesktopUpdateSection() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [releasesUrl, setReleasesUrl] = useState('');

  useEffect(() => {
    const desktop = window.smartiDesktop;
    if (!desktop) return;
    let cancelled = false;
    void desktop.getInfo().then((info) => {
      if (!cancelled && info) {
        setState(info.update);
        setReleasesUrl(info.releasesUrl);
      }
    });
    const off = desktop.onUpdateState((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!state || !window.smartiDesktop) return null;

  const label = (() => {
    switch (state.phase) {
      case 'checking':
        return 'Checking for updates…';
      case 'current':
        return 'You have the latest version.';
      case 'available':
        return `Version ${state.availableVersion} is available.`;
      case 'downloading':
        return `Downloading${typeof state.percent === 'number' ? ` · ${Math.round(state.percent)}%` : '…'}`;
      case 'downloaded':
        return `Version ${state.availableVersion} is ready to install.`;
      case 'error':
        return state.error || 'The update check failed.';
      case 'disabled':
        return 'Updates are disabled in this development build.';
      default:
        return 'Updates have not been checked yet.';
    }
  })();

  const checking = state.phase === 'checking';
  return (
    <section className="desktop-update" aria-label="About and updates">
      <span className="settings-label">About &amp; updates</span>
      <strong>Smarti Board {state.currentVersion}</strong>
      <span className={state.phase === 'error' ? 'desktop-update-error' : 'settings-hint'}>{label}</span>
      <div className="desktop-update-actions">
        {state.phase === 'available' ? (
          <button className="settings-link" onClick={() => void window.smartiDesktop?.downloadUpdate()}>
            Download update
          </button>
        ) : state.phase === 'downloaded' ? (
          <button className="settings-link" onClick={() => void window.smartiDesktop?.restartAndInstall()}>
            Restart and update
          </button>
        ) : (
          <button
            className="settings-link"
            disabled={checking || state.phase === 'downloading' || state.phase === 'disabled'}
            onClick={() => void window.smartiDesktop?.checkForUpdates()}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {releasesUrl ? (
          <a href={releasesUrl} target="_blank" rel="noopener noreferrer">
            Release history
          </a>
        ) : null}
      </div>
    </section>
  );
}

// Opens the dashboard. Loaded with a dynamic import only when it is needed, so
// plain commands never load React or Ink.
import React from 'react';
import { render } from 'ink';
import { App } from './app.ts';

export async function runDashboard(): Promise<number> {
  const instance = render(React.createElement(App), {
    alternateScreen: true,
    exitOnCtrlC: true,
    // Anything a tool prints through console is routed above the UI, not into it.
    patchConsole: true,
  });
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    instance.cleanup();
  }
}

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const port = process.env.STOCKSENSE_ISOLATED_PORT || '3001';
const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '0.0.0.0', '--port', port], {
  env: {
    ...process.env,
    STOCKSENSE_DEMO_LOGIN: 'true',
    STOCKSENSE_DEMO_SECRET: process.env.STOCKSENSE_DEMO_SECRET || process.env.DATABASE_URL || 'stocksense-local-demo-only',
    STOCKSENSE_DEV_CACHE: '.next-isolated',
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error('Unable to start StockSense isolated dev server:', error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});

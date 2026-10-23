import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Base44 preview reaches this dev server through a proxy, so the Host header is
// "<port>-<sandbox id>.<BASE44_SANDBOX_HOST_DOMAIN>". Those hosts are environment-specific, so they are
// allowed only while BASE44_PREVIEW_MODE === "1"; unset (normal local/CI use) keeps Vite's default.
const previewMode = process.env.BASE44_PREVIEW_MODE === '1';
const previewHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean);
if (previewMode && process.env.BASE44_SANDBOX_HOST_DOMAIN) {
  previewHosts.push(`.${process.env.BASE44_SANDBOX_HOST_DOMAIN}`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    ...(previewMode && previewHosts.length ? { allowedHosts: previewHosts } : {}),
  },
});

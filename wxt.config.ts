import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: '1Study Class Recorder',
    version: '0.1.0',
    permissions: ['tabCapture', 'offscreen', 'storage', 'unlimitedStorage', 'alarms'],
    host_permissions: [
      'https://meet.google.com/*',
      'https://1study-lms-local.edu/*',
      'https://*.1study.vn/*',
    ],
  },
});

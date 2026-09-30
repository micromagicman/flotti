/**
 * Storybook of the components of the dashboard (#139): each one on its own,
 * in every state it has, with no fleet running. The stories are in
 * web/stories; the page's own Vite setup (web/vite.config.ts) is not loaded,
 * as its root and output are those of the dashboard build.
 */
import react from '@vitejs/plugin-react';
import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
    stories: ['../web/stories/**/*.stories.tsx'],
    framework: '@storybook/react-vite',
    core: {
        disableTelemetry: true
    },
    typescript: {
        // Docgen serves the Docs addon, which is not here; not running it keeps the build short.
        reactDocgen: false
    },
    viteFinal: (viteConfig) => ({
        ...viteConfig,
        plugins: [...(viteConfig.plugins ?? []), react()]
    })
};
export default config;

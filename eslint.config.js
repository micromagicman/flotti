import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import flotti from './eslint-rules/ui-text.js';
export default tseslint.config(
    ...tseslint.configs.recommended,
    {
        ignores: [ 'build/', 'build-test/' ]
    },
    {
        plugins: {
            '@stylistic': stylistic
        },
        rules: {
            '@stylistic/object-curly-spacing': [
                'error',
                'always'
            ],
            '@stylistic/no-multiple-empty-lines': [
                'error',
                {
                    max: 0,
                    maxEOF: 0,
                    maxBOF: 0
                }
            ],
            '@stylistic/padded-blocks': [
                'error',
                'never'
            ],
            'max-lines-per-function': [
                'error',
                {
                    max: 20,
                    skipComments: true
                }
            ],
        },
    },
    {
        // A function of the product code has at most four paths through it (#119).
        files: [ 'src/**/*.ts', 'web/src/**/*.{ts,tsx}' ],
        rules: {
            complexity: [
                'error',
                {
                    max: 4
                }
            ],
        },
    },
    {
        // Not under the limit yet (#119): a file leaves this list once its functions are split.
        files: [
            'src/agent-events.ts',
            'src/delegations.ts',
            'src/fleet-mcp.ts',
            'src/fleet.ts',
            'src/memory-bank.ts',
            'src/memory-store.ts',
            'src/notifications.ts',
            'src/notifier.ts',
            'src/run.ts',
            'src/ssh.ts',
            'src/supervisor.ts',
            'web/src/App.tsx',
            'web/src/components/Feed.tsx',
            'web/src/components/NotificationSettings.tsx',
            'web/src/components/SettingsPanel.tsx',
            'web/src/components/Sidebar.tsx',
            'web/src/feed.ts',
            'web/src/i18n/en.ts',
            'web/src/i18n/ru.ts',
            'web/src/markdown.ts'
        ],
        rules: {
            complexity: 'off'
        },
    },
    {
        // The words of the dashboard come from its languages, web/src/i18n (#86).
        files: [ 'web/src/**/*.ts', 'web/src/**/*.tsx' ],
        ignores: [ 'web/src/i18n/**' ],
        plugins: {
            flotti
        },
        rules: {
            'flotti/ui-text': 'error'
        },
    },
    {
        files: [ 'test/**', 'e2e/**' ],
        rules: {
            'max-lines-per-function': [
                'error',
                {
                    max: 50,
                    skipComments: true
                }
            ],
        },
    },
);
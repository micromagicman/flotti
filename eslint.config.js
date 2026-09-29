import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import flotti from './eslint-rules/ui-text.js';
export default tseslint.config(
    ...tseslint.configs.recommended,
    {
        ignores: [ 'build/', 'build-test/', 'storybook-static/' ]
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
        // The stories and the Storybook setup (#139): a story of many states is one long object.
        files: [ 'web/stories/**', '.storybook/**' ],
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
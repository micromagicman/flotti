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
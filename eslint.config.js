import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
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
                    max: 50,
                    skipComments: true
                }
            ],
        },
    },
);
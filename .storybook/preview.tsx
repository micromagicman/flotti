import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Decorator, Preview } from '@storybook/react-vite';
import { I18nProvider, useI18n } from '../web/src/i18n/I18n.js';
import { LANGUAGES } from '../web/src/i18n/languages.js';
import { applyScheme } from './scheme.js';
import type { Scheme } from './scheme.js';
import '../web/src/styles.css';
/** The language of the toolbar, set through the provider of the page as the settings would. */
function LanguageOf({ code, children }: { readonly code: string; readonly children: ReactNode }) {
    const { code: current, setLanguage } = useI18n();
    useEffect(() => {
        if (code !== current) {
            setLanguage(code);
        }
    }, [code, current, setLanguage]);
    return children;
}
const withPage: Decorator = (Story, { globals }) => {
    applyScheme(globals.scheme as Scheme);
    return (
        <I18nProvider>
            <LanguageOf code={globals.language as string}><Story /></LanguageOf>
        </I18nProvider>
    );
};
const preview: Preview = {
    decorators: [withPage],
    globalTypes: {
        scheme: {
            description: 'Colour scheme',
            toolbar: {
                title: 'Scheme',
                icon: 'mirror',
                items: [
                    { value: 'system', title: 'System' },
                    { value: 'light', title: 'Light', icon: 'sun' },
                    { value: 'dark', title: 'Dark', icon: 'moon' }
                ],
                dynamicTitle: true
            }
        },
        language: {
            description: 'Language of the page',
            toolbar: {
                title: 'Language',
                icon: 'globe',
                items: LANGUAGES.map((language) => ({ value: language.code, title: language.name })),
                dynamicTitle: true
            }
        }
    },
    initialGlobals: {
        scheme: 'system',
        language: 'en'
    },
    parameters: {
        layout: 'fullscreen',
        viewport: {
            options: {
                phone: { name: 'Phone', styles: { width: '390px', height: '844px' }, type: 'mobile' },
                tablet: { name: 'Tablet', styles: { width: '820px', height: '1180px' }, type: 'tablet' },
                laptop: { name: 'Laptop', styles: { width: '1280px', height: '800px' }, type: 'desktop' }
            }
        }
    }
};
export default preview;

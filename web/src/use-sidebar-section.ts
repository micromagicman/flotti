import { useEffect, useRef, useState } from 'react';
import { FIRST_SECTION, isSection } from './sidebar-sections.js';
import type { Section } from './sidebar-sections.js';
const STORAGE_KEY = 'flotti.sidebar-section';
/** The section picked before in this browser; Agents the first time, or when the storage is out of reach. */
function loadSection(): Section {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return isSection(stored) ? stored : FIRST_SECTION;
    } catch {
        return FIRST_SECTION;
    }
}
function saveSection(section: Section): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, section);
    } catch {
        // The section holds while the page is open.
    }
}
/**
 * The open section of the sidebar (#136), kept across reloads. It follows
 * what opens: when the open tab changes to one of another section — a click
 * in the feed that leads to an agent, a notification — the switch turns to
 * that section. The fleet coming in does not move it: only a new tab does.
 */
function useSidebarSection(tab: string, sectionOfTab: Section | undefined): [Section, (section: Section) => void] {
    const [section, setSection] = useState(loadSection);
    const choose = (next: Section): void => {
        setSection(next);
        saveSection(next);
    };
    const lastTab = useRef(tab);
    useEffect(() => {
        if (lastTab.current === tab) {
            return;
        }
        lastTab.current = tab;
        if (sectionOfTab !== undefined) {
            setSection(sectionOfTab);
            saveSection(sectionOfTab);
        }
    }, [tab, sectionOfTab]);
    return [section, choose];
}
export { useSidebarSection };

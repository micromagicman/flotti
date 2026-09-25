/**
 * The words of the dashboard in English. Every language has a file like this
 * one, with the same keys: its type is the type of the others (#86).
 * Messages of agents and of people are never here — they are shown as written.
 */
import type { AdminAction, AdminActionState, AgentStatus, DelegationState, ToolCallStatus } from '../../../src/agent-events.js';
import type { Delivery, NotificationEvents } from '../../../src/dashboard-protocol.js';
import { formatFor } from './format.js';
const f = formatFor('en');
const s = (n: number): string => (n === 1 ? '' : 's');
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n}${suffix}`;
}
/** What an action of an administrator does, in words: `restart claude`, `clear its own context`. */
function doing(action: AdminAction, target: string | undefined): string {
    if (target === undefined) {
        return action === 'restart' ? 'restart itself' : 'clear its own context';
    }
    return action === 'restart' ? `restart ${target}` : `clear the context of ${target}`;
}
/** The line of an action of an administrator in its state; `target` is undefined when it acts on itself. */
function adminAction(state: AdminActionState, admin: string, action: AdminAction, target: string | undefined, reason: string | undefined): string {
    const what = doing(action, target);
    switch (state) {
        case 'pending':
            return `${admin} asks to ${what}`;
        case 'scheduled':
            return `${admin} will ${what} once its turn is over`;
        case 'done':
            return `${admin} ${what.replace(/^restart/, 'restarted').replace(/^clear/, 'cleared')}`;
        case 'refused':
            return `${admin} may not ${what}: ${reason ?? 'refused'}`;
        case 'failed':
            return `${admin} could not ${what}: ${reason ?? 'no reason given'}`;
    }
}
const status: Readonly<Record<AgentStatus, string>> = {
    starting: 'starting',
    idle: 'idle',
    working: 'working',
    waiting: 'waiting for you',
    error: 'error',
    stopped: 'stopped'
};
const toolStatus: Readonly<Record<ToolCallStatus, string>> = {
    pending: 'pending',
    in_progress: 'in progress',
    completed: 'completed',
    failed: 'failed'
};
const delegationState: Readonly<Record<DelegationState, string>> = {
    working: 'working',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled'
};
const delegationOutcome: Readonly<Record<DelegationState, string>> = {
    working: 'Working',
    completed: 'Result',
    failed: 'Why it failed',
    canceled: 'Why it was canceled'
};
const deliveryResult: Readonly<Record<Delivery['result'], string>> = {
    taken: 'delivered',
    queued: 'queued: the agent is busy',
    failed: 'failed'
};
const notificationEvents: Readonly<Record<keyof NotificationEvents, string>> = {
    waiting: 'An agent waits for an answer or a permission',
    error: 'An agent fails or falls',
    connection: 'The SSH connection to an agent is lost'
};
const en = {
    common: {
        cancel: 'Cancel',
        send: 'Send',
        save: 'Save',
        start: 'Start',
        stop: 'Stop',
        restart: 'Restart',
        edit: 'Edit',
        delete: 'Delete',
        back: 'Back',
        answered: 'answered',
        you: 'You',
        youQuoted: 'you',
        and: (one: string, other: string) => `${one} and ${other}`,
        andWord: 'and',
        fromTo: (from: string, to: string) => `From ${from} to ${to}`,
        inLine: (n: number) => `${f.number(n)} in line`,
        messages: (n: number) => `${f.number(n)} message${s(n)}`,
        localKind: 'local · ACP',
        remoteKind: 'remote · A2A'
    },
    errors: {
        dashboardAnswered: (code: number) => `The dashboard answered ${code}.`,
        notDelivered: 'The message did not reach the agent.',
        notifyRefused: 'The browser was not allowed to show notifications.',
        envLine: (line: string) => `Environment: "${line}" is not NAME=value.`,
        timeout: (value: string) => `Heartbeat timeout: "${value}" is not a positive number of seconds.`
    },
    status,
    link: {
        connecting: 'Connecting…',
        open: 'Connected',
        closed: 'Connection lost, reconnecting…',
        gone: 'flotti has stopped'
    },
    topbar: {
        notify: 'Notify me',
        notifyHint: 'A notification when an agent waits for you and flotti is out of sight'
    },
    attention: {
        waitingTitle: (name: string) => `${name} is waiting for you`,
        asksPermission: (title: string) => `Asks for permission: ${title}`,
        allowIt: (action: string) => `${action}: allow it?`,
        openToAnswer: 'Open flotti to answer.'
    },
    sidebar: {
        label: 'Agents',
        allAgents: 'All agents',
        broadcast: 'Broadcast',
        settings: 'Settings',
        settingsHint: 'Fleet and agents',
        newOutput: 'new output',
        newMessages: 'new messages',
        conversations: 'Conversations',
        allConversations: 'All conversations',
        pairs: (n: number) => `${f.number(n)} pair${s(n)} of agents`,
        conversationOf: (names: string, n: number) => `Conversation of ${names}, ${f.number(n)} message${s(n)}`
    },
    health: {
        label: 'SSH connection',
        latency: 'latency',
        reconnects: 'reconnects',
        lastActivity: 'last activity',
        tunnelUp: 'tunnel up',
        notMeasured: 'not measured yet',
        ms: (n: number) => `${f.number(n)} ms`,
        inLastHour: (total: number, lastHour: number) => `${f.number(total)} · ${f.number(lastHour)} in the last hour`,
        last: (ago: string) => `last ${ago}`,
        ago: (time: string) => `${time} ago`,
        noneYet: 'none yet',
        down: 'down',
        duration: (ms: number) => f.duration(ms, { s: 's', min: 'min', h: 'h', d: 'd' }),
        poor: (reasons: string) => `Poor connection: ${reasons}`,
        poorReconnects: (n: number) => `${f.number(n)} reconnects in the last hour`,
        poorLatency: (ms: number) => `latency ${f.number(ms)} ms`,
        poorMark: 'poor connection',
        lost: (reasons: string) => `No connection: ${reasons}`,
        tunnelDown: 'the tunnel is down',
        lostMark: 'no connection',
        fine: 'fine',
        more: 'Details'
    },
    agent: {
        harness: 'Harness',
        harnessUnknown: 'harness unknown',
        harnessRemote: 'The remote agent does not say which harness runs it.',
        harnessLocal: 'The manifest names no adapter, so the harness is not known.',
        admin: 'admin',
        adminHint: 'Administrator: may restart agents and clear their context',
        view: 'View',
        chat: 'Chat',
        memory: 'Memory',
        messageTo: (name: string) => `Message to ${name}`,
        replyTo: (name: string) => `Reply to ${name}`,
        messagePlaceholder: (name: string) => `Message ${name}…`,
        replyPlaceholder: 'Write a reply…',
        reply: 'Reply',
        details: 'Details',
        detailsOf: (name: string) => `Details of ${name}`,
        closeDetails: 'Close',
        about: 'Agent',
        kind: 'Type',
        role: 'Role',
        connection: 'Connection',
        actions: 'Actions',
        noHarness: 'not known'
    },
    composer: {
        toSend: 'to send',
        newLine: 'new line'
    },
    feed: {
        output: (name: string) => `Output of ${name}`,
        empty: (name: string) => `Nothing yet. Say something to ${name}.`,
        permission: 'Permission requested',
        allow: 'Allow',
        refuse: 'Refuse',
        adminRequest: 'Administrator action',
        adminAction,
        contextCleared: 'context cleared',
        contextClearedLabel: (text: string) => `Context cleared: ${text}`,
        toolStatus,
        thinking: 'Thinking',
        turnEnded: (reason: string) => `Turn ended: ${reason}`,
        rawMessage: (protocol: string) => `${protocol} message`
    },
    message: {
        gone: 'message is no longer in the feed',
        jump: (who: string) => `Reply to ${who}: jump to the message`,
        cancelReply: (who: string) => `Cancel the reply to ${who}`,
        forwarded: 'forwarded',
        forwardedFrom: (who: string) => `Forwarded from ${who}`,
        forwardTo: 'Forward to',
        noOther: 'no other agent in the fleet',
        forwardedTo: (name: string) => `Forwarded to ${name}`,
        actions: 'Message actions',
        reply: 'Reply',
        forward: 'Forward'
    },
    line: {
        ordinal,
        nextUp: 'Next up',
        afterTurn: 'after the current turn',
        onceReady: 'once the agent is ready',
        place: 'In line',
        from: (name: string) => `from ${name}`,
        cancel: '✕ cancel',
        cancelling: 'Cancelling…',
        cancelLabel: (place: number) => `Cancel queued message ${place}`,
        notDelivered: (reason: string) => `Not delivered: ${reason}`,
        sentAgain: 'sent again',
        sending: 'Sending…',
        sendAgain: 'Send again',
        fromName: (name: string) => `From ${name}`
    },
    delegation: {
        task: 'task',
        label: (from: string, to: string, state: string) => `Task from ${from} to ${to}: ${state}`,
        state: delegationState,
        outcome: delegationOutcome,
        due: (time: string) => `due by ${time}`
    },
    broadcast: {
        label: 'Broadcast',
        title: 'Message all agents',
        lead: 'Each agent gets the message on its own; the answers come in its tab.',
        noAgents: 'No agents yet',
        addFirst: 'Add the first one in the settings.',
        openSettings: 'Open settings',
        sendTo: 'Send to',
        fieldLabel: 'Message to all agents',
        placeholder: 'Message the fleet…',
        selected: (n: number) => `${f.number(n)} agent${s(n)} selected`,
        delivery: 'Delivery',
        result: deliveryResult
    },
    conversation: {
        of: (names: string) => `Conversation of ${names}`,
        notYet: (names: string) => `${names} have not written to each other yet.`,
        all: 'All conversations',
        onlyTwo: 'Only the two agents write here.',
        writeTo: (name: string) => `Write to ${name}`,
        title: 'Conversations',
        lead: 'What the agents of the fleet write to each other, one lane for every two of them.',
        none: 'No agent has written to another yet.'
    },
    memory: {
        searchLabel: 'Search notes',
        searchPlaceholder: 'Search notes…',
        refresh: 'Refresh',
        refreshHint: 'Read the notes again',
        notes: 'Notes',
        noMatch: 'No note has these words.',
        noNotes: 'No notes yet: the agent has not written any.',
        truncated: (n: number) => `Only the first ${f.number(n)} notes are listed.`,
        pick: 'Pick a note.',
        tryAgain: 'Try again',
        reading: 'Reading the memory bank…',
        readingNote: 'Reading the note…',
        copyPath: 'Copy path',
        copied: 'Copied',
        notCopied: 'Could not copy',
        edited: (ago: string) => `edited ${ago}`,
        linkedFrom: 'Linked from',
        nothingYet: 'nothing yet',
        allNotes: '← All notes',
        missing: (name: string) => `No note named “${name}” yet`,
        done: 'done',
        notDone: 'not done',
        justNow: 'just now',
        minutesAgo: (n: number) => `${f.number(n)} min ago`,
        hoursAgo: (n: number) => `${f.number(n)} h ago`,
        yesterday: 'yesterday',
        daysAgo: (n: number) => `${f.number(n)} days ago`,
        date: (time: number) => f.date(time)
    },
    settings: {
        label: 'Fleet settings',
        title: 'Fleet settings',
        sshTitle: 'Connect over SSH',
        sshAddress: 'SSH address',
        connect: 'Connect',
        connecting: 'Connecting…',
        sshHint: 'Your public key has to be on the host already. flotti asks the host which agents it publishes, adds them, and keeps an SSH tunnel to each one up: no port, no token to copy.',
        added: (names: string, present: string | undefined) => `Added ${names}${present === undefined ? '' : `; already in the fleet: ${present}`}.`,
        fleetTitle: 'Fleet directory',
        fleetPath: 'Fleet directory path',
        switch: 'Switch',
        sourceArgument: 'given with --fleet for this run',
        sourceEnvironment: 'given by FLOTTI_FLEET for this run',
        sourceSettings: 'saved in the settings',
        sourceSettingsFile: (file: string) => `saved in ${file}`,
        sourceDefault: 'the default',
        fleetHint: 'Switching stops the agents of this fleet and starts those of the new one; a directory that is not there yet is created. The choice is saved, and the next flotti run opens it too',
        fleetPinned: (by: string) => ` — unless it is started with ${by} again, as this one was.`,
        agentsTitle: 'Agents',
        noAgents: 'No agents yet.',
        addLocal: 'Add local agent',
        addRemote: 'Add remote agent',
        adminSuffix: ' · admin',
        confirmDelete: (name: string) => `Stop ${name} and move its directory to .trash in the fleet directory?`,
        keep: 'Keep',
        readingManifest: 'Reading the manifest…',
        adminTitle: 'Administrators',
        adminConfirm: 'Ask me before an administrator restarts an agent or clears its context',
        adminHint: 'An administrator is an agent with Administrator ticked in its settings. When this is on, each of its actions waits for Allow in the dashboard; a refusal reaches it as one. When off, it is done at once.',
        languageTitle: 'Language',
        languageLabel: 'Language of the dashboard',
        languageHint: 'Kept in this browser. Messages of agents and people are shown as they were written.'
    },
    form: {
        newAgent: (kind: 'local' | 'remote') => `New ${kind} agent`,
        agentLabel: (id: string) => `Agent ${id}`,
        adapter: 'Adapter',
        adapterHint: 'Which ACP adapter the command starts; picking one fills in its command.',
        plainAcp: 'Plain ACP',
        command: 'Command',
        commandHint: 'Executable to run.',
        arguments: 'Arguments',
        argumentsHint: 'One per line.',
        model: 'Model',
        modelHint: 'Empty: the adapter\'s own default.',
        host: 'Host',
        hostHint: 'Empty: this machine. user@host: flotti starts the agent there over SSH with your key; the command, the working directory and everything the agent does are on that host.',
        workdir: 'Working directory',
        workdirHint: 'Empty: the agent directory. ~ and relative paths are fine.',
        workdirRemoteHint: 'A path on the host. Empty: the home directory there.',
        environment: 'Environment',
        environmentHint: 'NAME=value, one per line. Keep secrets out: this is written to agent.json.',
        restart: 'Restart',
        restartDefault: 'default (on failure)',
        restartAlways: 'always',
        restartOnFailure: 'on failure',
        restartNever: 'never',
        heartbeat: 'Heartbeat timeout, s',
        heartbeatHint: 'Empty: 60.',
        systemPrompt: 'System prompt',
        systemPromptHint: 'Kept in system-prompt.md next to the manifest.',
        publishedAgent: 'Published agent',
        publishedAgentHint: 'Empty: the only one the host publishes.',
        url: 'URL',
        urlHint: 'Address of the agent, http: or https:.',
        ssh: 'SSH',
        sshHint: 'user@host: flotti opens the tunnel and gets the address and the token itself. Empty: reach the agent at URL.',
        auth: 'Authentication',
        authSshHint: 'Over SSH, the token the host publishes wins; this is for a host that publishes none.',
        authNone: 'none',
        authBearer: 'bearer token',
        authApiKey: 'API key header',
        tokenEnv: 'Token variable',
        tokenEnvHint: 'Environment variable with the token; the token itself stays out of the manifest.',
        header: 'Header',
        valueEnv: 'Value variable',
        valueEnvHint: 'Environment variable with the key.',
        id: 'Id',
        idNewHint: 'Names the agent directory: letters, digits, ".", "_" and "-".',
        idHint: 'The id is the directory name and stays.',
        name: 'Name',
        nameHint: 'Empty: the id.',
        description: 'Description',
        administrator: 'Administrator',
        administratorHint: 'May restart the agents of the fleet and clear their context, itself included, with the tools of an administrator. Only a person gives and takes this role.',
        restartsOnSave: 'Saving restarts the agent with the new settings, unless it is stopped.',
        addAgent: 'Add agent'
    },
    notifications: {
        title: 'Notifications',
        reading: 'Reading the settings…',
        lead: 'When you are away from the dashboard: one notification per wait, taken back once the agent has its answer.',
        events: notificationEvents,
        when: 'Notify when',
        remind: 'Remind every (minutes)',
        remindHint: 'While an agent still waits. 0: tell once.',
        link: 'Link to the dashboard',
        linkHint: 'Empty: the address of this dashboard. Put the address you open it by from elsewhere here.',
        telegram: 'Telegram',
        botToken: 'Bot token',
        botTokenSaved: 'Saved; it is never shown. Type a new one to replace it.',
        botTokenNew: 'From @BotFather. Kept on this machine, never shown again.',
        savedPlaceholder: 'saved',
        chatId: 'Chat id',
        chatIdHint: 'Your id, or the id of a group the bot is in.',
        webPushEnabled: 'Web Push to the subscribed browsers',
        webPush: 'Web Push',
        webPushLead: 'Web Push: notifications on this browser even with the dashboard closed.',
        noBrowser: 'No browser subscribed yet.',
        browsers: (n: number) => `Browsers subscribed: ${f.number(n)}.`,
        unsupported: 'This browser cannot take Web Push here.',
        stopHere: 'Stop on this browser',
        notifyHere: 'Notify this browser',
        noChannel: 'No channel is switched on.',
        sent: 'sent',
        failed: (why: string | undefined) => `failed — ${why ?? 'no reason'}`,
        sending: 'Sending…',
        test: 'Send a test',
        saved: 'Saved.'
    }
};
type Messages = typeof en;
export { en };
export type { Messages };

/**
 * Слова дашборда по-русски: те же ключи, что в en.ts (#86). Сообщения агентов
 * и людей здесь не переводятся — они показываются как написаны.
 */
import type { AdminAction, AdminActionState, AgentStatus, DelegationState, ToolCallStatus } from '../../../src/agent-events.js';
import type { Delivery, NotificationEvents } from '../../../src/dashboard-protocol.js';
import type { Messages } from './en.js';
import { formatFor } from './format.js';
import type { PluralForms } from './format.js';
const f = formatFor('ru');
/** Число и слово в нужной форме: «1 сообщение», «3 сообщения», «5 сообщений». */
const count = (n: number, one: string, few: string, many: string): string => {
    const forms: PluralForms = { one, few, many, other: few };
    return `${f.number(n)} ${f.plural(n, forms)}`;
};
/** Что делает действие администратора: «перезапустить claude», «очистить свой контекст». */
function doing(action: AdminAction, target: string | undefined): string {
    if (target === undefined) {
        return action === 'restart' ? 'перезапустить себя' : 'очистить свой контекст';
    }
    return action === 'restart' ? `перезапустить ${target}` : `очистить контекст ${target}`;
}
/** Сделанное действие без глагола в прошедшем времени: у агента нет рода. */
function done(action: AdminAction, target: string | undefined): string {
    if (target === undefined) {
        return action === 'restart' ? 'перезапуск выполнен' : 'свой контекст очищен';
    }
    return action === 'restart' ? `${target} перезапущен` : `контекст ${target} очищен`;
}
function adminAction(state: AdminActionState, admin: string, action: AdminAction, target: string | undefined, reason: string | undefined): string {
    const what = doing(action, target);
    switch (state) {
        case 'pending':
            return `${admin} просит ${what}`;
        case 'scheduled':
            return `${admin} собирается ${what}, когда закончит ход`;
        case 'done':
            return `${admin}: ${done(action, target)}`;
        case 'refused':
            return `${admin} не может ${what}: ${reason ?? 'отказано'}`;
        case 'failed':
            return `${admin}: не удалось ${what}: ${reason ?? 'причина не указана'}`;
    }
}
const status: Readonly<Record<AgentStatus, string>> = {
    starting: 'запускается',
    idle: 'свободен',
    working: 'работает',
    waiting: 'ждёт вас',
    error: 'ошибка',
    stopped: 'остановлен'
};
const toolStatus: Readonly<Record<ToolCallStatus, string>> = {
    pending: 'ожидает',
    in_progress: 'выполняется',
    completed: 'готово',
    failed: 'ошибка'
};
const delegationState: Readonly<Record<DelegationState, string>> = {
    working: 'в работе',
    completed: 'выполнена',
    failed: 'не выполнена',
    canceled: 'отменена'
};
const delegationOutcome: Readonly<Record<DelegationState, string>> = {
    working: 'В работе',
    completed: 'Результат',
    failed: 'Почему не вышло',
    canceled: 'Почему отменена'
};
const deliveryResult: Readonly<Record<Delivery['result'], string>> = {
    taken: 'доставлено',
    queued: 'в очереди: агент занят',
    failed: 'не доставлено'
};
const notificationEvents: Readonly<Record<keyof NotificationEvents, string>> = {
    waiting: 'Агент ждёт ответа или разрешения',
    error: 'Агент упал или завершился с ошибкой',
    connection: 'Пропало SSH-соединение с агентом'
};
const ru: Messages = {
    common: {
        cancel: 'Отмена',
        send: 'Отправить',
        save: 'Сохранить',
        start: 'Запустить',
        stop: 'Остановить',
        restart: 'Перезапустить',
        edit: 'Изменить',
        delete: 'Удалить',
        back: 'Назад',
        answered: 'ответ дан',
        you: 'Вы',
        youQuoted: 'вы',
        and: (one, other) => `${one} и ${other}`,
        andWord: 'и',
        fromTo: (from, to) => `От ${from} к ${to}`,
        inLine: (n) => `${f.number(n)} в очереди`,
        messages: (n) => count(n, 'сообщение', 'сообщения', 'сообщений'),
        localKind: 'локальный · ACP',
        remoteKind: 'удалённый · A2A'
    },
    errors: {
        dashboardAnswered: (code) => `Дашборд ответил кодом ${code}.`,
        notDelivered: 'Сообщение не дошло до агента.',
        notifyRefused: 'Браузеру не разрешено показывать уведомления.',
        envLine: (line) => `Окружение: «${line}» — не в виде ИМЯ=значение.`,
        timeout: (value) => `Таймаут heartbeat: «${value}» — не положительное число секунд.`
    },
    status,
    link: {
        connecting: 'Подключение…',
        open: 'Подключено',
        closed: 'Связь потеряна, переподключаюсь…',
        gone: 'flotti остановлен'
    },
    topbar: {
        notify: 'Уведомлять',
        notifyHint: 'Уведомление, когда агент ждёт вас, а вкладка flotti не на виду'
    },
    attention: {
        waitingTitle: (name) => `${name} ждёт вас`,
        asksPermission: (title) => `Просит разрешения: ${title}`,
        allowIt: (action) => `${action}: разрешить?`,
        openToAnswer: 'Откройте flotti, чтобы ответить.'
    },
    sidebar: {
        label: 'Агенты',
        allAgents: 'Все агенты',
        broadcast: 'Рассылка',
        settings: 'Настройки',
        settingsHint: 'Флот и агенты',
        newOutput: 'новый вывод',
        newMessages: 'новые сообщения',
        conversations: 'Переписки',
        allConversations: 'Все переписки',
        pairs: (n) => `${count(n, 'пара', 'пары', 'пар')} агентов`,
        conversationOf: (names, n) => `Переписка ${names}, ${count(n, 'сообщение', 'сообщения', 'сообщений')}`
    },
    health: {
        label: 'SSH-соединение',
        latency: 'задержка',
        reconnects: 'переподключения',
        lastActivity: 'активность',
        tunnelUp: 'туннель работает',
        notMeasured: 'ещё не измерена',
        ms: (n) => `${f.number(n)} мс`,
        inLastHour: (total, lastHour) => `${f.number(total)} · ${f.number(lastHour)} за последний час`,
        last: (ago) => `последнее ${ago}`,
        ago: (time) => `${time} назад`,
        noneYet: 'пока не было',
        down: 'не работает',
        duration: (ms) => f.duration(ms, { s: 'с', min: 'мин', h: 'ч', d: 'д' }),
        poor: (reasons) => `Плохое соединение: ${reasons}`,
        poorReconnects: (n) => `${count(n, 'переподключение', 'переподключения', 'переподключений')} за последний час`,
        poorLatency: (ms) => `задержка ${f.number(ms)} мс`,
        poorMark: 'плохая связь',
        lost: (reasons) => `Нет связи: ${reasons}`,
        tunnelDown: 'туннель не работает',
        lostMark: 'нет связи',
        fine: 'в порядке',
        more: 'Подробнее'
    },
    agent: {
        harness: 'Харнесс',
        harnessUnknown: 'харнесс неизвестен',
        harnessRemote: 'Удалённый агент не сообщает, какой харнесс его запускает.',
        harnessLocal: 'В манифесте не указан адаптер, поэтому харнесс неизвестен.',
        admin: 'админ',
        adminHint: 'Администратор: может перезапускать агентов и очищать их контекст',
        view: 'Вид',
        chat: 'Чат',
        memory: 'Память',
        memoryOn: (policy) => `память вкл · политика v${policy}`,
        memoryOnHint: 'flotti передал агенту инструменты памяти, политику памяти и навык flotti-memory.',
        memorySkillUser: 'Навык flotti-memory в skills/ — собственный навык агента: встроенный поверх него не ставится.',
        memorySkillMissing: 'Встроенный навык flotti-memory не удалось записать в skills/.',
        memoryUnsupported: 'память не поддерживается',
        memoryUnavailable: 'память недоступна',
        messageTo: (name) => `Сообщение для ${name}`,
        replyTo: (name) => `Ответ для ${name}`,
        messagePlaceholder: (name) => `Написать ${name}…`,
        replyPlaceholder: 'Напишите ответ…',
        reply: 'Ответить',
        details: 'Сведения',
        detailsOf: (name) => `Сведения об агенте ${name}`,
        closeDetails: 'Закрыть',
        about: 'Агент',
        kind: 'Тип',
        role: 'Роль',
        connection: 'Соединение',
        actions: 'Действия',
        noHarness: 'неизвестен'
    },
    composer: {
        toSend: '— отправить',
        newLine: '— новая строка'
    },
    feed: {
        output: (name) => `Вывод ${name}`,
        empty: (name) => `Пока пусто. Напишите что-нибудь ${name}.`,
        permission: 'Запрос разрешения',
        allow: 'Разрешить',
        refuse: 'Отказать',
        adminRequest: 'Действие администратора',
        adminAction,
        contextCleared: 'контекст очищен',
        contextClearedLabel: (text) => `Контекст очищен: ${text}`,
        toolStatus,
        thinking: 'Размышления',
        turnEnded: (reason) => `Ход завершён: ${reason}`,
        rawMessage: (protocol) => `Сообщение ${protocol}`
    },
    message: {
        gone: 'сообщения уже нет в ленте',
        jump: (who) => `Ответ на сообщение ${who}: перейти к нему`,
        cancelReply: (who) => `Отменить ответ ${who}`,
        forwarded: 'переслано',
        forwardedFrom: (who) => `Переслано от ${who}`,
        forwardTo: 'Переслать',
        noOther: 'других агентов во флоте нет',
        forwardedTo: (name) => `Переслано ${name}`,
        actions: 'Действия с сообщением',
        reply: 'Ответить',
        forward: 'Переслать'
    },
    line: {
        ordinal: (n) => `${n}-е`,
        nextUp: 'Следующие',
        afterTurn: 'после текущего хода',
        onceReady: 'когда агент будет готов',
        place: 'В очереди',
        from: (name) => `от ${name}`,
        cancel: '✕ отменить',
        cancelling: 'Отменяю…',
        cancelLabel: (place) => `Отменить сообщение ${place} в очереди`,
        notDelivered: (reason) => `Не доставлено: ${reason}`,
        sentAgain: 'отправлено снова',
        sending: 'Отправляю…',
        sendAgain: 'Отправить снова',
        fromName: (name) => `От ${name}`
    },
    delegation: {
        task: 'задача',
        label: (from, to, state) => `Задача от ${from} для ${to}: ${state}`,
        state: delegationState,
        outcome: delegationOutcome,
        due: (time) => `срок — ${time}`
    },
    broadcast: {
        label: 'Рассылка',
        title: 'Сообщение всем агентам',
        lead: 'Каждый агент получает сообщение отдельно; ответы приходят в его вкладку.',
        noAgents: 'Агентов пока нет',
        addFirst: 'Добавьте первого в настройках.',
        openSettings: 'Открыть настройки',
        sendTo: 'Кому',
        fieldLabel: 'Сообщение всем агентам',
        placeholder: 'Написать флоту…',
        selected: (n) => `выбрано: ${count(n, 'агент', 'агента', 'агентов')}`,
        delivery: 'Доставка',
        result: deliveryResult
    },
    conversation: {
        of: (names) => `Переписка ${names}`,
        notYet: (names) => `${names} ещё не писали друг другу.`,
        all: 'Все переписки',
        onlyTwo: 'Здесь пишут только эти два агента.',
        writeTo: (name) => `Написать ${name}`,
        title: 'Переписки',
        lead: 'Что агенты флота пишут друг другу — по ленте на каждую пару.',
        none: 'Агенты ещё не писали друг другу.'
    },
    memory: {
        searchLabel: 'Поиск по заметкам',
        searchPlaceholder: 'Искать в заметках…',
        refresh: 'Обновить',
        refreshHint: 'Перечитать заметки',
        notes: 'Заметки',
        noMatch: 'Ни в одной заметке нет этих слов.',
        noNotes: 'Заметок пока нет: агент ещё ничего не записал.',
        truncated: (n) => `Показаны только первые ${count(n, 'заметка', 'заметки', 'заметок')}.`,
        pick: 'Выберите заметку.',
        tryAgain: 'Повторить',
        reading: 'Читаю банк памяти…',
        readingNote: 'Читаю заметку…',
        copyPath: 'Копировать путь',
        copied: 'Скопировано',
        notCopied: 'Не удалось скопировать',
        edited: (ago) => `изменена ${ago}`,
        linkedFrom: 'Ссылаются',
        nothingYet: 'пока ничего',
        allNotes: '← Все заметки',
        missing: (name) => `Заметки «${name}» пока нет`,
        done: 'сделано',
        notDone: 'не сделано',
        justNow: 'только что',
        minutesAgo: (n) => `${f.number(n)} мин назад`,
        hoursAgo: (n) => `${f.number(n)} ч назад`,
        yesterday: 'вчера',
        daysAgo: (n) => `${count(n, 'день', 'дня', 'дней')} назад`,
        date: (time) => f.date(time)
    },
    settings: {
        label: 'Настройки флота',
        title: 'Настройки флота',
        sshTitle: 'Подключить по SSH',
        sshAddress: 'Адрес SSH',
        connect: 'Подключить',
        connecting: 'Подключаю…',
        sshHint: 'Ваш публичный ключ уже должен быть на хосте. flotti спросит у хоста, каких агентов он публикует, добавит их и будет держать SSH-туннель к каждому: ни порта, ни токена копировать не нужно.',
        added: (names, present) => `Добавлены: ${names}${present === undefined ? '' : `; уже во флоте: ${present}`}.`,
        fleetTitle: 'Каталог флота',
        fleetPath: 'Путь к каталогу флота',
        switch: 'Сменить',
        sourceArgument: 'задан через --fleet для этого запуска',
        sourceEnvironment: 'задан через FLOTTI_FLEET для этого запуска',
        sourceSettings: 'сохранён в настройках',
        sourceSettingsFile: (file) => `сохранён в ${file}`,
        sourceDefault: 'по умолчанию',
        fleetHint: 'Смена останавливает агентов этого флота и запускает агентов нового; каталог, которого ещё нет, будет создан. Выбор сохраняется, и следующий запуск flotti откроет его же',
        fleetPinned: (by) => ` — если только его снова не запустят с ${by}, как этот.`,
        agentsTitle: 'Агенты',
        noAgents: 'Агентов пока нет.',
        addLocal: 'Добавить локального агента',
        addRemote: 'Добавить удалённого агента',
        adminSuffix: ' · админ',
        confirmDelete: (name) => `Остановить ${name} и переместить его каталог в .trash каталога флота?`,
        keep: 'Оставить',
        readingManifest: 'Читаю манифест…',
        adminTitle: 'Администраторы',
        adminConfirm: 'Спрашивать меня, прежде чем администратор перезапустит агента или очистит его контекст',
        adminHint: 'Администратор — агент, у которого в настройках отмечено «Администратор». Когда это включено, каждое его действие ждёт «Разрешить» в дашборде; отказ доходит до него как отказ. Когда выключено — выполняется сразу.',
        languageTitle: 'Язык',
        languageLabel: 'Язык дашборда',
        languageHint: 'Хранится в этом браузере. Сообщения агентов и людей показываются как написаны.'
    },
    form: {
        newAgent: (kind) => (kind === 'local' ? 'Новый локальный агент' : 'Новый удалённый агент'),
        agentLabel: (id) => `Агент ${id}`,
        adapter: 'Адаптер',
        adapterHint: 'Какой ACP-адаптер запускает команда; выбор адаптера подставляет его команду.',
        plainAcp: 'Обычный ACP',
        command: 'Команда',
        commandHint: 'Исполняемый файл.',
        arguments: 'Аргументы',
        argumentsHint: 'По одному на строку.',
        model: 'Модель',
        modelHint: 'Пусто: модель адаптера по умолчанию.',
        host: 'Хост',
        hostHint: 'Пусто: эта машина. user@host: flotti запустит агента там по SSH с вашим ключом; команда, рабочий каталог и всё, что делает агент, — на том хосте.',
        workdir: 'Рабочий каталог',
        workdirHint: 'Пусто: каталог агента. Можно ~ и относительные пути.',
        workdirRemoteHint: 'Путь на хосте. Пусто: домашний каталог там.',
        environment: 'Окружение',
        environmentHint: 'ИМЯ=значение, по одному на строку. Секреты сюда не кладите: это пишется в agent.json.',
        restart: 'Перезапуск',
        restartDefault: 'по умолчанию (при сбое)',
        restartAlways: 'всегда',
        restartOnFailure: 'при сбое',
        restartNever: 'никогда',
        heartbeat: 'Таймаут heartbeat, с',
        heartbeatHint: 'Пусто: 60.',
        systemPrompt: 'Системный промпт',
        systemPromptHint: 'Хранится в system-prompt.md рядом с манифестом.',
        publishedAgent: 'Опубликованный агент',
        publishedAgentHint: 'Пусто: единственный, кого публикует хост.',
        url: 'URL',
        urlHint: 'Адрес агента, http: или https:.',
        ssh: 'SSH',
        sshHint: 'user@host: flotti сам откроет туннель и получит адрес и токен. Пусто: агент доступен по URL.',
        auth: 'Аутентификация',
        authSshHint: 'По SSH побеждает токен, который публикует хост; это поле — для хоста, который его не публикует.',
        authNone: 'нет',
        authBearer: 'bearer-токен',
        authApiKey: 'заголовок с API-ключом',
        tokenEnv: 'Переменная с токеном',
        tokenEnvHint: 'Переменная окружения с токеном; сам токен в манифест не попадает.',
        header: 'Заголовок',
        valueEnv: 'Переменная со значением',
        valueEnvHint: 'Переменная окружения с ключом.',
        id: 'Id',
        idNewHint: 'Имя каталога агента: буквы, цифры, «.», «_» и «-».',
        idHint: 'Id — имя каталога, он не меняется.',
        name: 'Имя',
        nameHint: 'Пусто: id.',
        description: 'Описание',
        administrator: 'Администратор',
        administratorHint: 'Может перезапускать агентов флота и очищать их контекст, включая свой, инструментами администратора. Давать и снимать эту роль может только человек.',
        restartsOnSave: 'Сохранение перезапустит агента с новыми настройками, если он не остановлен.',
        addAgent: 'Добавить агента'
    },
    notifications: {
        title: 'Уведомления',
        reading: 'Читаю настройки…',
        lead: 'Когда вы не в дашборде: одно уведомление на каждое ожидание, оно снимается, как только агент получит ответ.',
        events: notificationEvents,
        when: 'Когда уведомлять',
        remind: 'Напоминать каждые (минут)',
        remindHint: 'Пока агент всё ещё ждёт. 0: сказать один раз.',
        link: 'Ссылка на дашборд',
        linkHint: 'Пусто: адрес этого дашборда. Укажите адрес, по которому открываете его извне.',
        telegram: 'Telegram',
        botToken: 'Токен бота',
        botTokenSaved: 'Сохранён и никогда не показывается. Введите новый, чтобы заменить.',
        botTokenNew: 'От @BotFather. Хранится на этой машине и больше не показывается.',
        savedPlaceholder: 'сохранён',
        chatId: 'Id чата',
        chatIdHint: 'Ваш id или id группы, в которой состоит бот.',
        webPushEnabled: 'Web Push в подписанные браузеры',
        webPush: 'Web Push',
        webPushLead: 'Web Push: уведомления в этом браузере, даже когда дашборд закрыт.',
        noBrowser: 'Ни один браузер ещё не подписан.',
        browsers: (n) => `Подписано браузеров: ${f.number(n)}.`,
        unsupported: 'Этот браузер здесь не может получать Web Push.',
        stopHere: 'Отключить в этом браузере',
        notifyHere: 'Уведомлять этот браузер',
        noChannel: 'Ни один канал не включён.',
        sent: 'отправлено',
        failed: (why) => `не удалось — ${why ?? 'причина не указана'}`,
        sending: 'Отправляю…',
        test: 'Отправить тестовое',
        saved: 'Сохранено.'
    }
};
export { ru };

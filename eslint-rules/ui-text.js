/**
 * `flotti/ui-text`: the words of the dashboard live in the strings of its
 * languages (web/src/i18n), never in a component (#86). Marked are words
 * written as JSX text, as an attribute a person reads or hears (a title, a
 * label, a placeholder, a hint), as a string that an expression puts on the
 * page, and as the message of an error thrown in the page.
 *
 * A word is two lowercase letters in a row: class names and ids stay out
 * because they are not in the attributes looked at; names that are the same
 * in every language — flotti, Claude Code, keys on the keyboard — are allowed
 * as they are.
 */
const ALLOWED = ['Claude Code', 'Codex', 'flotti', 'Enter', 'Shift'];
const WORD = /\p{Ll}{2}/u;
/** Attributes whose value a person reads or hears, and the props of the page's own components that carry one. */
const TEXT_ATTRIBUTE = /^(title|alt|placeholder|label|hint|aria-(label|description|roledescription|placeholder|valuetext)|[a-z]+(Label|Hint|Title|Placeholder))$/;
/** Paths, addresses and URLs — `memory/`, `user@host`, `http://…` — are not words either. */
const PLACE = /\S*[/@]\S*/gu;
function hasWords(text) {
    const rest = ALLOWED.reduce((left, name) => left.split(name).join(' '), text);
    return WORD.test(rest.replace(PLACE, ' '));
}
/** The pieces of text an expression can put on the page, and the nodes they are in. */
function textsOf(node) {
    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'string' ? [[node, node.value]] : [];
        case 'TemplateLiteral':
            return [[node, node.quasis.map((quasi) => quasi.value.cooked ?? '').join(' ')]];
        case 'ConditionalExpression':
            return [...textsOf(node.consequent), ...textsOf(node.alternate)];
        case 'LogicalExpression':
            return [...textsOf(node.left), ...textsOf(node.right)];
        case 'BinaryExpression':
            return node.operator === '+' ? [...textsOf(node.left), ...textsOf(node.right)] : [];
        default:
            return [];
    }
}
function attributeName(attribute) {
    return attribute.name.type === 'JSXNamespacedName' ? `${attribute.name.namespace.name}:${attribute.name.name.name}` : attribute.name.name;
}
/** Marks each piece of text of the expression that has words. */
function textChecker(context) {
    const report = (node, text) => context.report({ node, messageId: 'text', data: { text: text.trim().slice(0, 40) } });
    return (expression) => {
        for (const [node, text] of textsOf(expression)) {
            if (hasWords(text)) {
                report(node, text);
            }
        }
    };
}
/** `new Error('…')`: the message of an error thrown in the page is read by a person. */
function checkError(node, check) {
    if (node.callee.type === 'Identifier' && node.callee.name === 'Error' && node.arguments[0] !== undefined) {
        check(node.arguments[0]);
    }
}
function create(context) {
    const check = textChecker(context);
    return {
        JSXText: (node) => check({ ...node, type: 'Literal', value: node.value }),
        JSXAttribute(node) {
            if (node.value !== null && TEXT_ATTRIBUTE.test(attributeName(node))) {
                check(node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value);
            }
        },
        JSXExpressionContainer(node) {
            if (node.parent.type === 'JSXElement' || node.parent.type === 'JSXFragment') {
                check(node.expression);
            }
        },
        NewExpression: (node) => checkError(node, check)
    };
}
const rule = {
    meta: {
        type: 'problem',
        docs: { description: 'Words of the dashboard come from the strings of its languages (web/src/i18n), not from a component.' },
        messages: { text: 'Words of the page belong in web/src/i18n (en.ts and the other languages): "{{text}}".' },
        schema: []
    },
    create
};
export default { rules: { 'ui-text': rule } };

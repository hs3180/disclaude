const object = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid user-input request');
    }
    return value;
};
const string = (value, max, empty = false) => {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
        throw new Error('Invalid user-input field');
    }
    return value;
};
export function parseAgentInputParams(value) {
    const p = object(value);
    if (typeof p.isBlocking !== 'boolean' || !Array.isArray(p.questions) || !p.questions.length || p.questions.length > 10) {
        throw new Error('Unsupported user-input request');
    }
    const questions = p.questions.map(value => {
        const q = object(value);
        if ((q.isOther !== undefined && typeof q.isOther !== 'boolean') || (q.isSecret !== undefined && typeof q.isSecret !== 'boolean')) {
            throw new Error('Invalid user-input flags');
        }
        if (q.options !== undefined && q.options !== null && (!Array.isArray(q.options) || q.options.length > 30)) {
            throw new Error('Unsupported user-input options');
        }
        const options = Array.isArray(q.options) ? q.options.map(value => {
            const option = object(value);
            return { label: string(option.label, 300), description: string(option.description, 2000, true) };
        }) : null;
        if (options && new Set(options.map(o => o.label)).size !== options.length) {
            throw new Error('Ambiguous user-input options');
        }
        return { id: string(q.id, 200), header: string(q.header, 300, true), question: string(q.question, 6000),
            isOther: q.isOther === true, isSecret: q.isSecret === true, options };
    });
    if (new Set(questions.map(q => q.id)).size !== questions.length) {
        throw new Error('Duplicate user-input question IDs');
    }
    return { threadId: string(p.threadId, 200), turnId: string(p.turnId, 200), itemId: string(p.itemId, 200), isBlocking: p.isBlocking, questions };
}
export function validateAgentInputAnswers(params, value) {
    const answers = object(value);
    const ids = params.questions.map(q => q.id);
    if (Object.keys(answers).length !== ids.length || Object.keys(answers).some(id => !ids.includes(id))) {
        throw new Error('Answer every question');
    }
    const result = Object.create(null);
    for (const q of params.questions) {
        const answer = object(answers[q.id]);
        if (!Array.isArray(answer.answers) || !answer.answers.length || answer.answers.length > 10) {
            throw new Error('Missing answer');
        }
        const values = answer.answers.map(value => string(value, 12_000));
        if (q.options?.length && !q.isOther && values.some(value => !q.options?.some(option => option.label === value))) {
            throw new Error('Answer must match an offered option');
        }
        result[q.id] = { answers: values };
    }
    return result;
}

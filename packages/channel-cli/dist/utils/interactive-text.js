/** Reject dense literal Unicode escapes; never silently reinterpret JSON text. */
function assertReadable(value, field) {
    const escaped = value.match(/\\u[\da-f]{4}/gi) ?? [];
    if (escaped.length && escaped.length * 6 > value.length / 2) {
        throw new Error(`${field} contains dense literal \\uXXXX sequences, likely double-escaped JSON. Use a single JSON escape layer or raw UTF-8 via --options-file / --action-prompts-file, then inspect --dry-run decodedPreview.`);
    }
}
export function assertReadableInteractiveText(options, prompts) {
    options.forEach((option, index) => assertReadable(option.text, `options[${index}].text`));
    for (const [value, prompt] of Object.entries(prompts ?? {})) {
        if (typeof prompt === 'string') {
            assertReadable(prompt, `action-prompts[${JSON.stringify(value)}]`);
        }
    }
}

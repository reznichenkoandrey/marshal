export function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}
export function scoreStringSimilarity(query, candidate) {
    const left = normalizeText(query);
    const right = normalizeText(candidate);
    if (!left || !right) {
        return 0;
    }
    if (left === right) {
        return 1;
    }
    if (right.includes(left) || left.includes(right)) {
        return 0.8;
    }
    const leftTokens = new Set(left.split(" "));
    const rightTokens = new Set(right.split(" "));
    const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return overlap / Math.max(leftTokens.size, rightTokens.size, 1);
}
export async function healSelector(page, query) {
    const candidates = (await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("button, a, input, textarea, [role], [contenteditable='true']")).slice(0, 250);
        return elements.map((element) => {
            const role = element.getAttribute("role") ?? "";
            const name = element.getAttribute("aria-label") ??
                element.textContent ??
                (element instanceof HTMLInputElement ? element.value : "") ??
                "";
            const placeholder = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                ? element.placeholder
                : "";
            return {
                role,
                name,
                placeholder,
                tagName: element.tagName.toLowerCase()
            };
        });
    }));
    let best = { score: 0, selector: null };
    for (const candidate of candidates) {
        const roleScore = scoreStringSimilarity(query, candidate.name);
        if (candidate.role && roleScore > best.score) {
            best = {
                score: roleScore,
                selector: {
                    kind: "role",
                    role: candidate.role,
                    name: candidate.name.trim()
                }
            };
        }
        const placeholderScore = scoreStringSimilarity(query, candidate.placeholder);
        if (candidate.placeholder && placeholderScore > best.score) {
            best = {
                score: placeholderScore,
                selector: {
                    kind: "placeholder",
                    value: candidate.placeholder.trim()
                }
            };
        }
        const textScore = scoreStringSimilarity(query, candidate.name);
        if (candidate.name && textScore > best.score) {
            best = {
                score: textScore,
                selector: {
                    kind: "text",
                    value: candidate.name.trim()
                }
            };
        }
    }
    return best.score >= 0.45 ? best.selector : null;
}

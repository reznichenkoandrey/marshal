# Selector Strategy

Composer discovery order:

1. `getByRole("textbox", { name: /message|ask|chat/i })`
2. `getByRole("textbox")`
3. `getByPlaceholder(/message/i)`
4. `locator("textarea")`
5. Self-heal using DOM scan plus fuzzy ranking

Rules:

- Prefer Playwright role, label, and placeholder locators.
- Do not depend on CSS class names.
- Cache the last working selector strategy for the ChatGPT composer.
- Attempt `New chat` with role-based link/button selectors.

Stabilization:

- Poll assistant text every 300-500ms.
- Require 3 identical reads before accepting the response.
- Fall back on timeout with the latest non-empty text.

Self-healing:

1. Scan visible buttons, links, inputs, textareas, and ARIA-role elements.
2. Rank candidates by fuzzy similarity to the failed selector query.
3. Retry with the best candidate.
4. Keep selector logic centralized so UI updates only require one change surface.

Session handling:

- Reuse `storageState` when available.
- If missing, start headed, wait for manual login, then save the state.

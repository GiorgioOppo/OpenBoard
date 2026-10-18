# Languages and translation maintenance

OpenBoard supports English (`en`), Italian (`it`), French (`fr`), Spanish (`es`), German (`de`), Simplified Chinese (`zh-CN`) and Japanese (`ja`). Translations are bundled with the static frontend; no translation service, external fonts, CDN or npm package is required at runtime.

## Choosing a language

The selector is available in the sign-in dialog and the workspace header. An explicit `?lang=` URL takes priority, followed by the browser preference saved under `openboard.language`, then the first supported browser language. Unsupported browser languages fall back to English. Regional variants map to their supported base language; Chinese variants use Simplified Chinese.

On the unreleased development branch, changing language updates the interface in place, including open card and panel editors. The selectors inside dialogs stay synchronized and retain their language after a form reset. Controls remain mounted: unsaved values, selected options, editor drafts, focus/selection, panel/view, session and revision state are preserved. Switching sends no save or API mutation and does not reload or navigate. Language remains a browser preference; account synchronization is still pending.

The selected language is saved under `openboard.language` when local storage is available. An existing `lang` URL override is updated with `history.replaceState`, retaining the current history state, board/card fragment and unrelated query parameters. If storage or history is blocked, switching still works for the current page; a later reload may return to the browser language or existing URL override. Browser-supplied date pickers and validation strings follow browser/OS settings.

Dates, accessible labels, feedback messages, standard catalogue labels and API errors are localized. Card summaries and selection counters use `Intl.PluralRules` and locale number formatting. Date inputs and API payloads retain ISO dates; booleans, numbers, identifiers, enum values, JSON and iCalendar protocols keep their original types and values.

Board titles, list names, descriptions, comments, usernames, custom field names, options and submitted answers are user content and remain unchanged when language changes. New boards send a `language` hint to `POST /api/boards`, which creates their three initial lists in that language. The API defaults to Italian when the hint is omitted, preserving compatibility. The interface also supplies localized copy suffixes when duplicating boards or saved reports, preserving the original name within the API character limit. Changing the interface language does not rename existing lists or translate demonstration data.

The C backend continues to expose authenticated APIs only. API error responses retain their canonical messages; the frontend translates them for display. API clients should use HTTP status codes rather than translated text. Unknown errors use a generic message in the selected language.

## Adding or editing translations

Italian authored text acts as the translation key. Each entry in `locales/*.json` contains six translations in this fixed order:

```json
{
  "Cestino": ["Trash", "Corbeille", "Papelera", "Papierkorb", "回收站", "ゴミ箱"]
}
```

Use `tr('Authored text')` for plain text and tagged `tr` templates for messages with dynamic values. Template expressions become positional placeholders such as `{0}` and `{1}`. Every translation must preserve the placeholders, though their order may change. `OpenBoardI18n.count(one, other, count, params)` selects the appropriate plural form and supplies the formatted `{count}` value.

Tag HTML templates with `ui`. The runtime translates authored text and accessible attributes **before** interpolating dynamic values. It never reverse-matches rendered user data to catalogue keys. The browser runtime records authored text/attribute provenance in opaque comment ranges and attributes; a language change updates only those marked literals and explicit bindings. Dynamic slots retain their DOM nodes, including when a translation changes slot order. Initial author-marked static markup is captured once before application data renders.

Continue escaping user text with the existing `escapeHTML`/`e` helpers: `ui` preserves interpolated HTML fragments and does not automatically escape them. Do not pass arbitrary user content to `tr`. The browser's global `tr` returns a locally branded string value so authored parameters survive nested templates; use `OpenBoardI18n.text(element, value)` and `.attribute(element, name, value)` for direct DOM assignments, `.join(values, separator)` for combined localized values and `.markup(value)` for escaped text in generated markup. Explicitly assigning a literal through these helpers clears any prior translation binding. `.t()` and the default `create()` API retain primitive strings for non-live integrations and exports. Do not serialize branded display values into domain data.

Generate the committed browser bundle after editing catalogues:

```sh
python3 scripts/build-locales.py
make test-frontend
```

The builder validates all six translations and placeholder parity. Shared keys follow a deterministic priority: common, core, planning, workflows, errors, extra errors, counts, then activity. Put deliberate shared-term overrides in `locales/common.json`.

The dependency-free extractor inspects static translation calls, nested templates, authored HTML and C API errors without evaluating interpolation expressions:

```sh
node scripts/extract-i18n.cjs web/app.js web/planning.js web/enterprise.js web/workflows.js web/productivity.js web/index.html
node scripts/extract-i18n.cjs src/*.c
```

The frontend test target checks that the generated bundle is current, that all extracted sources are covered, and that placeholders, HTML escaping, language detection, storage/history fallback, in-place switching, draft/focus retention, date formatting and plural rules behave correctly. Labels selected dynamically from trusted API catalogues need explicit entries as well.

## Development-branch validation — 18 October 2026

The frontend target runs 16 suites, including `test_live_language.js`. Its DOM adapter invokes actual initialization/change handlers and application renderers. It checks all seven languages, unchanged user text matching catalogue keys, mounted dirty card/table/review/request controls, typed zero/false answers, selections, drafts, late comment reads, errors/toasts, reset-safe selectors, attribute replacement, hostile field/timeline content and blocked storage/history. These checks do not replace a browser/OS/IME or native-language matrix.

A limited in-app-browser check on a disposable SQLite fixture confirmed English → French and French → Japanese changes, unchanged user content, and retained unsaved card title/comment without server mutations. It identified the reset/Save-label issues subsequently covered by regressions. Browser control later timed out during editor closure; the final follow-up changes were verified by the DOM suite, rather than a completed final browser session. The complete E2E matrix (ID 99) remains pending.

## Historical rollout evidence — 16 October 2026

- 1,470 catalogue entries, each with six translations; Italian remains the source language.
- Source coverage: 1,116 UI messages and 318 static C API errors.
- Recorded combined Python suite: 176 checks passed and 13 optional checks skipped. The same checks passed with AddressSanitizer and UndefinedBehaviorSanitizer. See the [security audit](SECURITY_AUDIT_2026-10-16.md) for additional external-storage validation and remaining deployment risks.
- Both Docker images build; three isolated HTTP tests verify frontend assets, security headers and static access restrictions.
- All five JavaScript suites pass: localization runtime, source coverage, base frontend, enterprise panels and workflows.
- Browser checks on an isolated authenticated instance: all six new languages before and after sign-in; French authentication error; Japanese sprint dates and new-board lists; Chinese request submission preserving numeric zero and boolean false; unchanged user content across switches.
- Actual activity rendering verified with 12 events from authenticated C APIs in all seven languages, including escaped user content and localized fallbacks for unknown event codes.
- Desktop layout at 1280 pixels and mobile layout at 390 pixels checked in English, German, Chinese and Japanese, without horizontal page overflow.

![English interface with original user content](preview-language-en.png)

![Japanese sprint details with localized dates](preview-language-ja.png)

![Chinese request details with typed answers](preview-language-zh.png)

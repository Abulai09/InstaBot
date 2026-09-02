import { html, type Html } from '../html.js';

/**
 * Стилей нет намеренно: CSP запрещает инлайновые стили, а отдельный файл стилей
 * появится вместе с конструктором (фаза E). Пока страницы простые, но рабочие.
 */
export function layout(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/app.css">
<title>${title}</title>
</head>
<body>
${body}
</body>
</html>`;
}

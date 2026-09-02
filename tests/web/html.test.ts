import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw } from '../../src/web/html.js';

describe('тег html', () => {
  it('S21: экранирует подстановку', () => {
    const name = '<script>alert(1)</script>';
    expect(html`<h1>${name}</h1>`.value)
      .toBe('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
  });

  it('S21: экранирует кавычки — иначе подстановка выходит из атрибута', () => {
    const value = '" onmouseover="alert(1)';
    expect(html`<input value="${value}">`.value)
      .toBe('<input value="&quot; onmouseover=&quot;alert(1)">');
  });

  it('S21: экранирует одинарную кавычку и амперсанд', () => {
    expect(escapeHtml("&'")).toBe('&amp;&#39;');
  });

  it('амперсанд экранируется первым, иначе выходит двойное экранирование', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('raw вставляется как есть: им собирают вложенную разметку', () => {
    expect(html`<div>${raw('<b>жирный</b>')}</div>`.value)
      .toBe('<div><b>жирный</b></div>');
  });

  it('вложенный результат тега не экранируется повторно', () => {
    const row = html`<li>${'<b>'}</li>`;
    expect(html`<ul>${row}</ul>`.value).toBe('<ul><li>&lt;b&gt;</li></ul>');
  });

  it('массив склеивается без разделителя: так собирают списки', () => {
    const items = ['a', '<b>'].map((t) => html`<li>${t}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  it('null и undefined дают пустую строку, а не текст "null"', () => {
    expect(html`<p>${null}${undefined}</p>`.value).toBe('<p></p>');
  });

  it('число подставляется как текст', () => {
    expect(html`<p>${42}</p>`.value).toBe('<p>42</p>');
  });
});

// BUG-244. Keep the complete value together and allow it below a long label.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('BUG-244: строка квоты допускает перенос полного значения',()=>{
  const css=readFileSync(new URL('../src/components/views.css',import.meta.url),'utf8');
  const row=css.match(/^\.quota-top\s*\{([^}]+)\}/m)?.[1];
  const value=css.match(/^\.quota-value\s*\{([^}]+)\}/m)?.[1];
  assert.match(row,/flex-wrap:\s*wrap\s*;/);
  assert.match(value,/white-space:\s*nowrap\s*;/);
});

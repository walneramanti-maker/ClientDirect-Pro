import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tplFromNaf, TEMPLATES, templateFor } from '../src/templates.js';
import { planCards } from '../src/views.js';

test('chaque code NAF des prospects donne le bon métier', () => {
  assert.equal(tplFromNaf('96.02B'), 'beaute');
  assert.equal(tplFromNaf('96.02A'), 'coiffeur');
  assert.equal(tplFromNaf('45.20A'), 'garage');
  assert.equal(tplFromNaf('45.32Z'), 'garage');
  assert.equal(tplFromNaf('56.10C'), 'restaurant');
  assert.equal(tplFromNaf('77.11A'), 'location');
  assert.equal(tplFromNaf('80.10Z'), 'securite');
  assert.equal(tplFromNaf('43.21A'), 'artisan');
  assert.equal(tplFromNaf('62.01Z'), null);
  assert.equal(tplFromNaf(''), null);
});

test('le modèle institut de beauté existe en français et en anglais', () => {
  assert.ok(TEMPLATES.beaute);
  const en = templateFor('beaute', 'en');
  assert.equal(en.label, 'Beauty salon');
  assert.equal(en.services.length, TEMPLATES.beaute.services.length);
  assert.ok(en.services.every((s) => typeof s[1] === 'number'));
});

test('les cartes de formules séparent ce qui est inclus de ce qui ne l’est pas', () => {
  const html = planCards('EUR');
  const cards = html.split('<div class="plan ').slice(1);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /Non inclus/);
  assert.match(cards[1], /Non inclus/);
  assert.doesNotMatch(cards[2], /Non inclus/);
  assert.match(cards[2], /Toutes les fonctionnalités incluses/);
  const offCount = (c) => (c.match(/class="off"/g) || []).length;
  assert.ok(offCount(cards[0]) > offCount(cards[1]));
});

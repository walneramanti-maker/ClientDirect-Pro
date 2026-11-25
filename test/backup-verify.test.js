// Test de restauration à blanc et alertes : la sauvegarde est réellement relue, sans toucher à la base en service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

const app = await setup({ ADMIN_EMAIL: 'alerte@exemple.fr' });
const { db } = app;
test.after(() => app.close());
const B = await import('../src/backup.js');
const dir = () => path.join(path.dirname(path.resolve(db.file)), 'backups', 'test');

test('test de restauration : la dernière sauvegarde est déchiffrée, vérifiée et comparée à la base', async () => {
  await B.createBackup(db);
  const r = await B.verifyBackup(db);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.backup && r.live, 'contenu comparé');
  assert.equal(B.backupHealth(db).ok, B.remoteConfigured() ? true : false);
  assert.equal(db.one("SELECT COUNT(*) n FROM audit WHERE action='job.backup_verify'").n, 1);
  assert.equal(fs.readdirSync(path.dirname(path.resolve(db.file))).filter((f) => f.startsWith('.verification')).length, 0, 'fichier temporaire supprimé');
});

test('sauvegarde altérée : alerte critique et e-mail à l’administrateur', async () => {
  const f = path.join(dir(), fs.readdirSync(dir()).sort().reverse()[0]);
  const buf = fs.readFileSync(f); buf[buf.length - 5] ^= 0xff; fs.writeFileSync(f, buf);
  const r = await B.verifyBackup(db);
  assert.equal(r.ok, false); assert.match(r.error, /altéré|incorrecte/);
  const inc = db.one("SELECT * FROM incidents WHERE kind='backup_verify'");
  assert.equal(inc.severity, 'critical');
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='admin_alert' AND to_addr='alerte@exemple.fr'"), 'alerte e-mail mise en file');
  const h = B.backupHealth(db);
  assert.equal(h.ok, false); assert.ok(h.problems.includes('dernier test de restauration échoué'));
});

test('surveillance externe : /health/sauvegardes répond 503 tant qu’il y a un problème', async () => {
  const res = await app.realFetch(app.base + '/health/sauvegardes');
  assert.equal(res.status, 503);
  const j = await res.json(); assert.equal(j.ok, false); assert.ok(j.problemes.length);
  const h = await (await app.realFetch(app.base + '/health')).json();
  assert.equal(h.ready.sauvegardes.ok, false); assert.equal(h.ready.sauvegardes.testRestauration.ok, false);
  assert.equal(h.ready.alertesEmail, false, 'ni Brevo ni SMTP : signalé');
});

test('alerte si aucune sauvegarde réussie depuis trop longtemps', () => {
  db.run("UPDATE backups SET created_at=? WHERE status='ok'", Date.now() - B.maxBackupAgeMs() - 60e3);
  assert.ok(B.backupHealth(db).problems.includes('dernière sauvegarde trop ancienne'));
});

test('préparation du lancement : liste vérifiée automatiquement, visible par l’administrateur', async () => {
  const { readiness } = await import('../src/readiness.js');
  const r = readiness(db);
  assert.equal(r.total, r.items.length); assert.ok(r.items.find((i) => i.key === 'paiement_test' && !i.ok));
  const h = await (await app.realFetch(app.base + '/health')).json();
  assert.equal(h.ready.lancement.total, r.total); assert.ok(h.ready.lancement.restants.includes('paiement_test'));
  assert.ok(!JSON.stringify(h).match(/sk_(test|live)_/), 'aucun secret');
});

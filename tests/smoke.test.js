const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

const fnSrc = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

test('functions/index.js parses', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'functions/index.js')]);
});

test('page access tokens never travel to the browser', () => {
  assert.ok(!/accessToken/.test(fnSrc.match(/fbStart[\s\S]*?\}\);/)[0]), 'fbStart must not return tokens');
  assert.ok(fnSrc.includes("batch.set(db.doc(`pages/${uid}_${p.id}`)"), 'pages stored per uid');
});

test('scheduling uses Facebook native scheduling, no cron of ours', () => {
  assert.ok(fnSrc.includes('scheduled_publish_time'));
  assert.ok(fnSrc.includes('published: \'false\''));
  assert.ok(!fnSrc.includes('onSchedule'));
});

test('oauth state is HMAC-signed and expiry-checked', () => {
  assert.ok(fnSrc.includes('createHmac') && fnSrc.includes('timingSafeEqual'));
  assert.ok(fnSrc.includes('15 * 60 * 1000'));
});

test('scopes cover page posting', () => {
  for (const s of ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'])
    assert.ok(fnSrc.includes(s), `missing scope ${s}`);
});

test('firestore rules deny everything by default and scope pages/posts to the owner', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  assert.ok(rules.includes('resource.data.uid == request.auth.uid'));
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  const poster = fs.readFileSync(path.join(ROOT, 'web/rehoflow.html'), 'utf8');
  assert.ok(poster.includes('noindex'));
  assert.ok(poster.includes('Sign in with Google') && poster.includes('schedulePost'));
});

test('CI deploys gated on the service account secret', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.ok(yml.includes('node-version: 22'));
  assert.ok(yml.includes('[ -z "${FIREBASE_SERVICE_ACCOUNT_REHOFLOW:-}" ]'));
});

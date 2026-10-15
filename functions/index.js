// RehoFlow: no-configuration social scheduling.
// MVP: Facebook Pages only (free, native scheduling via Graph API).
// Design invariants:
//   * Page tokens live in Firestore, written only by these functions with the
//     Admin SDK. They are never sent to the browser and no web request can read
//     another user's pages.
//   * Scheduling uses Facebook's own scheduled_publish_time (10 min to 75 days
//     out), so there is no cron of ours to keep alive for the MVP.
'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/v2/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const FB_APP_ID = defineSecret('FB_APP_ID');
const FB_APP_SECRET = defineSecret('FB_APP_SECRET');

const FB_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${FB_VERSION}`;
const WEB_BASE = process.env.WEB_BASE || 'https://rehoflow.web.app/';
// Facebook allows scheduling between 10 minutes and 75 days ahead.
const MIN_SCHEDULE_SECS = 11 * 60;
const MAX_SCHEDULE_SECS = 75 * 86400;

const CALLBACK_URL = 'https://us-central1-rehoteq-field.cloudfunctions.net/fbCallback';
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'].join(',');

// The OAuth state carries the Firebase uid of the signed-in user. It is signed
// so a tampered uid cannot write page tokens into someone else's space.
function signState(uid, secret) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${uid}.${nonce}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${mac}`;
}

function verifyState(state, secret) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return null;
  const [uid, nonce, ts, mac] = parts;
  if (Number(ts) < Date.now() - 15 * 60 * 1000) return null;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${uid}.${nonce}.${ts}`).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? uid : null;
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  if (!res.ok) throw new Error(`graph ${path}: ${body && body.error ? body.error.message : res.status}`);
  return body;
}

async function graphPost(path, params) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`graph ${path}: ${body && body.error ? body.error.message : res.status}`);
  return body;
}

// Step 1 of connect: hand the signed-in user the Facebook Login dialog URL.
// With { list: true } it instead returns the pages already connected to the
// caller (id and name only; tokens never leave the server).
exports.fbStart = onCall({ secrets: [FB_APP_SECRET], region: 'us-central1' }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  if (req.data && req.data.list) {
    const snap = await db.collection('pages').where('uid', '==', uid).get();
    return { pages: snap.docs.map((d) => {
      const v = d.data();
      return { pageId: v.pageId, pageName: v.pageName };
    }) };
  }
  try {
    const state = signState(uid, FB_APP_SECRET.value());
    const url = new URL('https://www.facebook.com/' + FB_VERSION + '/dialog/oauth');
    url.searchParams.set('client_id', FB_APP_ID.value());
    url.searchParams.set('redirect_uri', CALLBACK_URL);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', SCOPES);
    return { url: url.toString() };
  } catch (e) {
    throw new HttpsError('failed-precondition', 'The Facebook app is not configured yet. Set FB_APP_ID and FB_APP_SECRET.');
  }
});

// Step 2 of connect: Facebook redirects here. Verify state, exchange the code
// for a long-lived page token, and store pages under the caller's uid.
exports.fbCallback = onRequest({ secrets: [FB_APP_ID, FB_APP_SECRET], region: 'us-central1' }, async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const appSecret = FB_APP_SECRET.value();
  const appId = FB_APP_ID.value();
  const fail = (msg) => res.redirect(`${WEB_BASE}?error=${encodeURIComponent(msg)}`);
  if (!code || !state) return fail('Facebook did not return an authorization code.');
  const uid = verifyState(state, appSecret);
  if (!uid) return fail('The connect link expired. Close the window and try again.');
  try {
    const shortTok = await graphGet('/oauth/access_token', {
      client_id: appId, client_secret: appSecret, redirect_uri: CALLBACK_URL, code,
    });
    const longTok = await graphGet('/oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret,
      fb_exchange_token: shortTok.access_token,
    });
    const pages = await graphGet('/me/accounts', {
      access_token: longTok.access_token,
      fields: 'id,name,access_token,tasks',
    });
    const batch = db.batch();
    for (const p of (pages.data || [])) {
      if (!Array.isArray(p.tasks) || !p.tasks.includes('CREATE_CONTENT')) continue;
      batch.set(db.doc(`pages/${uid}_${p.id}`), {
        uid, pageId: p.id, pageName: p.name, accessToken: p.access_token,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    return res.redirect(`${WEB_BASE}?connected=1`);
  } catch (e) {
    return fail(e.message || 'Facebook rejected the connection.');
  }
});

// Schedule a post on a connected page. Facebook publishes it natively, so the
// function only writes once and returns.
exports.schedulePost = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  const { pageId, text, when } = req.data || {};
  const message = String(text || '').trim();
  const whenSecs = Math.floor(Number(when) / 1000);
  if (!pageId) throw new HttpsError('invalid-argument', 'Choose a page.');
  if (!message) throw new HttpsError('invalid-argument', 'Write something to post.');
  if (message.length > 5000) throw new HttpsError('invalid-argument', 'Keep the post under 5,000 characters.');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(whenSecs) || whenSecs < now + MIN_SCHEDULE_SECS)
    throw new HttpsError('invalid-argument', 'Pick a time at least 11 minutes from now.');
  if (whenSecs > now + MAX_SCHEDULE_SECS)
    throw new HttpsError('invalid-argument', 'Facebook schedules at most 75 days ahead.');

  const pageSnap = await db.doc(`pages/${uid}_${pageId}`).get();
  if (!pageSnap.exists) throw new HttpsError('permission-denied', 'That page is not connected to your account.');
  const page = pageSnap.data();
  try {
    const post = await graphPost(`/${pageId}/feed`, {
      access_token: page.accessToken,
      message,
      published: 'false',
      scheduled_publish_time: String(whenSecs),
    });
    const ref = await db.collection('posts').add({
      uid, pageId, pageName: page.pageName, text: message,
      scheduledAt: new Date(whenSecs * 1000),
      fbPostId: post.id || null, status: 'scheduled',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, postId: ref.id, fbPostId: post.id || null };
  } catch (e) {
    throw new HttpsError('unavailable', 'Facebook refused the post. ' + e.message);
  }
});

// List the caller's scheduled posts, newest first.
exports.listPosts = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  const snap = await db.collection('posts')
    .where('uid', '==', uid).orderBy('scheduledAt', 'desc').limit(50).get();
  return snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id, pageId: v.pageId, pageName: v.pageName, text: v.text,
      scheduledAt: v.scheduledAt ? v.scheduledAt.toMillis() : null,
      fbPostId: v.fbPostId, status: v.status,
    };
  });
});

// Unschedule: tell Facebook to drop the scheduled post, then mark our doc.
exports.cancelPost = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  const { postId } = req.data || {};
  if (!postId) throw new HttpsError('invalid-argument', 'Missing post id.');
  const ref = db.doc(`posts/${postId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid)
    throw new HttpsError('permission-denied', 'That post is not yours.');
  const data = snap.data();
  if (data.fbPostId && data.status === 'scheduled') {
    const pageSnap = await db.doc(`pages/${uid}_${data.pageId}`).get();
    if (pageSnap.exists) {
      try {
        await fetch(`${GRAPH}/${data.fbPostId}?access_token=${encodeURIComponent(pageSnap.data().accessToken)}`,
          { method: 'DELETE', signal: AbortSignal.timeout(15000) });
      } catch (_) { /* our doc still records the intent; FB keeps the post scheduled */ }
    }
  }
  await ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

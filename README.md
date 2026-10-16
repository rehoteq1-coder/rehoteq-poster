# RehoFlow

No-configuration social media scheduling. Connect a page, write a post, pick a
time. Done.

## MVP scope (Facebook Pages first)

Facebook Pages are the only integration in v1 because Meta's Graph API publishes
scheduled posts natively (`scheduled_publish_time`, 10 minutes to 75 days ahead)
with no cron of ours to keep alive, and it is free. Instagram, TikTok and X come
later (Instagram needs Business/Creator account + App Review, ~2-6 weeks; TikTok
is private-only until audited; X has no free posting tier).

## How it works

- `web/rehoflow.html` - the whole interface. Google sign-in, connect a page,
  write, schedule, see and cancel scheduled posts.
- `functions/` - Cloud Functions (Node 22, us-central1) on the `rehoflow`
  Firebase project:
  - `fbStart` - OAuth dialog URL (state is HMAC-signed to the Firebase uid), or
    the caller's connected pages when called with `{list: true}`.
  - `fbCallback` - exchanges the code for a long-lived page token and stores
    pages server-side only.
  - `schedulePost` / `listPosts` / `cancelPost` - callables; each user's rows in
    Firestore are theirs alone.
- Page tokens are written only by the Admin SDK and never returned to any
  client. `firestore.rules` deny everything else by default.

## Setup (one time)

1. Create an app at developers.facebook.com, add **Facebook Login for Web**,
   set the Valid OAuth Redirect URI to
   `https://us-central1-rehoflow.cloudfunctions.net/fbCallback`, and
   request `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
   In Development mode only the app's admins/developers/testers can post;
   submit for App Review before opening it to the public.
2. Store the app id and secret where functions read them:
   `firebase functions:secrets:set FB_APP_ID` and `FB_APP_SECRET`.
3. Add the `FIREBASE_SERVICE_ACCOUNT_REHOFLOW` secret (service account
   JSON) to this GitHub repo so CI can deploy.
4. Push to `main`. CI runs the smoke tests, then deploys functions and rules.

`web/rehoflow.html` is served at its own Firebase Hosting domain (set by WEB_BASE, e.g. `https://rehoflow.web.app`)
(noindex) by the rehoflow repo's normal deploy.

import {route} from '../../src/shared/http.mjs';

/**
 * The public legal pages, served as HTML rather than JSON.
 *
 * Google Play will not publish an app without a privacy policy reachable at a
 * public URL, and an app that creates accounts also needs a page describing
 * how an account is deleted. Both have to stay true as the app changes, so
 * they live next to the code they describe rather than in a CMS nobody opens:
 * a route that starts collecting something new is a route whose author is
 * editing this file in the same change.
 *
 * Deliberately outside every guard prefix — a policy behind a login is not a
 * policy anyone can read.
 */

const CONTACT_EMAIL = 'support@homemate.co.tz';
const COMPANY = 'FahamuTech Limited';
const APP_NAME = 'HomeMate Africa';
const LAST_UPDATED = '18 September 2026';

/** One shell, so the three pages cannot drift apart visually. */
function page(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${APP_NAME}</title>
<style>
  :root { color-scheme: light dark; --ink: #12130f; --muted: #5b5f57; --bg: #ffffff; --rule: #e4e6e0; --accent: #1f6f4a; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #ecefe8; --muted: #a3a8a0; --bg: #14160f; --rule: #2c2f27; --accent: #6fc79a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1rem 5rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .35rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 2.4rem 0 .6rem; letter-spacing: -.01em; }
  h3 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
  p, li { color: var(--ink); }
  .meta { color: var(--muted); font-size: .9rem; margin: 0 0 2rem; }
  ul { padding-left: 1.2rem; }
  li { margin: .35rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .95rem; }
  th, td { text-align: left; vertical-align: top; padding: .6rem .5rem; border-bottom: 1px solid var(--rule); }
  th { color: var(--muted); font-weight: 600; }
  a { color: var(--accent); }
  footer { margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
${body}
<footer>
  ${COMPANY} · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br>
  <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/account-deletion">Delete your account</a>
</footer>
</main>
</body>
</html>`;
}

function html(response, title, body) {
    response.status(200).set('Content-Type', 'text/html; charset=utf-8').send(page(title, body));
}

// --- privacy -----------------------------------------------------------------

const PRIVACY = `
<h1>Privacy Policy</h1>
<p class="meta">${APP_NAME} · Last updated ${LAST_UPDATED}</p>

<p>${APP_NAME} is operated by ${COMPANY}. This policy explains what the app
collects, why it collects it, and what you can do about it. It covers the
HomeMate Africa mobile app and the service behind it.</p>

<h2>What we collect</h2>
<table>
  <tr><th>Data</th><th>Why</th></tr>
  <tr><td>Phone number</td><td>It is your account. We send a one-time SMS code to prove it is yours.</td></tr>
  <tr><td>Name</td><td>So a landlord or agent knows who is asking to view a home.</td></tr>
  <tr><td>Email address (optional)</td><td>Receipts and account notices, if you give one.</td></tr>
  <tr><td>Profile photo (optional)</td><td>Shown on your profile and to the agent you are meeting.</td></tr>
  <tr><td>PIN</td><td>Stored only as a one-way hash. We cannot read your PIN, and it is never sent to anyone else.</td></tr>
  <tr><td>Saved homes, enquiries, viewings and bookings</td><td>To run the service — to show your shortlist, deliver your enquiry, and hold your appointment.</td></tr>
  <tr><td>Payment records</td><td>Rent and fees are paid by mobile money, card or bank transfer. We record the amount, reference and status so you and the landlord have the same receipt.</td></tr>
  <tr><td>Language preference</td><td>To show the app in English or Kiswahili.</td></tr>
  <tr><td>Notification token</td><td>To send you updates about your enquiries, viewings and payments.</td></tr>
  <tr><td>IP address and device/browser identifier at sign-in</td><td>Security only. Every SMS costs money, so we use these to detect and block abuse of the code-sending endpoint.</td></tr>
</table>

<h2>What we do not collect</h2>
<ul>
  <li><strong>We do not track your location.</strong> The app does not request location permission. Maps are drawn around the area you search for, not around where you are.</li>
  <li><strong>We do not read your contacts, photos, messages, call logs or files</strong>, beyond a single image you deliberately choose as a profile photo.</li>
  <li><strong>We never see your mobile money PIN or your full card number.</strong> A payment is authorised inside your provider's own flow; we receive only the result and a reference.</li>
  <li><strong>We do not sell your data, and the app carries no advertising</strong> and no advertising or analytics trackers.</li>
</ul>

<h2>Who else sees it</h2>
<ul>
  <li><strong>The landlord or agent</strong> for a home you enquire about or book sees your name and phone number — that is the point of the enquiry.</li>
  <li><strong>Our SMS provider</strong> receives your phone number in order to deliver a one-time code.</li>
  <li><strong>Payment providers</strong> (M-Pesa, Airtel Money, Mixx by Yas, and our card/bank processor) receive the details needed to process a payment you initiate.</li>
  <li><strong>OpenStreetMap</strong> serves the map tiles the app displays.</li>
  <li><strong>Authorities</strong>, where the law of the United Republic of Tanzania requires it.</li>
</ul>
<p>Nobody else. We do not share your data with advertisers or data brokers.</p>

<h2>How long we keep it</h2>
<p>Your account data is kept while your account exists. Payment and booking
records are kept for seven years after the transaction, because tax and
tenancy law requires it — this applies even if you close your account, and
those records are retained in a form that is not used to contact you.
Sign-in security logs are kept for 90 days.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>See and correct your data</strong> — in the app, under Profile.</li>
  <li><strong>Delete your account</strong> — see <a href="/legal/account-deletion">Delete your account</a>.</li>
  <li><strong>Turn off notifications</strong> — in your phone's system settings for HomeMate, or in the app.</li>
  <li><strong>Ask us anything about your data</strong> — email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we will answer within 30 days.</li>
</ul>

<h2>Security</h2>
<p>Traffic between the app and our servers is encrypted in transit. PINs are
stored only as hashes, sessions expire, and repeated failed PIN attempts lock
an account temporarily. Access to production data is limited to staff who need
it to operate the service.</p>

<h2>Children</h2>
<p>HomeMate is for adults renting a home. It is not directed at children, and
we do not knowingly collect data from anyone under 18. If you believe a child
has given us data, email us and we will delete it.</p>

<h2>Changes</h2>
<p>If this policy changes in a way that affects you, we will say so in the app
before the change takes effect. The date at the top always reflects the
current version.</p>

<h2>Contact</h2>
<p>${COMPANY}, Dar es Salaam, Tanzania<br>
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;

export const legalPrivacy = route({
    method: 'get',
    path: '/legal/privacy',
    description: 'Public privacy policy, as required by Google Play',
    handler: (_request, response) => html(response, 'Privacy Policy', PRIVACY),
});

// --- account deletion --------------------------------------------------------

const ACCOUNT_DELETION = `
<h1>Delete your HomeMate account</h1>
<p class="meta">${APP_NAME} · Last updated ${LAST_UPDATED}</p>

<p>You can ask us to delete your HomeMate account and the data attached to it
at any time, whether or not you still have the app installed.</p>

<h2>How to ask</h2>
<p>Send a message to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
from the email on your account, or from any address, with the subject
<strong>Delete my account</strong> and the phone number you sign in with. We
will verify the request by sending a code to that number, then delete the
account. We complete requests within 30 days.</p>

<h2>What gets deleted</h2>
<ul>
  <li>Your name, email address, profile photo and PIN.</li>
  <li>Your saved homes, enquiries and viewing requests.</li>
  <li>Your notification token, so we stop contacting you.</li>
</ul>

<h2>What we have to keep, and for how long</h2>
<ul>
  <li><strong>Payment and tenancy records — seven years.</strong> Tanzanian tax
      and tenancy law requires a landlord and a platform to be able to produce
      a record of money that changed hands. These are kept as financial records
      and are not used to contact you or to rebuild your profile.</li>
  <li><strong>Nothing else.</strong> Once the retention period ends, the
      remaining records are deleted too.</li>
</ul>

<p>If you have an active booking or an unpaid balance, we will tell you before
the account is closed — deleting the account does not cancel a tenancy or
settle a debt.</p>
`;

export const legalAccountDeletion = route({
    method: 'get',
    path: '/legal/account-deletion',
    description: 'How a customer deletes their account and what is retained, as required by Google Play',
    handler: (_request, response) => html(response, 'Delete your account', ACCOUNT_DELETION),
});

// --- terms -------------------------------------------------------------------

const TERMS = `
<h1>Terms of Service</h1>
<p class="meta">${APP_NAME} · Last updated ${LAST_UPDATED}</p>

<p>These terms govern your use of the ${APP_NAME} app, operated by ${COMPANY}.
By using the app you agree to them.</p>

<h2>What HomeMate is</h2>
<p>HomeMate is a platform that connects people looking for a home with
landlords and agents who have one to let. We list properties, arrange
viewings, and pass payments to the landlord or agent. <strong>We are not the
landlord.</strong> The tenancy agreement is between you and them.</p>

<h2>Your account</h2>
<ul>
  <li>You must be 18 or older.</li>
  <li>Your phone number identifies your account. Keep your PIN to yourself — anything done with it is treated as done by you.</li>
  <li>Give us accurate information. A false name or number wastes an agent's day and may get the account closed.</li>
</ul>

<h2>Listings</h2>
<p>Listings are supplied by landlords and agents. We check them, but we do not
own or inspect every property, and we do not guarantee that a listing is
complete, current, or that the home is still available. Always view a property
before committing money to it.</p>

<h2>Payments</h2>
<ul>
  <li>Payments are made through mobile money and are subject to your provider's own terms and fees.</li>
  <li>A booking or viewing fee is shown before you pay it. Refund terms for each payment are shown at the time of payment.</li>
  <li>Never pay a landlord or agent outside the app. We can only help with a payment we have a record of.</li>
</ul>

<h2>What you may not do</h2>
<ul>
  <li>List a property you have no right to let, or post a listing that is false.</li>
  <li>Harass other users, agents or our staff.</li>
  <li>Scrape, resell or republish listings, or attempt to break, overload or probe the service.</li>
</ul>
<p>We may suspend or close an account that does any of these.</p>

<h2>Liability</h2>
<p>We provide the app as it is. To the fullest extent the law allows, we are
not liable for a dispute between you and a landlord or agent, for a property
that is not as described, or for loss arising from a payment made outside the
app. Nothing here limits liability that cannot lawfully be limited.</p>

<h2>Changes and ending</h2>
<p>We may change these terms; material changes are announced in the app before
they take effect. You may stop using HomeMate at any time — see
<a href="/legal/account-deletion">Delete your account</a>.</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of the United Republic of Tanzania, and
the courts of Tanzania have jurisdiction.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;

export const legalTerms = route({
    method: 'get',
    path: '/legal/terms',
    description: 'Public terms of service',
    handler: (_request, response) => html(response, 'Terms of Service', TERMS),
});

# AI emails — Amboras

URL: https://www.amboras.com/ai-emails

ProductSolutionsResources[Examples](https://www.amboras.com/examples)[Pricing](https://www.amboras.com/pricing)
[Amboras](https://www.amboras.com/)
[Log in](https://www.amboras.com/login)[Start for free](https://www.amboras.com/register)
AI Emails · Postal class
# Every email. _Sent for you._
Ten transactional templates that fire on every order, every customer event, every refund — already addressed, already stamped, already in the box.
[Get started](https://www.amboras.com/register)[Read the mailbag](https://www.amboras.com/ai-emails#templates)
1¢ · POSTAGE PAIDVIA RESENDDKIM · SPF · DMARC
10 templates 98% deliverability 3× retry on failure
From
AMBORAS · Returns
Subject
Your refund is on its way
From
AMBORAS · Welcome
Subject
A short hello, plus a key
AMBORAS
Order #1024 · Confirmation
AMBORAS · STORE · MAIL · AMBORAS · STORE · MAIL ·JUN 282026
Hi _Jordan_ —
Your order of $98.00 has been received and is being prepared. We’ll send tracking the moment it ships.
Track your package
The mailbag
## Ten letters, _addressed for you._
Each one is a real transactional template, pre-wired to a Medusa event. Personalised with the customer’s name, the order total, the tracking link — all auto-filled, all auditable.
Nº 01
TO: Customer · FROM: Your Store
Order confirmation
“Thanks for your order — we’ve got it from here.”
Inside Nº 01
Subject: Order #1024 — confirmed
Receipt with line items, totals, shipping address, and a tracking link slot that fills in when fulfilment moves.
Sent the moment checkout completes.
Nº 02
TO: Customer · FROM: Your Store
Shipped & delivered
“Your order is on the way. Tap to track.”
Inside Nº 02
Subject: Order #1024 — shipped, tracking inside
Carrier badge, live tracking link, and a follow-up when the package is marked delivered.
Sent twice — at handoff and at doorstep.
Nº 03
TO: Customer · FROM: Your Store
Order cancelled
“Your order has been cancelled. Refund is on its way.”
Inside Nº 03
Subject: Order #1024 — cancelled, refund coming
Reason, refund amount, and the expected timing for the funds to land back on the original card.
Sent when an order is cancelled — by you or by the customer.
Nº 04
TO: Customer · FROM: Your Store
Refund confirmation
“Your refund of {{amount}} is processed.”
Inside Nº 04
Subject: Refund of $44 — processed
Refund total, items refunded (full or partial), and the bank settlement window.
Sent the moment Stripe confirms the refund.
Nº 05
TO: Customer · FROM: Your Store
Customer welcome
“Welcome — here’s what we picked out for you.”
Inside Nº 05
Subject: Welcome to {{store}} — first pick is on us
Brand greeting, a 2-product recommendation block, and a one-tap link into the customer portal.
Sent the first time someone creates an account.
Nº 06
TO: Customer · FROM: Your Store
Password reset
“Reset your password — link expires in 24h.”
Inside Nº 06
Subject: Reset your password (link expires in 24h)
Secure single-use link, IP/device summary, and a help line if the request wasn’t the customer.
Sent immediately after a reset request.
Nº 07
TO: Customer · FROM: Your Store
Abandoned cart
“You left something behind. Want it back?”
Inside Nº 07
Subject: You left a Cedar Bloom — want it back?
Cart preview, optional discount code, and a one-click resume-to-checkout link.
Sent four hours after a cart goes idle.
Nº 08
TO: Customer · FROM: Your Store
Review request
“How did we do? One tap to leave a review.”
Inside Nº 08
Subject: How was your Cedar Bloom?
Per-item star prompt, a free-form notes field, and an opt-out for shoppers who don’t want to be asked again.
Sent seven days after delivery.
Nº 09
TO: Customer · FROM: Your Store
Trial ending
“Your trial ends in 3 days — keep going?”
Inside Nº 09
Subject: Your trial ends in 3 days — keep going?
Trial recap, a clear price for the first paid cycle, and a one-tap upgrade link.
Sent three days before the trial converts.
Nº 10
TO: Customer · FROM: Your Store
Payment failed
“Your card couldn’t be charged. Update it here.”
Inside Nº 10
Subject: Your card couldn't be charged — quick fix
Why the charge declined (where Stripe shares it), the next retry attempt, and a one-tap card-update link.
Sent on each failed retry, up to three times.
How a letter ends up in their inbox
## Something happens. _A letter goes out._
Listen to the events your store is already firing. The right template renders, the right customer is addressed, the right postman walks it to the door.
Event → Email
LIVE TODAY
  * When
A customer places an order
↓
Email sent
Order confirmation
Receipt, items, total, tracking placeholder
  * When
You ship the order
↓
Email sent
Shipped notification
Carrier + live tracking link
  * When
A new customer signs up
↓
Email sent
Customer welcome
Account, history, recommendations
  * When
A cart sits idle for 4 hours
↓
Email sent
Recovery email
Items they left, optional discount


Edit your way
## Your stationery, _your handwriting._
Override any template with your own HTML. Drop Handlebars vars wherever you want them — we render with the live order on send.
templates / order-confirmation.hbslive

```
<!-- order confirmation · postal class -->
<mjml>
  <mj-body background-color="#f9f3df">
    <mj-text>
      Hi {{ customer.firstName }},

      Your order {{ order.id }} totaling
      {{ order.total }} is on its way.

      {{#if order.tracking }}
        Track: {{ order.tracking.url }}
      {{/if}}
    </mj-text>
  </mj-body>
</mjml>

```

handlebars · mjml · safesave → ⌘S
Inbox
AMBORAS · Order confirmed
### Hi _Jordan_ ,
Your order #1024 totaling $98.00 is on its way.
Tracking
usps.com/track/9400 1118 …
View order
Sent via Resend · Unsubscribe
Handlebars vars
Drop {{customer}}, {{order}}, {{store}} anywhere — we render with the live values.
DKIM · SPF · DMARC
Signed and aligned through Resend. Domain verification optional, never required.
Audit + retry
Every send logged with sent / bounced / opened / clicked. Failed sends retry 3 times.
The lift
## What good mail _is worth._
10
Templates · zero setup
98%
Median deliverability
100%
Audit-logged sends
Mail call
## Mail’s already _in the box._
Switch on the day you install. Ten transactional templates fire on the events your store is already firing — addressed in your name, stamped with your domain, signed by Resend.
[Get started](https://www.amboras.com/register)[See pricing](https://www.amboras.com/pricing)
10 templatesGDPR · CASL ready3× retry on failureHandlebars overrides
[AMBORAS](https://www.amboras.com/)
E-commerce, version two.
[What is Amboras?→](https://www.amboras.com/what-is-amboras)
Product
  * [AI SEO](https://www.amboras.com/ai-seo)
  * [Reviews](https://www.amboras.com/reviews)
  * [Agentic A/B testing](https://www.amboras.com/ab-testing)
  * [Analytics](https://www.amboras.com/analytics)
  * [AI emails](https://www.amboras.com/ai-emails)


Solutions
  * [Start a new store](https://www.amboras.com/register)
  * [Migrate a store](https://www.amboras.com/migrate)
  * [Apps & integrations](https://www.amboras.com/apps-and-integrations)


Resources
  * [Changelog](https://www.amboras.com/changelog)
  * [FAQ](https://www.amboras.com/faq)
  * [Book a call](https://cal.com/imad-mokadem/founder-call?overlayCalendar=true)
  * [Support](https://www.amboras.com/contact)
  * [Status](https://www.amboras.com/status)


Support
  * Contact us
  * [Book a meeting](https://cal.com/imad-mokadem/amboras-team)


Company
  * [About](https://www.amboras.com/about)
  * [Team](https://www.amboras.com/team)


Follow
  * [Instagram](https://www.instagram.com/amboras.ai/)
  * [LinkedIn](https://www.linkedin.com/company/ecomcoder)
  * [X](https://x.com/Amboras_inc)
  * [Y Combinator](https://www.ycombinator.com/companies/amboras)


© 2026 Amboras, Inc. All rights reserved.
[Terms](https://www.amboras.com/terms)[Privacy](https://www.amboras.com/privacy)[Your Privacy Choices](https://www.amboras.com/privacy/do-not-sell)
Need help?
Cookies
We use cookies and analytics to make Amboras better. You choose what runs. [Cookie policy](https://www.amboras.com/cookies)
Accept allCustomize

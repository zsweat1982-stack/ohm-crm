# Static ad system (every client, every month)

Zac's standard (Nov 8, 2026): static ads, not posters. Real photos. Different formats and different angles. Every buyer stage covered every month. Nothing goes out without passing the gate at the bottom. Design library: `~/Downloads/Creative-System/static_designs.py` (10 genuinely different designs: editorial, color_poster, notes_app, reminders_app, imessage, annotated, polaroid_wall, grid_card, big_number, review_card, ticket_offer). Demo sheet: `~/Downloads/Creative-System/static-ads/designs/` (layout test only, claims marked VERIFY). The older `static_ad_builder.py` (photo on top) is just one of the looks.

**Copy comes from `Voice-of-Customer-to-Copy.md`: Reddit threads, competitors' reviews and what people search, read between the lines.**

## 1. The monthly pack (per client)
**15 statics a month: 3 per buyer stage.** Each of the 3 uses a different DESIGN (not just different words) AND a different angle. Across the 15, use at least 8 different designs. Plan it before anyone builds:
| Stage | Buyer | Angles to pick from (use 3 different ones) | Layouts that fit | CTA | Metric |
|---|---|---|---|---|---|
| 1 Potential | doesn't know yet | curiosity ("Ever wonder who builds..."), hidden cost, myth | photo_top, overlay | See the work, Learn more | Reach, 3 sec views, shares |
| 2 Pain | feels it | the exact moment, the mistake, the cost of waiting | overlay, photo_top | Talk to a builder, Get help | CTR, saves, comments |
| 3 Promise | knows what they want | the outcome, the process, what is included, comparison | split, photo_top | See how it works | CTR, landing page views, DMs |
| 4 Proof | wants evidence | customer quote, before and after, real numbers, behind the scenes | quote, split | See the work, Read the story | Link clicks, replies |
| 5 Offer | ready | the offer with real terms, deadline (only if real), quote request | photo_top, overlay | Get a quote, Call, Book | Calls, forms, booked jobs |

**More layouts to add (backlog):** list card on a real photo (3 to 5 plain bullets), text-message or Notes native screenshot over a real photo, price or range card (only when the client allows), map and ZIP card, deadline card (real dates only), question card ("Which one?" with two real photos).
**Angle bank (rotate, never repeat in one month):** pain moment, mistake, myth vs fact, cost, speed, proof, comparison, process, local identity, objection answered, deadline, offer.

## 2. Rules for every static
- Real photo from the client's jobs, shop or site. Never AI images, never renders, never stock. Record who confirmed it is theirs.
- One idea. One person in one moment. One checkable detail. One button. Domain and phone in the footer.
- No icons, borders, stickers, extra badges or decorative lines. Brand colors for headline and button only.
- First line passes the cheat sheet test (one person, one moment, checkable, about them).
- Offers carry their terms and real dates. A published end date can be extended, never cut short.
- Every claim has a source in the log, or it is marked VERIFY and does not publish.
- Competitor and review quotes are research only. Customer quotes need a written release.

## 3. QA gate (all must be yes before it goes to approval)
1. Stage (1 to 5), angle and layout recorded. 2. Photo is the client's own and confirmed by name. 3. First line passes the test. 4. Every claim sourced or removed. 5. Compliance rules in the client brain met. 6. Text readable at phone size and inside Feed safe areas. 7. No em dashes, no hashtags on Instagram, US spelling. 8. File named `CODE_STATIC_S{stage}_{angle}_{layout}_v1.png`. 9. Logged in `static_ad_log.csv` (builder does this). 10. Approval path followed (Zac, or client folder in Basecamp).

## 3b. Test order
Stage 1 to 3 run organically first (two versions, compare saves, shares, profile visits). Stage 3 to 5 run as paid or retargeting. A static is TESTED only after a real result is written to the log; PROVEN only after it wins repeatedly with enough volume.

## 4. Where it lives
Each client brain has a "Static pack" table (15 rows: stage, angle, layout, photo, headline, status). The dashboard shows pack completion by stage so a missing stage is visible.

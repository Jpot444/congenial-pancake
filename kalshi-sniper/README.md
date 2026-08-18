# Kalshi Sniper

A userscript that lays a one-tap buying panel over Kalshi's own market pages.
Open an event, hit **SNIPE**, and every market in that event is a row with a
live YES price and a button that sweeps the book.

Version 8 was built for a phone and for an API that no longer exists. This is
version 9: the API calls are current, and the layout is built for an iPad as
well as for a phone.

## What changed in Kalshi's API

Three things broke under version 8, and all three were silent — the script kept
running and simply stopped being able to read a price or place an order.

**Money is no longer sent in integer cents.** The `yes_ask`, `no_bid` and
`last_price` fields were removed in March 2026. Prices now arrive as
fixed-point dollar strings in fields suffixed `_dollars` (`"0.6500"`), and
contract counts as fixed-point strings suffixed `_fp` (`"13.00"`). Version 8
read `market.yes_ask` and got `undefined`, which rendered as `--` on every row
— a board that looked like it had loaded and had not.

**The orderbook moved inside `orderbook_fp`.** Its `yes_dollars` and
`no_dollars` arrays hold `[price, size]` pairs, both strings. Version 8 half
knew about this and multiplied its way back to cents; version 9 keeps the
original string and hands it back untouched when it places the order, so
nothing is lost to rounding on a sub-penny market.

**Orders are written through `POST /portfolio/events/orders`.** The V2 order
takes one book side — `"bid"` or `"ask"` — and one decimal price, rather than
the old `side: "yes"` + `action: "buy"` + `yes_price: <cents>` shape. Buying
YES is a **bid**. The pre-V2 endpoint is still routed for now, so a 404 on the
V2 path falls back to it rather than failing the trade.

The production host is also now `external-api.kalshi.com`. The older
`api.elections.kalshi.com` still answers and is one field away in settings.

Authentication did **not** change: RSA-PSS over SHA-256 with a 32-byte salt,
signing `<timestamp_ms><METHOD><path>`, where the path keeps its `/trade-api/v2`
prefix and drops the query string.

## What a snipe actually does

Kalshi publishes bids only. The YES offers you are lifting are the mirror of
the NO book — a NO bid at 7¢ is a YES ask at 93¢ — so the ladder is built by
reflecting the NO side and sorting it cheapest-first.

From there the sweep walks that ladder from the cheapest level down, taking
whole contracts until it has your size or hits your price cap, whichever comes
first. The limit it sends is **the worst level it actually intends to touch**,
as an immediate-or-cancel order: everything at or under that price fills, and
nothing above it does.

That last part is the substantive change from version 8, which always sent the
worst price in the entire book. On a thin market that is an instruction to pay
90¢ for something quoted at 65¢ if someone is resting an order up there. The
**Max ¢** box is the ceiling, and with it set the row tells you before you tap
what the sweep will cost.

The board's prices come from the event fetch, but the book is re-read at the
instant you tap, so the limit reflects what is actually resting rather than
what was resting when the page last polled.

## Installing it

Any userscript engine that provides a cross-origin fetch will do. On iOS and
iPadOS that means **Userscripts** for Safari, or **Orion**. Install
`kalshi-sniper.user.js`, open a Kalshi market page, and a green SNIPE button
appears in the corner. Drag it anywhere — where it lands is remembered, which
matters on an iPad where the default corner sits on top of Kalshi's own trade
ticket.

### Credentials

Kalshi issues these under **Account → API Keys**: a key ID and an RSA private
key, downloaded once as a PEM. Paste both into the settings panel. PKCS#8 and
PKCS#1 PEMs are both accepted — the second is what you get if the file has been
through `openssl rsa`, and it is unpacked by hand here because WebCrypto will
not import it and nobody wants to find an `openssl` on an iPad.

### The Worker proxy is now optional

Version 8 refused to start without one. It is only needed if your userscript
engine has no cross-origin fetch, or if you would rather your signed traffic
went through infrastructure you own. Leave it blank and the script talks to
Kalshi directly through the engine's own request API. If that turns out to be
blocked, the error says so and names the proxy as the fix rather than making
you guess.

## On an iPad

The overlay is a centred card above 760px rather than a full-screen takeover,
so the market page stays visible behind it, and the rows lay out as a grid —
two columns in portrait, three in landscape — instead of one tall list you
have to scroll. Below that width, on a phone or in a narrow Split View pane,
it goes full-bleed and single-column. Safe-area insets are respected at both
sizes, so nothing hides under the home indicator.

With a keyboard attached you should not need the screen at all:

| Key | Does |
| --- | --- |
| `1`–`9` | Fire that row. The number is printed on the card. |
| `/` | Jump to the filter box |
| `R` | Refresh prices now |
| `Esc` | Close the panel, or leave the field you are typing in |

Number keys are ignored while you are typing in a field, so filtering for a
market called "90" does not buy anything.

## The rest of it

- **Size** is a box and five preset chips. Rows re-price as you change it, so
  the estimated cost under each market is always for the size you would send.
- **Filter** narrows the board as you type — useful on a strike ladder with
  forty rows.
- **Prices refresh** on their own every few seconds, and pause when the tab is
  in the background. One request repaints the whole board, because market
  objects carry their own ask; version 8 fired one orderbook request *per row*
  on every load, which on a phone connection was most of the wait.
- **A result stays put.** The ✓ badge on a filled row survives the refresh that
  follows it, rather than being painted over half a second later by the poll.
- **Errors go to the footer**, never to `alert()`. A modal dialog on iOS blocks
  the page and is a genuinely bad thing to meet mid-trade.
- **Require a second tap** is in settings, off by default, for when the iPad is
  somewhere it might get knocked.

## Known limits

- **The private key is in `localStorage`.** It has to be reachable to sign
  requests, and a userscript has nowhere better to put it. Anything with script
  access to `kalshi.com` in that browser can read it. Use a key scoped to what
  you are willing to lose, and clear it with **Forget stored key** on a device
  you do not control. The key is no longer echoed back into the settings form —
  a stored key shows as a placeholder, not as its own text.
- **Event tickers are guessed from the URL.** Kalshi's routes are not one
  shape: the ticker can be in the path, the hash, or a query parameter, and a
  series landing page has no event ticker in it at all. The guess is shown in
  the header so you can see what it resolved to, a series page falls back to
  listing that series' markets, and settings has an override for the day it is
  still wrong.
- **It buys YES and only YES.** Selling, and buying NO, are not here.
- **The V2 order shape is verified against a stub, not against production.**
  See below.

## Tests

```
node test/unit.test.js        # no dependencies
npm install jsdom
node test/browser.test.js
```

`unit.test.js` pulls the real functions out of the userscript — it does not
copy them — and checks fixed-point conversion, orderbook parsing in both the
new and legacy shapes, sweep planning against price caps and thin books, and
URL-to-ticker resolution.

`browser.test.js` runs the whole userscript in a DOM against a stubbed Kalshi:
it opens the panel, checks the board paints from `_dollars` fields, fires an
order and asserts the request body is the V2 shape, forces a 404 to prove the
pre-V2 fallback works, drives the keyboard shortcuts, and — using a real
generated RSA key — verifies every signature the script emits against the
public half. 95 assertions across the two.

What that does **not** cover is Kalshi itself. This was written somewhere with
no route to `docs.kalshi.com` or to the API, so the endpoint shapes come from
documentation rather than from a live call, and the first real order is the
first time the V2 body meets the exchange. Send a small one.

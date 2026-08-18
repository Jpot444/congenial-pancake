/* Unit tests for the parts of the sniper where being wrong costs money:
 * fixed-point conversion, reading the orderbook, planning a sweep, and
 * working out which event a Kalshi URL is pointing at.
 *
 * The implementations are pulled out of the userscript itself rather than
 * copied, so these cannot drift away from what actually ships.
 *
 *   node test/unit.test.js
 */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'kalshi-sniper.user.js'),'utf8');

// Pull the real implementations out of the userscript so the tests exercise
// shipped code rather than a copy of it.
function grab(re, name) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}
const parts = [
  grab(/const centsOf = \(dollars\) => \{[\s\S]*?\n  \};/, 'centsOf'),
  grab(/const countOf = \(fp\) => \{[\s\S]*?\n  \};/, 'countOf'),
  grab(/const dollarsOf = \(cents\) =>[^\n]*/, 'dollarsOf'),
  grab(/function levels\(raw, asDollars\) \{[\s\S]*?\n  \}/, 'levels'),
  grab(/function readBook\(resp\) \{[\s\S]*?\n  \}/, 'readBook'),
  grab(/function plan\(asks, want, capCents\) \{[\s\S]*?\n  \}/, 'plan'),
  grab(/const filledFrom = \(resp\) => \{[\s\S]*?\n  \};/, 'filledFrom'),
  grab(/const balanceFrom = \(resp\) =>[\s\S]*?null;/, 'balanceFrom'),
];
const mod = new Function(parts.join('\n') +
  '\nreturn {centsOf,countOf,dollarsOf,levels,readBook,plan,filledFrom,balanceFrom};')();
const {centsOf,countOf,dollarsOf,readBook,plan,filledFrom,balanceFrom} = mod;

let pass=0, fail=0;
const eq=(n,got,want)=>{const g=JSON.stringify(got),w=JSON.stringify(want);
  if(g===w){pass++;console.log('  ok  '+n);}else{fail++;console.log('  FAIL '+n+'\n    got  '+g+'\n    want '+w);}};

console.log('--- fixed point (cents removed from the API in March 2026) ---');
eq('"0.6500" -> 65c', centsOf('0.6500'), 65);
eq('"0.0700" -> 7c', centsOf('0.0700'), 7);
eq('"0.9900" -> 99c', centsOf('0.9900'), 99);
eq('null price', centsOf(undefined), null);
eq('count "13.00"', countOf('13.00'), 13);
eq('65c -> "0.6500"', dollarsOf(65), '0.6500');
eq('7c -> "0.0700"', dollarsOf(7), '0.0700');

console.log('--- orderbook_fp: YES asks are the mirror of the NO book ---');
const book = readBook({orderbook_fp:{no_dollars:[["0.1000","50.00"],["0.3000","200.00"],["0.3500","500.00"]]}});
eq('cheapest YES first', book.asks.map(a=>a.cents), [65,70,90]);
eq('best ask', book.best, 65);
eq('depth', book.depth, 750);
eq('unsorted input sorts', readBook({orderbook_fp:{no_dollars:[["0.3500","500"],["0.1000","50"]]}}).asks.map(a=>a.cents), [65,90]);
eq('orderbook_fp.no alias', readBook({orderbook_fp:{no:[["0.3500","500"]]}}).best, 65);
eq('legacy cents book', readBook({orderbook:{no:[[10,50],[35,500]]}}).best, 65);
{ const b = readBook({});
  eq('empty response', {asks:b.asks,best:b.best,depth:b.depth}, {asks:[],best:null,depth:0});
  eq('book carries a read timestamp', typeof b.at, 'number'); }
eq('0c and 100c dropped', readBook({orderbook_fp:{no_dollars:[["0.0000","10"],["1.0000","5"],["0.4000","9"]]}}).asks.map(a=>a.cents), [60]);
eq('zero size dropped', readBook({orderbook_fp:{no_dollars:[["0.5000","0"],["0.4000","9"]]}}).asks.map(a=>a.cents), [60]);

console.log('--- sweep planning ---');
eq('inside best level', plan(book.asks,100,null), {count:100,limit:65,cost:6500});
eq('exactly best level', plan(book.asks,500,null), {count:500,limit:65,cost:32500});
eq('walks two levels', plan(book.asks,600,null), {count:600,limit:70,cost:39500});
eq('wants more than rests', plan(book.asks,5000,null), {count:750,limit:90,cost:51000});
eq('cap 65 stops at level 1', plan(book.asks,600,65), {count:500,limit:65,cost:32500});
eq('cap 70 takes two', plan(book.asks,600,70), {count:600,limit:70,cost:39500});
eq('cap under best = no trade', plan(book.asks,100,60), {count:0,limit:null,cost:0});
eq('empty book = no trade', plan([],100,null), {count:0,limit:null,cost:0});
eq('fractional level floors, cost agrees', plan(readBook({orderbook_fp:{no_dollars:[["0.5000","10.50"]]}}).asks,100,null), {count:10,limit:50,cost:500});
eq('cost == count*limit when one level', (()=>{const p=plan(book.asks,300,null);return p.cost===p.count*p.limit;})(), true);

console.log('--- response readers ---');
eq('V2 fill_count fixed point', filledFrom({order_id:'x',fill_count:'25.00'}), 25);
eq('V1 nested order', filledFrom({order:{fill_count:12}}), 12);
eq('fill_count_fp fallback', filledFrom({fill_count_fp:'7.00'}), 7);
eq('no fill', filledFrom({order_id:'x',fill_count:'0'}), 0);
eq('balance_dollars', balanceFrom({balance_dollars:'1234.5600'}), 123456);
eq('legacy integer cents balance', balanceFrom({balance:5000}), 5000);
eq('prefers dollars when both', balanceFrom({balance_dollars:'10.0000',balance:999}), 1000);


console.log('--- event ticker out of the URL ---');
{
  const body = src.match(/function tickerFromUrl\(\) \{[\s\S]*?\n  \}/)[0];
  let store = { get: (k, d) => d };
  const make = new Function('store', 'getLoc',
    body.replace(/location\./g, 'getLoc().') + '\nreturn tickerFromUrl;');
  const run = (url) => {
    const u = new URL(url);
    return make(store, () => ({ pathname: u.pathname, hash: u.hash, search: u.search }))();
  };
  const eqUrl = (n, g, w) => eq(n, g, w);
  const eq2 = eq;


eq('hash carries the event', run('https://kalshi.com/markets/kxhighny/highest-temperature-in-nyc#kxhighny-25aug18'), 'KXHIGHNY-25AUG18');
eq('slug beside ticker: ticker wins', run('https://kalshi.com/markets/kxpres/presidential-election-winner/KXPRES-24'), 'KXPRES-24');
eq('query param', run('https://kalshi.com/markets?event_ticker=INXD-25AUG18'), 'INXD-25AUG18');
eq('event= param', run('https://kalshi.com/markets/foo?event=KXFED-25DEC'), 'KXFED-25DEC');
eq('bare ticker path', run('https://kalshi.com/markets/KXHIGHNY-25AUG18'), 'KXHIGHNY-25AUG18');
eq('no digits anywhere: series segment', run('https://kalshi.com/markets/kxpres/presidential-election'), 'KXPRES');
eq('markets root', run('https://kalshi.com/markets'), '');
eq('no-digit hash ignored, series wins', run('https://kalshi.com/markets/kxpres/election#orderbook'), 'KXPRES');
eq('trailing slash', run('https://kalshi.com/markets/kxpres/KXPRES-24/'), 'KXPRES-24');

console.log('--- override beats everything ---');
store={get:(k,d)=> k==='event' ? 'MYEVENT-99' : d};
eq('settings override', run('https://kalshi.com/markets/kxhighny/x#kxhighny-25aug18'), 'MYEVENT-99');

}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

/* End-to-end test: runs the real userscript in a DOM against a stubbed
 * Kalshi, and checks the things a syntax check cannot — that the overlay
 * paints, that a tap sends a well-formed V2 order, that a badge survives the
 * refresh underneath it, and that every request it signs verifies against the
 * public half of the key.
 *
 *   npm install jsdom && node test/browser.test.js
 */
const fs=require('fs'), path=require('path'), nodeCrypto=require('crypto');
const {JSDOM}=require('jsdom');

const SRC=fs.readFileSync(path.join(__dirname, '..', 'kalshi-sniper.user.js'),'utf8');

// A real RSA key, so the script's WebCrypto import and signing are exercised
// for real and every signature it emits can be verified against the public half.
const {publicKey,privateKey}=nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048});
const PEM=privateKey.export({type:'pkcs8',format:'pem'});

process.on('unhandledRejection',e=>{console.log('UNHANDLED: '+(e&&e.stack||e));process.exit(1);});
const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{
  url:'https://kalshi.com/markets/kxhighny/high-temp-nyc#kxhighny-25aug18',
  pretendToBeVisual:true, runScripts:'outside-only',
});
const {window}=dom;
// jsdom's window.crypto is a getter with no subtle; replace it wholesale.
Object.defineProperty(window,'crypto',{value:nodeCrypto.webcrypto,configurable:true,writable:true});
window.TextEncoder=TextEncoder;
global.window=window; global.document=window.document;

window.localStorage.setItem('ks_keyid','test-key-id');
window.localStorage.setItem('ks_pem',PEM);
window.localStorage.setItem('ks_qty','100');

const MARKETS=[
  {ticker:'KXHIGHNY-25AUG18-T85',yes_sub_title:'85° or above',status:'open',yes_ask_dollars:'0.6500',volume_fp:'1200.00'},
  {ticker:'KXHIGHNY-25AUG18-T90',yes_sub_title:'90° or above',status:'open',yes_ask_dollars:'0.1200',volume_fp:'340.00'},
  {ticker:'KXHIGHNY-25AUG18-T95',yes_sub_title:'95° or above',status:'closed',yes_ask_dollars:'0.0200',volume_fp:'10.00'},
];
const BOOK={orderbook_fp:{no_dollars:[["0.1000","50.00"],["0.3000","200.00"],["0.3500","500.00"]]}};

const sent=[];           // every request the script made
const problems=[];

window.GM_xmlhttpRequest=function(o){
  sent.push(o);
  const u=new URL(o.url);
  const path=u.pathname;
  let body=null;

  // Verify the signature over <ts><METHOD><path-without-query>, per Kalshi auth.
  const h=o.headers||{};
  const msg=(h['KALSHI-ACCESS-TIMESTAMP']||'')+o.method.toUpperCase()+path;
  const ok=nodeCrypto.verify('sha256',Buffer.from(msg),
    {key:publicKey,padding:nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32},
    Buffer.from(h['KALSHI-ACCESS-SIGNATURE']||'','base64'));
  if(!ok) problems.push('signature did not verify for '+o.method+' '+path);
  if(h['KALSHI-ACCESS-KEY']!=='test-key-id') problems.push('missing/wrong access key header');
  if(!/^\d{13}$/.test(h['KALSHI-ACCESS-TIMESTAMP']||'')) problems.push('timestamp is not ms epoch: '+h['KALSHI-ACCESS-TIMESTAMP']);
  if(!path.startsWith('/trade-api/v2/')) problems.push('path missing /trade-api/v2 prefix: '+path);

  // Order first: /portfolio/events/orders also contains '/events/'.
  if(path.endsWith('/portfolio/events/orders')){
    if(global.V2_GONE){ setTimeout(()=>o.onload({status:404,responseText:'not found'}),0); return; }
    body={order_id:'o1',fill_count:'600.00',remaining_count:'0'};
  }
  else if(path.endsWith('/portfolio/orders')) body={order:{order_id:'legacy',fill_count:600}};
  else if(path.endsWith('/portfolio/balance')) body={balance_dollars:'2500.0000'};
  else if(path.endsWith('/orderbook')) body=BOOK;
  else if(path.includes('/events/')) body={event:{title:'Highest temperature in NYC',markets:MARKETS}};
  else body={markets:[]};

  setTimeout(()=>o.onload({status:200,responseText:JSON.stringify(body)}),0);
};

// Run the userscript.
window.eval(SRC);

const $=(id)=>window.document.getElementById(id);
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

function fire(el,type,props){
  const e=new window.Event(type,{bubbles:true});
  Object.assign(e,props||{});
  el.dispatchEvent(e);
}

(async()=>{
  let pass=0,fail=0;
  const eq=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
    if(a===b){pass++;console.log('  ok  '+n);}else{fail++;console.log('  FAIL '+n+'\n    got  '+a+'\n    want '+b);}};
  const ok=(n,c)=>eq(n,!!c,true);

  console.log('--- the button ---');
  const fab=$('ks-fab');
  ok('FAB injected',fab);
  eq('FAB label',fab.textContent,'SNIPE');

  fab.setPointerCapture=()=>{};
  fab.releasePointerCapture=()=>{};
  fire(fab,'pointerdown',{clientX:10,clientY:10,pointerId:1});
  fire(fab,'pointerup',{clientX:10,clientY:10,pointerId:1});

  await wait(120);

  console.log('--- the board ---');
  ok('overlay opened',$('ks-wrap'));
  ok('body scroll locked',window.document.body.style.overflow==='hidden');
  eq('title from the event',$('ks-title').textContent,'Highest temperature in NYC');
  ok('subtitle names the resolved ticker',$('ks-sub').textContent.includes('KXHIGHNY-25AUG18'));
  ok('subtitle shows balance',$('ks-sub').textContent.includes('$2,500.00'));

  const cards=$('ks-grid').querySelectorAll('.ksc');
  eq('closed market filtered out',cards.length,2);
  eq('first row name',cards[0].querySelector('.ks-n').textContent,'85° or above');
  eq('price read from _dollars',cards[0].querySelector('.ks-ask').textContent,'65¢');
  eq('second row price',cards[1].querySelector('.ks-ask').textContent,'12¢');
  ok('estimated cost shown',cards[0].querySelector('.ks-meta').textContent.includes('$65.00'));
  eq('keyboard hint on row 1',cards[0].querySelector('.ks-key').textContent,'1');

  console.log('--- size chips ---');
  const chip250=[...$('ks-grid').ownerDocument.querySelectorAll('.ks-chip')].find(c=>c.dataset.qty==='250');
  chip250.click();
  await wait(10);
  eq('qty input follows the chip',$('ks-qty').value,'250');
  ok('cost re-estimated for 250',$('ks-grid').querySelector('.ks-meta').textContent.includes('$162.50'));

  console.log('--- filter ---');
  const search=$('ks-search');
  search.value='90'; fire(search,'input');
  await wait(10);
  eq('filter narrows the grid',$('ks-grid').querySelectorAll('.ksc').length,1);
  search.value=''; fire(search,'input');
  await wait(10);

  console.log('--- firing an order ---');
  // 600 against a book of 500@65c / 200@70c / 50@90c must walk two levels.
  const qtyIn=$('ks-qty'); qtyIn.value='600'; fire(qtyIn,'input');
  await wait(10);
  sent.length=0;
  $('ks-grid').querySelector('.ks-b').click();
  await wait(200);

  const order=sent.find(r=>r.url.endsWith('/portfolio/events/orders'));
  ok('used the V2 order endpoint',order);
  const b=JSON.parse(order.data);
  eq('ticker',b.ticker,'KXHIGHNY-25AUG18-T85');
  eq('side is the book side, not "yes"',b.side,'bid');
  eq('price is a decimal dollar string',b.price,'0.7000');
  eq('count is the full sweep',b.count,'600');
  eq('immediate or cancel',b.time_in_force,'immediate_or_cancel');
  eq('self trade prevention',b.self_trade_prevention_type,'taker_at_cross');
  ok('client order id present',/^ks-/.test(b.client_order_id));
  ok('no legacy yes_price field',b.yes_price===undefined);
  ok('no legacy action field',b.action===undefined);

  const btn=$('ks-grid').querySelector('.ks-b');
  ok('badge survives the post-fill refresh',btn.textContent.includes('600'));
  ok('footer reports the fill',$('ks-foot').textContent.includes('Bought 600'));

  console.log('--- price cap ---');
  const cap=$('ks-cap');
  cap.value='13'; fire(cap,'input');
  await wait(10);
  sent.length=0;
  $('ks-grid').querySelector('.ks-b').click();   // 85° book is 65c, over a 13c cap
  await wait(150);
  ok('no order sent above the cap',!sent.some(r=>r.url.includes('/orders')));
  ok('says why it refused',$('ks-foot').textContent.includes('cap'));

  console.log('--- falls back to the pre-V2 order endpoint on 404 ---');
  cap.value=''; fire(cap,'input');        // lift the cap set just above
  global.V2_GONE=true;
  sent.length=0;
  await wait(3100);                       // let the badge clear
  $('ks-grid').querySelector('.ks-b').click();
  await wait(250);
  const legacy=sent.find(r=>r.url.endsWith('/portfolio/orders'));
  ok('retried the old endpoint',legacy);
  const lb=JSON.parse(legacy.data);
  eq('legacy side',lb.side,'yes');
  eq('legacy action',lb.action,'buy');
  eq('legacy price in cents',lb.yes_price,70);
  eq('legacy count is a number',lb.count,600);
  ok('legacy fill reported',$('ks-foot').textContent.includes('Bought 600'));
  global.V2_GONE=false;

  console.log('--- keyboard fires a row (iPad) ---');
  await wait(3100);
  sent.length=0;
  window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'2',bubbles:true}));
  await wait(250);
  const k=sent.find(r=>r.url.includes('/orders'));
  ok('key 2 fired the second row',k && JSON.parse(k.data).ticker==='KXHIGHNY-25AUG18-T90');

  console.log('--- number keys do not fire while typing ---');
  await wait(3100);
  sent.length=0;
  const sb=$('ks-search'); sb.focus();
  const ev=new window.KeyboardEvent('keydown',{key:'1',bubbles:true});
  Object.defineProperty(ev,'target',{value:sb});
  sb.dispatchEvent(ev);
  await wait(120);
  ok('no order from typing a digit',!sent.some(r=>r.url.includes('/orders')));

  console.log('--- keyboard (iPad) ---');
  const esc=new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true});
  window.document.dispatchEvent(esc);
  await wait(20);
  ok('Esc closes the overlay',!$('ks-wrap'));
  ok('body scroll restored',window.document.body.style.overflow==='');

  console.log('--- auth ---');
  eq('every signature verified',problems,[]);

  console.log('--- first run, no credentials ---');
  {
    const d2=new JSDOM('<!doctype html><html><head></head><body></body></html>',{
      url:'https://kalshi.com/markets/kxhighny/high-temp-nyc#kxhighny-25aug18',
      pretendToBeVisual:true, runScripts:'outside-only'});
    const w=d2.window;
    Object.defineProperty(w,'crypto',{value:nodeCrypto.webcrypto,configurable:true,writable:true});
    w.TextEncoder=TextEncoder;
    let called=false;
    w.GM_xmlhttpRequest=()=>{called=true;};
    w.eval(SRC);
    const f=w.document.getElementById('ks-fab');
    f.setPointerCapture=()=>{};
    const ev=(el,t,pr)=>{const e=new w.Event(t,{bubbles:true});Object.assign(e,pr);el.dispatchEvent(e);};
    ev(f,'pointerdown',{clientX:5,clientY:5,pointerId:1});
    ev(f,'pointerup',{clientX:5,clientY:5,pointerId:1});
    await wait(50);
    const g=(id)=>w.document.getElementById(id);
    ok('settings shown instead of the board',g('ks-set'));
    ok('no board rendered',!g('ks-grid'));
    ok('asks for the key id',g('f-keyid'));
    ok('asks for the PEM',g('f-pem'));
    ok('proxy is optional, not demanded',g('f-proxy').value==='');
    eq('defaults to the current production host',g('f-host').value,'https://external-api.kalshi.com');
    ok('no request made without credentials',!called);
    ok('shows the ticker it detected',g('f-event').placeholder.includes('KXHIGHNY-25AUG18'));
    g('f-save').click();
    await wait(20);
    ok('refuses to connect with empty fields',g('ks-foot').textContent.includes('required'));
    ok('still no request attempted',!called);
  }

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail||problems.length?1:0);
})();

// =====================================================================
// RAVEN PROP BACKEND: Money.gs
// Payments, manual USDT, gateways, payouts, KYC, affiliate. Parts 11-15.
// Prefixes: pay_, crypto_, gw_, payout_, kyc_, aff_.
// =====================================================================

// ===== PART 11: PAYMENT CORE =====
// Order flow: created -> awaiting_payment -> (verified | awaiting_confirmation) -> confirmed -> challenge_created,
// plus failed, expired, rejected, refunded. One order_ref is saved BEFORE any payment (by fx_saveQuote), and the
// amount and currency ALWAYS come from that stored quote, never from the browser.
//   Gateway route: awaiting_payment -> verified (server-side verify call, exact match) -> confirmed (system).
//   Manual route:  awaiting_payment -> awaiting_confirmation -> confirmed | rejected (admin only).
//   confirmed -> challenge_created happens exactly once, inside the script lock.
// Browser-callable here: pay_createOrder and pay_getOrder only. Every other function is internal, and an
// order can never be marked paid from a browser call. Parts 12 and 13 call the composites at the bottom:
// pay_completeGateway (gateway) and pay_approveManual (admin approval).
var PAY_TRANSITIONS_={
  created:['awaiting_payment','failed','expired'],
  awaiting_payment:['verified','awaiting_confirmation','failed','expired'],
  verified:['confirmed','failed'],
  awaiting_confirmation:['confirmed','rejected'],
  confirmed:['challenge_created','refunded'],
  failed:['awaiting_payment'],
  challenge_created:[],rejected:[],expired:[],refunded:[]
};
function pay_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function pay_get_(ref){
  var o=typeof ref==='string'&&ref?sheet_getByKey('Payments',ref):null;
  if(!o)throw pay_bad_('Order not found.');
  return o;
}
function pay_history_(o){var h=sheet_jsonParse_(o.status_history,[]);return Array.isArray(h)?h:[];}
function pay_actor_(ctx){
  if(ctx&&ctx.system)return 'system:'+String(ctx.system).slice(0,40);
  if(ctx&&ctx.user)return (ctx.role||'user')+':'+ctx.user.user_id;
  return 'system';
}
function pay_requireAdmin_(ctx){
  if(!ctx||!ctx.user||(ctx.role!=='admin'&&ctx.role!=='owner'))throw util_error_(CODES.FORBIDDEN,'You do not have access to this action.');
}
function pay_requireSystem_(ctx){
  if(!ctx||!ctx.system)throw util_error_(CODES.FORBIDDEN,'Only the payment system can do this.');
}
function pay_text_(v,min,max,msg){
  var s=typeof v==='string'?v.trim():'';
  if(s.length<min||s.length>max||/[\u0000-\u001F]/.test(s))throw pay_bad_(msg);
  return s;
}
// The single place an order changes state. Re-reads the row inside the lock, checks the transition table
// and an optional guard, appends who/what/when to status_history, and writes once.
function pay_transition_(ref,to,ctx,changes,opts){
  opts=opts||{};
  return util_withLock_(function(){
    var o=pay_get_(ref),from=o.status;
    if((PAY_TRANSITIONS_[from]||[]).indexOf(to)===-1)throw pay_bad_('This payment cannot move from '+from+' to '+to+'.');
    if(opts.guard)opts.guard(o);
    var hist=pay_history_(o);
    if(from==='failed'&&to==='awaiting_payment'){
      var fails=hist.filter(function(h){return h.to==='failed';}).length;
      if(fails>=Number(settings_get('payment_retry_limit',3)))throw pay_bad_('Too many failed attempts. Please start a new order.');
      if(!(Date.parse(o.quote_expires_at)>Date.now()))throw pay_bad_('This quote has expired. Please start a new order.');
    }
    var now=util_nowIso_();
    hist.push({from:from,to:to,at:now,by:pay_actor_(ctx),note:opts.note?String(opts.note).slice(0,200):''});
    if(hist.length>100)hist=hist.slice(-100);
    var row=sheet_updateRow('Payments',o,Object.assign({},changes||{},{status:to,updated_at:now,status_history:hist}));
    if((to==='expired'||to==='rejected')&&o.promo_code)fx_promoRelease_(o.promo_code); // an unpaid order gives its promo use back
    return row;
  });
}
function pay_out_(o){
  return {order_ref:o.order_ref,plan_id:o.plan_id,country:o.country,gateway:o.gateway,currency:o.currency,
    list_fee_usd:o.list_fee_usd,promo_code:o.promo_code,discount_usd:o.discount_usd,amount_usd:o.amount_usd,
    local_amount:o.local_amount,rate:o.rate_used,markup_pct:o.markup_pct,status:o.status,
    quote_expires_at:o.quote_expires_at,deadline_at:o.deadline_at,network:o.network,pay_address:o.pay_address,
    txid:o.txid,challenge_id:o.challenge_id,reject_reason:o.reject_reason,created_at:o.created_at,
    manual:o.gateway==='manual'&&o.pay_address?crypto_page_(o):null};
}
function pay_billing_(p,u){
  var name=pay_text_(p.billing_name||u.full_name||'',2,100,'Enter your full name.');
  var email=util_normalizeEmail_(p.billing_email||u.email||'');
  if(!email)throw pay_bad_('Enter a valid billing email.');
  var phone=util_normalizePhone_(p.billing_phone||u.phone||'');
  if(!phone)throw pay_bad_('Enter a valid phone number.');
  var addr=p.billing_address?pay_text_(p.billing_address,3,200,'Enter a valid address.'):'';
  var city=p.billing_city?pay_text_(p.billing_city,2,80,'Enter a valid city.'):'';
  if(!addr&&!city)throw pay_bad_('Enter your city or address.');
  return {billing_name:name,billing_email:email,billing_phone:phone,billing_address:[addr,city].filter(Boolean).join(', ')};
}
function pay_refCode_(v,u){
  var r=String(v||u.ref_used||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);
  return r;
}

// ---- Browser actions ----
// Creates the order: validates billing FIRST (so a typo never burns a promo use), then saves the server-side
// quote (fx_saveQuote reads only plan_id, country and promo_code), then records billing and the referral code.
function pay_createOrder(p,ctx){
  p=p||{};
  var uid=ctx&&ctx.user&&ctx.user.user_id;
  if(!uid)throw util_error_(CODES.UNAUTHENTICATED,'Please log in.');
  var u=sheet_getByKey('Users',uid);
  if(!u||u.status!=='active')throw util_error_(CODES.FORBIDDEN,'Your account cannot place orders right now.');
  var billing=pay_billing_(p,u),ref=pay_refCode_(p.ref_code,u);
  var q=fx_saveQuote(uid,{plan_id:p.plan_id,country:p.country,promo_code:p.promo_code});
  var changes=Object.assign({ref_code:ref},billing);
  var row=pay_transition_(q.order_ref,'awaiting_payment',{user:ctx.user,role:ctx.role},changes,{note:'order created'});
  if(row.gateway==='manual'){ // Part 12: address, network, exact amount and deadline. If it cannot be prepared, the order is dropped and the promo use is returned.
    try{row=crypto_prepare_(row.order_ref);}
    catch(e){try{pay_transition_(row.order_ref,'expired',{system:'prepare-failed'},{},{note:'manual payment could not be prepared'});}catch(x){}throw e;}
  }
  return pay_out_(row);
}
function pay_getOrder(p,ctx){
  p=p||{};
  var o=pay_get_(p.order_ref);
  if(o.user_id!==ctx.user.user_id)throw pay_bad_('Order not found.'); // same message: no ownership leak
  return pay_out_(pay_lazyExpire_(o));
}

// ---- Expiry ----
// An unpaid order expires when its deadline (manual) or quote (gateway) passes. An order with a gateway
// reference or TXID has money possibly in flight, so it is never auto-expired.
function pay_expiryMs_(o){var d=Date.parse(o.deadline_at||''),q=Date.parse(o.quote_expires_at||'');return isFinite(d)?d:q;}
function pay_isStale_(o){
  return (o.status==='created'||o.status==='awaiting_payment')&&!o.gateway_ref&&!o.txid&&!(pay_expiryMs_(o)>Date.now());
}
function pay_lazyExpire_(o){
  if(!pay_isStale_(o))return o;
  try{return pay_transition_(o.order_ref,'expired',{system:'expiry'},{},{note:'quote or deadline passed'});}
  catch(e){return pay_get_(o.order_ref);}
}
function pay_expireStale(){
  var n=0;
  sheet_readAll('Payments').forEach(function(o){
    if(!pay_isStale_(o))return;
    try{pay_transition_(o.order_ref,'expired',{system:'expiry'},{},{note:'quote or deadline passed'});n++;}catch(e){}
  });
  return n;
}

// ---- Verification (pure rules; Part 13 fetches the gateway's own record and passes it in) ----
// Exact amount, matching currency, matching reference, and a gateway reference not used by any other order.
function pay_verifyPayment_(o,ev){
  ev=ev||{};
  if(o.status==='confirmed'||o.status==='challenge_created'||sheet_findOne('Challenges',{order_ref:o.order_ref}))
    return {ok:false,reason:'This order has already been fulfilled.'};
  var gref=typeof ev.gateway_ref==='string'?ev.gateway_ref.trim():'';
  if(!gref||gref.length>100)return {ok:false,reason:'Missing gateway reference.'};
  if(String(ev.reference||'')!==o.order_ref)return {ok:false,reason:'Payment reference does not match the order.'};
  var q=fx_checkQuote(o,ev.amount,ev.currency);
  if(!q.ok)return q;
  var used=sheet_findOne('Payments',function(r){return r.order_ref!==o.order_ref&&r.gateway_ref===gref;});
  if(used)return {ok:false,reason:'This payment reference has already been used.'};
  return {ok:true,reason:''};
}
// Gateway route: awaiting_payment -> verified. Replaying the same gateway reference is harmless.
function pay_recordVerified(ref,ev,ctx){
  pay_requireSystem_(ctx);
  return util_withLock_(function(){
    var o=pay_get_(ref);
    if(o.gateway==='manual')throw pay_bad_('Manual orders are confirmed by an admin, not verified by a gateway.');
    var gref=ev&&typeof ev.gateway_ref==='string'?ev.gateway_ref.trim():'';
    if(o.gateway_ref&&o.gateway_ref===gref&&['verified','confirmed','challenge_created'].indexOf(o.status)!==-1)return {order:o,already:true};
    var v=pay_verifyPayment_(o,ev);
    if(!v.ok)throw pay_bad_(v.reason);
    return {order:pay_transition_(ref,'verified',ctx,{gateway_ref:gref,verified_at:util_nowIso_()},{note:'gateway verified'}),already:false};
  });
}
// Manual route: awaiting_payment -> awaiting_confirmation. The TXID must never have been used on any order.
// Part 12 adds the network, amount and deadline checks in front of this.
function pay_awaitConfirmation(ref,txid,ctx){
  return util_withLock_(function(){
    var o=pay_get_(ref);
    if(ctx&&ctx.user&&ctx.role==='trader'&&o.user_id!==ctx.user.user_id)throw pay_bad_('Order not found.');
    if(o.gateway!=='manual')throw pay_bad_('This order is paid through a payment gateway.');
    var tx=typeof txid==='string'?txid.trim():'';
    if(tx.length<8||tx.length>120||/[\s\u0000-\u001F]/.test(tx))throw pay_bad_('Enter a valid transaction ID.');
    var used=sheet_findOne('Payments',function(r){return r.order_ref!==ref&&String(r.txid).toLowerCase()===tx.toLowerCase();});
    if(used)throw pay_bad_('This transaction ID has already been used.');
    return pay_transition_(ref,'awaiting_confirmation',ctx,{txid:tx},{note:'txid submitted'});
  });
}

// ---- Confirmation, rejection, fulfilment ----
// verified -> confirmed is done by the system; awaiting_confirmation -> confirmed is done by an admin only.
// Anything else (including a second approval of a confirmed order) is refused by the transition table.
function pay_confirm(ref,ctx){
  return util_withLock_(function(){
    var row=pay_transition_(ref,'confirmed',ctx,{confirmed_at:util_nowIso_(),confirmed_by:pay_actor_(ctx)},{
      note:'confirmed',
      guard:function(o){if(o.status==='awaiting_confirmation')pay_requireAdmin_(ctx);else pay_requireSystem_(ctx);}
    });
    if(ctx&&ctx.user)settings_audit_(ctx,'payment.confirm','Payments',ref,'status','awaiting_confirmation','confirmed');
    aff_onPaymentConfirmed(ref); // Part 15: creates the pending commission. Never throws, so it can never block a payment.
    return row;
  });
}
function pay_reject(ref,reason,ctx){
  var why=pay_text_(reason,3,300,'A rejection needs a reason (3 to 300 characters).');
  return util_withLock_(function(){
    var row=pay_transition_(ref,'rejected',ctx,{reject_reason:why},{note:'rejected',guard:function(){pay_requireAdmin_(ctx);}});
    settings_audit_(ctx,'payment.reject','Payments',ref,'status','awaiting_confirmation','rejected',why);
    return row;
  });
}
function pay_fail(ref,reason,ctx){
  pay_requireSystem_(ctx);
  return pay_transition_(ref,'failed',ctx,{},{note:reason||'payment failed'});
}
// Only a confirmed payment with NO account assigned can be refunded (policy: no refund once credentials are issued).
function pay_refund(ref,reason,ctx){
  var why=pay_text_(reason,3,300,'A refund needs a reason (3 to 300 characters).');
  return util_withLock_(function(){
    var row=pay_transition_(ref,'refunded',ctx,{refunded_at:util_nowIso_()},{note:why,guard:function(o){
      pay_requireAdmin_(ctx);
      if(o.challenge_id||sheet_findOne('Challenges',{order_ref:o.order_ref}))throw pay_bad_('An account has already been issued for this order.');
    }});
    settings_audit_(ctx,'payment.refund','Payments',ref,'status','confirmed','refunded',why);
    aff_onPaymentRefunded(ref,why,ctx); // Part 15: cancels or claws back the commission. Never throws.
    return row;
  });
}
// confirmed -> challenge_created, exactly once (whole thing runs in the script lock, and chal_createChallenge
// is itself keyed on order_ref). If the pool is empty it throws BUSY and the order simply stays confirmed.
function pay_fulfil(ref,ctx){
  return util_withLock_(function(){
    var o=pay_get_(ref);
    if(o.status==='challenge_created')return {order:o,challenge_id:o.challenge_id,created:false};
    if(o.status!=='confirmed')throw pay_bad_('Only a confirmed payment can create a challenge.');
    var res=chal_createChallenge({user_id:o.user_id,plan_id:o.plan_id,order_ref:o.order_ref},{by:pay_actor_(ctx)});
    var upd=pay_transition_(ref,'challenge_created',ctx,{challenge_id:res.challenge.challenge_id},{note:'challenge created'});
    return {order:upd,challenge_id:res.challenge.challenge_id,created:res.created};
  });
}
function pay_tryFulfil_(ref,ctx){
  try{var r=pay_fulfil(ref,ctx);return {order:r.order,challenge_id:r.challenge_id,pending_account:false};}
  catch(e){
    if(e&&e.outOfStock)return {order:pay_get_(ref),challenge_id:null,pending_account:true};
    throw e;
  }
}
// Composites for Parts 12 and 13. The payment stays 'confirmed' (paid, account pending) if the pool is empty.
function pay_completeGateway(ref,ev,ctx){
  pay_recordVerified(ref,ev,ctx);
  var o=pay_get_(ref);
  if(o.status==='verified')pay_confirm(ref,ctx);
  return pay_tryFulfil_(ref,ctx);
}
function pay_approveManual(ref,ctx){
  pay_confirm(ref,ctx);
  return pay_tryFulfil_(ref,{system:'admin-approval',user:ctx.user,role:ctx.role});
}
// Retries every paid-but-unassigned order (after a restock). Safe to run any time and as often as needed.
function pay_retryFulfilments(){
  var done=0,waiting=0;
  sheet_readAll('Payments').filter(function(o){return o.status==='confirmed';}).forEach(function(o){
    var r=pay_tryFulfil_(o.order_ref,{system:'retry'});
    if(r.pending_account)waiting++;else done++;
  });
  return {fulfilled:done,waiting:waiting};
}

// ---- Test: editor only, throwaway spreadsheet ----
function pay_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-PAY-TEST'),bad=[],owner={user:{user_id:'U-OWN'},role:'owner'};
  var gw={system:'gateway'},trader=function(id){return {user:{user_id:id},role:'trader'};};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,code){try{f();}catch(e){if(code&&e.code!==code)throw new Error('wrong code '+e.code+': '+e.message);return;}throw new Error('should have failed');}
  function user(id,extra){sheet_appendRow('Users',Object.assign({user_id:id,email:id.toLowerCase()+'@t.com',password_hash:'x',role:'trader',status:'active',created_at:util_nowIso_()},extra||{}));}
  var bill={billing_name:'Ada Obi',billing_email:'ada@t.com',billing_phone:'+2348012345678',billing_city:'Lagos'};
  function mk(uid,plan,country,extra){return pay_createOrder(Object.assign({plan_id:plan,country:country},bill,extra||{}),trader(uid));}
  function row(ref){return sheet_getByKey('Payments',ref);}
  function stock(logins,size){
    var r=admin_poolImport({rows:logins.map(function(l){return {login:l,password:'Pw'+l+'x',investor_password:'Iv'+l+'y',server:'Demo-Srv',size:size};})},owner);
    util_assertEq_(r.imported,logins.length,'imported');
  }
  function ev(o,over){return Object.assign({amount:o.local_amount,currency:o.currency,reference:o.order_ref,gateway_ref:'GW-'+o.order_ref},over||{});}
  try{
    sheet_buildAll_(ss);settings_clear_();gw_testEnable_(['squad']);
    user('U-A',{ref_used:'AB12'});user('U-B');user('U-BAN',{status:'restricted'});
    crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:'T'+'A'.repeat(33)},owner); // Part 12: manual orders need an address
    stock(['10000001','10000002','10000003'],10000);
    stock(['20000000'],1000); // exactly one $1k account: the manual test uses it, the empty-pool test then finds none
    var ng=null,jp=null;
    t('create order: server quote, client amounts ignored',function(){
      ng=mk('U-A','swift-10000','NG',{amount_usd:1,local_amount:5,status:'confirmed',currency:'USD',gateway:'manual'});
      util_assertEq_(ng.status,'awaiting_payment','status');util_assertEq_(ng.local_amount,132000,'local amount from server');
      util_assertEq_(ng.currency,'NGN','currency');util_assertEq_(ng.amount_usd,100,'usd from plan');util_assertEq_(ng.gateway,'squad','route');
      var r=row(ng.order_ref);
      util_assertEq_(r.ref_code,'AB12','referral captured from user');util_assertEq_(r.billing_name,'Ada Obi','billing');
      util_assertEq_(r.billing_phone,'+2348012345678','phone');util_assertEq_(r.billing_address,'Lagos','city');
      util_assert_(/^RV-\d{6}-/.test(ng.order_ref),'reference format');
      util_assertEq_(pay_history_(r).length,2,'history: created + awaiting_payment');
      util_assertEq_(mk('U-A','swift-10000','NG',{ref_code:'x-9'}).order_ref!==ng.order_ref,true,'unique refs');
      util_assertEq_(row(mk('U-A','swift-10000','NG',{ref_code:'x-9'}).order_ref).ref_code,'X9','explicit referral cleaned');
    });
    t('bad billing is refused and burns no promo',function(){
      admin_promoSave({code:'ONCE',percent_off:10,usage_limit:1},owner);
      var n=sheet_readAll('Payments').length;
      fails(function(){mk('U-A','swift-10000','NG',{promo_code:'ONCE',billing_email:'nope'});});
      fails(function(){mk('U-A','swift-10000','NG',{promo_code:'ONCE',billing_phone:'12'});});
      fails(function(){mk('U-A','swift-10000','NG',{promo_code:'ONCE',billing_name:' '});});
      fails(function(){mk('U-A','swift-10000','NG',{promo_code:'ONCE',billing_city:'',billing_address:''});});
      util_assertEq_(sheet_readAll('Payments').length,n,'no order written');
      util_assertEq_(sheet_getByKey('PromoCodes','ONCE').used_count,0,'promo untouched');
      fails(function(){mk('U-A','nope','NG');});
      fails(function(){mk('U-A','swift-10000','ZZ');});
      fails(function(){pay_createOrder(Object.assign({plan_id:'swift-10000',country:'NG'},bill),trader('U-BAN'));},CODES.FORBIDDEN);
      fails(function(){pay_createOrder(Object.assign({plan_id:'swift-10000',country:'NG'},bill),{});},CODES.UNAUTHENTICATED);
    });
    t('promo used once, given back when the order expires',function(){
      var o=mk('U-A','swift-10000','NG',{promo_code:'ONCE'});
      util_assertEq_(o.amount_usd,90,'discounted');util_assertEq_(sheet_getByKey('PromoCodes','ONCE').used_count,1,'taken');
      fails(function(){mk('U-B','swift-10000','NG',{promo_code:'ONCE'});});
      sheet_updateRow('Payments',o.order_ref,{quote_expires_at:'2000-01-01T00:00:00.000Z'});
      util_assertEq_(pay_getOrder({order_ref:o.order_ref},trader('U-A')).status,'expired','lazily expired on read');
      util_assertEq_(sheet_getByKey('PromoCodes','ONCE').used_count,0,'promo released');
      fails(function(){pay_recordVerified(o.order_ref,ev(row(o.order_ref)),gw);});
    });
    t('order privacy',function(){
      fails(function(){pay_getOrder({order_ref:ng.order_ref},trader('U-B'));});
      fails(function(){pay_getOrder({order_ref:'RV-NOPE'},trader('U-A'));});
      var s=JSON.stringify(pay_getOrder({order_ref:ng.order_ref},trader('U-A')));
      util_assert_(s.indexOf('gateway_ref')<0&&s.indexOf('confirmed_by')<0&&s.indexOf('billing_')<0,'no internals');
    });
    t('gateway: strict verification',function(){
      var o=row(ng.order_ref);
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{amount:o.local_amount-1}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{amount:o.local_amount+1}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{amount:'1'}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{currency:'USD'}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{reference:'RV-OTHER'}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o,{gateway_ref:''}),gw);});
      fails(function(){pay_recordVerified(o.order_ref,ev(o),trader('U-A'));},CODES.FORBIDDEN);
      fails(function(){pay_recordVerified(o.order_ref,ev(o),{user:{user_id:'U-OWN'},role:'owner'});},CODES.FORBIDDEN);
      util_assertEq_(row(o.order_ref).status,'awaiting_payment','still unpaid after every refusal');
    });
    var g1=null;
    t('gateway: pay once, one challenge, replay-proof',function(){
      g1=mk('U-A','swift-10000','NG');
      var o=row(g1.order_ref);
      var r=pay_completeGateway(g1.order_ref,ev(o),gw);
      util_assertEq_(r.pending_account,false,'account assigned');util_assert_(!!r.challenge_id,'challenge id');
      util_assertEq_(row(g1.order_ref).status,'challenge_created','final state');
      util_assertEq_(row(g1.order_ref).confirmed_by,'system:gateway','confirmed by the system');
      util_assertEq_(sheet_findRows('Challenges',{order_ref:g1.order_ref}).length,1,'one challenge');
      var again=pay_completeGateway(g1.order_ref,ev(o),gw);
      util_assertEq_(again.challenge_id,r.challenge_id,'same challenge on replay');
      util_assertEq_(sheet_findRows('Challenges',{order_ref:g1.order_ref}).length,1,'still one challenge');
      util_assertEq_(pay_fulfil(g1.order_ref,gw).created,false,'fulfil replay creates nothing');
      util_assertEq_(sheet_readAll('AccountPool').filter(function(x){return x.status==='Assigned';}).length,1,'one pool account used');
      fails(function(){pay_recordVerified(g1.order_ref,ev(o,{gateway_ref:'GW-NEW'}),gw);},CODES.BAD_REQUEST); // different ref on a paid order
      var h=pay_history_(row(g1.order_ref)).map(function(x){return x.to||x.status;}).join('>');
      util_assertEq_(h,'created>awaiting_payment>verified>confirmed>challenge_created','history order');
    });
    t('gateway reference cannot be reused on another order',function(){
      var o2=mk('U-A','swift-10000','NG');
      fails(function(){pay_recordVerified(o2.order_ref,ev(row(o2.order_ref),{gateway_ref:'GW-'+g1.order_ref}),gw);});
      util_assertEq_(row(o2.order_ref).status,'awaiting_payment','unpaid');
    });
    t('manual: admin only, exactly once',function(){
      jp=mk('U-B','swift-1000','JP');
      util_assertEq_(jp.gateway,'manual','manual route');util_assertEq_(jp.currency,'USD','usd');
      fails(function(){pay_confirm(jp.order_ref,owner);}); // awaiting_payment can not be confirmed
      fails(function(){pay_awaitConfirmation(jp.order_ref,'short',trader('U-B'));});
      fails(function(){pay_awaitConfirmation(jp.order_ref,'abc def ghi jkl',trader('U-B'));});
      fails(function(){pay_awaitConfirmation(jp.order_ref,'a'.repeat(40),trader('U-A'));}); // not their order
      fails(function(){pay_awaitConfirmation(ng.order_ref,'a'.repeat(40),trader('U-A'));}); // gateway order
      pay_awaitConfirmation(jp.order_ref,'0x'+'ab'.repeat(20),trader('U-B'));
      util_assertEq_(row(jp.order_ref).status,'awaiting_confirmation','waiting for admin');
      fails(function(){pay_confirm(jp.order_ref,trader('U-B'));},CODES.FORBIDDEN);
      fails(function(){pay_confirm(jp.order_ref,gw);},CODES.FORBIDDEN);
      fails(function(){pay_reject(jp.order_ref,'',owner);});
      fails(function(){pay_reject(jp.order_ref,'no funds',trader('U-B'));},CODES.FORBIDDEN);
      var r=pay_approveManual(jp.order_ref,owner);
      util_assertEq_(r.pending_account,false,'account assigned');util_assertEq_(row(jp.order_ref).status,'challenge_created','final');
      util_assertEq_(row(jp.order_ref).confirmed_by,'owner:U-OWN','confirmed by owner');
      fails(function(){pay_confirm(jp.order_ref,owner);});          // double approve
      fails(function(){pay_approveManual(jp.order_ref,owner);});    // double approve, composite
      fails(function(){pay_reject(jp.order_ref,'changed my mind',owner);}); // reject after confirm
      util_assertEq_(sheet_findRows('Challenges',{order_ref:jp.order_ref}).length,1,'one challenge');
      util_assert_(sheet_findRows('AuditLog',{action:'payment.confirm'}).length===1,'approval audited');
    });
    t('manual: txid reuse refused, reject frees the promo',function(){
      var a=mk('U-B','swift-1000','JP'),b=mk('U-B','swift-1000','JP',{promo_code:'ONCE'});
      pay_awaitConfirmation(a.order_ref,'0x'+'cd'.repeat(20),trader('U-B'));
      fails(function(){pay_awaitConfirmation(b.order_ref,'0x'+'CD'.repeat(20),trader('U-B'));});
      pay_awaitConfirmation(b.order_ref,'0x'+'ef'.repeat(20),trader('U-B'));
      util_assertEq_(sheet_getByKey('PromoCodes','ONCE').used_count,1,'promo held');
      pay_reject(b.order_ref,'TXID not found on chain',owner);
      util_assertEq_(row(b.order_ref).status,'rejected','rejected');util_assertEq_(row(b.order_ref).reject_reason,'TXID not found on chain','reason');
      util_assertEq_(sheet_getByKey('PromoCodes','ONCE').used_count,0,'promo released');
      fails(function(){pay_confirm(b.order_ref,owner);}); // rejected can never be approved
    });
    t('empty pool: paid stays confirmed, restock fulfils',function(){
      var a=mk('U-B','swift-1000','JP');
      pay_awaitConfirmation(a.order_ref,'0x'+'12'.repeat(20),trader('U-B'));
      var r=pay_approveManual(a.order_ref,owner);
      util_assertEq_(r.pending_account,true,'pending');util_assertEq_(row(a.order_ref).status,'confirmed','paid, waiting for an account');
      util_assertEq_(sheet_findRows('Challenges',{order_ref:a.order_ref}).length,0,'no challenge yet');
      fails(function(){pay_reject(a.order_ref,'too late to reject',owner);});
      util_assertEq_(pay_retryFulfilments().waiting,1,'still waiting');
      stock(['20000001'],1000);
      var res=pay_retryFulfilments();
      util_assertEq_(res.fulfilled,1,'fulfilled after restock');util_assertEq_(row(a.order_ref).status,'challenge_created','done');
      util_assertEq_(pay_retryFulfilments().fulfilled,0,'nothing left to retry');
    });
    t('refund only before an account is issued',function(){
      var a=mk('U-B','swift-1000','JP');
      pay_awaitConfirmation(a.order_ref,'0x'+'34'.repeat(20),trader('U-B'));
      pay_confirm(a.order_ref,owner); // confirmed, not fulfilled
      fails(function(){pay_refund(a.order_ref,'x',owner);});
      fails(function(){pay_refund(a.order_ref,'duplicate payment',trader('U-B'));},CODES.FORBIDDEN);
      pay_refund(a.order_ref,'duplicate payment',owner);
      util_assertEq_(row(a.order_ref).status,'refunded','refunded');
      fails(function(){pay_fulfil(a.order_ref,gw);});
      fails(function(){pay_refund(jp.order_ref,'too late',owner);}); // account already issued
    });
    t('failed orders: limited retries',function(){
      var a=mk('U-A','swift-10000','NG'); // payment_retry_limit = 3 failed attempts in total
      pay_fail(a.order_ref,'declined 1',gw);pay_transition_(a.order_ref,'awaiting_payment',gw,{},{}); // retry 1 ok
      pay_fail(a.order_ref,'declined 2',gw);pay_transition_(a.order_ref,'awaiting_payment',gw,{},{}); // retry 2 ok
      pay_fail(a.order_ref,'declined 3',gw);
      fails(function(){pay_transition_(a.order_ref,'awaiting_payment',gw,{},{});}); // third failure ends it
      fails(function(){pay_fail(mk('U-A','swift-10000','NG').order_ref,'x',trader('U-A'));},CODES.FORBIDDEN);
    });
    t('bulk expiry',function(){
      var a=mk('U-A','swift-10000','NG'),b=mk('U-A','swift-10000','NG');
      sheet_updateRow('Payments',a.order_ref,{quote_expires_at:'2000-01-01T00:00:00.000Z'});
      sheet_updateRow('Payments',b.order_ref,{quote_expires_at:'2000-01-01T00:00:00.000Z',gateway_ref:'GW-INFLIGHT'});
      util_assert_(pay_expireStale()>=1,'expired');
      util_assertEq_(row(a.order_ref).status,'expired','stale expired');
      util_assertEq_(row(b.order_ref).status,'awaiting_payment','in-flight payment is never auto-expired');
    });
    t('nothing browser-callable can mark an order paid',function(){
      var allowed={pay_createOrder:1,pay_getOrder:1};
      Object.keys(ACTIONS).forEach(function(k){
        var f=ACTIONS[k].fn;
        if(f.indexOf('pay_')===0)util_assert_(allowed[f],'action '+k+' exposes '+f);
      });
      util_assertEq_(ACTIONS['pay.createOrder'].level,'trader','createOrder needs a session');
      var r=router_handle_({postData:{contents:JSON.stringify({action:'pay.createOrder',payload:Object.assign({plan_id:'swift-10000',country:'NG'},bill)})}});
      util_assertEq_(r.code,CODES.UNAUTHENTICATED,'no token, no order');
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 11 TESTS PASSED');
}

// ===== PART 12: MANUAL USDT ROUTE AND CRYPTO ORDERS =====
// The manual route pays into an admin-managed receiving address (ReceivingAddresses sheet). The order page shows
// the address, the network, the EXACT amount (fee + unique cents, so one shared address can still tell orders
// apart) and a deadline (Settings: manual_order_deadline_minutes). The trader submits the TXID, the order waits
// in the Crypto Orders queue, and an admin approves after checking the chain. Approval reuses Part 11
// (pay_approveManual), so the transition guard, exactly-once challenge creation and audit trail all still apply.
// Browser-callable here: crypto_submitTxid only. Everything crypto_admin* is called by the Part 16 admin actions
// (admin.crypto.list / approve / reject and admin.addresses.save) and checks the admin role itself.
// Launch: USDT on TRC-20 only. To add a coin or network, extend the three tables below.
var CRYPTO_COINS_=['USDT'];
var CRYPTO_NETWORKS_=['TRC-20'];
var CRYPTO_TXID_RE_={'TRC-20':/^[0-9a-fA-F]{64}$/};
var CRYPTO_ADDR_RE_={'TRC-20':/^T[1-9A-HJ-NP-Za-km-z]{33}$/};
var CRYPTO_EXPLORER_={'TRC-20':'https://tronscan.org/#/transaction/'};

// ---- Receiving addresses ----
function crypto_addressList_(){
  return sheet_readAll('ReceivingAddresses').sort(function(a,b){return String(a.created_at)<String(b.created_at)?-1:1;});
}
// The address new orders are sent to: the oldest ACTIVE USDT/TRC-20 row.
function crypto_activeAddress_(){
  var list=crypto_addressList_().filter(function(a){return a.active&&a.coin==='USDT'&&a.network==='TRC-20';});
  return list.length?list[0]:null;
}
function crypto_addrOut_(a){
  return {address_id:a.address_id,coin:a.coin,network:a.network,address:a.address,note:a.note,active:a.active,created_at:a.created_at,updated_at:a.updated_at};
}
// Admin action: list, add, or edit. Adding or changing an address, coin or network is OWNER only (a swapped
// address would redirect every customer's money); an admin may only switch a row on or off and edit its note.
// Rows are never deleted, only switched off, so old orders still point at a real row.
function crypto_saveAddresses(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  if(!p.address_id&&p.address===undefined)return {addresses:crypto_addressList_().map(crypto_addrOut_)};
  return util_withLock_(function(){
    var cur=p.address_id?sheet_getByKey('ReceivingAddresses',String(p.address_id)):null;
    if(p.address_id&&!cur)throw pay_bad_('Address not found.');
    var now=util_nowIso_(),ch={};
    if(p.note!==undefined){
      var nt=String(p.note===null?'':p.note).trim();
      if(nt.length>200||/[\u0000-\u001F]/.test(nt))throw pay_bad_('The note must be 200 characters or fewer.');
      ch.note=nt;
    }
    if(p.active!==undefined){
      if(typeof p.active!=='boolean')throw pay_bad_('active must be true or false.');
      ch.active=p.active;
    }
    var touchesAddress=!cur||['coin','network','address'].some(function(k){return p[k]!==undefined&&String(p[k]).trim()!==String(cur[k]);});
    if(touchesAddress){
      if(ctx.role!=='owner')throw util_error_(CODES.FORBIDDEN,'Only the owner can add or change a receiving address.');
      var coin=String(p.coin===undefined&&cur?cur.coin:p.coin||'').trim().toUpperCase();
      var net=String(p.network===undefined&&cur?cur.network:p.network||'').trim().toUpperCase();
      var addr=String(p.address===undefined&&cur?cur.address:p.address||'').trim();
      if(CRYPTO_COINS_.indexOf(coin)===-1)throw pay_bad_('Coin must be one of: '+CRYPTO_COINS_.join(', ')+'.');
      if(CRYPTO_NETWORKS_.indexOf(net)===-1)throw pay_bad_('Network must be one of: '+CRYPTO_NETWORKS_.join(', ')+'.');
      if(!CRYPTO_ADDR_RE_[net].test(addr))throw pay_bad_('That is not a valid '+net+' address. Copy it again from your wallet.');
      var dup=sheet_findOne('ReceivingAddresses',function(r){return r.address===addr&&r.network===net&&(!cur||r.address_id!==cur.address_id);});
      if(dup)throw pay_bad_('This address is already in the list.');
      ch.coin=coin;ch.network=net;ch.address=addr;
    }
    if(!Object.keys(ch).length)throw pay_bad_('Nothing to change.');
    ch.updated_at=now;
    var row;
    if(cur){
      row=sheet_updateRow('ReceivingAddresses',cur,ch);
      Object.keys(ch).forEach(function(k){
        if(k!=='updated_at'&&String(cur[k]==null?'':cur[k])!==String(ch[k]))settings_audit_(ctx,'address.update','ReceivingAddresses',cur.address_id,k,cur[k],ch[k]);
      });
    }else{
      row=sheet_appendRow('ReceivingAddresses',Object.assign({address_id:sheet_newKey_('ReceivingAddresses'),active:ch.active===undefined?true:ch.active,note:'',created_at:now},ch));
      settings_audit_(ctx,'address.add','ReceivingAddresses',row.address_id,'address','',row.address);
    }
    return {address:crypto_addrOut_(row),addresses:crypto_addressList_().map(crypto_addrOut_)};
  });
}

// ---- Preparing an order for payment ----
// A different amount for every OPEN order at the same address: fee + 1 to 99 cents. Stale (past-deadline,
// no TXID) orders do not hold a number.
function crypto_pickAmount_(o,addr){
  var base=util_toCents_(o.amount_usd),taken={};
  sheet_readAll('Payments').forEach(function(r){
    if(r.order_ref===o.order_ref||r.gateway!=='manual'||r.pay_address!==addr.address)return;
    if(r.status!=='awaiting_payment'&&r.status!=='awaiting_confirmation')return;
    if(pay_isStale_(r))return;
    taken[util_toCents_(r.local_amount)]=true;
  });
  var start=Math.floor(Math.random()*99),i,c;
  for(i=0;i<99;i++){c=((start+i)%99)+1;if(!taken[base+c])return util_roundMoney_((base+c)/100);}
  throw util_error_(CODES.BUSY,'Too many open orders at this price. Please try again in a few minutes.');
}
// Called by pay_createOrder for manual-route orders. Sets the address, network, exact amount and deadline once.
// The manual route is always USDT, so the order is fixed to USD at rate 1 (amount_usd, the fee, is untouched;
// local_amount becomes the exact amount to send).
function crypto_prepare_(ref){
  return util_withLock_(function(){
    var o=pay_get_(ref);
    if(o.gateway!=='manual')throw pay_bad_('This order is not on the manual route.');
    if(o.pay_address)return o;
    var addr=crypto_activeAddress_();
    if(!addr)throw util_error_(CODES.BUSY,'Crypto payments are not available right now. Please try again later.');
    var min=Number(settings_get('min_crypto_usd',10));
    if(!(o.amount_usd>=min))throw pay_bad_('The minimum for a crypto payment is $'+min+'.');
    var mins=Number(settings_get('manual_order_deadline_minutes',60));
    if(!(mins>0))mins=60;
    return sheet_updateRow('Payments',o,{currency:'USD',rate_used:1,markup_pct:0,network:addr.network,pay_address:addr.address,
      local_amount:crypto_pickAmount_(o,addr),deadline_at:new Date(Date.now()+mins*6e4).toISOString(),updated_at:util_nowIso_()});
  });
}
// Order-page data for a manual order (part of pay_out_). Warning texts come from here, not the frontend.
function crypto_page_(o){
  var a=o.pay_address?sheet_findOne('ReceivingAddresses',{address:o.pay_address}):null,coin=a?a.coin:'USDT',amt=Number(o.local_amount).toFixed(2);
  return {coin:coin,network:o.network,address:o.pay_address,amount:o.local_amount,currency:'USD',deadline_at:o.deadline_at,warnings:[
    'Send exactly '+amt+' '+coin+' on the '+o.network+' network. Sending on any other network can lose your money for good.',
    'The cents in the amount identify your order. Do not round it.',
    'You pay the network fee. Make sure the full amount arrives.',
    'After you pay, submit your transaction ID before the deadline.'
  ]};
}

// ---- Trader: submit the transaction ID ----
function crypto_txid_(v,network){
  var s=typeof v==='string'?v.trim():'',re=CRYPTO_TXID_RE_[network];
  if(re?!re.test(s):(s.length<8||s.length>120))throw pay_bad_('Enter a valid transaction ID'+(network?' for the '+network+' network':'')+'.');
  return s;
}
function crypto_submitTxid(p,ctx){
  p=p||{};
  var uid=ctx&&ctx.user&&ctx.user.user_id;
  if(!uid)throw util_error_(CODES.UNAUTHENTICATED,'Please log in.');
  var o=pay_get_(p.order_ref);
  if(o.user_id!==uid)throw pay_bad_('Order not found.');
  o=pay_lazyExpire_(o);
  if(o.gateway!=='manual')throw pay_bad_('This order is paid through a payment gateway.');
  if(o.status==='expired')throw pay_bad_('This order has expired. If you already paid, contact support with your order reference and transaction ID.');
  if(o.status!=='awaiting_payment')throw pay_bad_('This order is not waiting for a payment.');
  var row=pay_awaitConfirmation(o.order_ref,crypto_txid_(p.txid,o.network),ctx);
  crypto_alertAdmin_(row);
  return pay_out_(row);
}
// Email alert to the owner. Part 18 replaces this with the notification system. Never throws.
function crypto_alertAdmin_(o){
  try{
    var to=PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
    if(!to)return;
    auth_mail_(to,'Crypto order awaiting confirmation: '+o.order_ref,
      'A trader submitted a payment for review.\n\nOrder: '+o.order_ref+'\nPlan: '+o.plan_id+'\nExpected: '+Number(o.local_amount).toFixed(2)+' USDT ('+o.network+')\nTXID: '+o.txid+'\nDeadline: '+o.deadline_at+'\n\nOpen the Crypto Orders queue in the admin panel to check and approve or reject.');
  }catch(e){console.error('crypto_alertAdmin_: '+e);}
}

// ---- Admin: the Crypto Orders queue ----
function crypto_submittedAt_(o){
  var h=pay_history_(o).filter(function(x){return x.to==='awaiting_confirmation';});
  return h.length?h[h.length-1].at:'';
}
function crypto_adminList(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var st=p.status===undefined?'awaiting_confirmation':String(p.status),all=sheet_readAll('Payments');
  if(st!=='all'&&Object.keys(PAY_TRANSITIONS_).indexOf(st)===-1)throw pay_bad_('Unknown status.');
  var lim=Math.min(Math.max(Number(p.limit)||100,1),200);
  var rows=all.filter(function(o){return o.gateway==='manual'&&(st==='all'||o.status===st);})
    .sort(function(a,b){return String(a.created_at)<String(b.created_at)?-1:1;}).slice(0,lim);
  return {orders:rows.map(function(o){
    var sub=crypto_submittedAt_(o),dl=Date.parse(o.deadline_at||'');
    return {order_ref:o.order_ref,user_id:o.user_id,plan_id:o.plan_id,billing_name:o.billing_name,billing_email:o.billing_email,
      status:o.status,fee_usd:o.amount_usd,expected_amount:o.local_amount,network:o.network,pay_address:o.pay_address,txid:o.txid,
      explorer_url:o.txid&&CRYPTO_EXPLORER_[o.network]?CRYPTO_EXPLORER_[o.network]+o.txid:'',
      created_at:o.created_at,deadline_at:o.deadline_at,submitted_at:sub,late_submission:!!(sub&&isFinite(dl)&&Date.parse(sub)>dl),
      txid_reused:!!(o.txid&&all.some(function(r){return r.order_ref!==o.order_ref&&String(r.txid).toLowerCase()===String(o.txid).toLowerCase();})),
      reject_reason:o.reject_reason,challenge_id:o.challenge_id};
  })};
}
// Approve only after the admin has checked the chain. The checks from the spec are enforced here, not just
// shown: TXID unused (re-checked), network confirmed, transaction confirmed, amount at least the fee, and the
// payment arrived before the deadline (a late payment needs accept_late plus a note).
function crypto_adminApprove(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var o=pay_get_(p.order_ref);
  if(o.gateway!=='manual')throw pay_bad_('This is not a manual crypto order.');
  if(o.status!=='awaiting_confirmation')throw pay_bad_('Only an order that is awaiting confirmation can be approved.');
  if(sheet_findOne('Payments',function(r){return r.order_ref!==o.order_ref&&String(r.txid).toLowerCase()===String(o.txid).toLowerCase();}))
    throw pay_bad_('This transaction ID is on another order. Reject this order.');
  if(p.network_ok!==true||p.chain_confirmed!==true)
    throw pay_bad_('Confirm on the explorer that the network is '+o.network+' and that the transaction is confirmed.');
  var got=(p.received_usd===undefined||p.received_usd===null||p.received_usd===''||typeof p.received_usd==='boolean')?NaN:Number(p.received_usd);
  if(!isFinite(got)||got<=0)throw pay_bad_('Enter the amount received.');
  if(util_toCents_(got)<util_toCents_(o.amount_usd))
    throw pay_bad_('Underpaid: received $'+got.toFixed(2)+' but the fee is $'+Number(o.amount_usd).toFixed(2)+'. Ask for a top-up or reject with a reason.');
  var paidAt=Date.parse(p.paid_at||'');
  if(!isFinite(paidAt))throw pay_bad_('Enter the time the payment arrived (from the explorer).');
  if(paidAt>Date.now()+3e5)throw pay_bad_('The payment time cannot be in the future.');
  if(paidAt<Date.parse(o.created_at)-6e4)throw pay_bad_('This payment is older than the order. It cannot belong to it.');
  var late=paidAt>Date.parse(o.deadline_at),note=typeof p.note==='string'?p.note.trim().slice(0,200):'';
  if(late&&!(p.accept_late===true&&note.length>=3))
    throw pay_bad_('The payment arrived after the deadline. To accept it, tick accept late and add a note.');
  var res=pay_approveManual(o.order_ref,ctx);
  settings_audit_(ctx,'crypto.approve','Payments',o.order_ref,'received_usd','',got.toFixed(2),
    (late?'LATE; ':'')+'paid_at '+new Date(paidAt).toISOString()+(note?'; '+note:''));
  return {order:pay_out_(res.order),challenge_id:res.challenge_id,pending_account:res.pending_account};
}
function crypto_adminReject(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var o=pay_get_(p.order_ref);
  if(o.gateway!=='manual')throw pay_bad_('This is not a manual crypto order.');
  return pay_out_(pay_reject(o.order_ref,p.reason,ctx));
}

// ---- Test: editor only, throwaway spreadsheet. Run crypto_runTests from the Apps Script editor. ----
function crypto_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-CRYPTO-TEST'),bad=[];
  var owner={user:{user_id:'U-OWN'},role:'owner'},admin={user:{user_id:'U-ADM'},role:'admin'};
  var trader=function(id){return {user:{user_id:id},role:'trader'};};
  var ADDR='T'+'A'.repeat(33),ADDR2='T'+'B'.repeat(33);
  var tx=function(c){return String(c).repeat(64);};
  var bill={billing_name:'Ken Sato',billing_email:'ken@t.com',billing_phone:'+819012345678',billing_city:'Tokyo'};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,code){try{f();}catch(e){if(code&&e.code!==code)throw new Error('wrong code '+e.code+': '+e.message);return;}throw new Error('should have failed');}
  function user(id){sheet_appendRow('Users',{user_id:id,email:id.toLowerCase()+'@t.com',password_hash:'x',role:'trader',status:'active',created_at:util_nowIso_()});}
  function mk(uid,extra){return pay_createOrder(Object.assign({plan_id:'swift-10000',country:'JP'},bill,extra||{}),trader(uid));}
  function row(ref){return sheet_getByKey('Payments',ref);}
  function ago(ref,createdMin,deadlineMin){
    sheet_updateRow('Payments',ref,{created_at:new Date(Date.now()-createdMin*6e4).toISOString(),deadline_at:new Date(Date.now()-deadlineMin*6e4).toISOString()});
  }
  function okApprove(o,over){
    return Object.assign({order_ref:o.order_ref,received_usd:o.local_amount,paid_at:new Date(Date.now()-60000).toISOString(),network_ok:true,chain_confirmed:true},over||{});
  }
  try{
    sheet_buildAll_(ss);settings_clear_();gw_testEnable_(['squad']);
    user('U-A');user('U-B');
    var r0=admin_poolImport({rows:['30000001','30000002','30000003'].map(function(l){return {login:l,password:'Pw'+l+'x',investor_password:'Iv'+l+'y',server:'Demo-Srv',size:10000};})},owner);
    util_assertEq_(r0.imported,3,'pool stocked');

    t('no active address: order refused cleanly, promo returned',function(){
      admin_promoSave({code:'HALF',percent_off:10,usage_limit:1},owner);
      fails(function(){mk('U-A',{promo_code:'HALF'});},CODES.BUSY);
      util_assertEq_(sheet_getByKey('PromoCodes','HALF').used_count,0,'promo returned');
      util_assertEq_(sheet_readAll('Payments').filter(function(o){return o.status==='awaiting_payment';}).length,0,'no open order left behind');
    });
    t('addresses: validated, owner only for new or changed addresses',function(){
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:ADDR},admin);},CODES.FORBIDDEN);
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:ADDR},trader('U-A'));},CODES.FORBIDDEN);
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:'T123'},owner);});
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:'X'+'A'.repeat(33)},owner);});
      fails(function(){crypto_saveAddresses({coin:'DOGE',network:'TRC-20',address:ADDR},owner);});
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'ERC-20',address:ADDR},owner);});
      var r=crypto_saveAddresses({coin:'usdt',network:'trc-20',address:ADDR,note:'Main wallet'},owner);
      util_assertEq_(r.address.active,true,'active by default');util_assertEq_(r.address.coin,'USDT','coin normalised');
      fails(function(){crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:ADDR},owner);}); // duplicate
      var id=r.address.address_id;
      fails(function(){crypto_saveAddresses({address_id:id,address:ADDR2},admin);},CODES.FORBIDDEN); // admin cannot swap the address
      util_assertEq_(crypto_saveAddresses({address_id:id,note:'Hot wallet'},admin).address.note,'Hot wallet','admin may edit the note');
      util_assertEq_(crypto_saveAddresses({},admin).addresses.length,1,'list');
      util_assert_(sheet_findRows('AuditLog',{action:'address.add'}).length===1,'add audited');
    });
    var a=null,b=null;
    t('manual order: address, exact amount with unique cents, deadline',function(){
      a=mk('U-A');b=mk('U-B');
      util_assertEq_(a.gateway,'manual','manual route');util_assertEq_(a.network,'TRC-20','network');util_assertEq_(a.pay_address,ADDR,'address');
      util_assertEq_(a.currency,'USD','usd');util_assertEq_(a.amount_usd,100,'fee unchanged');
      var c=util_toCents_(a.local_amount)-10000;
      util_assert_(c>=1&&c<=99,'unique cents added to the fee: '+a.local_amount);
      util_assert_(a.local_amount!==b.local_amount,'two open orders never share an amount');
      var mins=(Date.parse(a.deadline_at)-Date.now())/6e4;
      util_assert_(mins>58&&mins<=60.5,'60 minute deadline: '+mins);
      util_assertEq_(a.manual.coin,'USDT','coin');util_assertEq_(a.manual.amount,a.local_amount,'page amount');util_assert_(a.manual.warnings.length>=3,'warnings');
      util_assertEq_(pay_getOrder({order_ref:a.order_ref},trader('U-A')).manual.address,ADDR,'order page data');
      // the amounts of many open orders are all different
      var seen={};seen[a.local_amount]=1;seen[b.local_amount]=1;
      for(var i=0;i<20;i++){var x=mk('U-A');util_assert_(!seen[x.local_amount],'duplicate amount '+x.local_amount);seen[x.local_amount]=1;}
    });
    t('submit TXID: owner only, format checked, once, never reused',function(){
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:tx('a')},{});},CODES.UNAUTHENTICATED);
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:tx('a')},trader('U-B'));}); // not their order
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:'0x'+'ab'.repeat(20)},trader('U-A'));}); // not a TRC-20 hash
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:tx('g')},trader('U-A'));});
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:''},trader('U-A'));});
      var r=crypto_submitTxid({order_ref:a.order_ref,txid:tx('a')},trader('U-A'));
      util_assertEq_(r.status,'awaiting_confirmation','waiting for admin');util_assertEq_(row(a.order_ref).txid,tx('a'),'saved');
      fails(function(){crypto_submitTxid({order_ref:a.order_ref,txid:tx('c')},trader('U-A'));}); // already submitted
      fails(function(){crypto_submitTxid({order_ref:b.order_ref,txid:tx('A')},trader('U-B'));}); // same hash, other case
      util_assertEq_(row(b.order_ref).status,'awaiting_payment','b untouched');
      var ng=pay_createOrder(Object.assign({plan_id:'swift-10000',country:'NG'},bill),trader('U-A'));
      fails(function(){crypto_submitTxid({order_ref:ng.order_ref,txid:tx('d')},trader('U-A'));}); // gateway order
    });
    t('past the deadline with no TXID: expired, cannot submit',function(){
      var e=mk('U-B');ago(e.order_ref,90,30);
      fails(function(){crypto_submitTxid({order_ref:e.order_ref,txid:tx('e')},trader('U-B'));});
      util_assertEq_(row(e.order_ref).status,'expired','expired');
    });
    t('queue: shows what the admin needs, hides passwords, admin only',function(){
      fails(function(){crypto_adminList({},trader('U-A'));},CODES.FORBIDDEN);
      var q=crypto_adminList({},admin).orders;
      util_assertEq_(q.length,1,'one waiting');util_assertEq_(q[0].order_ref,a.order_ref,'the submitted one');
      util_assertEq_(q[0].txid,tx('a'),'txid');util_assertEq_(q[0].late_submission,false,'on time');util_assertEq_(q[0].txid_reused,false,'unique');
      util_assert_(q[0].explorer_url.indexOf(tx('a'))>0,'explorer link');
      var s=JSON.stringify(crypto_adminList({status:'all'},admin));
      util_assert_(s.toLowerCase().indexOf('password')<0,'no passwords in the queue');
      util_assert_(crypto_adminList({status:'all'},admin).orders.length>1,'all statuses listed');
      fails(function(){crypto_adminList({status:'nope'},admin);});
    });
    t('approve: every check is enforced',function(){
      var o=row(a.order_ref);
      fails(function(){crypto_adminApprove(okApprove(o),trader('U-A'));},CODES.FORBIDDEN);
      fails(function(){crypto_adminApprove(okApprove(o,{network_ok:false}),admin);});
      fails(function(){crypto_adminApprove(okApprove(o,{chain_confirmed:undefined}),admin);});
      fails(function(){crypto_adminApprove(okApprove(o,{received_usd:99.99}),admin);});           // underpaid by a cent
      fails(function(){crypto_adminApprove(okApprove(o,{received_usd:''}),admin);});
      fails(function(){crypto_adminApprove(okApprove(o,{paid_at:'not a date'}),admin);});
      fails(function(){crypto_adminApprove(okApprove(o,{paid_at:new Date(Date.now()+36e5).toISOString()}),admin);}); // future
      fails(function(){crypto_adminApprove(okApprove(o,{paid_at:new Date(Date.now()-864e5).toISOString()}),admin);}); // older than the order
      fails(function(){crypto_adminApprove(okApprove(b),admin);}); // b never submitted a TXID
      util_assertEq_(row(a.order_ref).status,'awaiting_confirmation','still waiting after every refusal');
      // late payment: refused without accept_late and a note, accepted with both
      ago(a.order_ref,40,10);
      var late=okApprove(o,{paid_at:new Date(Date.now()-5*6e4).toISOString()});
      fails(function(){crypto_adminApprove(late,admin);});
      fails(function(){crypto_adminApprove(Object.assign({},late,{accept_late:true}),admin);}); // needs a note
      util_assertEq_(crypto_adminList({},admin).orders[0].late_submission,true,'queue flags a TXID submitted after the deadline');
      var r=crypto_adminApprove(Object.assign({},late,{accept_late:true,note:'Wallet delay, TXID checked'}),admin);
      util_assertEq_(r.order.status,'challenge_created','challenge created');util_assert_(!!r.challenge_id,'challenge id');util_assertEq_(r.pending_account,false,'account assigned');
      util_assertEq_(row(a.order_ref).confirmed_by,'admin:U-ADM','confirmed by the admin');
      util_assert_(sheet_findRows('AuditLog',{action:'crypto.approve'}).length===1,'approval audited with the late note');
      util_assertEq_(sheet_findRows('Challenges',{order_ref:a.order_ref}).length,1,'one challenge');
    });
    t('approve twice, or reject after approve: refused',function(){
      fails(function(){crypto_adminApprove(okApprove(row(a.order_ref)),admin);});
      fails(function(){crypto_adminReject({order_ref:a.order_ref,reason:'changed my mind'},admin);});
      util_assertEq_(sheet_findRows('Challenges',{order_ref:a.order_ref}).length,1,'still one challenge');
    });
    t('on-time approve, overpayment fine; reject needs a reason and frees the promo',function(){
      var c=mk('U-B');crypto_submitTxid({order_ref:c.order_ref,txid:tx('7')},trader('U-B'));
      var r=crypto_adminApprove(okApprove(row(c.order_ref),{received_usd:150}),owner);
      util_assertEq_(r.order.status,'challenge_created','overpaid order approved by the owner');
      admin_promoSave({code:'TEN',percent_off:10,usage_limit:1},owner);
      var d=mk('U-B',{promo_code:'TEN'});util_assertEq_(d.amount_usd,90,'discount applied');
      crypto_submitTxid({order_ref:d.order_ref,txid:tx('8')},trader('U-B'));
      fails(function(){crypto_adminReject({order_ref:d.order_ref,reason:''},admin);});
      fails(function(){crypto_adminReject({order_ref:d.order_ref,reason:'no funds'},trader('U-B'));},CODES.FORBIDDEN);
      var rj=crypto_adminReject({order_ref:d.order_ref,reason:'TXID not found on chain'},admin);
      util_assertEq_(rj.status,'rejected','rejected');util_assertEq_(rj.reject_reason,'TXID not found on chain','reason shown to the trader');
      util_assertEq_(sheet_getByKey('PromoCodes','TEN').used_count,0,'promo returned');
      fails(function(){crypto_adminApprove(okApprove(row(d.order_ref)),admin);});
    });
    t('deactivated address: new orders refused, open orders keep theirs',function(){
      var open=mk('U-A'),id=crypto_saveAddresses({},admin).addresses[0].address_id;
      crypto_saveAddresses({address_id:id,active:false},admin);
      fails(function(){mk('U-A');},CODES.BUSY);
      util_assertEq_(row(open.order_ref).pay_address,ADDR,'open order keeps its address');
      crypto_saveAddresses({address_id:id,active:true},admin);mk('U-A');
      util_assertEq_(sheet_readAll('ReceivingAddresses').length,1,'never deleted');
    });
    t('only the TXID action is browser-callable, and it needs a session',function(){
      Object.keys(ACTIONS).forEach(function(k){
        var f=ACTIONS[k].fn;
        if(f.indexOf('crypto_')===0)util_assert_(f==='crypto_submitTxid'&&ACTIONS[k].level==='trader','action '+k+' exposes '+f);
      });
      var r=router_handle_({postData:{contents:JSON.stringify({action:'crypto.submitTxid',payload:{order_ref:a.order_ref,txid:tx('f')}})}});
      util_assertEq_(r.code,CODES.UNAUTHENTICATED,'no token, no submit');
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 12 TESTS PASSED');
}

// ===== PART 13: GATEWAY ROUTES: SQUAD, FLUTTERWAVE, MONNIFY =====
// Route: gw_getPaymentRoute(country) reads the Countries sheet (gateway + currency), applies the Nigeria switches
// (nigeria_use_monnify, nigeria_use_flutterwave) and the per-gateway on/off settings. A gateway that is off, or has no
// keys in Script Properties, sends the buyer to the manual USDT route (USD). Changing a country's gateway in the sheet
// changes its route with no code change.
// Payment is NEVER trusted from the browser or from a redirect. gw_verify asks the provider's own verify API, and
// pay_completeGateway (Part 11) then checks exact amount, currency, reference and reuse before anything is created.
// Secrets live in Script Properties only, are sent in request headers only, and are never logged or returned.
// Browser-callable: gw_initiate, gw_verify, gw_useManual, gw_routePublic (public), gw_adminStatus (admin).
// Provider endpoints below follow each provider's public docs as of writing: confirm every one in the provider's
// SANDBOX before live keys go in (the build plan requires sandbox first).
var GW_NAMES_=['squad','flutterwave','monnify'];
var GW_KEYS_={squad:['SQUAD_SECRET_KEY'],flutterwave:['FLW_SECRET_KEY'],monnify:['MONNIFY_API_KEY','MONNIFY_SECRET_KEY','MONNIFY_CONTRACT_CODE']};
var GW_ONLY_CCY_={squad:'NGN',monnify:'NGN'};
var GW_SYS_={system:'gateway'};
var GW_TEST_SECRETS_=null; // tests only: replaces Script Properties
var GW_HTTP_=null;         // tests only: replaces UrlFetchApp

// ---- Settings, secrets, HTTP ----
function gw_bool_(v){return v===true||String(v).toLowerCase()==='true';}
function gw_secret_(k){
  if(GW_TEST_SECRETS_)return String(GW_TEST_SECRETS_[k]||'');
  return String(PropertiesService.getScriptProperties().getProperty(k)||'');
}
function gw_keysPresent_(g){var need=GW_KEYS_[g]||[];return need.length>0&&need.every(function(k){return !!gw_secret_(k);});}
function gw_enabled_(g){return GW_NAMES_.indexOf(g)!==-1&&gw_bool_(settings_get('gateway_'+g+'_enabled',false))&&gw_keysPresent_(g);}
function gw_mode_(g){
  if(!gw_keysPresent_(g))return 'no_keys';
  if(g==='squad')return gw_secret_('SQUAD_SECRET_KEY').indexOf('sandbox_')===0?'sandbox':'live';
  if(g==='flutterwave')return /^FLWSECK_TEST/i.test(gw_secret_('FLW_SECRET_KEY'))?'sandbox':'live';
  return gw_secret_('MONNIFY_ENV')==='live'?'live':'sandbox';
}
function gw_fetch_(url,opt){var r=UrlFetchApp.fetch(url,opt);return {code:r.getResponseCode(),text:r.getContentText()};}
// Never logs the URL, headers or body (they can carry keys or customer data): gateway name and status code only.
function gw_call_(g,method,url,headers,body){
  var opt={method:method,muteHttpExceptions:true,headers:headers||{},followRedirects:false};
  if(body!==undefined){opt.contentType='application/json';opt.payload=JSON.stringify(body);}
  var r;
  try{r=(GW_HTTP_||gw_fetch_)(url,opt);}
  catch(e){console.error('gateway '+g+' unreachable');throw util_error_(CODES.BUSY,'The payment provider could not be reached. Please try again in a moment.');}
  var j=null;try{j=JSON.parse(r.text);}catch(e){}
  return {code:Number(r.code)||0,json:j};
}
function gw_provider_(g,code){
  console.error('gateway '+g+' http '+code);
  return util_error_(CODES.BUSY,'The payment provider is not available right now. Please try again, or pay by crypto instead.');
}
function gw_safeUrl_(u){return typeof u==='string'&&/^https:\/\/[^\s"'<>]+$/i.test(u)&&u.length<2000;}

// ---- Transaction reference sent to the provider ----
// First attempt uses the order reference. After a failed attempt the provider would reject a repeated reference, so a
// retry uses <order_ref>-R<n>. When the provider returns exactly the reference we sent, it is mapped back to the order
// reference before Part 11 checks it.
function gw_failCount_(o){return pay_history_(o).filter(function(h){return h.to==='failed';}).length;}
function gw_txRef_(o){
  var n=gw_failCount_(o)-(o.status==='failed'?1:0);
  return n>0?o.order_ref+'-R'+n:o.order_ref;
}
function gw_evRef_(o,got,sent){return String(got||'')===sent?o.order_ref:String(got||'');}

// ---- Squad (Nigeria, NGN; amounts in kobo) ----
function gw_squadBase_(){return gw_secret_('SQUAD_SECRET_KEY').indexOf('sandbox_')===0?'https://sandbox-api-d.squadco.com':'https://api-d.squadco.com';}
function gw_squadAuth_(){return {Authorization:'Bearer '+gw_secret_('SQUAD_SECRET_KEY')};}
function gw_squadInitiate_(o,ret){
  var r=gw_call_('squad','post',gw_squadBase_()+'/transaction/initiate',gw_squadAuth_(),{
    amount:util_toCents_(o.local_amount),email:o.billing_email,currency:'NGN',initiate_type:'inline',
    transaction_ref:gw_txRef_(o),callback_url:ret,customer_name:o.billing_name,metadata:{order_ref:o.order_ref}});
  var url=r.json&&r.json.data&&r.json.data.checkout_url;
  if(r.code<200||r.code>=300||!gw_safeUrl_(url))throw gw_provider_('squad',r.code);
  return {checkout_url:url};
}
function gw_squadVerify_(o){
  var sent=gw_txRef_(o);
  var r=gw_call_('squad','get',gw_squadBase_()+'/transaction/verify/'+encodeURIComponent(sent),gw_squadAuth_());
  if(r.code===404)return {state:'pending'};
  if(r.code===401||r.code===403||r.code>=500||r.code===0)throw gw_provider_('squad',r.code);
  var d=r.json&&r.json.data;if(!d)return {state:'pending'};
  var st=String(d.transaction_status||'').toLowerCase();
  if(st==='success')return {state:'paid',ev:{amount:Number(d.transaction_amount)/100,currency:String(d.transaction_currency_id||''),
    reference:gw_evRef_(o,d.transaction_ref,sent),gateway_ref:String(d.gateway_transaction_ref||d.transaction_ref||'')}};
  if(st==='failed'||st==='expired')return {state:'failed'};
  return {state:'pending'};
}

// ---- Flutterwave (v3; amount in major units) ----
function gw_flwAuth_(){return {Authorization:'Bearer '+gw_secret_('FLW_SECRET_KEY')};}
function gw_flwInitiate_(o,ret){
  var r=gw_call_('flutterwave','post','https://api.flutterwave.com/v3/payments',gw_flwAuth_(),{
    tx_ref:gw_txRef_(o),amount:o.local_amount,currency:o.currency,redirect_url:ret,
    customer:{email:o.billing_email,name:o.billing_name,phonenumber:o.billing_phone},
    customizations:{title:String(settings_get('site_name','Raven Prop')),description:'Challenge fee'},meta:{order_ref:o.order_ref}});
  var url=r.json&&r.json.data&&r.json.data.link;
  if(r.code<200||r.code>=300||!gw_safeUrl_(url))throw gw_provider_('flutterwave',r.code);
  return {checkout_url:url};
}
function gw_flwVerify_(o){
  var sent=gw_txRef_(o);
  var r=gw_call_('flutterwave','get','https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref='+encodeURIComponent(sent),gw_flwAuth_());
  if(r.code===404)return {state:'pending'};
  if(r.code===401||r.code===403||r.code>=500||r.code===0)throw gw_provider_('flutterwave',r.code);
  var d=r.json&&r.json.data;if(!d||typeof d!=='object')return {state:'pending'}; // "no transaction found" carries no data
  var st=String(d.status||'').toLowerCase();
  if(st==='successful')return {state:'paid',ev:{amount:Number(d.amount),currency:String(d.currency||''),
    reference:gw_evRef_(o,d.tx_ref,sent),gateway_ref:String(d.flw_ref||d.id||'')}};
  if(st==='failed')return {state:'failed'};
  return {state:'pending'};
}

// ---- Monnify (Nigeria backup, NGN; bearer token from key:secret) ----
function gw_monnifyBase_(){return gw_secret_('MONNIFY_ENV')==='live'?'https://api.monnify.com':'https://sandbox.monnify.com';}
function gw_monnifyToken_(){
  var cache=null,ck='gw_monnify_tok';
  if(!GW_TEST_SECRETS_){try{cache=CacheService.getScriptCache();var c=cache.get(ck);if(c)return c;}catch(e){cache=null;}}
  var basic=Utilities.base64Encode(gw_secret_('MONNIFY_API_KEY')+':'+gw_secret_('MONNIFY_SECRET_KEY'));
  var r=gw_call_('monnify','post',gw_monnifyBase_()+'/api/v1/auth/login',{Authorization:'Basic '+basic});
  var tok=r.json&&r.json.requestSuccessful&&r.json.responseBody&&r.json.responseBody.accessToken;
  if(r.code<200||r.code>=300||!tok)throw gw_provider_('monnify',r.code);
  if(cache){try{cache.put(ck,tok,240);}catch(e){}}
  return tok;
}
function gw_monnifyAuth_(){return {Authorization:'Bearer '+gw_monnifyToken_()};}
function gw_monnifyInitiate_(o,ret){
  var r=gw_call_('monnify','post',gw_monnifyBase_()+'/api/v1/merchant/transactions/init-transaction',gw_monnifyAuth_(),{
    amount:o.local_amount,customerName:o.billing_name,customerEmail:o.billing_email,paymentReference:gw_txRef_(o),
    paymentDescription:'Challenge fee',currencyCode:'NGN',contractCode:gw_secret_('MONNIFY_CONTRACT_CODE'),
    redirectUrl:ret,paymentMethods:['CARD','ACCOUNT_TRANSFER']});
  var url=r.json&&r.json.requestSuccessful&&r.json.responseBody&&r.json.responseBody.checkoutUrl;
  if(r.code<200||r.code>=300||!gw_safeUrl_(url))throw gw_provider_('monnify',r.code);
  return {checkout_url:url};
}
function gw_monnifyVerify_(o){
  var sent=gw_txRef_(o);
  var r=gw_call_('monnify','get',gw_monnifyBase_()+'/api/v2/merchant/transactions/query?paymentReference='+encodeURIComponent(sent),gw_monnifyAuth_());
  if(r.code===404)return {state:'pending'};
  if(r.code===401||r.code===403||r.code>=500||r.code===0)throw gw_provider_('monnify',r.code);
  var d=r.json&&r.json.requestSuccessful&&r.json.responseBody;if(!d)return {state:'pending'};
  var st=String(d.paymentStatus||'').toUpperCase();
  // OVERPAID and PARTIALLY_PAID are passed on with the real amount so the exact-match rule refuses them and flags support.
  if(st==='PAID'||st==='OVERPAID'||st==='PARTIALLY_PAID')return {state:'paid',ev:{amount:Number(d.amountPaid),currency:String(d.currencyCode||d.currency||''),
    reference:gw_evRef_(o,d.paymentReference,sent),gateway_ref:String(d.transactionReference||'')}};
  if(st==='FAILED'||st==='EXPIRED'||st==='CANCELLED')return {state:'failed'};
  return {state:'pending'};
}
function gw_adapter_(g){
  if(g==='squad')return {initiate:gw_squadInitiate_,verify:gw_squadVerify_};
  if(g==='flutterwave')return {initiate:gw_flwInitiate_,verify:gw_flwVerify_};
  if(g==='monnify')return {initiate:gw_monnifyInitiate_,verify:gw_monnifyVerify_};
  throw pay_bad_('This order is not paid through a payment gateway.');
}

// ---- Routing ----
// The one place a country becomes a route. Used by the quote (fx_getFeeQuote), so the price, the currency and the
// route always agree. A gateway that is off or has no keys falls back to manual USDT in USD.
function gw_getPaymentRoute(country){
  var c=settings_getCountry(country);
  if(!c||!c.enabled)return null;
  var g=String(c.gateway||'manual').toLowerCase(),cur=String(c.currency||'USD').toUpperCase(),want=g;
  if(c.country_code==='NG'&&g!=='manual'){
    if(gw_bool_(settings_get('nigeria_use_monnify',false)))g='monnify';
    else if(gw_bool_(settings_get('nigeria_use_flutterwave',false)))g='flutterwave';
    want=g;
  }
  var only=GW_ONLY_CCY_[g];
  if(g!=='manual'&&(GW_NAMES_.indexOf(g)===-1||!gw_enabled_(g)||(only&&only!==cur)))g='manual';
  if(g==='manual')cur='USD';
  return {country:c.country_code,gateway:g,currency:cur,fallback:g==='manual'&&want!=='manual'};
}
function gw_routePublic(p,ctx){
  var r=gw_getPaymentRoute(util_normalizeCountry_(p&&p.country));
  if(!r)throw pay_bad_('Payments are not available in this country.');
  return {country:r.country,gateway:r.gateway,currency:r.currency,manual_fallback:r.fallback};
}

// ---- Helpers for the browser actions ----
function gw_ownOrder_(ref,ctx,allowManual){
  var o=pay_get_(ref);
  if(!ctx||!ctx.user||o.user_id!==ctx.user.user_id)throw pay_bad_('Order not found.'); // same message: no ownership leak
  if(o.gateway==='manual'&&!allowManual)throw pay_bad_('This order is paid by crypto, not through a payment gateway.');
  return o;
}
function gw_urlKey_(o){return 'gwurl_'+gw_txRef_(o);}
function gw_urlGet_(o){try{return CacheService.getScriptCache().get(gw_urlKey_(o));}catch(e){return null;}}
function gw_urlPut_(o,url,mins){try{CacheService.getScriptCache().put(gw_urlKey_(o),url,Math.min(21600,Math.max(60,Math.round(mins*60))));}catch(e){}}
function gw_urlClear_(o){try{CacheService.getScriptCache().remove(gw_urlKey_(o));}catch(e){}}
function gw_throttle_(ref){ // at most one provider check per order every 3 seconds
  if(GW_TEST_SECRETS_)return true;
  try{var c=CacheService.getScriptCache(),k='gwv_'+ref;if(c.get(k))return false;c.put(k,'1',3);}catch(e){}
  return true;
}
function gw_manualAvailable_(){return !!crypto_activeAddress_();}
function gw_flagMismatch_(o,res,why){ // one AuditLog row per order, so a repeating check cannot flood the log
  var ev=res&&res.ev||{};
  if(sheet_findOne('AuditLog',{action:'payment.mismatch',entity_id:o.order_ref}))return;
  settings_audit_(GW_SYS_,'payment.mismatch','Payments',o.order_ref,'gateway_ref','',String(ev.gateway_ref||''),
    (String(why||'').slice(0,120))+' | provider: '+ev.amount+' '+ev.currency+' | expected: '+o.local_amount+' '+o.currency);
}
function gw_paidOut_(r){
  return {status:r.challenge_id?'paid':'paid_pending_account',order:pay_out_(r.order),challenge_id:r.challenge_id||null,pending_account:!!r.pending_account};
}
function gw_reopen_(ref){ // failed -> awaiting_payment for a payment the provider reports as successful (no retry limit applies)
  return util_withLock_(function(){
    var o=pay_get_(ref);if(o.status!=='failed')return o;
    var h=pay_history_(o);h.push({from:'failed',to:'awaiting_payment',at:util_nowIso_(),by:'system:gateway',note:'provider reports paid'});
    return sheet_updateRow('Payments',o,{status:'awaiting_payment',updated_at:util_nowIso_(),status_history:h});
  });
}
// Pay result -> Part 11. A payment that does not match exactly stays unpaid, is flagged for admin, and the trader is told to contact support.
function gw_complete_(o,res){
  if(o.status==='failed')o=gw_reopen_(o.order_ref);
  try{return gw_paidOut_(pay_completeGateway(o.order_ref,res.ev,GW_SYS_));}
  catch(e){
    if(e&&e.raven&&e.code===CODES.BAD_REQUEST){
      gw_flagMismatch_(o,res,e.message);
      throw pay_bad_('We could not match this payment to your order. Support has been alerted. Quote reference '+o.order_ref+'.');
    }
    throw e;
  }
}

// ---- Trader: start a gateway payment ----
// Only the order reference is read from the browser. Amount, currency and customer details come from the stored order.
function gw_initiate(p,ctx){
  p=p||{};
  var o=gw_ownOrder_(p.order_ref,ctx),g=o.gateway;
  if(!gw_enabled_(g))throw util_error_(CODES.BUSY,'Card and bank payments are not available right now. Please pay by crypto instead.');
  var only=GW_ONLY_CCY_[g];
  if(only&&only!==o.currency)throw pay_bad_('This payment method cannot take '+o.currency+'.');
  o=pay_lazyExpire_(o);
  if(o.status==='failed')o=pay_transition_(o.order_ref,'awaiting_payment',GW_SYS_,{},{note:'retry'}); // enforces the retry limit and quote validity
  if(o.status!=='awaiting_payment')throw pay_bad_('This order can no longer be paid. Please start a new order.');
  var mins=Number(settings_get('gateway_pay_window_minutes',60));if(!(mins>0))mins=60;
  var url=gw_urlGet_(o); // the same checkout link is returned if the buyer comes back before the window ends
  if(!url){
    if(!(Date.parse(o.quote_expires_at)>Date.now()))throw pay_bad_('This quote has expired. Please start a new order.');
    var ret=String(settings_get('site_url','https://ravenprop.cfd')).replace(/\/+$/,'')+'/#/pay/return?order='+encodeURIComponent(o.order_ref);
    url=gw_adapter_(g).initiate(o,ret).checkout_url;
    gw_urlPut_(o,url,mins);
    o=sheet_updateRow('Payments',o,{deadline_at:new Date(Date.now()+mins*6e4).toISOString(),updated_at:util_nowIso_()});
  }
  return {order_ref:o.order_ref,gateway:g,checkout_url:url,amount:o.local_amount,currency:o.currency,deadline_at:o.deadline_at};
}

// ---- Trader: check a gateway payment ----
// Called when the buyer returns from the provider. The redirect is only a nudge: the outcome comes from the provider's verify API.
function gw_verify(p,ctx){
  p=p||{};
  var o=gw_ownOrder_(p.order_ref,ctx),ref=o.order_ref;
  var none=function(status,ord){return {status:status,order:pay_out_(ord),challenge_id:ord.challenge_id||null,pending_account:false};};
  if(o.status==='challenge_created')return gw_paidOut_({order:o,challenge_id:o.challenge_id,pending_account:false});
  if(o.status==='verified'||o.status==='confirmed'){ // paid already; finish the job (an empty pool leaves it confirmed)
    if(o.status==='verified')pay_confirm(ref,GW_SYS_);
    return gw_paidOut_(pay_tryFulfil_(ref,GW_SYS_));
  }
  if(['awaiting_payment','failed','expired'].indexOf(o.status)===-1)return none(o.status,o);
  if(o.status==='awaiting_payment'&&!o.deadline_at)return none('not_started',o); // no checkout was opened, nothing to verify
  if(!gw_throttle_(ref)){var r0=none('pending',o);r0.throttled=true;return r0;}
  var res=gw_adapter_(o.gateway).verify(o);
  if(res.state==='paid'){
    if(o.status==='expired'){
      settings_audit_(GW_SYS_,'payment.late','Payments',ref,'status','expired','expired','Provider shows a payment after the order expired. Review and refund at the provider, or create the account by hand.');
      throw pay_bad_('Your payment arrived after this order expired. Please contact support and quote reference '+ref+'.');
    }
    return gw_complete_(o,res);
  }
  if(res.state==='failed'){
    if(o.status==='awaiting_payment'){pay_fail(ref,'provider reported the payment as failed',GW_SYS_);gw_urlClear_(o);}
    var f=pay_get_(ref),out=none('failed',f);
    out.can_retry=f.status==='failed'&&gw_failCount_(f)<Number(settings_get('payment_retry_limit',3))&&Date.parse(f.quote_expires_at)>Date.now();
    out.manual_available=gw_manualAvailable_(); // spec 7.3: offer the manual address as the second option
    return out;
  }
  o=pay_lazyExpire_(o);
  return none(o.status==='expired'?'expired':'pending',o);
}

// ---- Trader: switch an unpaid gateway order to the manual USDT address ----
// The provider is checked first, so a payment that already went through is honoured instead of being switched away.
function gw_useManual(p,ctx){
  p=p||{};
  var o=gw_ownOrder_(p.order_ref,ctx),ref=o.order_ref;
  if(['awaiting_payment','failed'].indexOf(o.status)===-1)throw pay_bad_('This order can no longer be switched.');
  if(gw_enabled_(o.gateway)&&(o.deadline_at||o.status==='failed')){
    var res=gw_adapter_(o.gateway).verify(o); // if the provider cannot be reached this throws and nothing changes
    if(res.state==='paid')return gw_verify({order_ref:ref},ctx);
  }
  return util_withLock_(function(){
    var cur=pay_get_(ref);
    if(['awaiting_payment','failed'].indexOf(cur.status)===-1)throw pay_bad_('This order can no longer be switched.');
    if(!(Date.parse(cur.quote_expires_at)>Date.now()))throw pay_bad_('This quote has expired. Please start a new order.');
    var before={gateway:cur.gateway,status:cur.status,deadline_at:cur.deadline_at||'',currency:cur.currency,local_amount:cur.local_amount,
      rate_used:cur.rate_used,markup_pct:cur.markup_pct,status_history:pay_history_(cur)};
    var h=pay_history_(cur).slice();
    h.push({from:cur.status,to:'awaiting_payment',at:util_nowIso_(),by:pay_actor_(ctx),note:'switched to manual crypto'});
    sheet_updateRow('Payments',cur,{gateway:'manual',status:'awaiting_payment',deadline_at:'',updated_at:util_nowIso_(),status_history:h});
    try{var prepared=crypto_prepare_(ref);gw_urlClear_(cur);return pay_out_(prepared);}
    catch(e){sheet_updateRow('Payments',pay_get_(ref),before);throw e;} // no address available: put the order back as it was
  });
}

// ---- Admin ----
// Status only: on/off, whether keys exist, sandbox or live. Key values are never returned. Switching a gateway on or off,
// or sending Nigeria to Monnify or Flutterwave, is done with admin.settings.set (audited).
function gw_adminStatus(p,ctx){
  pay_requireAdmin_(ctx);
  return {
    gateways:GW_NAMES_.map(function(g){
      return {gateway:g,enabled:gw_bool_(settings_get('gateway_'+g+'_enabled',false)),keys_present:gw_keysPresent_(g),mode:gw_mode_(g),ready:gw_enabled_(g)};
    }),
    nigeria:{route:gw_getPaymentRoute('NG'),use_monnify:gw_bool_(settings_get('nigeria_use_monnify',false)),use_flutterwave:gw_bool_(settings_get('nigeria_use_flutterwave',false))},
    manual_ready:gw_manualAvailable_()
  };
}

// ---- Scheduled (Part 18 attaches the trigger, every 10 minutes) ----
// Catches buyers who paid but closed the browser before returning. Run it BEFORE pay_expireStale.
function gw_reconcilePending(){
  var out={checked:0,completed:0,failed:0,flagged:0,errors:0};
  var cutoff=Date.now()-48*36e5;
  sheet_readAll('Payments').forEach(function(o){
    if(out.checked>=60)return;
    if(o.gateway==='manual'||o.status!=='awaiting_payment'||!o.deadline_at||!(Date.parse(o.created_at)>=cutoff))return;
    out.checked++;
    try{
      var res=gw_adapter_(o.gateway).verify(o);
      if(res.state==='paid'){gw_complete_(o,res);out.completed++;}
      else if(res.state==='failed'){pay_fail(o.order_ref,'provider reported the payment as failed',GW_SYS_);out.failed++;}
    }catch(e){
      if(e&&e.raven&&e.code===CODES.BAD_REQUEST)out.flagged++;else out.errors++;
    }
  });
  return out;
}

// ---- Tests: editor only, throwaway spreadsheet, provider calls are mocked (no network, no real keys) ----
// Other suites that quote Nigeria in NGN call this in their setup, because Nigeria is on the manual route until Squad is on.
function gw_testEnable_(list){
  GW_TEST_SECRETS_=Object.assign(GW_TEST_SECRETS_||{},{SQUAD_SECRET_KEY:'sandbox_sk_TEST',FLW_SECRET_KEY:'FLWSECK_TEST-TEST',
    MONNIFY_API_KEY:'MK_TEST',MONNIFY_SECRET_KEY:'MS_TEST',MONNIFY_CONTRACT_CODE:'100'});
  var ch={};(list||['squad']).forEach(function(g){ch['gateway_'+g+'_enabled']=true;});
  admin_settingsSet({changes:ch},{user:{user_id:'U-TEST'},role:'owner'});
  settings_clear_();
}
function gw_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-GW-TEST'),bad=[],owner={user:{user_id:'U-OWN'},role:'owner'};
  var oldHttp=GW_HTTP_,oldSec=GW_TEST_SECRETS_;
  function trader(id){return {user:{user_id:id},role:'trader'};}
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,code){try{f();}catch(e){if(code&&e.code!==code)throw new Error('wrong code '+e.code+': '+e.message);return;}throw new Error('should have failed');}
  function user(id){sheet_appendRow('Users',{user_id:id,email:id.toLowerCase()+'@t.com',password_hash:'x',role:'trader',status:'active',created_at:util_nowIso_()});}
  var bill={billing_name:'Ada Obi',billing_email:'ada@t.com',billing_phone:'+2348012345678',billing_city:'Lagos'};
  function mk(uid,plan,country){return pay_createOrder(Object.assign({plan_id:plan,country:country||'NG'},bill),trader(uid));}
  function row(ref){return sheet_getByKey('Payments',ref);}
  function set(ch){admin_settingsSet({changes:ch},owner);settings_clear_();}
  function base(ref){return String(ref).replace(/-R\d+$/,'');}
  var calls=[],over={},down=false;
  function count(part){return calls.filter(function(c){return c.url.indexOf(part)!==-1;}).length;}
  function json(o,code){return {code:code||200,text:JSON.stringify(o)};}
  // One mock for all three providers. It reads the stored order, so a "paid" answer carries the true amount unless `over` changes it.
  GW_HTTP_=function(url,opt){
    calls.push({url:url,opt:opt});
    if(down)throw new Error('network down');
    var m,ref,o,body=opt.payload?JSON.parse(opt.payload):null;
    if(url.indexOf('squadco.com/transaction/initiate')!==-1)return json({status:200,success:true,data:{checkout_url:'https://checkout.squad.test/'+body.transaction_ref}});
    if((m=url.match(/squadco\.com\/transaction\/verify\/([^?]+)$/))){
      ref=decodeURIComponent(m[1]);o=row(base(ref));
      if(over.notfound)return json({},404);
      return json({status:200,success:true,data:{transaction_status:over.status||'success',transaction_amount:over.amount!=null?over.amount:util_toCents_(o.local_amount),
        transaction_currency_id:over.currency||o.currency,transaction_ref:over.ref||ref,gateway_transaction_ref:over.gref||('SQ-'+ref)}});
    }
    if(url.indexOf('api.flutterwave.com/v3/payments')!==-1)return json({status:'success',data:{link:'https://checkout.flw.test/'+body.tx_ref}});
    if((m=url.match(/verify_by_reference\?tx_ref=(.+)$/))){
      ref=decodeURIComponent(m[1]);o=row(base(ref));
      return json({status:'success',data:{status:over.status||'successful',amount:o.local_amount,currency:o.currency,tx_ref:ref,flw_ref:'FLW-'+ref,id:7}});
    }
    if(url.indexOf('/api/v1/auth/login')!==-1)return json({requestSuccessful:true,responseBody:{accessToken:'tok-mnfy'}});
    if(url.indexOf('/init-transaction')!==-1)return json({requestSuccessful:true,responseBody:{checkoutUrl:'https://checkout.monnify.test/'+body.paymentReference}});
    if((m=url.match(/transactions\/query\?paymentReference=(.+)$/))){
      ref=decodeURIComponent(m[1]);o=row(base(ref));
      return json({requestSuccessful:true,responseBody:{paymentStatus:over.status||'PAID',amountPaid:over.paid!=null?over.paid:o.local_amount,currencyCode:o.currency,paymentReference:ref,transactionReference:'MNFY|'+ref}});
    }
    return json({},404);
  };
  try{
    sheet_buildAll_(ss);settings_clear_();GW_TEST_SECRETS_={};
    ['U-A','U-B'].forEach(user);
    crypto_saveAddresses({coin:'USDT',network:'TRC-20',address:'T'+'A'.repeat(33)},owner);
    var r=admin_poolImport({rows:['10000001','10000002','10000003','10000004','10000005','10000006','10000007','10000008'].map(function(l){
      return {login:l,password:'Pw'+l+'x',investor_password:'Iv'+l+'y',server:'Demo-Srv',size:10000};})},owner);
    util_assertEq_(r.imported,8,'imported');
    var ghc=sheet_readAll('Countries').filter(function(c){return c.gateway==='flutterwave'&&c.enabled;})[0];

    t('everything off: every country is manual, priced in USD',function(){
      var a=gw_getPaymentRoute('NG');util_assertEq_(a.gateway,'manual','ng manual');util_assertEq_(a.currency,'USD','ng usd');util_assertEq_(a.fallback,true,'flagged as fallback');
      util_assertEq_(gw_getPaymentRoute(ghc.country_code).gateway,'manual','flw country manual');
      var q=fx_getFeeQuote('swift-10000','NG');util_assertEq_(q.gateway,'manual','quote route');util_assertEq_(q.currency,'USD','quote ccy');util_assertEq_(q.local_amount,100,'quote amount');
      util_assert_(gw_getPaymentRoute('US')===null,'disabled country has no route');
    });
    t('toggle without keys does not open a route',function(){
      set({gateway_squad_enabled:true});util_assertEq_(gw_getPaymentRoute('NG').gateway,'manual','no keys, still manual');
    });
    t('squad on with keys: Nigeria pays NGN through Squad',function(){
      gw_testEnable_(['squad']);var a=gw_getPaymentRoute('NG');util_assertEq_(a.gateway,'squad','squad');util_assertEq_(a.currency,'NGN','ngn');util_assertEq_(a.fallback,false,'not fallback');
      var q=fx_getFeeQuote('swift-10000','NG');util_assertEq_(q.gateway,'squad','quote route');util_assertEq_(q.local_amount,132000,'quote amount');
      var pub=gw_routePublic({country:'ng'},{});util_assertEq_(pub.gateway,'squad','public route');
      fails(function(){gw_routePublic({country:'US'},{});});
    });
    t('Nigeria switches: Monnify, then Flutterwave, both in NGN',function(){
      set({nigeria_use_monnify:true});util_assertEq_(gw_getPaymentRoute('NG').gateway,'manual','monnify not on yet, safe fallback');
      gw_testEnable_(['monnify']);util_assertEq_(gw_getPaymentRoute('NG').gateway,'monnify','monnify');util_assertEq_(gw_getPaymentRoute('NG').currency,'NGN','monnify ngn');
      set({nigeria_use_monnify:false,nigeria_use_flutterwave:true});gw_testEnable_(['flutterwave']);
      util_assertEq_(gw_getPaymentRoute('NG').gateway,'flutterwave','flutterwave');util_assertEq_(gw_getPaymentRoute('NG').currency,'NGN','flw ngn');
      set({nigeria_use_flutterwave:false});util_assertEq_(gw_getPaymentRoute('NG').gateway,'squad','back to squad');
    });
    t('changing a country row changes its route with no code change',function(){
      var c=sheet_getByKey('Countries',ghc.country_code);util_assertEq_(gw_getPaymentRoute(c.country_code).gateway,'flutterwave','flw');
      sheet_updateRow('Countries',c,{gateway:'manual'});settings_clear_();util_assertEq_(gw_getPaymentRoute(c.country_code).gateway,'manual','now manual');
      sheet_updateRow('Countries',sheet_getByKey('Countries',c.country_code),{gateway:'flutterwave'});settings_clear_();
    });

    var o1=null;
    t('initiate: amount comes from the stored order, client values ignored, secret never leaves the header',function(){
      o1=mk('U-A','swift-10000');util_assertEq_(o1.gateway,'squad','order route');
      fails(function(){gw_initiate({order_ref:o1.order_ref},trader('U-B'));});
      fails(function(){gw_initiate({order_ref:'RV-nope'},trader('U-A'));});
      var res=gw_initiate({order_ref:o1.order_ref,amount:1,local_amount:1,currency:'USD',gateway:'manual'},trader('U-A'));
      util_assert_(/^https:\/\//.test(res.checkout_url),'https checkout link');
      var c=calls.filter(function(x){return x.url.indexOf('/transaction/initiate')!==-1;})[0],b=JSON.parse(c.opt.payload);
      util_assertEq_(b.amount,13200000,'kobo from the quote');util_assertEq_(b.currency,'NGN','currency from the quote');util_assertEq_(b.transaction_ref,o1.order_ref,'reference');
      util_assertEq_(c.opt.headers.Authorization,'Bearer sandbox_sk_TEST','key sent in a header');
      calls.forEach(function(x){util_assert_(x.url.indexOf('sandbox_sk_TEST')===-1&&(!x.opt.payload||x.opt.payload.indexOf('sandbox_sk_TEST')===-1),'key never in a URL or body');});
      util_assert_(JSON.stringify(res).indexOf('sandbox_sk_TEST')===-1,'key never returned');
      util_assert_(!!row(o1.order_ref).deadline_at,'payment window set');
      var n=count('/transaction/initiate');gw_initiate({order_ref:o1.order_ref},trader('U-A'));util_assertEq_(count('/transaction/initiate'),n,'same link, no second checkout');
    });
    t('verify: pending, then wrong amount, wrong currency, wrong reference are all refused and flagged',function(){
      over={status:'pending'};var a=gw_verify({order_ref:o1.order_ref},trader('U-A'));util_assertEq_(a.status,'pending','pending');
      util_assert_(!sheet_findOne('Challenges',{order_ref:o1.order_ref}),'no challenge yet');
      [{amount:13199999},{currency:'USD'},{ref:'RV-000000-OTHER'}].forEach(function(v){
        over=v;fails(function(){gw_verify({order_ref:o1.order_ref},trader('U-A'));},CODES.BAD_REQUEST);
        util_assertEq_(row(o1.order_ref).status,'awaiting_payment','still unpaid');util_assert_(!sheet_findOne('Challenges',{order_ref:o1.order_ref}),'no challenge');
      });
      util_assertEq_(sheet_findRows('AuditLog',{action:'payment.mismatch',entity_id:o1.order_ref}).length,1,'flagged once, not once per attempt');
      over={};fails(function(){gw_verify({order_ref:o1.order_ref},trader('U-B'));});
    });
    t('verify: exact payment creates the challenge once; replays create nothing',function(){
      over={};var a=gw_verify({order_ref:o1.order_ref},trader('U-A'));
      util_assertEq_(a.status,'paid','paid');util_assert_(!!a.challenge_id,'challenge id');util_assertEq_(row(o1.order_ref).status,'challenge_created','order state');
      var b=gw_verify({order_ref:o1.order_ref},trader('U-A'));util_assertEq_(b.challenge_id,a.challenge_id,'same challenge');
      util_assertEq_(sheet_findRows('Challenges',{order_ref:o1.order_ref}).length,1,'exactly one challenge');
      fails(function(){pay_completeGateway(o1.order_ref,{amount:1320e2,currency:'NGN',reference:o1.order_ref,gateway_ref:'SQ-x'},GW_SYS_);});
      fails(function(){pay_completeGateway(o1.order_ref,{amount:1,currency:'NGN',reference:o1.order_ref,gateway_ref:'x'},{});},CODES.FORBIDDEN);
    });
    t('the same provider payment cannot pay two orders',function(){
      var a=mk('U-A','swift-10000'),b=mk('U-A','swift-10000');
      gw_initiate({order_ref:a.order_ref},trader('U-A'));gw_initiate({order_ref:b.order_ref},trader('U-A'));
      over={gref:'SQ-REUSED'};gw_verify({order_ref:a.order_ref},trader('U-A'));
      fails(function(){gw_verify({order_ref:b.order_ref},trader('U-A'));},CODES.BAD_REQUEST);
      util_assert_(!sheet_findOne('Challenges',{order_ref:b.order_ref}),'no second challenge');over={};
    });
    t('a failed payment can be retried with a fresh reference, and manual is offered',function(){
      var a=mk('U-A','swift-10000');gw_initiate({order_ref:a.order_ref},trader('U-A'));
      over={status:'failed'};var f=gw_verify({order_ref:a.order_ref},trader('U-A'));
      util_assertEq_(f.status,'failed','failed');util_assertEq_(f.can_retry,true,'can retry');util_assertEq_(f.manual_available,true,'manual offered');
      over={};var res=gw_initiate({order_ref:a.order_ref},trader('U-A'));
      util_assertEq_(row(a.order_ref).status,'awaiting_payment','reopened');util_assert_(/-R1$/.test(res.checkout_url),'retry uses a new reference');
      var g=gw_verify({order_ref:a.order_ref},trader('U-A'));util_assertEq_(g.status,'paid','paid on retry');
      util_assertEq_(row(a.order_ref).gateway_ref.indexOf('R1')!==-1,true,'provider ref recorded');
    });
    t('switch to the manual address: works, refuses when the provider is down, honours a payment already made',function(){
      var a=mk('U-B','swift-10000');gw_initiate({order_ref:a.order_ref},trader('U-B'));
      down=true;fails(function(){gw_useManual({order_ref:a.order_ref},trader('U-B'));},CODES.BUSY);down=false;
      util_assertEq_(row(a.order_ref).gateway,'squad','unchanged while provider is down');
      over={status:'pending'};var m=gw_useManual({order_ref:a.order_ref},trader('U-B'));
      util_assertEq_(m.gateway,'manual','manual');util_assertEq_(m.currency,'USD','usd');util_assert_(!!m.pay_address&&m.local_amount>100,'address and exact amount');
      fails(function(){gw_initiate({order_ref:a.order_ref},trader('U-B'));});
      fails(function(){gw_verify({order_ref:a.order_ref},trader('U-B'));});
      var c=mk('U-B','swift-10000');gw_initiate({order_ref:c.order_ref},trader('U-B'));
      over={};var p=gw_useManual({order_ref:c.order_ref},trader('U-B'));util_assertEq_(p.status,'paid','paid order is not switched away');
      util_assertEq_(row(c.order_ref).gateway,'squad','still squad');
    });
    t('flutterwave and monnify full flow (Nigeria, NGN)',function(){
      set({nigeria_use_flutterwave:true});var f=mk('U-A','swift-10000');util_assertEq_(f.gateway,'flutterwave','flw route');
      var fi=gw_initiate({order_ref:f.order_ref},trader('U-A'));
      var fb=JSON.parse(calls.filter(function(x){return x.url.indexOf('/v3/payments')!==-1;})[0].opt.payload);
      util_assertEq_(fb.amount,132000,'flw amount');util_assertEq_(fb.currency,'NGN','flw ccy');util_assertEq_(fb.tx_ref,f.order_ref,'flw ref');util_assert_(gw_safeUrl_(fi.checkout_url),'flw link');
      over={};util_assertEq_(gw_verify({order_ref:f.order_ref},trader('U-A')).status,'paid','flw paid');
      set({nigeria_use_flutterwave:false,nigeria_use_monnify:true});var m=mk('U-A','swift-10000');util_assertEq_(m.gateway,'monnify','monnify route');
      var mi=gw_initiate({order_ref:m.order_ref},trader('U-A'));
      var lc=calls.filter(function(x){return x.url.indexOf('/auth/login')!==-1;})[0];
      util_assertEq_(lc.opt.headers.Authorization,'Basic '+Utilities.base64Encode('MK_TEST:MS_TEST'),'monnify basic auth');
      var mb=JSON.parse(calls.filter(function(x){return x.url.indexOf('/init-transaction')!==-1;})[0].opt.payload);
      util_assertEq_(mb.amount,132000,'monnify amount');util_assertEq_(mb.contractCode,'100','contract code');util_assertEq_(mb.paymentReference,m.order_ref,'monnify ref');util_assert_(gw_safeUrl_(mi.checkout_url),'monnify link');
      over={status:'PARTIALLY_PAID',paid:100000};fails(function(){gw_verify({order_ref:m.order_ref},trader('U-A'));},CODES.BAD_REQUEST);util_assertEq_(row(m.order_ref).status,'awaiting_payment','short pay stays unpaid');
      over={};util_assertEq_(gw_verify({order_ref:m.order_ref},trader('U-A')).status,'paid','monnify paid');
      set({nigeria_use_monnify:false});
    });
    t('reconcile finds a payment the buyer never came back for; it skips orders never sent to a provider',function(){
      var a=mk('U-A','swift-10000'),b=mk('U-A','swift-10000');gw_initiate({order_ref:a.order_ref},trader('U-A'));
      over={};var res=gw_reconcilePending();
      util_assert_(res.completed>=1,'completed one');util_assertEq_(row(a.order_ref).status,'challenge_created','paid order finished');util_assertEq_(row(b.order_ref).status,'awaiting_payment','untouched order left alone');
    });
    t('admin status shows state but never key values; traders cannot call it',function(){
      var s=gw_adminStatus({},owner),txt=JSON.stringify(s);
      Object.keys(GW_TEST_SECRETS_).forEach(function(k){util_assert_(txt.indexOf(GW_TEST_SECRETS_[k])===-1,'no value of '+k);});
      util_assertEq_(s.gateways.length,3,'three gateways');util_assertEq_(s.gateways[0].keys_present,true,'keys flagged present');
      fails(function(){gw_adminStatus({},trader('U-A'));},CODES.FORBIDDEN);
    });
    t('actions are whitelisted at the right level',function(){
      util_assertEq_(ACTIONS['gw.initiate'].level,'trader','initiate');util_assertEq_(ACTIONS['gw.verify'].level,'trader','verify');util_assertEq_(ACTIONS['gw.useManual'].level,'trader','useManual');
      util_assertEq_(ACTIONS['pay.route'].level,'public','route');util_assertEq_(ACTIONS['admin.gateways.status'].level,'admin','status');
      ['gw_reconcilePending','gw_getPaymentRoute','gw_testEnable_'].forEach(function(f){util_assert_(!Object.keys(ACTIONS).some(function(k){return ACTIONS[k].fn===f;}),f+' is not browser-callable');});
    });
  }finally{
    GW_HTTP_=oldHttp;GW_TEST_SECRETS_=oldSec;sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 13 TESTS PASSED');
}


// ===== PART 14: PAYOUTS, KYC AND PROOF WALL =====
// KYC: one row per user. Statuses: Under Review (set on every submit) -> Verified | Action Required.
// Bank details on a payout ALWAYS come from the trader's KYC row, never from the request body, so
// "bank account name must match the ID name" cannot be bypassed from the browser.
// Payouts: only from an active Funded account. States: Submitted -> Under Review -> Approved -> Paid,
// or Rejected (with a reason) from any open state. Approve, reject and mark-paid are limited to
// the role in Settings.payout_approver_role (default owner). The router also lets admins reach
// them so that setting can work; payout_requireApprover_ is the real gate.
//
// MONEY MEANING (kept in payout_calc_ so it is easy to change if the owner decides differently):
//   available profit = funded last_balance - start_balance - profit already used by earlier payouts
//   payable          = available profit x split% (70% for payouts 1-3, 80% from payout 4, from the plan)
//   max this request = min(payable, payout_cap% of account size)     <- cap applies AFTER the split
//   min this request = min_payout_pct% of account size (checked against the amount the trader receives)
//   profit used      = amount paid / split%  (stored in Payouts.profit_usd; profit above the cap stays available)
var PAYOUT_OPEN_=['Submitted','Under Review','Approved'];
var PAYOUT_MOVES_={'Submitted':['Under Review','Approved','Rejected'],'Under Review':['Approved','Rejected'],'Approved':['Paid','Rejected']};

function kyc_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function payout_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function payout_mask_(n){var s=String(n||'');return s?'\u2022\u2022\u2022\u2022'+s.slice(-4):'';}
function payout_needUser_(ctx){if(!ctx||!ctx.user)throw util_error_(CODES.UNAUTHENTICATED,'Please log in.');}

// ---------- KYC ----------
function kyc_uniq_(a){return a.filter(function(x,i){return a.indexOf(x)===i;});}
function kyc_nameTokens_(s){
  var t=String(s||'').toLowerCase();
  try{t=t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');}catch(e){}
  try{t=t.replace(/[^\p{L}\s]+/gu,' ');}catch(e){t=t.replace(/[^a-z\s]+/g,' ');}
  return kyc_uniq_(t.split(/\s+/).filter(function(x){return x.length>0;}));
}
// Same person = the shorter name (2+ words) is fully contained in the longer one, any order.
// "Ada Obi" matches "Obi Ada Grace"; "Ada" alone never matches.
function kyc_namesMatch_(a,b){
  var x=kyc_nameTokens_(a),y=kyc_nameTokens_(b);
  if(x.length<2||y.length<2)return false;
  var s=x.length<=y.length?x:y,l=x.length<=y.length?y:x;
  return s.every(function(t){return l.indexOf(t)>=0;});
}
function kyc_banks_(){
  var b=settings_get('payout_banks',[]);if(!Array.isArray(b))return [];
  return b.map(function(x){return typeof x==='string'?x:(x&&x.name?String(x.name):'');}).filter(function(x){return x;});
}
function kyc_bankOk_(name){
  var list=kyc_banks_();if(!list.length)return true;
  var n=String(name).trim().toLowerCase();
  return list.some(function(x){return x.trim().toLowerCase()===n;});
}
function kyc_pub_(k){
  return {status:k.status,id_name:k.id_name,bank_name:k.bank_name,bank_account_name:k.bank_account_name,
    bank_account_masked:payout_mask_(k.bank_account_number),
    admin_note:k.status==='Action Required'?(k.admin_note||''):'',
    submitted_at:k.submitted_at,reviewed_at:k.reviewed_at};
}
function kyc_get(p,ctx){
  payout_needUser_(ctx);
  var k=sheet_findOne('KYC',{user_id:ctx.user.user_id});
  return {kyc:k?kyc_pub_(k):null,required:!!settings_get('kyc_required_before_payout',true),banks:kyc_banks_()};
}
function kyc_submit(p,ctx){
  payout_needUser_(ctx);p=p||{};
  var idName=pay_text_(p.id_name,3,100,'Enter your full name exactly as it appears on your government ID.');
  var bankName=pay_text_(p.bank_name,2,60,'Choose your bank.');
  var accName=pay_text_(p.bank_account_name,3,100,'Enter the account name exactly as your bank shows it.');
  var accNum=String(p.bank_account_number==null?'':p.bank_account_number).replace(/[\s-]/g,'');
  if(!/^[0-9A-Za-z]{6,34}$/.test(accNum))throw kyc_bad_('Enter a valid bank account number.');
  if(!kyc_bankOk_(bankName))throw kyc_bad_('Choose your bank from the list.');
  if(!kyc_namesMatch_(idName,accName))throw kyc_bad_('The bank account name must match the name on your ID.');
  return util_withLock_(function(){
    var now=util_nowIso_(),uid=ctx.user.user_id,ex=sheet_findOne('KYC',{user_id:uid}),row;
    var f={id_name:idName,bank_name:bankName,bank_account_name:accName,bank_account_number:accNum,
      status:'Under Review',admin_note:'',submitted_at:now,reviewed_at:'',reviewed_by:''};
    if(ex)row=sheet_updateRow('KYC',ex,f);
    else{f.kyc_id=sheet_newKey_('KYC');f.user_id=uid;row=sheet_appendRow('KYC',f);}
    settings_audit_(ctx,'kyc.submit','KYC',row.kyc_id,'status',ex?ex.status:'','Under Review');
    return {kyc:kyc_pub_(row)};
  });
}
// One admin action for both jobs. No kyc_id = the queue. kyc_id + decision = review it.
function kyc_adminReview(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  if(!p.kyc_id){
    var want=p.status||'Under Review',all=sheet_readAll('KYC');
    if(want!=='all')all=all.filter(function(k){return k.status===want;});
    var users={};sheet_readAll('Users').forEach(function(u){users[u.user_id]=u;});
    var everyKyc=sheet_readAll('KYC');
    all.sort(function(a,b){return String(a.submitted_at).localeCompare(String(b.submitted_at));});
    return {queue:all.slice(0,200).map(function(k){
      var u=users[k.user_id]||{};
      return {kyc_id:k.kyc_id,user_id:k.user_id,email:u.email||'',full_name:u.full_name||'',status:k.status,
        id_name:k.id_name,bank_name:k.bank_name,bank_account_name:k.bank_account_name,bank_account_number:k.bank_account_number,
        names_match:kyc_namesMatch_(k.id_name,k.bank_account_name),
        shared_bank_account_with:everyKyc.filter(function(o){return o.user_id!==k.user_id&&o.bank_account_number&&o.bank_account_number===k.bank_account_number;}).length,
        admin_note:k.admin_note,submitted_at:k.submitted_at,reviewed_at:k.reviewed_at};
    })};
  }
  var decision=p.decision;
  if(decision!=='verify'&&decision!=='action_required')throw kyc_bad_('decision must be verify or action_required.');
  var note=decision==='action_required'?pay_text_(p.note,3,300,'Tell the trader what to fix (3 to 300 characters).'):String(p.note||'').trim().slice(0,300);
  return util_withLock_(function(){
    var k=sheet_getByKey('KYC',String(p.kyc_id));
    if(!k)throw kyc_bad_('KYC record not found.');
    var to=decision==='verify'?'Verified':'Action Required';
    if(decision==='verify'){
      if(k.status!=='Under Review')throw kyc_bad_('Only a record that is under review can be verified.');
      if(!kyc_namesMatch_(k.id_name,k.bank_account_name))throw kyc_bad_('The ID name and bank account name do not match.');
    }else if(k.status!=='Under Review'&&k.status!=='Verified')throw kyc_bad_('This record is already waiting for the trader.');
    var row=sheet_updateRow('KYC',k,{status:to,admin_note:note,reviewed_at:util_nowIso_(),reviewed_by:ctx.user.user_id});
    settings_audit_(ctx,'kyc.review','KYC',k.kyc_id,'status',k.status,to,note);
    return {kyc_id:row.kyc_id,status:row.status};
  });
}

// ---------- Payout calculation (one place) ----------
function payout_split_(plan,number){
  var tiers=Array.isArray(plan.profit_split_tiers)?plan.profit_split_tiers.slice():[];
  if(!tiers.length)throw payout_bad_('No profit split is set for this plan.');
  tiers.sort(function(a,b){return a.from-b.from;});
  var pct=null;tiers.forEach(function(t){if(number>=t.from)pct=t.pct;});
  if(pct===null)throw payout_bad_('No profit split is set for this plan.');
  return Number(pct);
}
function payout_calc_(ch,acct,plan,rows){
  var live=rows.filter(function(r){return r.status!=='Rejected';});
  var paid=live.filter(function(r){return r.status==='Paid';}).length;
  var number=paid+1,split=payout_split_(plan,number);
  var size=Number(ch.account_size_usd)||Number(plan.account_size_usd)||0;
  var start=acct&&Number(acct.start_balance)>0?Number(acct.start_balance):size;
  var b=acct?acct.last_balance:null,hasBal=b!==''&&b!==null&&b!==undefined&&isFinite(Number(b));
  var total=hasBal?util_round_(Number(b)-start):0;
  var used=util_sumMoney_(live.map(function(r){return Number(r.profit_usd)||0;}));
  var avail=Math.max(0,util_round_(total-used));
  var share=avail>0?util_pctOf_(avail,split):0;
  var cap=util_pctOf_(size,plan.payout_cap),min=util_pctOf_(size,plan.min_payout_pct||0);
  var max=Math.min(share,cap);
  var last=null;live.forEach(function(r){if(!last||String(r.requested_at)>String(last.requested_at))last=r;});
  var gap=Number(plan.payout_gap_days)||0;
  var next=last&&gap>0?new Date(Date.parse(last.requested_at)+gap*864e5).toISOString():null;
  return {payout_number:number,split_pct:split,account_size_usd:size,start_balance:start,balance:hasBal?Number(b):null,
    profit_total_usd:total,profit_used_usd:used,profit_available_usd:avail,payable_usd:share,
    cap_usd:cap,min_usd:min,max_usd:max,cap_applied:share>cap,next_eligible_at:next,open:live.some(function(r){return PAYOUT_OPEN_.indexOf(r.status)>=0;})};
}
function payout_kycProblem_(userId){
  var k=sheet_findOne('KYC',{user_id:userId}),req=!!settings_get('kyc_required_before_payout',true);
  if(!k)return {reason:'Complete identity verification (KYC) before requesting a payout.',kyc:null};
  if(req&&k.status==='Under Review')return {reason:'Your identity verification is still under review.',kyc:k};
  if(req&&k.status==='Action Required')return {reason:'Your identity verification needs attention'+(k.admin_note?': '+k.admin_note:'.'),kyc:k};
  if(!kyc_namesMatch_(k.id_name,k.bank_account_name))return {reason:'Your bank account name must match your ID name. Update your verification details.',kyc:k};
  return {reason:'',kyc:k};
}
function payout_eligibility_(ch,userId){
  var out={can:false,reason:'',calc:null,kyc:null,plan:null,acct:null};
  if(!settings_get('payout_enabled',true)){out.reason='Payouts are paused right now. Please try again later.';return out;}
  if(ch.stage!=='Funded'||ch.status!=='Active'){out.reason='Payouts are only available on an active funded account.';return out;}
  var plan=settings_getPlan(ch.plan_id);
  if(!plan){out.reason='This challenge plan is no longer available.';return out;}
  var acct=chal_currentAccount_(ch);
  if(!acct||acct.stage!=='Funded'){out.reason='Your funded account is not ready yet.';return out;}
  var calc=payout_calc_(ch,acct,plan,sheet_findRows('Payouts',{challenge_id:ch.challenge_id}));
  out.calc=calc;out.plan=plan;out.acct=acct;
  if(calc.open){out.reason='You already have a payout request in progress.';return out;}
  var kp=payout_kycProblem_(userId);out.kyc=kp.kyc;
  if(kp.reason){out.reason=kp.reason;return out;}
  if(calc.next_eligible_at&&Date.now()<Date.parse(calc.next_eligible_at)){out.reason='You can request your next payout on '+calc.next_eligible_at.slice(0,10)+'.';return out;}
  if(calc.profit_available_usd<=0){out.reason='There is no available profit to pay out yet.';return out;}
  if(calc.max_usd<calc.min_usd){out.reason='Your payable profit is '+util_formatUsd_(calc.max_usd)+'. The minimum payout is '+util_formatUsd_(calc.min_usd)+'.';return out;}
  out.can=true;return out;
}
function payout_push_(o,from,to,by,note){
  var h=pay_history_(o).slice();h.push({from:from,to:to,at:util_nowIso_(),by:by,note:note?String(note).slice(0,200):''});
  return h.length>200?h.slice(-200):h;
}
function payout_rate_(userId){
  var u=sheet_getByKey('Users',userId),c=u&&u.country?settings_getCountry(u.country):null,ccy=c&&c.currency?String(c.currency).toUpperCase():'USD';
  try{var r=fx_getRate(ccy);return {currency:ccy,rate:r.rate};}catch(e){return {currency:'USD',rate:1};}
}

// ---------- Trader endpoints ----------
function payout_pub_(r){
  return {payout_id:r.payout_id,challenge_id:r.challenge_id,payout_number:r.payout_number,status:r.status,
    amount_usd:r.amount_usd,split_pct:r.split_pct,cap_usd:r.cap_usd,cap_applied:!!r.cap_applied,
    currency:r.currency,rate_used:r.rate_used,local_amount:r.local_amount,
    bank_name:r.bank_name,bank_account_masked:payout_mask_(r.bank_account_number),
    reject_reason:r.status==='Rejected'?r.reject_reason:'',reference:r.status==='Paid'?r.reference:'',
    requested_at:r.requested_at,approved_at:r.approved_at,paid_at:r.paid_at};
}
function payout_request(p,ctx){
  payout_needUser_(ctx);p=p||{};
  return util_withLock_(function(){
    var ch=chal_get_(p.challenge_id);
    if(ch.user_id!==ctx.user.user_id)throw payout_bad_('Challenge not found.'); // same message: no ownership leak
    var el=payout_eligibility_(ch,ctx.user.user_id);
    if(!el.can)throw payout_bad_(el.reason);
    var c=el.calc,amount;
    if(p.amount_usd===undefined||p.amount_usd===null||p.amount_usd==='')amount=c.max_usd;
    else{
      amount=util_parseAmount_(p.amount_usd,{min:0.01});
      if(amount===null)throw payout_bad_('Enter a valid amount.');
    }
    if(util_toCents_(amount)<util_toCents_(c.min_usd))throw payout_bad_('The minimum payout is '+util_formatUsd_(c.min_usd)+'.');
    if(util_toCents_(amount)>util_toCents_(c.max_usd))throw payout_bad_('The most you can request now is '+util_formatUsd_(c.max_usd)+'.');
    var fx=payout_rate_(ctx.user.user_id),now=util_nowIso_(),k=el.kyc;
    var used=Math.min(c.profit_available_usd,util_round_(amount*100/c.split_pct));
    var id=sheet_newKey_('Payouts');
    var row=sheet_appendRow('Payouts',{payout_id:id,challenge_id:ch.challenge_id,account_id:el.acct.account_id,user_id:ctx.user.user_id,
      payout_number:c.payout_number,profit_usd:used,requested_usd:amount,split_pct:c.split_pct,cap_usd:c.cap_usd,
      cap_applied:c.cap_applied&&util_toCents_(amount)===util_toCents_(c.cap_usd),amount_usd:amount,
      currency:fx.currency,rate_used:fx.rate,local_amount:util_round_(amount*fx.rate),
      bank_name:k.bank_name,bank_account_name:k.bank_account_name,bank_account_number:k.bank_account_number,
      status:'Submitted',requested_at:now,updated_at:now,
      status_history:payout_push_({},'','Submitted','trader:'+ctx.user.user_id,'requested')});
    settings_audit_(ctx,'payout.request','Payouts',id,'amount_usd','',amount);
    return {payout:payout_pub_(row)};
  });
}
function payout_listMine(p,ctx){
  payout_needUser_(ctx);
  var uid=ctx.user.user_id;
  var rows=sheet_findRows('Payouts',{user_id:uid}).sort(function(a,b){return String(b.requested_at).localeCompare(String(a.requested_at));});
  var elig=sheet_findRows('Challenges',{user_id:uid,stage:'Funded',status:'Active'}).map(function(ch){
    var o={challenge_id:ch.challenge_id,plan_id:ch.plan_id,account_size_usd:ch.account_size_usd,can_request:false,reason:''};
    try{
      var e=payout_eligibility_(ch,uid);o.can_request=e.can;o.reason=e.reason;
      if(e.calc)['payout_number','split_pct','cap_usd','min_usd','max_usd','payable_usd','profit_available_usd','next_eligible_at'].forEach(function(f){o[f]=e.calc[f];});
    }catch(err){o.reason=err&&err.raven?err.message:'Payout details are not available right now.';}
    return o;
  });
  var k=sheet_findOne('KYC',{user_id:uid});
  return {payouts:rows.map(payout_pub_),eligibility:elig,kyc_status:k?k.status:null,
    payout_enabled:!!settings_get('payout_enabled',true),approval_hours:settings_get('payout_approval_hours',24)};
}

// ---------- Admin / approver endpoints ----------
function payout_requireApprover_(ctx){
  pay_requireAdmin_(ctx);
  if(ctx.role==='owner')return;
  if(ctx.role==='admin'&&settings_get('payout_approver_role','owner')==='admin')return;
  throw util_error_(CODES.FORBIDDEN,'Only the owner can approve payouts.');
}
function payout_adminOut_(r,users,kycs){
  var u=users[r.user_id]||{},k=kycs[r.user_id]||{};
  var o=Object.assign({},r);o.status_history=pay_history_(r);
  o.user_email=u.email||'';o.user_name=u.full_name||'';o.kyc_status=k.status||'';
  return o;
}
function payout_adminList(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var rows=sheet_readAll('Payouts'),counts={};
  rows.forEach(function(r){counts[r.status]=(counts[r.status]||0)+1;});
  if(p.status){
    if(['Submitted','Under Review','Approved','Paid','Rejected'].indexOf(p.status)<0)throw payout_bad_('Unknown status.');
    rows=rows.filter(function(r){return r.status===p.status;});
  }
  rows.sort(function(a,b){return String(b.requested_at).localeCompare(String(a.requested_at));});
  var users={},kycs={};
  sheet_readAll('Users').forEach(function(u){users[u.user_id]=u;});
  sheet_readAll('KYC').forEach(function(k){kycs[k.user_id]=k;});
  return {payouts:rows.slice(0,200).map(function(r){return payout_adminOut_(r,users,kycs);}),counts:counts};
}
// Moves one payout. Everything runs in the lock and re-reads the row, so a double click or two
// admins acting at once can never approve twice, pay twice or reject something already paid.
function payout_move_(id,to,ctx,extra,opts){
  opts=opts||{};
  return util_withLock_(function(){
    var r=id?sheet_getByKey('Payouts',String(id)):null;
    if(!r)throw payout_bad_('Payout not found.');
    if((PAYOUT_MOVES_[r.status]||[]).indexOf(to)<0)throw payout_bad_('A payout that is "'+r.status+'" cannot be moved to "'+to+'".');
    if(opts.guard)opts.guard(r);
    var now=util_nowIso_(),ch=Object.assign({status:to,updated_at:now,
      status_history:payout_push_(r,r.status,to,pay_actor_(ctx),opts.note)},extra||{});
    var row=sheet_updateRow('Payouts',r,ch);
    settings_audit_(ctx,'payout.'+opts.action,'Payouts',r.payout_id,'status',r.status,to,opts.note);
    if(opts.after)opts.after(row);
    return row;
  });
}
function payout_adminReview(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  return {payout:payout_adminOut_(payout_move_(p.payout_id,'Under Review',ctx,{reviewed_at:util_nowIso_()},{action:'review'}),{},{})};
}
function payout_adminApprove(p,ctx){
  payout_requireApprover_(ctx);p=p||{};
  var row=payout_move_(p.payout_id,'Approved',ctx,{approved_at:util_nowIso_(),approved_by:ctx.user.user_id,reviewed_at:util_nowIso_()},{action:'approve',guard:function(r){
    var ch=sheet_getByKey('Challenges',r.challenge_id);
    if(!ch||ch.stage!=='Funded'||ch.status!=='Active')throw payout_bad_('This funded account is no longer active. Reject the request instead.');
    var kp=payout_kycProblem_(r.user_id);
    if(kp.reason)throw payout_bad_('Cannot approve: '+kp.reason);
    if(kp.kyc&&kp.kyc.status!=='Verified'&&settings_get('kyc_required_before_payout',true))throw payout_bad_('Cannot approve: identity is not verified.');
    if(kp.kyc&&(kp.kyc.bank_account_number!==r.bank_account_number||kp.kyc.bank_name!==r.bank_name))throw payout_bad_('The bank details changed after this request. Reject it and ask the trader to request again.');
  }});
  return {payout:payout_adminOut_(row,{},{})};
}
function payout_adminReject(p,ctx){
  payout_requireApprover_(ctx);p=p||{};
  var reason=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');
  var row=payout_move_(p.payout_id,'Rejected',ctx,{reject_reason:reason,reviewed_at:util_nowIso_()},{action:'reject',note:reason});
  return {payout:payout_adminOut_(row,{},{})};
}
function payout_adminMarkPaid(p,ctx){
  payout_requireApprover_(ctx);p=p||{};
  var ref=pay_text_(p.reference,3,100,'Enter the transfer reference (3 to 100 characters).');
  var paidAt=util_nowIso_();
  if(p.paid_at!==undefined&&p.paid_at!==null&&p.paid_at!==''){
    var d=util_parseTime_(p.paid_at);
    if(!d||d.getTime()>Date.now()+3e5)throw payout_bad_('The paid date is not valid or is in the future.');
    paidAt=d.toISOString();
  }
  var row=payout_move_(p.payout_id,'Paid',ctx,{reference:ref,paid_at:paidAt},{action:'paid',note:ref,after:function(r){
    // recount instead of +1: safe to repeat, and repairs itself if a past write failed
    var n=sheet_findRows('Payouts',{challenge_id:r.challenge_id,status:'Paid'}).length;
    sheet_updateRow('Challenges',r.challenge_id,{payouts_paid:n,updated_at:util_nowIso_()});
  }});
  return {payout:payout_adminOut_(row,{},{})};
}

// ---------- Public proof wall ----------
// PAID records only, anonymised, never seeded. Empty list until the first payout is marked Paid.
function payout_anon_(userId){return 'RV\u2022\u2022\u2022\u2022'+util_hex_(util_sha256_(util_utf8Bytes_(String(userId)))).slice(0,3).toUpperCase();}
function payout_proofWall(p,ctx){
  if(!settings_get('proof_wall_enabled',true))return {enabled:false,payouts:[]};
  var rows=sheet_findRows('Payouts',{status:'Paid'}).sort(function(a,b){return String(b.paid_at).localeCompare(String(a.paid_at));}).slice(0,50);
  return {enabled:true,payouts:rows.map(function(r){
    var ch=sheet_getByKey('Challenges',r.challenge_id)||{};
    return {trader:payout_anon_(r.user_id),amount_usd:r.amount_usd,account_size_usd:ch.account_size_usd||null,style:ch.style||'',paid_on:String(r.paid_at||'').slice(0,10)};
  })};
}

// ---------- Tests: run payout_runTests from the Apps Script editor ----------
function payout_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-PAYOUT-TEST'),bad=[];
  var owner={user:{user_id:'U-OWN'},role:'owner'},adm={user:{user_id:'U-ADM'},role:'admin'};
  var trA={user:{user_id:'U-A'},role:'trader'},trB={user:{user_id:'U-B'},role:'trader'};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,text){try{f();}catch(e){if(text&&String(e.message).indexOf(text)<0)throw new Error('wrong message: '+e.message);return;}throw new Error('should have failed');}
  function user(id,country){sheet_appendRow('Users',{user_id:id,email:id.toLowerCase()+'@t.com',password_hash:'x',role:'trader',status:'active',country:country||'NG',created_at:util_nowIso_()});}
  function funded(cid,uid,balance,stage,status){
    var now=util_nowIso_();
    sheet_appendRow('Challenges',{challenge_id:cid,user_id:uid,plan_id:'swift-10000',style:'Swift',account_size_usd:10000,stage:stage||'Funded',status:status||'Active',current_account_id:'A-'+cid,payouts_paid:0,created_at:now,funded_at:now});
    sheet_appendRow('Accounts',{account_id:'A-'+cid,challenge_id:cid,user_id:uid,stage:'Funded',pool_id:'P-'+cid,login:'9'+cid.replace(/\D/g,'').padStart(7,'0'),size_usd:10000,start_balance:10000,status:'Active',last_balance:balance,last_equity:balance,assigned_at:now});
  }
  function kycOk(uid,name){
    var r=kyc_submit({id_name:name||'Ada Grace Obi',bank_name:'Test Bank',bank_account_name:'Obi Ada',bank_account_number:'0123456789'},{user:{user_id:uid},role:'trader'});
    var k=sheet_findOne('KYC',{user_id:uid});kyc_adminReview({kyc_id:k.kyc_id,decision:'verify'},owner);return r;
  }
  function ago(id,days){sheet_updateRow('Payouts',id,{requested_at:new Date(Date.now()-days*864e5).toISOString()});}
  function dollars(x){return util_round_(x);}
  var first=null;
  try{
    sheet_buildAll_(ss);settings_clear_();
    user('U-A');user('U-B');user('U-C','GH');
    // ---- pure helpers
    t('name match',function(){
      util_assert_(kyc_namesMatch_('Ada Grace Obi','Obi Ada'),'subset any order');
      util_assert_(kyc_namesMatch_('  ADA obi ','Ada, Obi'),'case and punctuation');
      util_assert_(!kyc_namesMatch_('Ada Obi','Ada Okoro'),'different surname');
      util_assert_(!kyc_namesMatch_('Ada','Ada Obi'),'single name never matches');
      util_assert_(kyc_namesMatch_('Jos\u00e9 Garc\u00eda','jose garcia'),'accents');
    });
    t('split tiers',function(){
      var plan=settings_getPlan('swift-10000');
      util_assertEq_(payout_split_(plan,1),70,'#1');util_assertEq_(payout_split_(plan,3),70,'#3');
      util_assertEq_(payout_split_(plan,4),80,'#4');util_assertEq_(payout_split_(plan,9),80,'#9');
    });
    // ---- KYC
    funded('C-T1','U-A',15000);
    t('no KYC, no payout',function(){fails(function(){payout_request({challenge_id:'C-T1'},trA);},'KYC');});
    t('KYC validation',function(){
      var good={id_name:'Ada Grace Obi',bank_name:'Test Bank',bank_account_name:'Obi Ada',bank_account_number:'0123456789'};
      fails(function(){kyc_submit(Object.assign({},good,{bank_account_name:'Chidi Okoro'}),trA);},'match');
      fails(function(){kyc_submit(Object.assign({},good,{bank_account_number:'12'}),trA);},'account number');
      fails(function(){kyc_submit(Object.assign({},good,{id_name:''}),trA);},'ID');
      util_assertEq_(sheet_readAll('KYC').length,0,'nothing stored by refusals');
      var r=kyc_submit(good,trA);util_assertEq_(r.kyc.status,'Under Review','under review');
      util_assert_(r.kyc.bank_account_number===undefined&&r.kyc.bank_account_masked.slice(-4)==='6789','number masked');
    });
    t('under review blocks payout',function(){fails(function(){payout_request({challenge_id:'C-T1'},trA);},'under review');});
    t('trader cannot review own KYC',function(){fails(function(){kyc_adminReview({},trA);},'access');});
    t('verify KYC',function(){
      var q=kyc_adminReview({},adm).queue;util_assertEq_(q.length,1,'queue');util_assertEq_(q[0].names_match,true,'match flag');
      fails(function(){kyc_adminReview({kyc_id:q[0].kyc_id,decision:'action_required'},adm);},'fix');
      kyc_adminReview({kyc_id:q[0].kyc_id,decision:'verify'},adm);
      util_assertEq_(kyc_get({},trA).kyc.status,'Verified','verified');
      fails(function(){kyc_adminReview({kyc_id:q[0].kyc_id,decision:'verify'},adm);},'under review');
    });
    // ---- the $10k example
    t('$10k funded: max payout is $2,000',function(){
      var l=payout_listMine({},trA).eligibility[0];
      util_assertEq_(l.can_request,true,'can request');util_assertEq_(l.cap_usd,2000,'cap');util_assertEq_(l.min_usd,1000,'min');
      util_assertEq_(l.payable_usd,3500,'70% of 5000');util_assertEq_(l.max_usd,2000,'capped');
    });
    t('amount checks',function(){
      fails(function(){payout_request({challenge_id:'C-T1',amount_usd:500},trA);},'minimum');
      fails(function(){payout_request({challenge_id:'C-T1',amount_usd:2000.01},trA);},'most');
      fails(function(){payout_request({challenge_id:'C-T1',amount_usd:'abc'},trA);},'valid');
      fails(function(){payout_request({challenge_id:'C-T1'},trB);},'not found');
      util_assertEq_(sheet_readAll('Payouts').length,0,'nothing created by refusals');
    });
    t('request',function(){
      var r=payout_request({challenge_id:'C-T1',user_id:'U-B',bank_account_number:'9999999999'},trA);
      first=r.payout.payout_id;
      util_assertEq_(r.payout.amount_usd,2000,'default = max');util_assertEq_(r.payout.status,'Submitted','submitted');
      util_assertEq_(r.payout.currency,'NGN','ngn');util_assertEq_(r.payout.rate_used,1320,'rate');util_assertEq_(r.payout.local_amount,2640000,'local');
      util_assertEq_(r.payout.cap_applied,true,'cap applied');util_assertEq_(r.payout.split_pct,70,'split');
      var row=sheet_getByKey('Payouts',first);
      util_assertEq_(row.bank_account_number,'0123456789','bank details come from KYC, not the request');
      util_assertEq_(row.user_id,'U-A','user comes from session');util_assertEq_(dollars(row.profit_usd),2857.14,'profit used');
    });
    t('one open request at a time',function(){fails(function(){payout_request({challenge_id:'C-T1'},trA);},'in progress');});
    t('trader view masks bank number and hides others',function(){
      var l=payout_listMine({},trA);util_assertEq_(l.payouts.length,1,'own only');
      util_assert_(JSON.stringify(l).indexOf('0123456789')<0,'no full number');
      util_assertEq_(payout_listMine({},trB).payouts.length,0,'other trader sees none');
    });
    // ---- approver rules
    t('roles',function(){
      fails(function(){payout_adminApprove({payout_id:first},adm);},'owner');
      fails(function(){payout_adminApprove({payout_id:first},trA);},'access');
      fails(function(){payout_adminMarkPaid({payout_id:first,reference:'REF123'},owner);},'cannot be moved');
      util_assertEq_(payout_adminReview({payout_id:first},adm).payout.status,'Under Review','admin can review');
    });
    t('approve is guarded',function(){
      var k=sheet_findOne('KYC',{user_id:'U-A'});
      sheet_updateRow('KYC',k,{bank_account_number:'5555555555'});
      fails(function(){payout_adminApprove({payout_id:first},owner);},'bank details changed');
      sheet_updateRow('KYC',k,{bank_account_number:'0123456789',status:'Action Required'});
      fails(function(){payout_adminApprove({payout_id:first},owner);},'Cannot approve');
      sheet_updateRow('KYC',k,{status:'Verified'});
      sheet_updateRow('Challenges','C-T1',{status:'Breached'});
      fails(function(){payout_adminApprove({payout_id:first},owner);},'no longer active');
      sheet_updateRow('Challenges','C-T1',{status:'Active'});
      util_assertEq_(sheet_getByKey('Payouts',first).status,'Under Review','still under review after refusals');
    });
    t('approve then double approve',function(){
      util_assertEq_(payout_adminApprove({payout_id:first},owner).payout.status,'Approved','approved');
      fails(function(){payout_adminApprove({payout_id:first},owner);},'cannot be moved');
      fails(function(){payout_adminReject({payout_id:first,reason:''},owner);},'reason');
    });
    t('proof wall empty until paid',function(){util_assertEq_(payout_proofWall({},null).payouts.length,0,'empty');});
    t('mark paid',function(){
      fails(function(){payout_adminMarkPaid({payout_id:first},owner);},'reference');
      fails(function(){payout_adminMarkPaid({payout_id:first,reference:'REF123',paid_at:'2999-01-01'},owner);},'future');
      var r=payout_adminMarkPaid({payout_id:first,reference:'REF123'},owner);
      util_assertEq_(r.payout.status,'Paid','paid');util_assertEq_(sheet_getByKey('Challenges','C-T1').payouts_paid,1,'counter');
      fails(function(){payout_adminMarkPaid({payout_id:first,reference:'REF999'},owner);},'cannot be moved');
      fails(function(){payout_adminReject({payout_id:first,reason:'too late'},owner);},'cannot be moved');
      util_assertEq_(pay_history_(sheet_getByKey('Payouts',first)).length,4,'history: submitted, review, approved, paid');
    });
    t('proof wall after paid is anonymised',function(){
      var w=payout_proofWall({},null);util_assertEq_(w.payouts.length,1,'one record');
      var s=JSON.stringify(w);
      util_assert_(/^RV\u2022\u2022\u2022\u2022[0-9A-F]{3}$/.test(w.payouts[0].trader),'anon id');
      ['U-A','Ada','Obi','Test Bank','0123456789','a@t.com'].forEach(function(x){util_assert_(s.indexOf(x)<0,'leaks '+x);});
      admin_settingsSet({changes:{proof_wall_enabled:false}},owner);
      util_assertEq_(payout_proofWall({},null).payouts.length,0,'switch off');
      admin_settingsSet({changes:{proof_wall_enabled:true}},owner);
    });
    t('7 day gap',function(){
      var l=payout_listMine({},trA).eligibility[0];util_assertEq_(l.can_request,false,'blocked');
      fails(function(){payout_request({challenge_id:'C-T1'},trA);},'next payout on');
      ago(first,8);
      var l2=payout_listMine({},trA).eligibility[0];
      util_assertEq_(l2.can_request,true,'open after 8 days');util_assertEq_(l2.payout_number,2,'#2');
      util_assertEq_(dollars(l2.profit_available_usd),2142.86,'profit left after the capped payout');
      util_assertEq_(l2.max_usd,1500,'70% of what is left, under the cap');
    });
    t('rejected request does not use profit or start the gap',function(){
      var r=payout_request({challenge_id:'C-T1',amount_usd:1200},trA);
      payout_adminReject({payout_id:r.payout.payout_id,reason:'Details unclear'},owner);
      var row=sheet_getByKey('Payouts',r.payout.payout_id);util_assertEq_(row.status,'Rejected','rejected');util_assertEq_(row.reject_reason,'Details unclear','reason');
      var l=payout_listMine({},trA).eligibility[0];util_assertEq_(l.can_request,true,'can ask again now');util_assertEq_(l.max_usd,1500,'profit intact');
      util_assertEq_(sheet_getByKey('Challenges','C-T1').payouts_paid,1,'counter unchanged');
    });
    t('fourth payout pays 80%',function(){
      funded('C-T2','U-B',20000);kycOk('U-B','Ada Grace Obi');
      for(var i=0;i<3;i++)sheet_appendRow('Payouts',{payout_id:sheet_newKey_('Payouts'),challenge_id:'C-T2',user_id:'U-B',status:'Paid',profit_usd:0,amount_usd:100,requested_at:new Date(Date.now()-(60-i)*864e5).toISOString()});
      var l=payout_listMine({},trB).eligibility[0];
      util_assertEq_(l.payout_number,4,'#4');util_assertEq_(l.split_pct,80,'80%');util_assertEq_(l.payable_usd,8000,'80% of 10000');util_assertEq_(l.max_usd,2000,'cap still binds');
    });
    t('below minimum profit',function(){
      funded('C-T3','U-C',11000);kycOk('U-C','Ada Grace Obi');
      var l=payout_listMine({},{user:{user_id:'U-C'},role:'trader'}).eligibility[0];
      util_assertEq_(l.can_request,false,'blocked');util_assert_(/minimum payout/.test(l.reason),'reason: '+l.reason);
      util_assertEq_(l.max_usd,700,'70% of 1000');
    });
    t('non-funded and breached refused',function(){
      user('U-D');funded('C-T4','U-D',12000,'Phase 2','Active');
      fails(function(){payout_request({challenge_id:'C-T4'},{user:{user_id:'U-D'},role:'trader'});},'funded');
      util_assertEq_(payout_listMine({},{user:{user_id:'U-D'},role:'trader'}).eligibility.length,0,'no funded challenge listed');
    });
    t('payouts switch',function(){
      admin_settingsSet({changes:{payout_enabled:false}},owner);
      fails(function(){payout_request({challenge_id:'C-T1'},trA);},'paused');
      admin_settingsSet({changes:{payout_enabled:true}},owner);
    });
    t('approver setting',function(){
      var r=payout_request({challenge_id:'C-T1',amount_usd:1000},trA);
      admin_settingsSet({changes:{payout_approver_role:'admin'}},owner);
      util_assertEq_(payout_adminApprove({payout_id:r.payout.payout_id},adm).payout.status,'Approved','admin allowed when setting says so');
      admin_settingsSet({changes:{payout_approver_role:'owner'}},owner);
      fails(function(){payout_adminMarkPaid({payout_id:r.payout.payout_id,reference:'REF777'},adm);},'owner');
    });
    t('admin list',function(){
      var l=payout_adminList({},adm);util_assert_(l.payouts.length>=3,'rows');util_assert_(l.counts.Paid>=4,'counts');
      util_assert_(l.payouts[0].bank_account_number!==undefined,'admin sees bank details');
      fails(function(){payout_adminList({},trA);},'access');
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 14 TESTS PASSED');
}

// ===== PART 15: AFFILIATE SYSTEM =====
// One row per affiliate (Affiliates) and one ledger (AffiliateTransactions). Link: ravenprop.cfd/?ref=CODE.
// One level only: a commission is paid to the code on the buyer's order, never to the affiliate's own recruits.
//
// LEDGER (AffiliateTransactions.type):
//   commission  pending -> available -> withdrawn, or cancelled (refund, dispute, blocked)
//   adjustment  admin credit or debit, and refund clawbacks that arrive after payment (status available -> withdrawn)
//   withdrawal  requested -> approved -> paid, or rejected
//
// MONEY MEANING (each piece lives in one small function so it is easy to change):
//   commission base  = the fee the buyer actually paid, after any promo   -> aff_commissionBase_
//   commission rate  = the affiliate's own rate_pct, else the tier for their sales count (Settings.aff_tiers),
//                      else Settings.aff_commission_pct. The rate used is stored on the row, so later changes never rewrite history.
//   hold             = a commission is Pending from payment confirmation until Settings.aff_hold_days pass. Then it becomes
//                      Available, unless the order was refunded, the affiliate is suspended, frozen or flagged, or a
//                      self-referral is found (the buyer's KYC often does not exist at purchase time, so it is checked again here).
//   balance          = sum of Available commissions and adjustments. A refund clawback after payout is a debit, so it can go negative.
//   withdrawal       = takes the WHOLE available balance (the browser never sends an amount). Its rows are locked to it
//                      (status withdrawn, reference = the withdrawal id), so nothing can be paid twice. Rejecting it unlocks them.
//                      Bank details always come from the affiliate's KYC row, like trader payouts.
//   USD is the source of truth. Each row stores the currency, rate and local amount used at the time.
//
// Hooks (called by Part 11, never able to block a payment): aff_onPaymentConfirmed, aff_onPaymentRefunded.
// Hook from sign-up (Code.gs): aff_onSignup. Schedule aff_maintenance daily (Part 18 attaches the trigger).
// Everything is safe to repeat: one commission per order, one clawback per commission.
var AFF_SYS_={system:'affiliate'};
var AFF_WD_OPEN_=['requested','approved'];
var AFF_WD_MOVES_={requested:['approved','rejected'],approved:['paid','rejected']};

function aff_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function aff_num_(k,d){var v=Number(settings_get(k,d));return isFinite(v)?v:d;}
function aff_bool_(k,d){var v=settings_get(k,d);return v===true||String(v).toLowerCase()==='true';}
function aff_code_(v){return String(v==null?'':v).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);}
function aff_get_(id){
  var a=typeof id==='string'&&id?sheet_getByKey('Affiliates',id):null;
  if(!a)throw aff_bad_('Affiliate not found.');
  return a;
}
function aff_byCode_(code){var c=aff_code_(code);return c?sheet_findOne('Affiliates',{code:c}):null;}
function aff_byUser_(uid){return uid?sheet_findOne('Affiliates',{user_id:uid}):null;}
function aff_newCode_(){
  var taken={};
  sheet_readAll('Affiliates').forEach(function(a){taken[a.code]=true;});
  return util_unique_(function(){return util_randomCode_(8);},function(c){return taken[c]===true;});
}
function aff_link_(code){
  return String(settings_get('site_url','https://ravenprop.cfd')||'https://ravenprop.cfd').replace(/\/+$/,'')+'/?ref='+code;
}

// ---- Money rules ----
function aff_commissionBase_(o){return Number(o.amount_usd)||0;}
function aff_tiers_(){
  var t=settings_get('aff_tiers',[]);
  if(!Array.isArray(t))return [];
  return t.map(function(x){return {min:Number(x&&x.min_sales),pct:Number(x&&x.pct)};})
    .filter(function(x){return isFinite(x.min)&&x.min>=1&&isFinite(x.pct)&&x.pct>=0&&x.pct<=100;})
    .sort(function(a,b){return a.min-b.min;});
}
// sales = this sale's position among the affiliate's non-cancelled commissions (the first sale is 1)
function aff_rateFor_(aff,sales){
  var own=aff.rate_pct;
  if(own!==null&&own!==undefined&&isFinite(Number(own))&&Number(own)>=0)return Number(own);
  var rate=aff_num_('aff_commission_pct',10);
  aff_tiers_().forEach(function(t){if(sales>=t.min)rate=t.pct;});
  return rate;
}
function aff_cents_(rows,pick){var c=0;rows.forEach(function(r){if(pick(r))c+=util_toCents_(r.amount_usd);});return c;}

// ---- Self-referral checks ----
function aff_emailKey_(e){
  var n=util_normalizeEmail_(e);if(!n)return '';
  var p=n.split('@'),l=p[0].split('+')[0],d=p[1];
  if(d==='gmail.com'||d==='googlemail.com'){l=l.replace(/\./g,'');d='gmail.com';}
  return l+'@'+d;
}
function aff_phoneKey_(p){var d=String(p||'').replace(/\D/g,'');return d.length>=7?d.slice(-10):'';}
function aff_bankKey_(k){
  var n=String(k&&k.bank_account_number||'').replace(/\s/g,'').toLowerCase();
  return n?n+'|'+String(k.bank_name||'').trim().toLowerCase():'';
}
// Returns why the buyer looks like the affiliate, or ''. IP is the address the browser reported at sign-up
// (Apps Script cannot see it itself). Shared mobile networks can repeat an IP, so Settings.aff_block_same_ip turns that check off.
function aff_selfReferral_(aff,o){
  var a=sheet_getByKey('Users',aff.user_id),b=sheet_getByKey('Users',o.user_id);
  if(!a||!b)return '';
  if(a.user_id===b.user_id)return 'same account';
  var ea=aff_emailKey_(a.email);
  if(ea&&(ea===aff_emailKey_(b.email)||ea===aff_emailKey_(o.billing_email)))return 'same email';
  var pa=aff_phoneKey_(a.phone);
  if(pa&&(pa===aff_phoneKey_(b.phone)||pa===aff_phoneKey_(o.billing_phone)))return 'same phone';
  var ka=sheet_findOne('KYC',{user_id:a.user_id}),kb=sheet_findOne('KYC',{user_id:b.user_id});
  if(ka&&kb){
    var ba=aff_bankKey_(ka);
    if(ba&&ba===aff_bankKey_(kb))return 'same bank account';
    if(kyc_namesMatch_(ka.id_name,kb.id_name))return 'same person (ID name)';
  }
  if(aff_bool_('aff_block_same_ip',true)&&a.signup_ip&&a.signup_ip===b.signup_ip)return 'same IP address';
  return '';
}

// ---- Commission created when a payment is confirmed ----
// Exactly one row per order (pending, or cancelled with a "blocked:" reason so admins can see it). Runs in the lock.
function aff_record_(ref){
  return util_withLock_(function(){
    var o=pay_get_(ref);
    if(o.status!=='confirmed'&&o.status!=='challenge_created')return {created:false,skipped:'payment is not confirmed'};
    var code=aff_code_(o.ref_code);
    if(!code)return {created:false,skipped:'no referral code'};
    var ex=sheet_findOne('AffiliateTransactions',{order_ref:ref,type:'commission'});
    if(ex)return {created:false,already:true,txn_id:ex.txn_id};
    var aff=aff_byCode_(code);
    if(!aff)return {created:false,skipped:'unknown referral code'};
    var rows=sheet_findRows('AffiliateTransactions',{affiliate_id:aff.affiliate_id});
    var live=rows.filter(function(r){return r.type==='commission'&&r.status!=='cancelled';});
    var base=aff_commissionBase_(o),rate=aff_rateFor_(aff,live.length+1),amount=util_pctOf_(base,rate),block='',fraud=false;
    if(aff.status!=='active')block='affiliate is not active';
    else if(!(amount>0))block='no commission due on this order';
    else{
      var why=aff_selfReferral_(aff,o);
      if(why){block='self-referral ('+why+')';fraud=true;}
      else if(settings_get('aff_commission_mode','every_purchase')==='first_purchase'&&live.some(function(r){return r.referred_user_id===o.user_id;}))
        block='not the first purchase';
    }
    var fx=payout_rate_(aff.user_id),now=util_nowIso_(),at=util_parseTime_(o.confirmed_at)||new Date();
    var due=new Date(at.getTime()+Math.max(0,aff_num_('aff_hold_days',7))*864e5).toISOString();
    var row=sheet_appendRow('AffiliateTransactions',{txn_id:sheet_newKey_('AffiliateTransactions'),affiliate_id:aff.affiliate_id,
      type:'commission',status:block?'cancelled':'pending',referred_user_id:o.user_id,order_ref:ref,fee_usd:base,rate_pct:rate,
      amount_usd:amount,currency:fx.currency,rate_used:fx.rate,local_amount:util_round_(amount*fx.rate),
      available_at:block?'':due,reason:block?'blocked: '+block:'',created_by:'system',created_at:now,updated_at:now});
    if(fraud)settings_audit_(AFF_SYS_,'affiliate.blocked','AffiliateTransactions',row.txn_id,'reason','',block,'order '+ref);
    return {created:!block,blocked:block||undefined,txn_id:row.txn_id};
  });
}
// Called by pay_confirm. A failure here must never undo or block a confirmed payment; aff_maintenance repairs it.
function aff_onPaymentConfirmed(ref){
  try{return aff_record_(ref);}
  catch(e){console.error('aff_onPaymentConfirmed '+ref+': '+(e&&e.message||e));return {created:false,error:true};}
}

// ---- Clawback: refund or dispute ----
function aff_cancel_(row,why){return sheet_updateRow('AffiliateTransactions',row,{status:'cancelled',reason:why,updated_at:util_nowIso_()});}
function aff_wdRows_(id){
  return sheet_findRows('AffiliateTransactions',function(r){return r.reference===id&&r.status==='withdrawn'&&(r.type==='commission'||r.type==='adjustment');});
}
function aff_unlock_(rows){
  if(!rows.length)return;
  var now=util_nowIso_();
  sheet_updateRows('AffiliateTransactions',rows.map(function(r){return {target:r,changes:{status:'available',reference:'',updated_at:now}};}));
}
// After a locked row changed, keep an open withdrawal equal to what is still locked to it. Nothing left: reject it.
function aff_wdRecalc_(id,ctx){
  var wd=sheet_getByKey('AffiliateTransactions',id);
  if(!wd||wd.type!=='withdrawal'||AFF_WD_OPEN_.indexOf(wd.status)<0)return wd;
  var rows=aff_wdRows_(id),total=util_fromCents_(aff_cents_(rows,function(){return true;})),now=util_nowIso_();
  if(!(total>0)){
    aff_unlock_(rows);
    var r=sheet_updateRow('AffiliateTransactions',wd,{status:'rejected',reason:'Balance changed because an order was refunded.',reviewed_at:now,updated_at:now});
    settings_audit_(ctx||AFF_SYS_,'affiliate.withdrawal.auto_reject','AffiliateTransactions',id,'status',wd.status,'rejected','order refunded');
    return r;
  }
  if(util_toCents_(total)===util_toCents_(wd.amount_usd))return wd;
  var u=sheet_updateRow('AffiliateTransactions',wd,{amount_usd:total,local_amount:util_round_(total*Number(wd.rate_used||1)),updated_at:now});
  settings_audit_(ctx||AFF_SYS_,'affiliate.withdrawal.reduce','AffiliateTransactions',id,'amount_usd',wd.amount_usd,total,'order refunded');
  return u;
}
// pending or available -> cancelled. Locked in an open withdrawal -> cancelled and that withdrawal shrinks.
// Already paid out -> a debit adjustment (one per commission), which future earnings pay back.
function aff_clawback_(ref,reason,ctx){
  return util_withLock_(function(){
    var why='clawback: '+String(reason||'order reversed').slice(0,200),out={cancelled:0,debited:0,recalculated:0};
    sheet_findRows('AffiliateTransactions',{order_ref:ref,type:'commission'}).forEach(function(r){
      if(r.status==='pending'||r.status==='available'){aff_cancel_(r,why);out.cancelled++;return;}
      if(r.status!=='withdrawn')return;
      var wd=r.reference?sheet_getByKey('AffiliateTransactions',r.reference):null;
      if(wd&&wd.type==='withdrawal'&&wd.status==='paid'){
        var key='clawback:'+r.txn_id;
        if(sheet_findOne('AffiliateTransactions',{type:'adjustment',reference:key}))return;
        var now=util_nowIso_();
        sheet_appendRow('AffiliateTransactions',{txn_id:sheet_newKey_('AffiliateTransactions'),affiliate_id:r.affiliate_id,type:'adjustment',
          status:'available',order_ref:ref,amount_usd:-r.amount_usd,currency:r.currency,rate_used:r.rate_used,local_amount:-(Number(r.local_amount)||0),
          reason:why,reference:key,created_by:pay_actor_(ctx),created_at:now,updated_at:now});
        out.debited++;return;
      }
      aff_cancel_(r,why);out.cancelled++;
      if(wd&&AFF_WD_OPEN_.indexOf(wd.status)>=0){aff_wdRecalc_(wd.txn_id,ctx);out.recalculated++;}
    });
    if(out.cancelled+out.debited+out.recalculated>0)
      settings_audit_(ctx&&ctx.user?ctx:AFF_SYS_,'affiliate.clawback','Payments',ref,'commission','',JSON.stringify(out),why);
    return out;
  });
}
function aff_onPaymentRefunded(ref,reason,ctx){
  try{return aff_clawback_(ref,reason||'order refunded',ctx);}
  catch(e){console.error('aff_onPaymentRefunded '+ref+': '+(e&&e.message||e));return {error:true};}
}

// ---- Hold release (Pending -> Available) ----
// affId limits it to one affiliate (used lazily when they open their dashboard or withdraw).
function aff_release_(affId){
  return util_withLock_(function(){
    var out={released:0,cancelled:0,skipped:0},nowMs=Date.now(),now=util_nowIso_(),affs={},changes=[];
    sheet_readAll('Affiliates').forEach(function(a){affs[a.affiliate_id]=a;});
    var due=sheet_findRows('AffiliateTransactions',function(r){
      return r.type==='commission'&&r.status==='pending'&&(!affId||r.affiliate_id===affId)&&Date.parse(r.available_at)<=nowMs;
    });
    due.forEach(function(r){
      var a=affs[r.affiliate_id],o=sheet_getByKey('Payments',r.order_ref);
      if(o&&o.status==='refunded'){changes.push({target:r,changes:{status:'cancelled',reason:'clawback: order refunded',updated_at:now}});out.cancelled++;return;}
      if(!o||(o.status!=='confirmed'&&o.status!=='challenge_created')||!a||a.status!=='active'||a.frozen||a.flagged){out.skipped++;return;}
      var why=aff_selfReferral_(a,o);
      if(why){
        changes.push({target:r,changes:{status:'cancelled',reason:'blocked: self-referral ('+why+')',updated_at:now}});out.cancelled++;
        settings_audit_(AFF_SYS_,'affiliate.blocked','AffiliateTransactions',r.txn_id,'reason','','self-referral ('+why+')','found at release, order '+r.order_ref);
        return;
      }
      changes.push({target:r,changes:{status:'available',updated_at:now}});out.released++;
    });
    if(changes.length)sheet_updateRows('AffiliateTransactions',changes);
    return out;
  });
}
function aff_releaseHeld(){return aff_release_(null);}

// ---- Sign-up, clicks and bursts ----
// Called from boot_signup after the user row exists. Only counts; the commission checks happen at purchase.
function aff_onSignup(user){
  try{
    var a=aff_byCode_(user&&user.ref_used);
    if(!a||a.status!=='active')return;
    util_withLock_(function(){
      var f=sheet_getByKey('Affiliates',a.affiliate_id);
      if(f)sheet_updateRow('Affiliates',f,{signups:(f.signups||0)+1,updated_at:util_nowIso_()});
    });
  }catch(e){console.error('aff_onSignup: '+(e&&e.message||e));}
}
// Public. Counts one click per visitor per code every 6 hours (the visitor id is a random string the browser makes up,
// so this is a vanity number, never money). Returns only whether the code is valid: no affiliate details.
function aff_track(p,ctx){
  p=p||{};
  var a=aff_byCode_(p.code);
  if(!a||a.status!=='active')return {valid:false};
  var v=String(p.visitor||'');
  if(!/^[A-Za-z0-9_-]{8,64}$/.test(v))return {valid:true,counted:false};
  try{
    var c=CacheService.getScriptCache(),key='affclk_'+a.code+'_'+util_hex_(util_sha256_(util_utf8Bytes_(v))).slice(0,24);
    if(c.get(key))return {valid:true,counted:false};
    c.put(key,'1',21600);
  }catch(e){return {valid:true,counted:false};}
  util_withLock_(function(){
    var f=sheet_getByKey('Affiliates',a.affiliate_id);
    if(f)sheet_updateRow('Affiliates',f,{clicks:(f.clicks||0)+1,updated_at:util_nowIso_()});
  });
  return {valid:true,counted:true};
}
// Flags an active affiliate when many people signed up on their code in the window and none of them bought.
// A flagged affiliate keeps earning Pending commissions but nothing is released until an admin clears the flag.
function aff_flagBursts(){
  var hours=Math.max(1,aff_num_('aff_burst_window_hours',24)),limit=Math.max(1,aff_num_('aff_burst_threshold',10)),since=Date.now()-hours*36e5;
  var paid={},count={},changes=[],now=util_nowIso_();
  sheet_readAll('Payments').forEach(function(o){if(o.status==='confirmed'||o.status==='challenge_created')paid[o.user_id]=true;});
  sheet_readAll('Users').forEach(function(u){
    var c=aff_code_(u.ref_used);
    if(c&&!paid[u.user_id]&&Date.parse(u.created_at)>=since)count[c]=(count[c]||0)+1;
  });
  sheet_readAll('Affiliates').forEach(function(a){
    var n=count[a.code]||0;
    if(a.status==='active'&&!a.flagged&&n>=limit)
      changes.push({target:a,changes:{flagged:true,flag_reason:n+' sign-ups in '+hours+'h with no purchase',updated_at:now}});
  });
  if(changes.length){
    sheet_updateRows('Affiliates',changes);
    changes.forEach(function(c){settings_audit_(AFF_SYS_,'affiliate.flag','Affiliates',c.target.affiliate_id,'flagged','',c.changes.flag_reason);});
  }
  return changes.length;
}

// ---- Repair and schedule ----
// Fixes what a failed hook or a stopped script could leave behind. Safe to run any time and as often as needed.
function aff_reconcile_(){
  return util_withLock_(function(){
    var out={created:0,clawed:0,unlocked:0},rows=sheet_readAll('AffiliateTransactions'),have={},live={},wds={},clawed={};
    rows.forEach(function(r){
      if(r.type==='commission'){
        have[r.order_ref]=true;
        if(r.status==='pending'||r.status==='available'||r.status==='withdrawn')(live[r.order_ref]=live[r.order_ref]||[]).push(r);
      }
      if(r.type==='withdrawal')wds[r.txn_id]=r;
      if(r.type==='adjustment'&&r.reference)clawed[r.reference]=true;
    });
    sheet_readAll('Payments').forEach(function(o){
      if(!o.ref_code)return;
      if((o.status==='confirmed'||o.status==='challenge_created')&&!have[o.order_ref]){
        var r=aff_onPaymentConfirmed(o.order_ref);if(r&&r.created)out.created++;
      }
      if(o.status==='refunded'&&(live[o.order_ref]||[]).some(function(c){return c.status!=='withdrawn'||!clawed['clawback:'+c.txn_id];})){
        var c=aff_onPaymentRefunded(o.order_ref,'order refunded',AFF_SYS_);if(c&&(c.cancelled||c.debited||c.recalculated))out.clawed++;
      }
    });
    // a row locked to a withdrawal that does not exist (or was rejected) is set free again
    var stuck=sheet_findRows('AffiliateTransactions',function(r){
      return r.status==='withdrawn'&&(r.type==='commission'||r.type==='adjustment')&&r.reference&&r.reference.indexOf('clawback:')!==0
        &&(!wds[r.reference]||wds[r.reference].type!=='withdrawal'||wds[r.reference].status==='rejected');
    });
    aff_unlock_(stuck);out.unlocked=stuck.length;
    return out;
  });
}
// The one function to schedule (daily is plenty; dashboards also release lazily).
function aff_maintenance(){
  var out={};
  out.reconcile=aff_reconcile_();
  out.release=aff_releaseHeld();
  out.flagged=aff_flagBursts();
  return out;
}

// ---- Affiliate (browser) endpoints ----
function aff_program_(){
  return {rate_pct:aff_num_('aff_commission_pct',10),mode:settings_get('aff_commission_mode','every_purchase'),
    min_withdrawal_usd:aff_num_('aff_min_withdrawal_usd',10),hold_days:aff_num_('aff_hold_days',7),cookie_days:aff_num_('aff_cookie_days',30),
    approval_required:aff_bool_('aff_withdrawal_approval_required',true)};
}
function aff_join(p,ctx){
  payout_needUser_(ctx);
  return util_withLock_(function(){
    var uid=ctx.user.user_id,u=sheet_getByKey('Users',uid);
    if(!u||u.status!=='active')throw util_error_(CODES.FORBIDDEN,'Your account cannot join the affiliate program right now.');
    var ex=aff_byUser_(uid);
    if(ex)return aff_getMine({},ctx);
    var now=util_nowIso_(),auto=aff_bool_('aff_auto_approve',false),id=sheet_newKey_('Affiliates');
    var row=sheet_appendRow('Affiliates',{affiliate_id:id,user_id:uid,code:aff_newCode_(),status:auto?'active':'pending',clicks:0,signups:0,
      frozen:false,flagged:false,created_at:now,updated_at:now});
    settings_audit_(ctx,'affiliate.join','Affiliates',id,'status','',row.status);
    return aff_getMine({},ctx);
  });
}
function aff_wdPub_(r){
  return {txn_id:r.txn_id,status:r.status,amount_usd:r.amount_usd,currency:r.currency,rate_used:r.rate_used,local_amount:r.local_amount,
    bank_name:r.bank_name,bank_account_masked:payout_mask_(r.bank_account_number),
    reason:r.status==='rejected'?r.reason:'',reference:r.status==='paid'?r.reference:'',created_at:r.created_at,paid_at:r.paid_at};
}
function aff_ledgerPub_(r){
  var refunded=r.reason&&r.reason.indexOf('clawback:')===0;
  return {txn_id:r.txn_id,type:r.type,status:r.status,referral:r.type==='commission'?payout_anon_(r.referred_user_id):'',fee_usd:r.fee_usd,rate_pct:r.rate_pct,
    amount_usd:r.amount_usd,currency:r.currency,rate_used:r.rate_used,local_amount:r.local_amount,
    available_at:r.status==='pending'?r.available_at:'',
    note:refunded?'Order refunded':(r.type==='adjustment'?String(r.reason||''):''),created_at:r.created_at};
}
// local amounts use the rate stored on each row; a row in another currency is shown at today's rate
function aff_localCents_(rows,pick,cur,rate){
  var c=0;
  rows.forEach(function(r){
    if(!pick(r))return;
    c+=util_toCents_(r.currency===cur?(Number(r.local_amount)||0):Number(r.amount_usd)*rate);
  });
  return c;
}
function aff_balances_(rows,cur,rate){
  var isC=function(r){return r.type==='commission';},isBal=function(r){return (r.type==='commission'||r.type==='adjustment')&&r.status==='available';};
  var defs={
    pending:function(r){return isC(r)&&r.status==='pending';},
    available:isBal,
    in_withdrawal:function(r){return r.type==='withdrawal'&&AFF_WD_OPEN_.indexOf(r.status)>=0;},
    paid_out:function(r){return r.type==='withdrawal'&&r.status==='paid';},
    lifetime:function(r){return isC(r)&&r.status!=='cancelled';}
  },usd={},local={currency:cur};
  Object.keys(defs).forEach(function(k){
    usd[k]=util_fromCents_(aff_cents_(rows,defs[k]));
    local[k]=util_fromCents_(aff_localCents_(rows,defs[k],cur,rate));
  });
  return {usd:usd,local:local};
}
function aff_withdrawBlock_(a,rows,bal,uid){
  if(a.status!=='active')return 'Your affiliate account is not active.';
  if(a.frozen)return 'Withdrawals are on hold for your account. Please contact support.';
  if(rows.some(function(r){return r.type==='withdrawal'&&AFF_WD_OPEN_.indexOf(r.status)>=0;}))return 'You already have a withdrawal in progress.';
  var min=Math.max(0.01,aff_num_('aff_min_withdrawal_usd',10));
  if(util_toCents_(bal.usd.available)<util_toCents_(min))return 'The minimum withdrawal is '+util_formatUsd_(min)+'.';
  var kp=payout_kycProblem_(uid);
  if(kp.reason)return kp.reason;
  return '';
}
function aff_getMine(p,ctx){
  payout_needUser_(ctx);
  var uid=ctx.user.user_id,a=aff_byUser_(uid),program=aff_program_();
  if(!a)return {affiliate:null,can_apply:true,program:program};
  if(a.status==='pending'||a.status==='rejected')return {affiliate:{status:a.status,code:null,link:null},can_apply:false,program:program};
  try{aff_release_(a.affiliate_id);}catch(e){console.error('aff_getMine release: '+(e&&e.message||e));}
  var rows=sheet_findRows('AffiliateTransactions',{affiliate_id:a.affiliate_id}),fx=payout_rate_(uid),bal=aff_balances_(rows,fx.currency,fx.rate);
  var purchases=rows.filter(function(r){return r.type==='commission'&&r.status!=='cancelled';}).length;
  var users=sheet_findRows('Users',{ref_used:a.code}),ids={};
  users.forEach(function(u){ids[u.user_id]=u;});
  rows.forEach(function(r){if(r.type==='commission'&&r.referred_user_id&&!ids[r.referred_user_id])ids[r.referred_user_id]={user_id:r.referred_user_id,created_at:r.created_at};});
  var state={};
  sheet_findRows('Payments',function(o){return !!ids[o.user_id];}).forEach(function(o){
    if(o.status==='confirmed'||o.status==='challenge_created')state[o.user_id]='Purchased';
    else if((o.status==='awaiting_payment'||o.status==='awaiting_confirmation'||o.status==='verified')&&state[o.user_id]!=='Purchased')state[o.user_id]='Pending';
  });
  var refs=Object.keys(ids).map(function(k){return {referral:payout_anon_(k),status:state[k]||'Signed up',at:ids[k].created_at};})
    .sort(function(x,y){return String(y.at).localeCompare(String(x.at));}).slice(0,50);
  var ledger=rows.filter(function(r){
    if(r.type==='withdrawal')return false;
    return !(r.status==='cancelled'&&String(r.reason||'').indexOf('blocked:')===0); // policy blocks are not shown to the affiliate
  }).sort(function(x,y){return String(y.created_at).localeCompare(String(x.created_at));}).slice(0,100).map(aff_ledgerPub_);
  var wds=rows.filter(function(r){return r.type==='withdrawal';}).sort(function(x,y){return String(y.created_at).localeCompare(String(x.created_at));}).map(aff_wdPub_);
  var block=aff_withdrawBlock_(a,rows,bal,uid);
  return {affiliate:{status:a.status,code:a.code,link:aff_link_(a.code),frozen:!!a.frozen,rate_pct:aff_rateFor_(a,purchases+1),
      clicks:a.clicks||0,signups:a.signups||0,purchases:purchases},
    balances:bal,program:program,referrals:refs,ledger:ledger,withdrawals:wds,can_withdraw:!block,withdraw_note:block};
}
// The browser sends no amount: the withdrawal is the whole available balance, locked to the new withdrawal row.
function aff_requestWithdrawal(p,ctx){
  payout_needUser_(ctx);
  return util_withLock_(function(){
    var uid=ctx.user.user_id,a=aff_byUser_(uid);
    if(!a)throw aff_bad_('Join the affiliate program first.');
    aff_release_(a.affiliate_id);
    var all=sheet_findRows('AffiliateTransactions',{affiliate_id:a.affiliate_id}),fx=payout_rate_(uid),bal=aff_balances_(all,fx.currency,fx.rate);
    var block=aff_withdrawBlock_(a,all,bal,uid);
    if(block)throw aff_bad_(block);
    var rows=all.filter(function(r){return (r.type==='commission'||r.type==='adjustment')&&r.status==='available';});
    var total=util_fromCents_(aff_cents_(rows,function(){return true;})),id=sheet_newKey_('AffiliateTransactions'),now=util_nowIso_();
    var k=sheet_findOne('KYC',{user_id:uid});
    // lock the rows first: if anything stops after this, the money is held back (aff_reconcile_ frees it), never paid twice
    sheet_updateRows('AffiliateTransactions',rows.map(function(r){return {target:r,changes:{status:'withdrawn',reference:id,updated_at:now}};}));
    var row=sheet_appendRow('AffiliateTransactions',{txn_id:id,affiliate_id:a.affiliate_id,type:'withdrawal',
      status:aff_bool_('aff_withdrawal_approval_required',true)?'requested':'approved',
      amount_usd:total,currency:fx.currency,rate_used:fx.rate,local_amount:util_round_(total*fx.rate),
      bank_name:k.bank_name,bank_account_name:k.bank_account_name,bank_account_number:k.bank_account_number,
      created_by:'user:'+uid,created_at:now,updated_at:now});
    settings_audit_(ctx,'affiliate.withdrawal.request','AffiliateTransactions',id,'amount_usd','',total);
    return {withdrawal:aff_wdPub_(row)};
  });
}

// ---- Admin endpoints ----
function aff_balanceUsd_(rows){
  return {pending_usd:util_fromCents_(aff_cents_(rows,function(r){return r.type==='commission'&&r.status==='pending';})),
    available_usd:util_fromCents_(aff_cents_(rows,function(r){return (r.type==='commission'||r.type==='adjustment')&&r.status==='available';})),
    paid_out_usd:util_fromCents_(aff_cents_(rows,function(r){return r.type==='withdrawal'&&r.status==='paid';}))};
}
function aff_adminOut_(a,users,rows){
  var u=users[a.user_id]||{},mine=rows||[],purchases=mine.filter(function(r){return r.type==='commission'&&r.status!=='cancelled';}).length;
  return Object.assign({affiliate_id:a.affiliate_id,user_id:a.user_id,email:u.email||'',full_name:u.full_name||'',code:a.code,status:a.status,
    rate_pct:a.rate_pct,effective_rate_pct:aff_rateFor_(a,purchases+1),clicks:a.clicks||0,signups:a.signups||0,purchases:purchases,
    frozen:!!a.frozen,flagged:!!a.flagged,flag_reason:a.flag_reason||'',suspend_reason:a.suspend_reason||'',created_at:a.created_at},aff_balanceUsd_(mine));
}
function aff_adminList(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var users={},kycs={},byAff={},counts={};
  sheet_readAll('Users').forEach(function(u){users[u.user_id]=u;});
  sheet_readAll('KYC').forEach(function(k){kycs[k.user_id]=k;});
  var txns=sheet_readAll('AffiliateTransactions');
  txns.forEach(function(r){(byAff[r.affiliate_id]=byAff[r.affiliate_id]||[]).push(r);});
  var affs=sheet_readAll('Affiliates');
  affs.forEach(function(a){counts[a.status]=(counts[a.status]||0)+1;});
  var out={counts:counts,flagged:affs.filter(function(a){return a.flagged;}).length,program:aff_program_()};
  if(p.affiliate_id){
    var a=aff_get_(String(p.affiliate_id));
    out.affiliate=aff_adminOut_(a,users,byAff[a.affiliate_id]);
    out.transactions=(byAff[a.affiliate_id]||[]).slice().sort(function(x,y){return String(y.created_at).localeCompare(String(x.created_at));}).slice(0,300);
    return out;
  }
  var list=affs;
  if(p.status){
    if(['pending','active','suspended','rejected'].indexOf(p.status)<0)throw aff_bad_('Unknown status.');
    list=list.filter(function(a){return a.status===p.status;});
  }
  if(p.flagged)list=list.filter(function(a){return a.flagged;});
  list=list.slice().sort(function(x,y){return String(y.created_at).localeCompare(String(x.created_at));});
  out.affiliates=list.slice(0,200).map(function(a){return aff_adminOut_(a,users,byAff[a.affiliate_id]);});
  var open=txns.filter(function(r){return r.type==='withdrawal'&&AFF_WD_OPEN_.indexOf(r.status)>=0;})
    .sort(function(x,y){return String(x.created_at).localeCompare(String(y.created_at));});
  var affById={};affs.forEach(function(a){affById[a.affiliate_id]=a;});
  out.open_withdrawals=open.map(function(r){
    var a=affById[r.affiliate_id]||{},u=users[a.user_id]||{},k=kycs[a.user_id]||{},locked=util_fromCents_(aff_cents_(aff_wdRows_(r.txn_id),function(){return true;}));
    return Object.assign({},r,{email:u.email||'',full_name:u.full_name||'',code:a.code||'',frozen:!!a.frozen,kyc_status:k.status||'',
      ledger_matches:util_toCents_(locked)===util_toCents_(r.amount_usd)});
  });
  return out;
}
// decision: approve | reject | suspend | reinstate | freeze | unfreeze | clear_flag | set_rate (owner only)
function aff_adminUpdate(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var d=String(p.decision||'');
  if(d==='set_rate')payout_requireApprover_(ctx);
  return util_withLock_(function(){
    var a=aff_get_(String(p.affiliate_id||'')),now=util_nowIso_(),ch={updated_at:now},note='';
    function need(from,msg){if(from.indexOf(a.status)<0)throw aff_bad_(msg);}
    switch(d){
      case 'approve':need(['pending','rejected'],'Only a pending or rejected application can be approved.');ch.status='active';ch.suspend_reason='';break;
      case 'reject':need(['pending'],'Only a pending application can be rejected.');note=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');ch.status='rejected';ch.suspend_reason=note;break;
      case 'suspend':need(['active'],'Only an active affiliate can be suspended.');note=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');ch.status='suspended';ch.frozen=true;ch.suspend_reason=note;break;
      case 'reinstate':need(['suspended'],'Only a suspended affiliate can be reinstated.');ch.status='active';ch.frozen=false;ch.suspend_reason='';break;
      case 'freeze':ch.frozen=true;note=p.reason?pay_text_(p.reason,3,300,'The reason must be 3 to 300 characters.'):'';break;
      case 'unfreeze':ch.frozen=false;break;
      case 'clear_flag':ch.flagged=false;ch.flag_reason='';break;
      case 'set_rate':
        if(p.rate_pct===null||p.rate_pct===''||p.rate_pct===undefined){ch.rate_pct='';note='default rate';}
        else{
          var r=typeof p.rate_pct==='number'?p.rate_pct:(typeof p.rate_pct==='string'&&/^\d+(\.\d+)?$/.test(p.rate_pct.trim())?Number(p.rate_pct):NaN);
          if(!isFinite(r)||r<0||r>100)throw aff_bad_('The rate must be between 0 and 100.');
          ch.rate_pct=util_round_(r);note=String(ch.rate_pct);
        }
        break;
      default:throw aff_bad_('decision must be approve, reject, suspend, reinstate, freeze, unfreeze, clear_flag or set_rate.');
    }
    var row=sheet_updateRow('Affiliates',a,ch);
    settings_audit_(ctx,'affiliate.'+d,'Affiliates',a.affiliate_id,'status',a.status,row.status,note);
    var users={};users[row.user_id]=sheet_getByKey('Users',row.user_id);
    return {affiliate:aff_adminOut_(row,users,sheet_findRows('AffiliateTransactions',{affiliate_id:row.affiliate_id}))};
  });
}
// Approve, reject and mark paid follow the payout approver rule (owner by default), because money leaves.
// decision: approve | reject (reason) | paid (reference, optional paid_at)
function aff_adminWithdrawal(p,ctx){
  payout_requireApprover_(ctx);p=p||{};
  var to={approve:'approved',reject:'rejected',paid:'paid'}[String(p.decision||'')];
  if(!to)throw aff_bad_('decision must be approve, reject or paid.');
  var reason=to==='rejected'?pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).'):'';
  var ref=to==='paid'?pay_text_(p.reference,3,100,'Enter the transfer reference (3 to 100 characters).'):'';
  var paidAt=util_nowIso_();
  if(to==='paid'&&p.paid_at!==undefined&&p.paid_at!==null&&p.paid_at!==''){
    var dt=util_parseTime_(p.paid_at);
    if(!dt||dt.getTime()>Date.now()+3e5)throw aff_bad_('The paid date is not valid or is in the future.');
    paidAt=dt.toISOString();
  }
  return util_withLock_(function(){
    var wd=p.txn_id?sheet_getByKey('AffiliateTransactions',String(p.txn_id)):null;
    if(!wd||wd.type!=='withdrawal')throw aff_bad_('Withdrawal not found.');
    if((AFF_WD_MOVES_[wd.status]||[]).indexOf(to)<0)throw aff_bad_('A withdrawal that is "'+wd.status+'" cannot be moved to "'+to+'".');
    var a=aff_get_(wd.affiliate_id),locked=aff_wdRows_(wd.txn_id);
    if(to!=='rejected'){
      if(a.frozen)throw aff_bad_('This affiliate is frozen. Unfreeze first, or reject the withdrawal.');
      if(util_toCents_(util_fromCents_(aff_cents_(locked,function(){return true;})))!==util_toCents_(wd.amount_usd))
        throw aff_bad_('This withdrawal no longer matches the affiliate ledger. Reject it and ask the affiliate to request again.');
    }
    if(to==='approved'){
      var kp=payout_kycProblem_(a.user_id);
      if(kp.reason)throw aff_bad_('Cannot approve: '+kp.reason);
      if(kp.kyc&&(kp.kyc.bank_account_number!==wd.bank_account_number||kp.kyc.bank_name!==wd.bank_name))
        throw aff_bad_('The bank details changed after this request. Reject it and ask the affiliate to request again.');
    }
    var now=util_nowIso_(),ch={status:to,updated_at:now,reviewed_at:now,reviewed_by:ctx.user.user_id};
    if(to==='rejected'){ch.reason=reason;aff_unlock_(locked);}
    if(to==='paid'){ch.reference=ref;ch.paid_at=paidAt;}
    var row=sheet_updateRow('AffiliateTransactions',wd,ch);
    settings_audit_(ctx,'affiliate.withdrawal.'+p.decision,'AffiliateTransactions',wd.txn_id,'status',wd.status,to,reason||ref);
    return {withdrawal:Object.assign({},row)};
  });
}
// Manual credit (positive) or debit (negative). A reason is required and every adjustment is written to the AuditLog.
function aff_adminAdjust(p,ctx){
  payout_requireApprover_(ctx);p=p||{};
  var a=aff_get_(String(p.affiliate_id||''));
  var raw=typeof p.amount_usd==='string'?p.amount_usd.trim():p.amount_usd;
  var num=typeof raw==='number'?raw:(typeof raw==='string'&&/^-?\d+(\.\d+)?$/.test(raw)?Number(raw):NaN);
  if(!isFinite(num)||num===0)throw aff_bad_('Enter a credit (positive) or a debit (negative) amount.');
  var abs=util_parseAmount_(Math.abs(num),{min:0.01,max:100000});
  if(abs===null)throw aff_bad_('The amount must be between 0.01 and 100,000, with at most 2 decimals.');
  var amount=num<0?-abs:abs,why=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');
  return util_withLock_(function(){
    var fx=payout_rate_(a.user_id),now=util_nowIso_(),id=sheet_newKey_('AffiliateTransactions');
    var row=sheet_appendRow('AffiliateTransactions',{txn_id:id,affiliate_id:a.affiliate_id,type:'adjustment',status:'available',amount_usd:amount,
      currency:fx.currency,rate_used:fx.rate,local_amount:util_round_(amount*fx.rate),reason:why,created_by:ctx.user.user_id,created_at:now,updated_at:now});
    settings_audit_(ctx,'affiliate.adjust','AffiliateTransactions',id,'amount_usd','',amount,why);
    var rows=sheet_findRows('AffiliateTransactions',{affiliate_id:a.affiliate_id});
    return {adjustment:row,balance:aff_balanceUsd_(rows)};
  });
}
// A dispute or chargeback does not change the payment's status, so admins claw the commission back by order.
function aff_adminClawback(p,ctx){
  pay_requireAdmin_(ctx);p=p||{};
  var ref=pay_text_(p.order_ref,3,60,'Enter the order reference.');
  pay_get_(ref);
  var why=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');
  return aff_clawback_(ref,why,ctx);
}

// ---- Test: editor only, throwaway spreadsheet ----
function aff_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-AFFILIATE-TEST'),bad=[];
  var owner={user:{user_id:'U-OWN'},role:'owner'},adm={user:{user_id:'U-ADM'},role:'admin'};
  var trA={user:{user_id:'U-A'},role:'trader'},trB={user:{user_id:'U-B'},role:'trader'},trC={user:{user_id:'U-C'},role:'trader'};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,text){try{f();}catch(e){if(text&&String(e.message).indexOf(text)<0)throw new Error('wrong message: '+e.message);return;}throw new Error('should have failed');}
  function user(id,extra){sheet_appendRow('Users',Object.assign({user_id:id,email:id.toLowerCase()+'@t.com',phone:'',full_name:'',password_hash:'x',role:'trader',status:'active',country:'NG',created_at:util_nowIso_()},extra||{}));}
  var seq=0;
  function order(uid,code,extra){
    var ref='RV-T-'+(++seq);
    sheet_appendRow('Payments',Object.assign({order_ref:ref,user_id:uid,plan_id:'swift-10000',gateway:'manual',country:'NG',status:'awaiting_confirmation',
      list_fee_usd:100,amount_usd:100,currency:'USD',ref_code:code||'',created_at:util_nowIso_()},extra||{}));
    return ref;
  }
  function buy(uid,code,extra){var ref=order(uid,code,extra);pay_confirm(ref,adm);return ref;}
  function comm(ref){return sheet_findOne('AffiliateTransactions',{order_ref:ref,type:'commission'});}
  function due(ref){sheet_updateRow('AffiliateTransactions',comm(ref),{available_at:new Date(Date.now()-1000).toISOString()});}
  function setting(k,v){sheet_updateRow('Settings',k,{value:String(v)});settings_clear_();}
  function kyc(uid,acct,name,bank){
    sheet_appendRow('KYC',{kyc_id:sheet_newKey_('KYC'),user_id:uid,id_name:name||'Ada Grace Obi',bank_name:bank||'Test Bank',bank_account_name:'Obi Ada',
      bank_account_number:acct,status:'Verified',submitted_at:util_nowIso_()});
  }
  function bal(tr){return aff_getMine({},tr).balances.usd;}
  function audit(action){return sheet_findRows('AuditLog',{action:action}).length;}
  var A=null;
  try{
    sheet_buildAll_(ss);settings_clear_();
    user('U-A',{email:'u-a@t.com',phone:'+2348011111111',full_name:'Ada Obi'});
    user('U-B',{email:'bola@t.com',phone:'+2348022222222',full_name:'Bola Buyer'});
    user('U-C',{email:'chi@t.com',phone:'+2348033333333',full_name:'Chi Cee'});

    // ---- join, approval, clicks
    t('join and approve',function(){
      var r=aff_join({},trA);
      util_assertEq_(r.affiliate.status,'pending','pending until approved');util_assert_(r.affiliate.code===null&&r.affiliate.link===null,'no link before approval');
      var a=aff_byUser_('U-A');util_assert_(/^[0-9A-Z]{8}$/.test(a.code),'code shape');
      util_assertEq_(aff_join({},trA).affiliate.status,'pending','joining twice is harmless');util_assertEq_(sheet_readAll('Affiliates').length,1,'one row');
      util_assertEq_(aff_track({code:a.code,visitor:'visitor-abcdef12'},{}).valid,false,'pending code is not valid');
      fails(function(){aff_adminUpdate({affiliate_id:a.affiliate_id,decision:'approve'},trA);},'access');
      util_assertEq_(aff_adminUpdate({affiliate_id:a.affiliate_id,decision:'approve'},adm).affiliate.status,'active','approved');
      A=aff_byUser_('U-A');
      util_assertEq_(aff_getMine({},trA).affiliate.link,'https://ravenprop.cfd/?ref='+A.code,'link format');
      util_assertEq_(aff_getMine({},trB).can_apply,true,'non-affiliate can apply');
    });
    t('clicks',function(){
      var v='visitor-abcdef12';
      util_assertEq_(aff_track({code:A.code,visitor:v},{}).counted,true,'first click counted');
      util_assertEq_(aff_track({code:A.code,visitor:v},{}).counted,false,'same visitor not counted twice');
      util_assertEq_(aff_track({code:A.code.toLowerCase()+'-',visitor:'visitor-other-9999'},{}).counted,true,'code is cleaned');
      util_assertEq_(aff_track({code:A.code},{}).counted,false,'no visitor id, no count');
      var r=aff_track({code:'ZZZZZZZZ',visitor:v},{});util_assert_(r.valid===false&&Object.keys(r).join()==='valid','unknown code reveals nothing');
      util_assertEq_(aff_byUser_('U-A').clicks,2,'two clicks stored');
    });

    // ---- a referred purchase creates a Pending commission
    var o1;
    t('referred purchase -> pending commission',function(){
      sheet_updateRow('Users','U-B',{ref_used:A.code});aff_onSignup(sheet_getByKey('Users','U-B'));
      util_assertEq_(aff_byUser_('U-A').signups,1,'sign-up counted');
      o1=buy('U-B',A.code,{billing_email:'bola@t.com',billing_phone:'+2348022222222'});
      var c=comm(o1);
      util_assertEq_(c.status,'pending','pending');util_assertEq_(c.amount_usd,10,'10% of $100');util_assertEq_(c.rate_pct,10,'rate stored');
      util_assertEq_(c.fee_usd,100,'fee stored');util_assertEq_(c.referred_user_id,'U-B','buyer stored');
      util_assertEq_(c.currency+'/'+c.rate_used+'/'+c.local_amount,'NGN/1320/13200','local amount at the stored rate');
      util_assert_(Math.abs(Date.parse(c.available_at)-(Date.now()+7*864e5))<12e4,'available after 7 days');
      util_assertEq_(bal(trA).pending,10,'shows as pending');util_assertEq_(bal(trA).available,0,'nothing available yet');
    });
    t('replay creates no second commission',function(){
      util_assertEq_(aff_onPaymentConfirmed(o1).already,true,'already recorded');
      util_assertEq_(aff_reconcile_().created,0,'reconcile adds nothing');
      util_assertEq_(sheet_findRows('AffiliateTransactions',{order_ref:o1}).length,1,'one row for the order');
    });
    t('commission is on the fee paid (after promo)',function(){
      var r=buy('U-B',A.code,{amount_usd:90,list_fee_usd:100,promo_code:'X'});
      util_assertEq_(comm(r).amount_usd,9,'10% of $90');
    });
    t('unreferred and unknown codes create nothing',function(){
      var n=sheet_readAll('AffiliateTransactions').length;
      buy('U-B','');buy('U-B','NOSUCHCODE');
      util_assertEq_(sheet_readAll('AffiliateTransactions').length,n,'no rows');
    });

    // ---- a refund cancels it
    t('refund cancels the commission',function(){
      var r=buy('U-B',A.code),before=bal(trA).pending;
      util_assertEq_(comm(r).status,'pending','pending first');
      pay_refund(r,'Buyer changed their mind',adm);
      var c=comm(r);util_assertEq_(c.status,'cancelled','cancelled');util_assert_(c.reason.indexOf('clawback:')===0,'reason recorded');
      util_assertEq_(bal(trA).pending,util_round_(before-10),'pending balance drops');
      var again=aff_clawback_(r,'again',adm);util_assertEq_(again.cancelled+again.debited+again.recalculated,0,'second clawback does nothing');
      util_assert_(aff_getMine({},trA).ledger.some(function(x){return x.status==='cancelled'&&x.note==='Order refunded';}),'affiliate sees it as refunded');
    });

    // ---- self-referral is blocked
    kyc('U-A','0123456789');
    sheet_updateRow('Users','U-A',{signup_ip:'102.89.1.1'});
    function blocked(name,uid,extra,expect){
      t('self-referral: '+name,function(){
        var r=buy(uid,A.code,extra),c=comm(r);
        util_assertEq_(c.status,'cancelled','blocked');util_assertEq_(c.reason,'blocked: self-referral ('+expect+')','reason');
        util_assertEq_(c.available_at,'','never becomes available');
      });
    }
    user('U-S');blocked('own code','U-S'.replace('U-S','U-A'),{},'same account');
    user('U-E',{email:'someone@t.com'});blocked('same email via +tag on billing','U-E',{billing_email:'U-A+shop@T.com'},'same email');
    user('U-G',{email:'a.b.c@gmail.com'});
    t('gmail dots and +tags collapse',function(){
      util_assertEq_(aff_emailKey_('A.b.C+x@Gmail.com'),'abc@gmail.com','gmail');util_assertEq_(aff_emailKey_('a.b@t.com'),'a.b@t.com','dots kept elsewhere');
    });
    user('U-P',{phone:'08011111111'});blocked('same phone written locally','U-P',{},'same phone');
    user('U-K');kyc('U-K','0123456789','Kemi Zed Yusuf');blocked('same bank account','U-K',{},'same bank account');
    user('U-N');kyc('U-N','0999999999','Grace Ada Obi');blocked('same person, different account','U-N',{},'same person (ID name)');
    user('U-I',{signup_ip:'102.89.1.1'});blocked('same sign-up IP','U-I',{},'same IP address');
    t('IP check can be turned off',function(){
      setting('aff_block_same_ip','false');user('U-I2',{signup_ip:'102.89.1.1'});
      util_assertEq_(comm(buy('U-I2',A.code)).status,'pending','allowed when the setting is off');
      setting('aff_block_same_ip','true');
    });
    t('an unrelated buyer is not blocked',function(){
      user('U-OK',{phone:'+2348044444444',signup_ip:'41.58.2.2'});
      util_assertEq_(comm(buy('U-OK',A.code)).status,'pending','pending');
    });
    t('blocked attempts are audited',function(){util_assert_(audit('affiliate.blocked')>=6,'audit rows');});

    // ---- other refusals at purchase time
    t('inactive affiliate earns nothing',function(){
      aff_join({},trC);var c=aff_byUser_('U-C');
      var r=buy('U-B',c.code);util_assertEq_(comm(r).reason,'blocked: affiliate is not active','pending affiliate');
      aff_adminUpdate({affiliate_id:c.affiliate_id,decision:'approve'},adm);aff_adminUpdate({affiliate_id:c.affiliate_id,decision:'suspend',reason:'testing'},adm);
      util_assertEq_(comm(buy('U-B',c.code)).reason,'blocked: affiliate is not active','suspended affiliate');
      util_assertEq_(aff_byUser_('U-C').frozen,true,'suspend also freezes');
    });
    t('nothing due on a free order',function(){util_assertEq_(comm(buy('U-B',A.code,{amount_usd:0})).reason,'blocked: no commission due on this order','zero fee');});
    t('first_purchase mode',function(){
      setting('aff_commission_mode','first_purchase');user('U-F',{phone:'+2348055555555',signup_ip:'41.58.3.3'});
      util_assertEq_(comm(buy('U-F',A.code)).status,'pending','first purchase pays');
      util_assertEq_(comm(buy('U-F',A.code)).reason,'blocked: not the first purchase','second does not');
      setting('aff_commission_mode','every_purchase');
      util_assertEq_(comm(buy('U-F',A.code)).status,'pending','pays again in every_purchase mode');
    });

    // ---- hold and release
    t('release after the hold',function(){
      var r0=aff_releaseHeld();util_assertEq_(r0.released,0,'nothing due yet');
      due(o1);var o2=sheet_findOne('AffiliateTransactions',{referred_user_id:'U-B',fee_usd:90,type:'commission'}).order_ref;due(o2);
      var r=aff_releaseHeld();util_assert_(r.released>=2,'two released');
      util_assertEq_(comm(o1).status,'available','o1 available');util_assertEq_(bal(trA).available>=19,true,'balance shows it');
    });
    t('refund before release, hook missed: release cancels it',function(){
      var r=buy('U-B',A.code);sheet_updateRow('Payments',r,{status:'refunded'});due(r);
      aff_releaseHeld();util_assertEq_(comm(r).status,'cancelled','cancelled');util_assert_(comm(r).reason.indexOf('clawback:')===0,'as a clawback');
    });
    t('frozen, flagged and suspended affiliates are not released',function(){
      var r=buy('U-B',A.code);due(r);
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'freeze',reason:'checking'},adm);aff_releaseHeld();util_assertEq_(comm(r).status,'pending','frozen');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'unfreeze'},adm);sheet_updateRow('Affiliates',aff_byUser_('U-A'),{flagged:true,flag_reason:'test'});
      aff_releaseHeld();util_assertEq_(comm(r).status,'pending','flagged');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'clear_flag'},adm);aff_releaseHeld();util_assertEq_(comm(r).status,'available','released once clear');
    });
    t('self-referral found at release time',function(){
      user('U-L',{phone:'+2348066666666',signup_ip:'41.58.4.4'});var r=buy('U-L',A.code);util_assertEq_(comm(r).status,'pending','looks fine at purchase');
      kyc('U-L','0123456789','Lola Zed Yusuf');due(r);aff_releaseHeld();
      util_assertEq_(comm(r).reason,'blocked: self-referral (same bank account)','caught when the hold ends');
    });
    t('dashboard releases lazily',function(){
      var r=buy('U-B',A.code);var before=bal(trA).available;due(r);aff_getMine({},trA);
      util_assertEq_(comm(r).status,'available','released by opening the dashboard');util_assertEq_(bal(trA).available,util_round_(before+10),'balance up by $10');
    });

    // ---- rates and tiers
    t('tiers and per-affiliate rate',function(){
      var n=sheet_findRows('AffiliateTransactions',{affiliate_id:A.affiliate_id,type:'commission'}).filter(function(r){return r.status!=='cancelled';}).length;
      setting('aff_tiers',JSON.stringify([{min_sales:n+1,pct:15}]));
      var r1=buy('U-B',A.code);util_assertEq_(comm(r1).amount_usd,15,'tier 15%');util_assertEq_(comm(r1).rate_pct,15,'tier rate stored');
      fails(function(){aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'set_rate',rate_pct:20},adm);},'owner');
      fails(function(){aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'set_rate',rate_pct:101},owner);},'between 0 and 100');
      fails(function(){aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'set_rate',rate_pct:'abc'},owner);},'between 0 and 100');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'set_rate',rate_pct:20},owner);
      util_assertEq_(comm(buy('U-B',A.code)).amount_usd,20,'own rate beats the tier');
      util_assertEq_(comm(r1).amount_usd,15,'old rows keep their rate');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'set_rate',rate_pct:''},owner);util_assertEq_(comm(buy('U-B',A.code)).amount_usd,15,'back to the tier');
      setting('aff_tiers','[]');util_assertEq_(comm(buy('U-B',A.code)).amount_usd,10,'back to the default');
    });

    // ---- withdrawals
    t('withdrawal refusals',function(){
      fails(function(){aff_requestWithdrawal({},trB);},'Join');
      due(sheet_findRows('AffiliateTransactions',{type:'commission',status:'pending'})[0].order_ref);
      setting('aff_min_withdrawal_usd',100000);fails(function(){aff_requestWithdrawal({},trA);},'minimum');setting('aff_min_withdrawal_usd',10);
      var k=sheet_findOne('KYC',{user_id:'U-A'});
      sheet_updateRow('KYC',k,{status:'Under Review'});fails(function(){aff_requestWithdrawal({},trA);},'review');sheet_updateRow('KYC',sheet_findOne('KYC',{user_id:'U-A'}),{status:'Verified'});
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'freeze'},adm);fails(function(){aff_requestWithdrawal({},trA);},'on hold');
      util_assertEq_(aff_getMine({},trA).can_withdraw,false,'dashboard says no');aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'unfreeze'},adm);
    });
    var W=null,bank='0123456789';
    t('withdrawal takes the whole balance, locks it, ignores a browser amount',function(){
      aff_releaseHeld();var before=bal(trA).available;util_assert_(before>=10,'has a balance');
      var r=aff_requestWithdrawal({amount_usd:1,bank_account_number:'9999999999'},trA);W=r.withdrawal;
      util_assertEq_(W.amount_usd,before,'whole balance, not the $1 sent');util_assertEq_(W.status,'requested','waits for approval');
      util_assert_(W.bank_account_number===undefined&&W.bank_account_masked.slice(-4)==='6789','masked, and from KYC not the request');
      var row=sheet_getByKey('AffiliateTransactions',W.txn_id);util_assertEq_(row.bank_account_number,bank,'KYC account stored');
      util_assertEq_(row.currency+'/'+row.local_amount,'NGN/'+util_round_(before*1320),'rate stored on the row');
      util_assertEq_(bal(trA).available,0,'balance is locked');util_assertEq_(bal(trA).in_withdrawal,before,'shown as in withdrawal');
      util_assert_(sheet_findRows('AffiliateTransactions',{reference:W.txn_id,status:'withdrawn'}).length>=2,'rows locked to it');
      fails(function(){aff_requestWithdrawal({},trA);},'in progress');
    });
    t('withdrawal approval rules',function(){
      fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'approve'},adm);},'owner');
      fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'paid',reference:'REF1234'},owner);},'cannot be moved');
      util_assertEq_(aff_adminWithdrawal({txn_id:W.txn_id,decision:'approve'},owner).withdrawal.status,'approved','approved');
      fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'approve'},owner);},'cannot be moved');
      fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'paid'},owner);},'reference');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'freeze'},adm);fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'paid',reference:'REF1234'},owner);},'frozen');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'unfreeze'},adm);
      var p=aff_adminWithdrawal({txn_id:W.txn_id,decision:'paid',reference:'REF1234'},owner).withdrawal;
      util_assertEq_(p.status,'paid','paid');util_assertEq_(p.reference,'REF1234','reference kept');util_assert_(!!p.paid_at,'paid date');
      fails(function(){aff_adminWithdrawal({txn_id:W.txn_id,decision:'reject',reason:'too late'},owner);},'cannot be moved');
      var m=aff_getMine({},trA);util_assertEq_(m.balances.usd.paid_out,W.amount_usd,'paid out');util_assertEq_(m.balances.local.paid_out,util_round_(W.amount_usd*1320),'local paid out');
      util_assertEq_(m.withdrawals[0].reference,'REF1234','history shows the reference');
      util_assertEq_(sheet_findRows('AffiliateTransactions',{reference:W.txn_id,status:'withdrawn'}).length>=2,true,'commissions are now Withdrawn');
    });
    t('rejecting a withdrawal frees the balance',function(){
      var r=buy('U-B',A.code);due(r);var w=aff_requestWithdrawal({},trA).withdrawal;
      fails(function(){aff_adminWithdrawal({txn_id:w.txn_id,decision:'reject'},owner);},'reason');
      util_assertEq_(aff_adminWithdrawal({txn_id:w.txn_id,decision:'reject',reason:'Bank details need a check'},owner).withdrawal.status,'rejected','rejected');
      util_assertEq_(bal(trA).available,w.amount_usd,'balance is back');
      util_assertEq_(aff_getMine({},trA).withdrawals[0].reason,'Bank details need a check','affiliate sees why');
      util_assertEq_(comm(r).status,'available','commission available again');
    });

    // ---- clawback after money has moved
    function drain(){
      aff_releaseHeld();var b=bal(trA).available;
      if(b>=10){var w=aff_requestWithdrawal({},trA).withdrawal;aff_adminWithdrawal({txn_id:w.txn_id,decision:'approve'},owner);aff_adminWithdrawal({txn_id:w.txn_id,decision:'paid',reference:'DRAIN'+w.txn_id.slice(-4)},owner);}
    }
    t('refund while a withdrawal is open shrinks it, then rejects it',function(){
      drain();var x=buy('U-B',A.code),y=buy('U-B',A.code);due(x);due(y);
      var w=aff_requestWithdrawal({},trA).withdrawal;util_assertEq_(w.amount_usd,20,'both commissions');
      pay_refund(x,'refund x',adm);
      var row=sheet_getByKey('AffiliateTransactions',w.txn_id);util_assertEq_(row.amount_usd,10,'withdrawal reduced');util_assertEq_(row.local_amount,13200,'local reduced');
      util_assertEq_(aff_adminList({},adm).open_withdrawals.filter(function(o){return o.txn_id===w.txn_id;})[0].ledger_matches,true,'admin ledger check agrees');
      pay_refund(y,'refund y',adm);util_assertEq_(sheet_getByKey('AffiliateTransactions',w.txn_id).status,'rejected','nothing left: rejected');
      util_assertEq_(bal(trA).available,0,'no balance appears from nowhere');
    });
    var P;
    t('refund after payout becomes a debit, once',function(){
      drain();P=buy('U-B',A.code);due(P);aff_releaseHeld();
      var w=aff_requestWithdrawal({},trA).withdrawal;aff_adminWithdrawal({txn_id:w.txn_id,decision:'approve'},owner);aff_adminWithdrawal({txn_id:w.txn_id,decision:'paid',reference:'REFPAID1'},owner);
      pay_refund(P,'refund after payout',adm);
      var adj=sheet_findRows('AffiliateTransactions',{type:'adjustment',order_ref:P});
      util_assertEq_(adj.length,1,'one debit');util_assertEq_(adj[0].amount_usd,-10,'minus $10');util_assertEq_(adj[0].local_amount,-13200,'local too');
      util_assertEq_(bal(trA).available,-10,'balance is negative');
      util_assertEq_(aff_clawback_(P,'again',adm).debited,0,'no second debit');util_assertEq_(aff_reconcile_().clawed,0,'reconcile adds none');
      util_assertEq_(sheet_findRows('AffiliateTransactions',{type:'adjustment',order_ref:P}).length,1,'still one');
    });
    t('a debit is paid back from later earnings',function(){
      var q=buy('U-B',A.code);due(q);aff_releaseHeld();util_assertEq_(bal(trA).available,0,'-10 + 10');
      fails(function(){aff_requestWithdrawal({},trA);},'minimum');
      var q2=buy('U-B',A.code);due(q2);aff_releaseHeld();util_assertEq_(bal(trA).available,10,'only new money counts');
    });
    t('dispute clawback by order',function(){
      var q=buy('U-B',A.code);due(q);aff_releaseHeld();util_assertEq_(comm(q).status,'available','available');
      fails(function(){aff_adminClawback({order_ref:q,reason:'chargeback'},trA);},'access');
      fails(function(){aff_adminClawback({order_ref:'RV-NOPE',reason:'chargeback'},adm);},'not found');
      fails(function(){aff_adminClawback({order_ref:q},adm);},'reason');
      util_assertEq_(aff_adminClawback({order_ref:q,reason:'Card chargeback'},adm).cancelled,1,'cancelled');util_assertEq_(comm(q).status,'cancelled','row cancelled');
    });

    // ---- adjustments
    t('adjustments',function(){
      var a=A.affiliate_id,before=bal(trA).available;
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:5,reason:'goodwill'},adm);},'owner');
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:5},owner);},'reason');
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:0,reason:'nothing'},owner);},'credit');
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:'1e3',reason:'sci'},owner);},'credit');
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:1.234,reason:'decimals'},owner);},'decimals');
      fails(function(){aff_adminAdjust({affiliate_id:a,amount_usd:100001,reason:'too big'},owner);},'between');
      var n=audit('affiliate.adjust');
      aff_adminAdjust({affiliate_id:a,amount_usd:'5.50',reason:'Contest bonus'},owner);
      util_assertEq_(bal(trA).available,util_round_(before+5.5),'credit');
      var r=aff_adminAdjust({affiliate_id:a,amount_usd:-2,reason:'Correction'},owner);
      util_assertEq_(bal(trA).available,util_round_(before+3.5),'debit');util_assertEq_(r.balance.available_usd,util_round_(before+3.5),'admin sees the balance');
      util_assertEq_(audit('affiliate.adjust'),n+2,'both audited');
      util_assert_(aff_getMine({},trA).ledger.some(function(x){return x.type==='adjustment'&&x.note==='Contest bonus';}),'affiliate sees the reason');
    });

    // ---- bursts
    t('signup burst is flagged',function(){
      for(var i=0;i<10;i++)user('U-BR'+i,{ref_used:A.code,phone:'+23480777770'+i+'0'});
      util_assertEq_(aff_flagBursts(),1,'flagged');var a=aff_byUser_('U-A');util_assertEq_(a.flagged,true,'flag set');util_assert_(a.flag_reason.indexOf('10 sign-ups')===0,'reason');
      util_assertEq_(aff_flagBursts(),0,'not flagged twice');util_assertEq_(aff_adminList({flagged:true},adm).affiliates.length,1,'admin can filter');
      aff_adminUpdate({affiliate_id:A.affiliate_id,decision:'clear_flag'},adm);util_assertEq_(aff_byUser_('U-A').flagged,false,'cleared');
    });

    // ---- admin views, privacy, router
    t('admin list and detail',function(){
      var l=aff_adminList({},adm);util_assert_(l.affiliates.length>=2&&l.counts.active>=1,'rows and counts');
      var r=l.affiliates.filter(function(x){return x.code===A.code;})[0];util_assertEq_(r.email,'u-a@t.com','admin sees the email');
      var d=aff_adminList({affiliate_id:A.affiliate_id},adm);util_assert_(d.transactions.length>10,'detail has the ledger');
      fails(function(){aff_adminList({},trA);},'access');fails(function(){aff_adminList({status:'nope'},adm);},'status');
    });
    t('the affiliate never sees private data',function(){
      var s=JSON.stringify(aff_getMine({},trA));
      ['@','RV-','0123456789','flag_reason','blocked','password','order_ref','U-B'].forEach(function(x){util_assert_(s.indexOf(x)<0,'leaked '+x);});
      aff_getMine({},trA).referrals.forEach(function(r){util_assert_(/^RV\u2022{4}[0-9A-F]{3}$/.test(r.referral),'anonymised '+r.referral);});
      util_assert_(aff_getMine({},trA).referrals.length>=2,'referrals listed');
    });
    t('router: levels and access',function(){
      ['aff.join','aff.track','aff.getMine','aff.requestWithdrawal','admin.affiliates.list','admin.affiliates.update','admin.affiliates.withdrawal','admin.affiliates.adjust','admin.affiliates.clawback'].forEach(function(k){
        util_assert_(ACTIONS[k]&&typeof globalThis[ACTIONS[k].fn]==='function',k+' is wired to a real function');
      });
      util_assertEq_(ACTIONS['aff.track'].level,'public','track is public');util_assertEq_(ACTIONS['aff.join'].level,'trader','join needs login');
      var tok=auth_startSession_('U-A').token;
      function call(action,payload,token){return router_handle_({postData:{contents:JSON.stringify({action:action,token:token||'',payload:payload||{}})}});}
      util_assertEq_(call('aff.getMine',{},tok).ok,true,'trader can read their own');
      util_assertEq_(call('admin.affiliates.list',{},tok).code,'FORBIDDEN','trader cannot reach admin actions');
      util_assertEq_(call('admin.affiliates.adjust',{affiliate_id:A.affiliate_id,amount_usd:5,reason:'x'},tok).code,'FORBIDDEN','nor adjust');
      util_assertEq_(call('aff.getMine',{}).code,'UNAUTHENTICATED','login required');
      util_assertEq_(call('aff.track',{code:A.code,visitor:'router-visitor-1'}).data.valid,true,'track works without login');
      util_assertEq_(call('aff.getMine',{user_id:'U-B'},tok).data.affiliate.code,A.code,'a user_id in the body is ignored');
    });

    // ---- repair
    t('maintenance repairs what a failed hook left behind',function(){
      var m=order('U-B',A.code,{status:'confirmed',confirmed_at:util_nowIso_()});
      util_assertEq_(comm(m),null,'no commission yet');
      var r=aff_maintenance();util_assertEq_(r.reconcile.created,1,'created');util_assertEq_(comm(m).status,'pending','pending');
      sheet_updateRow('Payments',m,{status:'refunded'});
      util_assertEq_(aff_maintenance().reconcile.clawed,1,'clawed back a refund the hook missed');util_assertEq_(comm(m).status,'cancelled','cancelled');
      var ghost=comm(buy('U-B',A.code));sheet_updateRow('AffiliateTransactions',ghost,{status:'withdrawn',reference:'AT-GHOST0000'});
      util_assertEq_(aff_maintenance().reconcile.unlocked,1,'unlocked');util_assertEq_(sheet_getByKey('AffiliateTransactions',ghost.txn_id).status,'available','free again');
      util_assertEq_(aff_maintenance().reconcile.created+aff_maintenance().reconcile.clawed+aff_maintenance().reconcile.unlocked,0,'second run changes nothing');
    });
    t('a failing hook never blocks a payment',function(){
      var keep=aff_record_;aff_record_=function(){throw new Error('boom');};
      try{var r=order('U-B',A.code);pay_confirm(r,adm);util_assertEq_(sheet_getByKey('Payments',r).status,'confirmed','payment confirmed anyway');}
      finally{aff_record_=keep;}
    });
    t('audit trail',function(){
      ['affiliate.join','affiliate.approve','affiliate.withdrawal.request','affiliate.withdrawal.paid','affiliate.withdrawal.reject','affiliate.adjust','affiliate.clawback','affiliate.set_rate','affiliate.freeze'].forEach(function(a){util_assert_(audit(a)>0,'no audit row for '+a);});
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 15 TESTS PASSED');
}
